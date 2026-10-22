'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCodexRecorder } = require('../../src/accounts/codex-recorder');
const { readCodexRateLimits } = require('../../src/accounts/codex-rate-limits');
const { codexQuotaFromSessionLog } = require('../../src/accounts/observation');
const { PrivateStore } = require('../../src/storage/private-store');
const { UsageLog } = require('../../src/accounts/usage-log');
const { sandbox, COLLECTIONS } = require('../storage/helpers');

const T0 = new Date('2026-10-22T10:00:00.000Z');
const event = (minutesAgo, tokens) => JSON.stringify({ timestamp: new Date(T0.getTime() - minutesAgo * 60_000).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: tokens, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 } }, rate_limits: { primary: { used_percent: 10, window_minutes: 300, resets_at: Math.floor(T0.getTime() / 1000) + 3600 }, plan_type: 'plus' } } });

let lastHome = path.join(os.tmpdir(), 'mas-recorder-none');
const setupHome = () => lastHome;
function setup(t) {
  const box = sandbox(t);
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mas-recorder-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  lastHome = home;
  fs.mkdirSync(path.join(home, 'sessions', '2026', '10', '22'), { recursive: true });
  const rollout = path.join(home, 'sessions', '2026', '10', '22', 'rollout-2026-10-22T09-00-00-aaaa1111.jsonl');
  const store = new PrivateStore({ dir: box.dir, repoRoot: box.repoRoot, collections: [...COLLECTIONS] });
  const log = new UsageLog(store);
  let clock = T0;
  let reads = 0;
  const recorder = createCodexRecorder({
    now: () => clock,
    readReading: (id, at) => { reads += 1; return readCodexRateLimits(home, { profileId: id, now: at }); },
    append: (entry, at) => log.append(entry, at)
  });
  return { recorder, log, rollout, setClock: (value) => { clock = value; }, reads: () => reads, home };
}

test('the same event read twice adds one record to the usage log', (t) => {
  const { recorder, log, rollout, setClock } = setup(t);
  fs.writeFileSync(rollout, `${event(2, 1200)}\n`);
  assert.equal(recorder.record('acct-1'), 'recorded');
  setClock(new Date(T0.getTime() + 60_000));
  assert.equal(recorder.record('acct-1'), 'unchanged', 'a minute later, the same event: not a second record');
  assert.equal(log.query().entries.length, 1);
  assert.deepEqual([log.query().entries[0].inputTokens, log.query().entries[0].source, log.query().entries[0].provider], [1200, 'codex-session-log', 'codex']);
});

test('a new event is a new record, and the read is throttled per account', (t) => {
  const { recorder, log, rollout, setClock, reads } = setup(t);
  fs.writeFileSync(rollout, `${event(3, 100)}\n`);
  assert.equal(recorder.record('acct-1'), 'recorded');
  fs.writeFileSync(rollout, `${event(3, 100)}\n${event(1, 250)}\n`);
  setClock(new Date(T0.getTime() + 10_000));
  assert.equal(recorder.record('acct-1'), 'throttled', 'ten seconds later: not read again');
  assert.equal(reads(), 1);
  assert.equal(recorder.record('acct-2'), 'recorded', 'another account is not held back by it');
  assert.equal(reads(), 2);
  setClock(new Date(T0.getTime() + 31_000));
  assert.equal(recorder.record('acct-1'), 'recorded', 'after the throttle, the newer event is kept');
  assert.deepEqual(log.query({ accountProfileId: 'acct-1' }).entries.map((entry) => entry.inputTokens).sort(), [100, 250]);
  assert.equal(reads(), 3);
  setClock(new Date(T0.getTime() + 31_000 - 60_000));
  assert.equal(recorder.record('acct-1'), 'unchanged', 'a clock that went backwards does not throttle: it is read again (and the event is the same)');
  assert.equal(reads(), 4);
});

test('a clock that is not a time never throttles, and never makes a reading look current', (t) => {
  const { recorder, rollout, setClock, reads } = setup(t);
  fs.writeFileSync(rollout, `${event(2, 1200)}\n`);
  setClock(new Date(Number.NaN));
  assert.equal(recorder.record('acct-1'), 'no-entry', 'the reading itself refuses a clock that is not a time, so nothing is kept');
  assert.equal(recorder.record('acct-1'), 'no-entry');
  assert.deepEqual(readCodexRateLimits(setupHome(), { now: new Date(Number.NaN) }), { ok: false, reason: 'clock-invalid' });
  assert.equal(reads(), 2, 'both times it was read: nothing was throttled by a clock that is not a time');
  // The quota of a window whose reset time has passed is expired when the clock is not a time (it is never "current" by accident).
  const windows = { primary: { used_percent: 40, window_minutes: 300, resets_at: Math.floor(T0.getTime() / 1000) + 3600 } };
  for (const now of [new Date(Number.NaN), 'not a time', undefined === 1 ? 0 : Number.NaN]) {
    const read = codexQuotaFromSessionLog(windows, { profileId: 'p', observedAt: T0, now }).observations.find((entry) => entry.field === 'quota.five_hour.used_percent');
    assert.equal(read.value, null, String(now));
    assert.equal(read.reason, 'window-reset-passed');
  }
  const fine = codexQuotaFromSessionLog(windows, { profileId: 'p', observedAt: T0, now: T0 }).observations.find((entry) => entry.field === 'quota.five_hour.used_percent');
  assert.equal(fine.value, 40, 'a real clock before the reset keeps the reading');
});

test('a failing read or write never throws and is reported', () => {
  const throwing = createCodexRecorder({ readReading: () => { throw new Error('x'); }, append: () => ({ ok: true, appended: true }) });
  assert.equal(throwing.record('a'), 'failed');
  const failing = createCodexRecorder({ readReading: () => ({ ok: false, reason: 'no-session-files' }), append: () => ({ ok: true, appended: true }) });
  assert.equal(failing.record('a'), 'no-entry');
  const refusing = createCodexRecorder({ readReading: () => ({ ok: true, observedAt: T0.toISOString(), sessionKey: 'codex-x', usage: { input: 1, cachedInput: null, cacheWrite: null, output: null } }), append: () => ({ ok: false, reason: 'storage-unavailable' }) });
  assert.equal(refusing.record('a'), 'failed');
  assert.equal(createCodexRecorder({ readReading: () => null, append: () => null }).record('a'), 'no-entry');
});

test('the window\'s hook uses one recorder, and a Codex session change goes through it', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/accounts/quotaGateUi.ts'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal([...source.matchAll(/= createCodexRecorder\(\{/g)].length, 1);
  assert.match(source, /codexRecorder\.record\(accountProfileId, \{ configDir: own\.profile\.configDir, store: accounts\.store, now \}\);/);
});
