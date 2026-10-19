'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CHANNELS, assessIsolation, decideLaunch, describeAssessment, collectProbes } = require('../../src/isolation/capabilities');

const NOW = new Date('2026-10-19T12:00:00.000Z');
const at = (msAgo) => new Date(NOW.getTime() - msAgo).toISOString();
const good = (channel, over = {}) => ({ outcome: CHANNELS[channel].kind === 'bypass' ? 'blocked' : 'works', control: true, observedAt: at(1000), ...over });
const allGood = (over = {}) => Object.fromEntries(Object.keys(CHANNELS).map((channel) => [channel, good(channel, over)]));
const assess = (probes, platform = 'darwin', extra = {}) => assessIsolation({ platform, probes, now: NOW, ...extra });
const state = (assessment, channel) => assessment.channels.find((entry) => entry.channel === channel);

test('every required channel blocked or working, with a control, is the only way to read as enforced', () => {
  const result = assess(allGood());
  assert.deepEqual([result.mode, result.supported, result.reasons], ['enforced', true, []]);
  assert.ok(result.channels.every((entry) => entry.state === 'enforced'));
  assert.equal(Object.keys(CHANNELS).length, 9);
});

test('nothing probed, or a platform that is not macOS or Windows, is never enforced', () => {
  const none = assess({});
  assert.equal(none.mode, 'advisory');
  assert.ok(none.channels.every((entry) => entry.state === 'unknown' && entry.reason === 'not-probed'));
  for (const platform of ['linux', null, 'darwin ', 'WIN32']) {
    const result = assess(allGood(), platform);
    assert.deepEqual([result.mode, result.supported, result.platform], ['advisory', false, 'unsupported'], String(platform));
    assert.ok(result.channels.every((entry) => entry.reason === 'platform-not-supported'));
  }
});

test('a blocked attempt without a control that ran is unknown: a probe that could not run is not a closed door', () => {
  for (const control of [false, undefined, 'true', 1, null]) {
    const result = assess({ ...allGood(), 'direct-http': good('direct-http', { control }) });
    assert.deepEqual([state(result, 'direct-http').state, state(result, 'direct-http').reason, result.mode], ['unknown', 'control-did-not-run', 'advisory'], String(control));
  }
});

test('a bypass that worked is open, and open is reported as such, not as unknown', () => {
  const result = assess({ ...allGood(), 'gh-cli': good('gh-cli', { outcome: 'open' }) });
  assert.deepEqual([state(result, 'gh-cli').state, result.mode, result.reasons], ['open', 'advisory', ['gh-cli:open']]);
});

test('interaction that broke keeps the environment from being enforced even when every bypass is blocked', () => {
  const broken = assess({ ...allGood(), 'terminal-interaction': good('terminal-interaction', { outcome: 'broken' }) });
  assert.deepEqual([state(broken, 'terminal-interaction').state, broken.mode], ['open', 'advisory']);
  const unknown = assess({ ...allGood(), 'cli-own-login': undefined });
  assert.deepEqual([state(unknown, 'cli-own-login').state, unknown.mode], ['unknown', 'advisory']);
});

test('evidence from the future, with a bad time, or older than its lifetime is unknown', () => {
  for (const [observedAt, reason] of [[new Date(NOW.getTime() + 60_000).toISOString(), 'evidence-time-invalid'], ['not a time', 'evidence-time-invalid'], [undefined, 'evidence-time-invalid'], [at(24 * 60 * 60 * 1000), 'evidence-stale'], [at(25 * 60 * 60 * 1000), 'evidence-stale']]) {
    const result = assess({ ...allGood(), 'git-push': good('git-push', { observedAt }) });
    assert.deepEqual([state(result, 'git-push').state, state(result, 'git-push').reason], ['unknown', reason], String(observedAt));
  }
  assert.equal(state(assess({ ...allGood(), 'git-push': good('git-push', { observedAt: at(10_000) }) }, 'darwin', { validForMs: 5_000 }), 'git-push').reason, 'evidence-stale');
  assert.equal(assess(allGood(), 'darwin', { validForMs: -1 }).mode, 'enforced', 'an invalid lifetime falls back to the default, not to forever');
});

test('an outcome that is not one of the two recognized words, or of the wrong kind of channel, is unknown', () => {
  for (const outcome of ['Blocked', 'denied', true, 1, undefined, {}]) {
    assert.equal(state(assess({ ...allGood(), 'git-commit': good('git-commit', { outcome }) }), 'git-commit').reason, 'outcome-unrecognized', String(outcome));
  }
  assert.equal(state(assess({ ...allGood(), 'git-commit': good('git-commit', { outcome: 'works' }) }), 'git-commit').state, 'unknown', 'works is for interaction channels only');
  assert.equal(state(assess({ ...allGood(), 'terminal-interaction': good('terminal-interaction', { outcome: 'blocked' }) }), 'terminal-interaction').state, 'unknown');
});

test('a probe record that is not a plain object, or inherited properties, are not evidence', () => {
  for (const bad of [null, 'blocked', 5, [], () => ({})]) assert.equal(state(assess({ ...allGood(), 'git-commit': bad }), 'git-commit').reason, 'not-probed', String(bad));
  const inherited = Object.create({ 'git-commit': good('git-commit') });
  assert.equal(state(assess(inherited), 'git-commit').reason, 'not-probed');
  assert.equal(assess(null).mode, 'advisory');
  assert.equal(assess('x').mode, 'advisory');
});

test('enforced mode is refused unless fully enforced, with the reasons, and is never run as advice instead', () => {
  const full = assess(allGood());
  assert.deepEqual(decideLaunch({ assessment: full, requested: 'enforced' }), { allowed: true, mode: 'enforced', reasons: [], notice: 'Every required bypass was tried on this machine and blocked.' });
  const partial = assess({ ...allGood(), 'direct-http': undefined, 'gh-cli': good('gh-cli', { outcome: 'open' }) });
  const refused = decideLaunch({ assessment: partial, requested: 'enforced' });
  assert.deepEqual([refused.allowed, refused.mode], [false, 'none']);
  assert.deepEqual(refused.reasons, ['gh-cli:open', 'direct-http:not-probed']);
  assert.match(refused.notice, /nothing was started/);
  const advice = decideLaunch({ assessment: partial, requested: 'advisory' });
  assert.deepEqual([advice.allowed, advice.mode], [true, 'advisory']);
  assert.match(advice.notice, /nothing here prevents an agent from bypassing/);
});

test('a launch decision never trusts a hand-made assessment that claims enforcement on an unsupported platform, and bad input is refused', () => {
  const forged = { ...assess(allGood()), supported: false, platform: 'unsupported' };
  assert.equal(decideLaunch({ assessment: forged, requested: 'enforced' }).allowed, false);
  for (const input of [undefined, {}, { assessment: null, requested: 'enforced' }, { assessment: assess(allGood()), requested: 'ENFORCED' }, { assessment: assess(allGood()), requested: undefined }, { assessment: { channels: 'x' }, requested: 'advisory' }]) {
    const decision = decideLaunch(input);
    assert.deepEqual([decision.allowed, decision.reasons], [false, ['input-invalid']], JSON.stringify(input));
  }
});

test('the words shown never say blocked without evidence and name the platform', () => {
  const lines = describeAssessment(assess({}));
  assert.match(lines[0], /^Isolation on macOS: not enforced\. Advice mode only/);
  assert.ok(lines.slice(1).every((line) => /unknown \(not-probed\)$/.test(line)));
  assert.equal(lines.some((line) => /blocked|works/.test(line)), false);
  const mixed = describeAssessment(assess({ ...allGood(), 'gh-cli': good('gh-cli', { outcome: 'open' }), 'direct-http': undefined }, 'win32'));
  assert.match(mixed[0], /^Isolation on Windows: not enforced/);
  assert.ok(mixed.includes('- the `gh` command writing to GitHub: NOT blocked'));
  assert.ok(mixed.includes('- a direct HTTP request to the GitHub API: unknown (not-probed)'));
  assert.ok(mixed.includes('- a direct `git push` to the remote: blocked'));
  assert.match(describeAssessment(assess(allGood()))[0], /every required bypass was tried and blocked, and the CLI stayed usable/);
  assert.deepEqual(describeAssessment(null), ['Isolation: unknown.']);
});

test('collecting probes: a throwing, hanging, aborted or malformed probe leaves its channel unprobed and never throws', async () => {
  const seen = [];
  const platformModule = {
    platform: 'darwin',
    probe: async (channel) => {
      seen.push(channel);
      if (channel === 'git-commit') throw new Error('boom');
      if (channel === 'git-push') return new Promise(() => {});
      if (channel === 'gh-cli') return 'blocked';
      if (channel === 'direct-http') return null;
      return { outcome: CHANNELS[channel].kind === 'bypass' ? 'blocked' : 'works', control: true };
    }
  };
  const { platform, probes } = await collectProbes(platformModule, { timeoutMs: 20, now: () => NOW });
  assert.equal(platform, 'darwin');
  assert.deepEqual(seen, Object.keys(CHANNELS), 'every channel is asked once, in order');
  for (const missing of ['git-commit', 'git-push', 'gh-cli', 'direct-http']) assert.equal(Object.hasOwn(probes, missing), false, missing);
  assert.equal(probes['credential-helper'].observedAt, NOW.toISOString(), 'the time is stamped by the collector when the module did not say');
  const result = assess(probes);
  assert.equal(result.mode, 'advisory');
  assert.equal(state(result, 'git-commit').reason, 'not-probed');
  assert.deepEqual(await collectProbes(null), { platform: undefined, probes: {} });
  assert.deepEqual((await collectProbes({ platform: 'win32' })).probes, {});
});

test('aborting stops asking further channels, and a probe cannot outlive its timeout', async () => {
  const controller = new AbortController();
  const asked = [];
  const { probes } = await collectProbes({ platform: 'darwin', probe: async (channel, { signal }) => { asked.push(channel); if (asked.length === 2) controller.abort(); return { outcome: 'blocked', control: true, aborted: signal.aborted }; } }, { signal: controller.signal });
  assert.equal(asked.length, 2);
  assert.equal(Object.keys(probes).length, 2);
  let timedOutSignal;
  const started = Date.now();
  await collectProbes({ platform: 'darwin', probe: (channel, { signal }) => { timedOutSignal = signal; return new Promise(() => {}); } }, { timeoutMs: 10 });
  assert.ok(Date.now() - started < 5_000, 'a hanging probe does not hang the collector');
  assert.equal(timedOutSignal.aborted, true, 'the probe is told to stop');
});
