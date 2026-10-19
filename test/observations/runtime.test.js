'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SessionObservationRuntime, SESSION_ID_ENV, MAX_RECORD_BYTES, observationPath, readRecord, sweepStale, STALE_MS } = require('../../src/observations/runtime');

const NOW = '2026-01-01T00:00:00.000Z';
const RECORD = JSON.stringify({ schemaVersion: 1, eventId: 'e', observedAt: NOW, sequence: 1, statusLine: { model: { id: 'm' } } });

test('runtime binds a sanitized status-line record to exactly one managed session and account', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-observation-runtime-'));
  try {
    const runtime = new SessionObservationRuntime({ now: () => NOW, ttlMs: 1000 });
    const prepared = runtime.prepare({
      sessionId: 'session-a', provider: 'claude', accountProfileId: 'account-a',
      env: { CLAUDE_CONFIG_DIR: root }
    });
    assert.equal(prepared.env[SESSION_ID_ENV], 'session-a');
    const file = observationPath(root, 'session-a');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 1, eventId: 'event-a', observedAt: NOW, sequence: 1,
      statusLine: { model: { id: 'claude-sonnet-4-5' }, cost: { total_cost_usd: 0.1 } }
    }));
    const [session] = runtime.enrich([{ id: 'session-a', accountProfileId: 'account-a' }], NOW);
    assert.equal(session.providerObservation.model.value, 'claude-sonnet-4-5');
    assert.equal(session.providerObservation.status.confidence, 'unknown');
    assert.equal(session.providerObservation.accountProfileId, 'account-a');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('malformed, extra-field, stale and unsupported-provider data remain unknown', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-observation-unknown-'));
  try {
    const runtime = new SessionObservationRuntime({ now: () => NOW, ttlMs: 1000 });
    assert.equal(runtime.prepare({ sessionId: 'codex-a', provider: 'codex', accountProfileId: 'account-a', env: { CLAUDE_CONFIG_DIR: root } }).active, false);
    runtime.prepare({ sessionId: 'session-a', provider: 'claude', accountProfileId: 'account-a', env: { CLAUDE_CONFIG_DIR: root } });
    const file = observationPath(root, 'session-a');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 1, eventId: 'event-a', observedAt: NOW, sequence: 1,
      statusLine: { model: { id: 'claude-sonnet-4-5' } }, transcript: 'must-not-be-read'
    }));
    assert.equal(runtime.snapshot('session-a', NOW).model.confidence, 'unknown');
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 1, eventId: 'event-b', observedAt: NOW, sequence: 2,
      statusLine: { model: { id: 'claude-sonnet-4-5' } }
    }));
    assert.equal(runtime.snapshot('session-a', '2026-01-01T00:00:01.000Z').model.confidence, 'unknown');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime refuses a session id that could escape its account observation directory', () => {
  const runtime = new SessionObservationRuntime();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-observation-id-'));
  assert.throws(() => runtime.prepare({
    sessionId: '../escape', provider: 'claude', accountProfileId: 'account-a',
    env: { CLAUDE_CONFIG_DIR: root }
  }), /binding is invalid/);
  fs.rmSync(root, { recursive: true, force: true });
});

const recordText = (observedAt, over = {}) => JSON.stringify({
  schemaVersion: 1, eventId: `event-${observedAt}`, observedAt, sequence: Date.parse(observedAt) % 1_000_000,
  statusLine: { model: { id: 'claude-sonnet-4-5' }, cost: { total_cost_usd: 0.1 } }, ...over
});

function bound(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-observation-notify-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  const runtime = new SessionObservationRuntime({ ttlMs: 30_000, nowMs: () => clock, now: () => new Date(clock).toISOString(), ...options });
  t.after(() => runtime.dispose());
  runtime.prepare({ sessionId: 'session-a', provider: 'claude', accountProfileId: 'account-a', env: { CLAUDE_CONFIG_DIR: root } });
  const file = observationPath(root, 'session-a');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const events = [];
  const subscription = runtime.onDidChange((sessionId) => events.push(sessionId));
  return { root, runtime, file, events, subscription, advance: (ms) => { clock += ms; }, at: () => new Date(clock).toISOString() };
}

test('a new observation file refreshes the views once, and an unchanged one does not', (t) => {
  const { runtime, file, events, at } = bound(t);
  runtime.poll();
  assert.deepEqual(events, [], 'nothing was written yet');
  fs.writeFileSync(file, recordText(at()));
  runtime.poll();
  assert.deepEqual(events, ['session-a']);
  runtime.poll();
  runtime.poll();
  assert.equal(events.length, 1, 'an unchanged file is not reported again');
  fs.writeFileSync(file, recordText(at(), { eventId: 'later', sequence: 99 }));
  fs.utimesSync(file, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
  runtime.poll();
  assert.equal(events.length, 2, 'a rewritten file is reported');
});

test('what a record showed ages out into a refresh exactly once, and the snapshot is then unknown', (t) => {
  const { runtime, file, events, advance, at } = bound(t);
  fs.writeFileSync(file, recordText(at()));
  runtime.poll();
  assert.equal(events.length, 1);
  assert.equal(runtime.snapshot('session-a', at()).model.value, 'claude-sonnet-4-5');
  advance(29_000);
  runtime.poll();
  assert.equal(events.length, 1, 'still fresh: no refresh');
  advance(2_000);
  runtime.poll();
  assert.equal(events.length, 2, 'the freshness window passed: refresh so the screen stops showing it');
  runtime.poll();
  assert.equal(events.length, 2, 'reported once, not on every poll');
  const aged = runtime.snapshot('session-a', at());
  assert.equal(aged.model.confidence, 'unknown');
  assert.equal(aged.model.reason, 'stale');
});

test('removing the file refreshes the views, and stopping the session ends all refreshing and removes the timer', (t) => {
  const { runtime, file, events, at } = bound(t);
  fs.writeFileSync(file, recordText(at()));
  runtime.poll();
  fs.rmSync(file);
  runtime.poll();
  assert.equal(events.length, 2, 'a removed file is a change too');
  assert.notEqual(runtime.timer, null, 'a bound session with a listener has a timer');
  runtime.release('session-a');
  assert.equal(runtime.timer, null, 'no session bound: no timer');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, recordText(at()));
  runtime.poll();
  assert.equal(events.length, 2, 'a released session is never reported again');
});

test('there is no timer without a listener or without a bound session, and disposing the subscription or the runtime stops it', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-observation-timer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = new SessionObservationRuntime({ pollMs: 50 });
  t.after(() => runtime.dispose());
  assert.equal(runtime.timer, null);
  runtime.prepare({ sessionId: 'session-a', provider: 'claude', accountProfileId: 'account-a', env: { CLAUDE_CONFIG_DIR: root } });
  assert.equal(runtime.timer, null, 'bound but nobody listens');
  const subscription = runtime.onDidChange(() => {});
  assert.notEqual(runtime.timer, null);
  assert.equal(runtime.timer.hasRef(), false, 'the timer never keeps the process alive');
  subscription.dispose();
  assert.equal(runtime.timer, null);
  const again = runtime.onDidChange(() => {});
  assert.notEqual(runtime.timer, null);
  runtime.dispose();
  assert.equal(runtime.timer, null);
  assert.equal(runtime.bindings.size, 0);
  again.dispose();
});

test('a failing listener never stops the others', (t) => {
  const { runtime, file, at } = bound(t);
  const seen = [];
  runtime.onDidChange(() => { throw new Error('listener failure'); });
  runtime.onDidChange((sessionId) => seen.push(sessionId));
  fs.writeFileSync(file, recordText(at()));
  runtime.poll();
  assert.deepEqual(seen, ['session-a']);
});

test('the observation file is read only if it is a small, plain, singly-linked regular file', { skip: process.platform === 'win32' }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-observation-read-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const good = path.join(root, 'good.json');
  fs.writeFileSync(good, recordText('2026-01-01T00:00:00.000Z'));
  assert.equal(readRecord(good).schemaVersion, 1);

  const target = path.join(root, 'target.json');
  fs.writeFileSync(target, recordText('2026-01-01T00:00:00.000Z'));
  const link = path.join(root, 'link.json');
  fs.symlinkSync(target, link);
  assert.equal(readRecord(link), null, 'a symlink is never followed');

  const hard = path.join(root, 'hard.json');
  fs.linkSync(good, hard);
  assert.equal(readRecord(good), null, 'a hard-linked file could be someone else\'s file');
  fs.rmSync(hard);
  assert.equal(readRecord(good).schemaVersion, 1);

  const big = path.join(root, 'big.json');
  fs.writeFileSync(big, `{"schemaVersion":1,"pad":"${'x'.repeat(MAX_RECORD_BYTES)}"}`);
  assert.equal(readRecord(big), null, 'an oversized file is refused without reading it');

  const fifo = path.join(root, 'fifo.json');
  require('node:child_process').execFileSync('mkfifo', [fifo]);
  const started = Date.now();
  assert.equal(readRecord(fifo), null, 'a FIFO is refused before it can block the host');
  assert.ok(Date.now() - started < 2000);
  assert.equal(readRecord(path.join(root, 'missing.json')), null);
  assert.equal(readRecord(root), null, 'a directory is not a record');
});

test('starting a session sweeps record files left by sessions that never cleaned up, and only those', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-observation-sweep-'));
  try {
    const dir = path.dirname(observationPath(root, 'x'));
    fs.mkdirSync(dir, { recursive: true });
    const write = (name, ageMs) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, RECORD);
      const at = new Date(Date.now() - ageMs);
      fs.utimesSync(file, at, at);
      return file;
    };
    const stale = write('old-session.json', STALE_MS + 60_000);
    const fresh = write('other-window.json', 60_000);
    const foreign = write('notes.txt', STALE_MS * 5);
    const odd = write('..hidden.json', STALE_MS * 5);
    const notARecord = write('unrelated.json', STALE_MS * 5);
    fs.writeFileSync(notARecord, '{"setting":true}');
    fs.utimesSync(notARecord, new Date(Date.now() - STALE_MS * 5), new Date(Date.now() - STALE_MS * 5));
    const linkTarget = path.join(root, 'target.json');
    fs.writeFileSync(linkTarget, '{}');
    const link = path.join(dir, 'linked.json');
    fs.symlinkSync(linkTarget, link);
    const old = new Date(Date.now() - STALE_MS * 5);
    fs.lutimesSync(link, old, old);
    const runtime = new SessionObservationRuntime();
    runtime.prepare({ sessionId: 'session-new', provider: 'claude', accountProfileId: 'account-a', env: { CLAUDE_CONFIG_DIR: root } });
    assert.equal(fs.existsSync(stale), false, 'a day-old record is gone');
    for (const kept of [fresh, foreign, odd, notARecord, linkTarget]) assert.equal(fs.existsSync(kept), true, kept);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'a link is never followed or removed by the sweep');
    assert.equal(sweepStale(path.join(root, 'missing'), Date.now()), 0, 'a missing folder is fine');
    runtime.dispose();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a linked session-observations folder is never listed, swept or deleted from, through the real prepare and release paths', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-observation-link-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'session-observation-outside-'));
  try {
    const old = new Date(Date.now() - STALE_MS * 5);
    const victims = ['unrelated.json', 'session-new.json'].map((name) => {
      const file = path.join(outside, name);
      fs.writeFileSync(file, RECORD);
      fs.utimesSync(file, old, old);
      return file;
    });
    fs.symlinkSync(outside, path.dirname(observationPath(root, 'x')));
    assert.equal(sweepStale(path.dirname(observationPath(root, 'x')), Date.now()), 0);
    const runtime = new SessionObservationRuntime();
    runtime.prepare({ sessionId: 'session-new', provider: 'claude', accountProfileId: 'account-a', env: { CLAUDE_CONFIG_DIR: root } });
    runtime.release('session-new');
    runtime.dispose();
    for (const file of victims) assert.equal(fs.existsSync(file), true, 'nothing outside the account folder is removed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('a Codex terminal session is registered as having no verified event source: everything unknown, with the reason, and no files or servers involved', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-observation-codex-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = new SessionObservationRuntime({ now: () => NOW, ttlMs: 60_000 });
  t.after(() => runtime.dispose());
  const env = { CODEX_HOME: root };
  const prepared = runtime.prepare({ sessionId: 'codex-a', provider: 'codex', accountProfileId: 'account-a', env });
  assert.deepEqual(prepared, { env, active: false }, 'the launch environment is not touched');
  assert.deepEqual(fs.readdirSync(root), [], 'nothing is written into the account folder');
  const snapshot = runtime.snapshot('codex-a', NOW);
  assert.deepEqual([snapshot.providerSession, snapshot.provider, snapshot.accountProfileId], ['unavailable', 'codex', 'account-a']);
  assert.deepEqual([snapshot.status.confidence, snapshot.status.reason, snapshot.model.confidence, snapshot.model.reason], ['unknown', 'no-verified-event-source', 'unknown', 'no-verified-event-source']);
  assert.ok(snapshot.usage.every((entry) => entry.confidence === 'unknown' && entry.reason === 'no-verified-event-source'));
  assert.equal(runtime.core.ingest({ schemaVersion: 1, eventId: 'e', sessionId: 'codex-a', provider: 'codex', accountProfileId: 'account-a', source: 'codex-app-server-v2', observedAt: NOW, sequence: 1, state: 'working' }).ok, false, 'a notification from some other server has no session to land on');
  assert.equal(runtime.snapshot('codex-a', NOW).status.confidence, 'unknown');
  const [enriched] = runtime.enrich([{ id: 'codex-a' }, { id: 'codex-b' }], NOW);
  assert.equal(enriched.providerObservation.providerSession, 'unavailable');
  assert.equal(runtime.snapshot('codex-b', NOW), null, 'a session that was never prepared stays absent');
  runtime.release('codex-a');
  assert.equal(runtime.snapshot('codex-a', NOW), null, 'released');
  assert.equal(runtime.prepare({ sessionId: 'agy-a', provider: 'agy', accountProfileId: 'account-a', env }).active, false);
  assert.equal(runtime.snapshot('agy-a', NOW), null, 'only the Codex slice is registered here');
});

function providerSessionFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-observation-provider-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = new SessionObservationRuntime({ now: () => NOW, ttlMs: 60_000 });
  t.after(() => runtime.dispose());
  const start = (sessionId) => {
    runtime.prepare({ sessionId, provider: 'claude', accountProfileId: 'account-a', env: { CLAUDE_CONFIG_DIR: root } });
    return observationPath(root, sessionId);
  };
  const write = (file, sequence, providerSessionId, model = 'claude-sonnet-4-5') => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const record = { schemaVersion: 1, eventId: `event-${sequence}`, observedAt: NOW, sequence, statusLine: { model: { id: model } } };
    if (providerSessionId !== undefined) record.providerSessionId = providerSessionId;
    // Like the real bridge: write a temporary file, then replace the record by rename, so each record is a
    // new file (an in-place rewrite of an equally long record can leave the change marker unchanged on Windows).
    const temporary = `${file}.tmp.${sequence}`;
    fs.writeFileSync(temporary, JSON.stringify(record));
    fs.renameSync(temporary, file);
  };
  return { runtime, start, write };
}

test('the first record carrying a provider session id fixes the mapping; the same id keeps matching', (t) => {
  const { runtime, start, write } = providerSessionFixture(t);
  const file = start('session-a');
  assert.equal(runtime.snapshot('session-a', NOW).providerSession, 'unbound', 'nothing seen yet: not confirmed');
  write(file, 1, 'claude-own-1');
  let snapshot = runtime.snapshot('session-a', NOW);
  assert.deepEqual([snapshot.providerSession, snapshot.model.value, snapshot.model.confidence], ['bound', 'claude-sonnet-4-5', 'actual']);
  write(file, 2, 'claude-own-1', 'claude-opus-4-1');
  snapshot = runtime.snapshot('session-a', NOW);
  assert.deepEqual([snapshot.providerSession, snapshot.model.value], ['bound', 'claude-opus-4-1']);
});

test('records that never carry an id stay unbound: still shown, but never called matched', (t) => {
  const { runtime, start, write } = providerSessionFixture(t);
  const file = start('session-a');
  write(file, 1, undefined);
  const snapshot = runtime.snapshot('session-a', NOW);
  assert.deepEqual([snapshot.providerSession, snapshot.model.value], ['unbound', 'claude-sonnet-4-5']);
});

test('a different provider session id withdraws every value for good, even when the old id comes back', (t) => {
  const { runtime, start, write } = providerSessionFixture(t);
  const file = start('session-a');
  write(file, 1, 'claude-own-1');
  assert.equal(runtime.snapshot('session-a', NOW).model.confidence, 'actual');
  write(file, 2, 'claude-own-2', 'claude-opus-4-1');
  let snapshot = runtime.snapshot('session-a', NOW);
  assert.equal(snapshot.providerSession, 'mismatch');
  assert.deepEqual([snapshot.model.confidence, snapshot.model.reason, snapshot.status.confidence], ['unknown', 'provider-session-changed', 'unknown']);
  assert.ok(snapshot.usage.every((entry) => entry.confidence === 'unknown'), 'no usage survives');
  write(file, 3, 'claude-own-1');
  snapshot = runtime.snapshot('session-a', NOW);
  assert.deepEqual([snapshot.providerSession, snapshot.model.confidence], ['mismatch', 'unknown']);
});

test('once matched, a record that lost its id is treated as another writer: evidence is withdrawn', (t) => {
  const { runtime, start, write } = providerSessionFixture(t);
  const file = start('session-a');
  write(file, 1, 'claude-own-1');
  runtime.snapshot('session-a', NOW);
  write(file, 2, undefined);
  const snapshot = runtime.snapshot('session-a', NOW);
  assert.deepEqual([snapshot.providerSession, snapshot.model.reason], ['mismatch', 'provider-session-missing']);
});

test('a change is noticed by the poll too, so the screen drops the value without anyone asking for a snapshot', (t) => {
  const { runtime, start, write } = providerSessionFixture(t);
  const file = start('session-a');
  const seen = [];
  t.after(runtime.onDidChange((id) => seen.push(id)).dispose);
  write(file, 1, 'claude-own-1');
  runtime.poll();
  write(file, 2, 'claude-own-2');
  runtime.poll();
  assert.equal(seen.length, 2);
  assert.equal(runtime.core.snapshot('session-a', NOW).model.reason, 'provider-session-changed', 'withdrawn by the poll itself');
});

test('the mapping belongs to one managed session: reopening starts clean, and two sessions never share an id', (t) => {
  const { runtime, start, write } = providerSessionFixture(t);
  const first = start('session-a');
  write(first, 1, 'claude-own-1');
  runtime.snapshot('session-a', NOW);
  write(first, 2, 'claude-own-2');
  assert.equal(runtime.snapshot('session-a', NOW).providerSession, 'mismatch');
  runtime.release('session-a');
  const reopened = start('session-b');
  write(reopened, 1, 'claude-own-2');
  assert.deepEqual([runtime.snapshot('session-b', NOW).providerSession, runtime.snapshot('session-b', NOW).model.confidence], ['bound', 'actual']);
});

test('a malformed provider session id makes the record unreadable instead of being trusted', (t) => {
  const { runtime, start, write } = providerSessionFixture(t);
  const file = start('session-a');
  for (const bad of ['', '../x', 'a b', 'x'.repeat(200), 5, null]) {
    write(file, 1, bad);
    assert.equal(readRecord(file), null, JSON.stringify(bad));
  }
  assert.equal(runtime.snapshot('session-a', NOW).model.confidence, 'unknown');
});
