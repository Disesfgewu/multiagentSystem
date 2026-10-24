'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { addAccount, checkLabel, planLines, summarize } = require('../../src/accounts/add-account');

function deps(over = {}) {
  const calls = [];
  const base = {
    askLabel: async () => 'Work A',
    confirm: async (lines) => { calls.push(['confirm', lines]); return true; },
    suggest: (label) => `/home/person/multiagent-accounts/${label}`,
    createFolder: (label) => { calls.push(['folder', label]); return { ok: true, dir: `/home/person/multiagent-accounts/${label}` }; },
    createProfile: ({ label, dir }) => { calls.push(['profile', label, dir]); return { ok: true, profile: { id: 'acct-1', label, configDir: dir } }; },
    discardFolder: (dir) => calls.push(['discard', dir]),
    statusLine: async () => { calls.push(['status-line']); return { ok: true }; },
    hooks: async () => { calls.push(['hooks']); return { ok: true }; },
    openSignIn: async () => { calls.push(['sign-in']); return { ok: true, done: Promise.resolve() }; },
    check: async () => { calls.push(['check']); return { ok: true, state: 'checked', reason: 'checked' }; }
  };
  return { d: { ...base, ...over }, calls };
}

test('a Claude Code account: one confirmation, then the folder, the profile, usage and agent state, the sign-in and its check, in that order (#352)', async () => {
  const { d, calls } = deps();
  const result = await addAccount('claude', d);
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((call) => call[0]), ['confirm', 'folder', 'profile', 'status-line', 'hooks', 'sign-in', 'check']);
  assert.deepEqual(result.steps.map((step) => step.step), ['folder', 'profile', 'status-line', 'hooks', 'sign-in', 'check']);
  const lines = calls[0][1].join('\n');
  assert.match(lines, /Create the folder \/home\/person\/multiagent-accounts\/Work A/);
  assert.match(lines, /status line \(usage: 5h and 7d\) and the hook bridge/);
  assert.match(lines, /Your other Claude settings are not touched/);
  assert.deepEqual(summarize('claude', 'Work A', result), { level: 'info', text: '“Work A” is ready: signed in, with usage and agent state set up.' });
});

test('a Codex account has no bridges to set up; its plan says so (#352)', async () => {
  const { d, calls } = deps();
  const result = await addAccount('codex', d);
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((call) => call[0]), ['confirm', 'folder', 'profile', 'sign-in', 'check']);
  assert.equal(planLines('codex', 'Home', '/x').some((line) => /status line/.test(line)), false);
  assert.match(planLines('codex', 'Home', '/x').join('\n'), /^1\. [\s\S]*\n2\. Open a terminal that runs the Codex sign-in[\s\S]*\n3\. Check the sign-in/);
});

test('cancelling the name or the confirmation makes nothing (#352)', async () => {
  for (const over of [{ askLabel: async () => undefined }, { confirm: async () => false }]) {
    const { d, calls } = deps(over);
    const result = await addAccount('claude', d);
    assert.equal(result.cancelled, true);
    assert.equal(calls.some((call) => ['folder', 'profile', 'sign-in'].includes(call[0])), false);
    assert.equal(summarize('claude', 'x', result), null, 'nothing to say');
  }
});

test('each step that fails says why and what to do next; a folder made for an account that could not be saved is removed (#352)', async () => {
  const bad = await addAccount('claude', deps({ askLabel: async () => '   ' }).d);
  assert.deepEqual([bad.ok, bad.steps[0].step], [false, 'name']);
  assert.match(bad.steps[0].message, /Enter a name/);

  const noFolder = deps({ createFolder: () => ({ ok: false, message: 'The folder already exists.' }) });
  const folder = await addAccount('claude', noFolder.d);
  assert.deepEqual(folder.steps.at(-1), { step: 'folder', ok: false, message: 'The folder already exists.', next: 'Free the folder name or choose another account name, then start again.' });
  assert.equal(noFolder.calls.some((call) => call[0] === 'profile'), false);

  const noProfile = deps({ createProfile: () => ({ ok: false, message: 'The profile could not be saved.' }) });
  const profile = await addAccount('claude', noProfile.d);
  assert.equal(profile.steps.at(-1).step, 'profile');
  assert.deepEqual(noProfile.calls.find((call) => call[0] === 'discard'), ['discard', '/home/person/multiagent-accounts/Work A'], 'the folder made for it is removed');
  assert.equal(noProfile.calls.some((call) => call[0] === 'sign-in'), false);

  // A bridge that fails is reported, and the account and its sign-in still go on.
  const noBridge = deps({ statusLine: async () => ({ ok: false, message: 'settings.json could not be read.' }) });
  const bridge = await addAccount('claude', noBridge.d);
  assert.equal(bridge.ok, true, 'signed in even though usage is not set up');
  assert.deepEqual(bridge.steps.find((step) => step.step === 'status-line'), { step: 'status-line', ok: false, message: 'settings.json could not be read.', next: 'Use “Enable the Claude status line bridge” on the account row.' });
  assert.equal(summarize('claude', 'Work A', bridge).level, 'warning');
  assert.match(summarize('claude', 'Work A', bridge).text, /settings\.json could not be read\. Next: Use “Enable the Claude status line bridge”/);

  const noTerminal = deps({ openSignIn: async () => ({ ok: false, message: 'The CLI was not found.' }) });
  const terminal = await addAccount('claude', noTerminal.d);
  assert.deepEqual([terminal.ok, terminal.steps.at(-1).step, terminal.steps.at(-1).next], [false, 'sign-in', 'Use “Sign in” on the account row.']);
  assert.equal(noTerminal.calls.some((call) => call[0] === 'check'), false);

  const notSigned = await addAccount('claude', deps({ check: async () => ({ ok: false, state: 'unknown', reason: 'not-logged-in' }) }).d);
  assert.deepEqual([notSigned.ok, notSigned.steps.at(-1).step], [false, 'check']);
  assert.match(notSigned.steps.at(-1).message, /not-logged-in/);

  assert.equal((await addAccount('agy', deps().d)).steps[0].step, 'provider');
});

test('the check waits until the sign-in is done (#352)', async () => {
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const { d, calls } = deps({ openSignIn: async () => ({ ok: true, done }) });
  const running = addAccount('claude', d);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.some((call) => call[0] === 'check'), false, 'not before the sign-in is done');
  finish();
  await running;
  assert.equal(calls.at(-1)[0], 'check');
});

test('a name is plain text of at most 60 characters', () => {
  assert.deepEqual(checkLabel('  Work A  '), { ok: true, label: 'Work A' });
  for (const bad of ['', '   ', 'x'.repeat(61), 'a\nb', 'a\u0007b', 5, undefined]) assert.equal(checkLabel(bad).ok, false, JSON.stringify(bad));
});
