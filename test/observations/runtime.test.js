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

test('runtime binds a sanitized Codex notification record in CODEX_HOME and derives working and waiting states while usage stays unknown', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runtime-working-'));
  try {
    const runtime = new SessionObservationRuntime({ now: () => NOW, ttlMs: 1000 });
    const prepared = runtime.prepare({
      sessionId: 'codex-1', provider: 'codex', accountProfileId: 'account-1',
      env: { CODEX_HOME: root }
    });
    assert.equal(prepared.active, true);
    assert.equal(prepared.env.MULTIAGENT_CODEX_SESSION_ID, 'codex-1');

    const file = observationPath(root, 'codex-1');
    fs.mkdirSync(path.dirname(file), { recursive: true });

    // Active with empty activeFlags -> working
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 1, eventId: 'event-1', observedAt: NOW, sequence: 1,
      threadId: 'thr_1',
      notification: {
        method: 'thread/status/changed',
        params: { threadId: 'thr_1', status: { type: 'active', activeFlags: [] } }
      }
    }));
    const [workingSession] = runtime.enrich([{ id: 'codex-1', accountProfileId: 'account-1' }], NOW);
    assert.equal(workingSession.providerObservation.status.value, 'working');
    assert.equal(workingSession.providerObservation.status.confidence, 'actual');
    assert.equal(workingSession.providerObservation.status.source, 'codex-app-server-v2');
    assert.equal(workingSession.providerObservation.providerSession, 'bound');
    assert.equal(workingSession.providerObservation.model.confidence, 'unknown');
    assert.equal(workingSession.providerObservation.usage.every(u => u.confidence === 'unknown'), true);

    // Active with waitingOnApproval -> waiting
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 1, eventId: 'event-2', observedAt: NOW, sequence: 2,
      threadId: 'thr_1',
      notification: {
        method: 'thread/status/changed',
        params: { threadId: 'thr_1', status: { type: 'active', activeFlags: ['waitingOnApproval'] } }
      }
    }));
    const waitingSnapshot = runtime.snapshot('codex-1', NOW);
    assert.equal(waitingSnapshot.status.value, 'waiting');
    assert.equal(waitingSnapshot.status.confidence, 'actual');

    // Active with waitingOnUserInput -> waiting
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 1, eventId: 'event-3', observedAt: NOW, sequence: 3,
      threadId: 'thr_1',
      notification: {
        method: 'thread/status/changed',
        params: { threadId: 'thr_1', status: { type: 'active', activeFlags: ['waitingOnUserInput'] } }
      }
    }));
    assert.equal(runtime.snapshot('codex-1', NOW).status.value, 'waiting');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime ingests direct Codex app-server notification, updates state, and notifies listeners', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runtime-direct-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = new SessionObservationRuntime({ now: () => NOW, ttlMs: 1000 });
  t.after(() => runtime.dispose());

  runtime.prepare({
    sessionId: 'codex-s1', provider: 'codex', accountProfileId: 'account-1',
    env: { CODEX_HOME: root }
  });

  const events = [];
  t.after(runtime.onDidChange((id) => events.push(id)).dispose);

  const res = runtime.ingestCodexNotification('codex-s1', {
    method: 'thread/status/changed',
    params: { threadId: 'thr_alpha', status: { type: 'active', activeFlags: [] } }
  });
  assert.equal(res.ok, true);
  assert.equal(events.length, 1);
  assert.equal(events[0], 'codex-s1');

  const snapshot = runtime.snapshot('codex-s1', NOW);
  assert.equal(snapshot.status.value, 'working');
  assert.equal(snapshot.status.confidence, 'actual');
  assert.equal(snapshot.providerSession, 'bound');
});

test('Codex thread binding mismatch retracts session evidence and makes state unknown', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runtime-mismatch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = new SessionObservationRuntime({ now: () => NOW, ttlMs: 1000 });
  t.after(() => runtime.dispose());

  runtime.prepare({
    sessionId: 'codex-s1', provider: 'codex', accountProfileId: 'account-1',
    env: { CODEX_HOME: root }, threadId: 'thr_fixed'
  });

  const resWrong = runtime.ingestCodexNotification('codex-s1', {
    method: 'thread/status/changed',
    params: { threadId: 'thr_different', status: { type: 'active', activeFlags: [] } }
  });
  assert.equal(resWrong.ok, false);
  assert.equal(resWrong.reason, 'thread-binding-mismatch');

  const snapshot = runtime.snapshot('codex-s1', NOW);
  assert.equal(snapshot.status.confidence, 'unknown');
  assert.equal(snapshot.status.reason, 'thread-binding-mismatch');
  assert.equal(snapshot.providerSession, 'mismatch');

  // Even if the original thread is sent afterwards, it is refused and remains retracted
  const resOriginal = runtime.ingestCodexNotification('codex-s1', {
    method: 'thread/status/changed',
    params: { threadId: 'thr_fixed', status: { type: 'active', activeFlags: [] } }
  });
  assert.equal(resOriginal.ok, false);
  assert.equal(runtime.snapshot('codex-s1', NOW).status.confidence, 'unknown');
});

test('Codex non-observable status types (idle, systemError) fail closed without changing state to working or completed', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runtime-idle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = new SessionObservationRuntime({ now: () => NOW, ttlMs: 1000 });
  t.after(() => runtime.dispose());

  runtime.prepare({
    sessionId: 'codex-s1', provider: 'codex', accountProfileId: 'account-1',
    env: { CODEX_HOME: root }, threadId: 'thr_1'
  });

  // idle status type
  const idleRes = runtime.ingestCodexNotification('codex-s1', {
    method: 'thread/status/changed',
    params: { threadId: 'thr_1', status: { type: 'idle' } }
  });
  assert.equal(idleRes.ok, false);
  assert.equal(idleRes.reason, 'codex-state-unknown');
  assert.equal(runtime.snapshot('codex-s1', NOW).status.confidence, 'unknown');

  // systemError status type
  const errRes = runtime.ingestCodexNotification('codex-s1', {
    method: 'thread/status/changed',
    params: { threadId: 'thr_1', status: { type: 'systemError' } }
  });
  assert.equal(errRes.ok, false);
  assert.equal(errRes.reason, 'codex-state-unknown');
  assert.equal(runtime.snapshot('codex-s1', NOW).status.confidence, 'unknown');
});

test('Codex observation ages out to stale after ttlMs and poll notifies once', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runtime-expire-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let clock = Date.parse(NOW);
  const runtime = new SessionObservationRuntime({ ttlMs: 10_000, nowMs: () => clock, now: () => new Date(clock).toISOString() });
  t.after(() => runtime.dispose());

  runtime.prepare({
    sessionId: 'codex-s1', provider: 'codex', accountProfileId: 'account-1',
    env: { CODEX_HOME: root }, threadId: 'thr_1'
  });

  const file = observationPath(root, 'codex-s1');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1, eventId: 'event-1', observedAt: new Date(clock).toISOString(), sequence: 1,
    threadId: 'thr_1',
    notification: {
      method: 'thread/status/changed',
      params: { threadId: 'thr_1', status: { type: 'active', activeFlags: [] } }
    }
  }));

  const events = [];
  t.after(runtime.onDidChange((id) => events.push(id)).dispose);
  runtime.poll();
  assert.equal(events.length, 1);
  assert.equal(runtime.snapshot('codex-s1', new Date(clock).toISOString()).status.value, 'working');

  // Advance clock within TTL
  clock += 9_000;
  runtime.poll();
  assert.equal(events.length, 1);

  // Advance clock beyond TTL
  clock += 2_000;
  runtime.poll();
  assert.equal(events.length, 2, 'expired poll notification fired');
  const aged = runtime.snapshot('codex-s1', new Date(clock).toISOString());
  assert.equal(aged.status.confidence, 'unknown');
  assert.equal(aged.status.reason, 'stale');
});

test('Codex unassigned account profile or session without thread/notification stays unbound and unknown', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runtime-unbound-'));
  try {
    const runtime = new SessionObservationRuntime({ now: () => NOW });
    // unassigned account
    const unassigned = runtime.prepare({
      sessionId: 'codex-u', provider: 'codex', accountProfileId: 'unassigned', env: { CODEX_HOME: root }
    });
    assert.equal(unassigned.active, false);
    assert.equal(runtime.snapshot('codex-u'), null);

    // assigned account but no thread/notification yet
    const assigned = runtime.prepare({
      sessionId: 'codex-a', provider: 'codex', accountProfileId: 'acct-1', env: { CODEX_HOME: root }
    });
    assert.equal(assigned.active, true);
    const snap = runtime.snapshot('codex-a', NOW);
    assert.equal(snap.providerSession, 'unbound');
    assert.equal(snap.status.confidence, 'unknown');
    assert.equal(snap.status.reason, 'not-observed');
    assert.equal(snap.model.confidence, 'unknown');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('two Codex sessions with different accounts and threads remain strictly isolated', (t) => {
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-isolated-a-'));
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-isolated-b-'));
  t.after(() => {
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  });
  const runtime = new SessionObservationRuntime({ now: () => NOW, ttlMs: 10_000 });
  t.after(() => runtime.dispose());

  runtime.prepare({ sessionId: 'codex-1', provider: 'codex', accountProfileId: 'account-1', env: { CODEX_HOME: rootA }, threadId: 'thr_1' });
  runtime.prepare({ sessionId: 'codex-2', provider: 'codex', accountProfileId: 'account-2', env: { CODEX_HOME: rootB }, threadId: 'thr_2' });

  runtime.ingestCodexNotification('codex-1', {
    method: 'thread/status/changed', params: { threadId: 'thr_1', status: { type: 'active', activeFlags: [] } }
  });
  runtime.ingestCodexNotification('codex-2', {
    method: 'thread/status/changed', params: { threadId: 'thr_2', status: { type: 'active', activeFlags: ['waitingOnApproval'] } }
  });

  const snap1 = runtime.snapshot('codex-1', NOW);
  const snap2 = runtime.snapshot('codex-2', NOW);

  assert.equal(snap1.status.value, 'working');
  assert.equal(snap1.accountProfileId, 'account-1');
  assert.equal(snap2.status.value, 'waiting');
  assert.equal(snap2.accountProfileId, 'account-2');
});

