'use strict';

// Hook records as the hook bridge writes them, applied through the runtime and the existing Claude hook path.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SessionObservationRuntime, observationPath, readRecord, sweepStale, STALE_MS } = require('../../src/observations/runtime');

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const iso = (offsetMs) => new Date(T0 + offsetMs).toISOString();
let counter = 0;

function setup(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-hooks-'));
  const clock = { ms: T0 };
  const runtime = new SessionObservationRuntime({ now: () => new Date(clock.ms).toISOString(), nowMs: () => clock.ms, ttlMs: 30_000, ...options });
  runtime.prepare({ sessionId: 'session-a', provider: 'claude', accountProfileId: 'account-a', env: { CLAUDE_CONFIG_DIR: root } });
  const hookFile = observationPath(root, 'session-a', 'hook');
  const statusFile = observationPath(root, 'session-a');
  fs.mkdirSync(path.dirname(hookFile), { recursive: true });
  const hook = (eventName, at, { id = 'abc123', sequence = T0 + at, eventId, noId = false } = {}) => {
    counter += 1;
    const record = { schemaVersion: 1, eventId: eventId ?? `h-${counter}`, observedAt: iso(at), sequence };
    if (!noId) record.providerSessionId = id;
    record.hook = { hookEventName: eventName };
    fs.writeFileSync(hookFile, JSON.stringify(record));
  };
  const status = (at, { id = 'abc123', model = 'claude-sonnet-4-5', cost } = {}) => {
    counter += 1;
    const statusLine = { model: { id: model } };
    if (cost !== undefined) statusLine.cost = { total_cost_usd: cost };
    const record = { schemaVersion: 1, eventId: `s-${counter}`, observedAt: iso(at), sequence: T0 + at, statusLine };
    if (id !== undefined) record.providerSessionId = id;
    fs.writeFileSync(statusFile, JSON.stringify(record));
  };
  const at = (offsetMs) => { clock.ms = T0 + offsetMs; return iso(offsetMs); };
  return { root, runtime, hook, status, at, clock, hookFile, statusFile, cleanup: () => { runtime.dispose(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('hook events become working, waiting and ended with source and time, and age out to unknown', () => {
  const ctx = setup();
  try {
    for (const [event, state] of [['UserPromptSubmit', 'working'], ['PreToolUse', 'working'], ['PostToolUse', 'working'], ['Notification', 'waiting'], ['Stop', 'waiting']]) {
      const ctx2 = setup();
      try {
        ctx2.hook(event, 1000);
        const snap = ctx2.runtime.snapshot('session-a', ctx2.at(2000));
        assert.equal(snap.status.value, state, event);
        assert.equal(snap.status.confidence, 'actual');
        assert.equal(snap.status.source, 'claude-hook-v1');
        assert.equal(snap.status.observedAt, iso(1000));
        assert.equal(snap.providerSession, 'bound');
      } finally { ctx2.cleanup(); }
    }
    ctx.hook('SessionEnd', 1000);
    assert.equal(ctx.runtime.snapshot('session-a', ctx.at(2000)).status.value, 'ended');
    const stale = ctx.runtime.snapshot('session-a', ctx.at(1000 + 30_001));
    assert.equal(stale.status.confidence, 'unknown');
    assert.equal(stale.status.reason, 'stale');
  } finally { ctx.cleanup(); }
});

test('no hook record means unknown, never working', () => {
  const ctx = setup();
  try {
    const snap = ctx.runtime.snapshot('session-a', ctx.at(1000));
    assert.equal(snap.status.confidence, 'unknown');
    assert.equal(snap.status.value ?? null, null);
  } finally { ctx.cleanup(); }
});

test('Stop followed by a late PreToolUse is not stuck on working beyond the observation TTL', () => {
  const ctx = setup();
  try {
    ctx.hook('Stop', 1000);
    assert.equal(ctx.runtime.snapshot('session-a', ctx.at(1500)).status.value, 'waiting');
    ctx.hook('PreToolUse', 900, { sequence: T0 + 900 });
    const late = ctx.runtime.snapshot('session-a', ctx.at(1600));
    // The late event is older than the Stop that was already accepted: it must not replace it.
    assert.equal(late.status.value, 'waiting');
    // And even a newer late PreToolUse shows working only while fresh.
    ctx.hook('PreToolUse', 2000);
    assert.equal(ctx.runtime.snapshot('session-a', ctx.at(2100)).status.value, 'working');
    const expired = ctx.runtime.snapshot('session-a', ctx.at(2000 + 30_001));
    assert.equal(expired.status.confidence, 'unknown');
    assert.equal(expired.status.reason, 'stale');
  } finally { ctx.cleanup(); }
});

test('duplicate and out-of-order hook records do not change the state', () => {
  const ctx = setup();
  try {
    ctx.hook('UserPromptSubmit', 3000, { eventId: 'same' });
    assert.equal(ctx.runtime.snapshot('session-a', ctx.at(3100)).status.value, 'working');
    ctx.hook('Stop', 3000, { eventId: 'same' });
    assert.equal(ctx.runtime.snapshot('session-a', ctx.at(3200)).status.value, 'working', 'a repeated event id is a duplicate');
    ctx.hook('Stop', 2000, { eventId: 'older', sequence: T0 + 2000 });
    assert.equal(ctx.runtime.snapshot('session-a', ctx.at(3300)).status.value, 'working', 'an older event cannot replace a newer one');
    ctx.hook('Stop', 4000, { eventId: 'newer', sequence: T0 + 3000 });
    assert.equal(ctx.runtime.snapshot('session-a', ctx.at(4100)).status.value, 'working', 'a lower sequence is out of order even with a later time');
    ctx.hook('Stop', 4000, { eventId: 'newest', sequence: T0 + 4000 });
    assert.equal(ctx.runtime.snapshot('session-a', ctx.at(4200)).status.value, 'waiting');
  } finally { ctx.cleanup(); }
});

test('a hook event from the future is refused', () => {
  const ctx = setup();
  try {
    ctx.hook('Stop', 60_000);
    assert.equal(ctx.runtime.snapshot('session-a', ctx.at(1000)).status.confidence, 'unknown');
  } finally { ctx.cleanup(); }
});

test('an ended session cannot be revived by a later hook event', () => {
  const ctx = setup();
  try {
    ctx.hook('SessionEnd', 1000);
    assert.equal(ctx.runtime.snapshot('session-a', ctx.at(1100)).status.value, 'ended');
    ctx.hook('UserPromptSubmit', 2000);
    assert.equal(ctx.runtime.snapshot('session-a', ctx.at(2100)).status.value, 'ended');
  } finally { ctx.cleanup(); }
});

test('a hook record for another CLI session withdraws all evidence, status line included', () => {
  const ctx = setup();
  try {
    ctx.status(500, { cost: 0.5 });
    ctx.hook('UserPromptSubmit', 1000, { id: 'abc123' });
    let snap = ctx.runtime.snapshot('session-a', ctx.at(1100));
    assert.equal(snap.status.value, 'working');
    assert.equal(snap.model.value, 'claude-sonnet-4-5');
    ctx.hook('Stop', 2000, { id: 'other-session' });
    snap = ctx.runtime.snapshot('session-a', ctx.at(2100));
    assert.equal(snap.providerSession, 'mismatch');
    assert.equal(snap.status.confidence, 'unknown');
    assert.equal(snap.model.confidence, 'unknown');
    // For good: the original id coming back does not restore anything.
    ctx.hook('Stop', 3000, { id: 'abc123' });
    assert.equal(ctx.runtime.snapshot('session-a', ctx.at(3100)).status.confidence, 'unknown');
  } finally { ctx.cleanup(); }
});

test('a status-line record for another CLI session also withdraws hook evidence', () => {
  const ctx = setup();
  try {
    ctx.hook('PreToolUse', 1000);
    assert.equal(ctx.runtime.snapshot('session-a', ctx.at(1100)).status.value, 'working');
    ctx.status(1500, { id: 'someone-else' });
    const snap = ctx.runtime.snapshot('session-a', ctx.at(1600));
    assert.equal(snap.providerSession, 'mismatch');
    assert.equal(snap.status.confidence, 'unknown');
  } finally { ctx.cleanup(); }
});

test('a hook record without a session id is refused', () => {
  const ctx = setup();
  try {
    ctx.hook('Stop', 1000, { noId: true });
    assert.equal(ctx.runtime.snapshot('session-a', ctx.at(1100)).status.confidence, 'unknown');
  } finally { ctx.cleanup(); }
});

test('hook state and status-line model and cost live side by side without overwriting each other', () => {
  const ctx = setup();
  try {
    ctx.hook('UserPromptSubmit', 1000);
    ctx.status(1500, { cost: 0.25 });
    // A newer status-line refresh must not make the older hook event look out of order, nor drop it.
    ctx.status(2000, { cost: 0.3 });
    ctx.hook('PreToolUse', 1800);
    let snap = ctx.runtime.snapshot('session-a', ctx.at(2100));
    assert.equal(snap.status.value, 'working');
    assert.equal(snap.model.value, 'claude-sonnet-4-5');
    assert.equal(snap.usage.find((entry) => entry.field === 'usage.cost_usd').value, 0.3);
    // A hook event after the status line keeps what the status line reported.
    ctx.hook('Stop', 2200);
    snap = ctx.runtime.snapshot('session-a', ctx.at(2300));
    assert.equal(snap.status.value, 'waiting');
    assert.equal(snap.model.value, 'claude-sonnet-4-5');
    assert.equal(snap.usage.find((entry) => entry.field === 'usage.cost_usd').value, 0.3);
  } finally { ctx.cleanup(); }
});

test('hook record validation is strict: extra keys, other events, a status line inside, and a hook inside a status-line file', () => {
  const ctx = setup();
  try {
    const good = { schemaVersion: 1, eventId: 'e', observedAt: iso(0), sequence: 1, providerSessionId: 'abc123', hook: { hookEventName: 'Stop' } };
    fs.writeFileSync(ctx.hookFile, JSON.stringify(good));
    assert.ok(readRecord(ctx.hookFile, 'hook'));
    const bad = [
      { ...good, hook: { hookEventName: 'Stop', cwd: '/x' } },
      { ...good, hook: { hookEventName: 'SessionStart' } },
      { ...good, hook: { hookEventName: 'Stop', transcript_path: 'x' } },
      { ...good, hook: 'Stop' },
      { ...good, hook: {} },
      { ...good, transcript_path: '/x' },
      { ...good, cwd: '/x' },
      { ...good, statusLine: { model: { id: 'm' } } },
      { ...good, providerSessionId: '../x' },
      { ...good, providerSessionId: undefined },
      { ...good, schemaVersion: 2 },
      { ...good, sequence: 1.5 },
      { ...good, hook: { hookEventName: '__proto__' } }
    ];
    for (const record of bad) {
      fs.writeFileSync(ctx.hookFile, JSON.stringify(record));
      assert.equal(readRecord(ctx.hookFile, 'hook'), null, JSON.stringify(record));
    }
    fs.writeFileSync(ctx.statusFile, JSON.stringify(good));
    assert.equal(readRecord(ctx.statusFile, 'statusLine'), null, 'a hook record is not a status-line record');
    fs.writeFileSync(ctx.hookFile, JSON.stringify({ schemaVersion: 1, eventId: 'e', observedAt: iso(0), sequence: 1, providerSessionId: 'abc123', statusLine: { model: { id: 'm' } } }));
    assert.equal(readRecord(ctx.hookFile, 'hook'), null, 'a status-line record is not a hook record');
  } finally { ctx.cleanup(); }
});

test('the hook record is read with the same safe read: oversized files and links are refused', { skip: process.platform === 'win32' }, () => {
  const ctx = setup();
  try {
    fs.writeFileSync(ctx.hookFile, JSON.stringify({ schemaVersion: 1, eventId: 'e', observedAt: iso(0), sequence: 1, providerSessionId: 'abc123', hook: { hookEventName: 'Stop' }, pad: 'x'.repeat(9000) }));
    assert.equal(readRecord(ctx.hookFile, 'hook'), null);
    const real = path.join(ctx.root, 'real.json');
    fs.writeFileSync(real, JSON.stringify({ schemaVersion: 1, eventId: 'e', observedAt: iso(0), sequence: 1, providerSessionId: 'abc123', hook: { hookEventName: 'Stop' } }));
    fs.rmSync(ctx.hookFile);
    fs.symlinkSync(real, ctx.hookFile);
    assert.equal(readRecord(ctx.hookFile, 'hook'), null);
  } finally { ctx.cleanup(); }
});

test('a hook write is noticed by the poll and its expiry is announced', () => {
  const ctx = setup();
  try {
    const seen = [];
    ctx.runtime.onDidChange((id) => seen.push(id));
    ctx.runtime.poll();
    assert.deepEqual(seen, []);
    ctx.hook('PreToolUse', 1000);
    ctx.at(1100);
    ctx.runtime.poll();
    assert.deepEqual(seen, ['session-a']);
    ctx.at(1000 + 30_001);
    ctx.runtime.poll();
    assert.deepEqual(seen, ['session-a', 'session-a']);
    ctx.runtime.poll();
    assert.equal(seen.length, 2);
  } finally { ctx.cleanup(); }
});

test('release and prepare remove stale hook files, and the sweep removes old hook records and temporaries only', () => {
  const ctx = setup();
  try {
    ctx.hook('Stop', 1000);
    ctx.runtime.release('session-a');
    assert.equal(fs.existsSync(ctx.hookFile), false);
    const dir = path.dirname(ctx.hookFile);
    const old = new Date(T0 - 2 * STALE_MS);
    const good = JSON.stringify({ schemaVersion: 1, eventId: 'e', observedAt: iso(0), sequence: 1, providerSessionId: 'abc123', hook: { hookEventName: 'Stop' } });
    for (const [name, text] of [['old-1.hook.json', good], ['old-2.hook.json.tmp.1234', 'x'], ['unrelated.hook.json', 'not a record']]) {
      fs.writeFileSync(path.join(dir, name), text);
      fs.utimesSync(path.join(dir, name), old, old);
    }
    sweepStale(dir, T0);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['unrelated.hook.json']);
  } finally { ctx.cleanup(); }
});

// ---- delivery state: what the CLI last said, for typing a broadcast into it (issue #295) ----
const { DELIVERY_STATE_MAX_MS } = require('../../src/observations/runtime');
const delivery = (setup) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-delivery-state-'));
  const t0 = Date.parse('2026-01-01T00:00:00.000Z');
  let now = t0;
  const runtime = new SessionObservationRuntime({ nowMs: () => now, now: () => new Date(now).toISOString() });
  runtime.prepare({ sessionId: 'session-a', provider: 'claude', accountProfileId: 'account-a', env: { CLAUDE_CONFIG_DIR: root } });
  const file = observationPath(root, 'session-a', 'hook');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let sequence = 0;
  const hook = (hookEventName, { at = now, providerSessionId = 'claude-session-1' } = {}) => {
    sequence += 1;
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, eventId: `e${sequence}`, observedAt: new Date(at).toISOString(), sequence, providerSessionId, hook: { hookEventName } }));
  };
  try { return setup({ runtime, hook, advance: (ms) => { now += ms; }, t0, root, clock: () => now }); } finally { fs.rmSync(root, { recursive: true, force: true }); }
};

test('an idle agent stays waiting after the 30-second display lifetime, until the next hook event', () => {
  delivery(({ runtime, hook, advance }) => {
    assert.deepEqual(runtime.deliveryState('session-a'), { state: 'unknown', reason: 'no-hook-event', since: null }, 'before any hook event');
    hook('Stop');
    assert.equal(runtime.deliveryState('session-a').state, 'waiting');
    advance(31_000);
    assert.equal(runtime.deliveryState('session-a').state, 'waiting', 'still waiting after the 30 seconds the display lifetime allows');
    assert.equal(runtime.snapshot('session-a', new Date(Date.parse('2026-01-01T00:00:00.000Z') + 31_000).toISOString()).status.confidence, 'unknown', 'the display lifetime is unchanged');
    advance(3 * 60 * 60 * 1000);
    assert.equal(runtime.deliveryState('session-a').state, 'waiting', 'hours later, still waiting');
    hook('UserPromptSubmit');
    assert.equal(runtime.deliveryState('session-a').state, 'working', 'the next hook event replaces it');
    hook('Notification');
    assert.equal(runtime.deliveryState('session-a').state, 'waiting');
    hook('PreToolUse');
    assert.equal(runtime.deliveryState('session-a').state, 'working');
    hook('SessionEnd');
    assert.equal(runtime.deliveryState('session-a').state, 'ended');
  });
});

test('after twelve hours the last hook event no longer says anything, and a time in the future is not believed', () => {
  delivery(({ runtime, hook, advance, clock }) => {
    hook('Stop');
    advance(DELIVERY_STATE_MAX_MS - 1000);
    assert.equal(runtime.deliveryState('session-a').state, 'waiting');
    advance(2000);
    assert.deepEqual(runtime.deliveryState('session-a'), { state: 'unknown', reason: 'hook-event-too-old', since: null });
    hook('Stop', { at: clock() + 10 * 60 * 1000 });
    assert.equal(runtime.deliveryState('session-a').reason, 'hook-event-unusable');
  });
});

test('a hook record of another CLI session, a released terminal and a provider with no hook source give no state', () => {
  delivery(({ runtime, hook }) => {
    hook('Stop', { providerSessionId: 'claude-session-1' });
    assert.equal(runtime.deliveryState('session-a').state, 'waiting');
    hook('Stop', { providerSessionId: 'claude-session-2' });
    assert.equal(runtime.deliveryState('session-a').reason, 'provider-session-mismatch', 'the same terminal now running another session is not trusted');
    runtime.release('session-a');
    assert.deepEqual(runtime.deliveryState('session-a'), { state: 'unknown', reason: 'no-hook-bridge', since: null }, 'a closed terminal has no state');
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-delivery-codex-'));
  try {
    const runtime = new SessionObservationRuntime({});
    runtime.prepare({ sessionId: 'codex-a', provider: 'codex', accountProfileId: 'account-a', env: { CLAUDE_CONFIG_DIR: root } });
    assert.equal(runtime.deliveryState('codex-a').reason, 'no-verified-event-source');
    assert.equal(runtime.deliveryState('never-seen').reason, 'no-hook-bridge');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('enrich carries the delivery state next to the observation, for every session', () => {
  delivery(({ runtime, hook, clock }) => {
    hook('Stop');
    const [enriched] = runtime.enrich([{ id: 'session-a', accountProfileId: 'account-a' }], new Date(clock()).toISOString());
    assert.equal(enriched.deliveryState.state, 'waiting');
    assert.ok('providerObservation' in enriched);
  });
});

test('the permission mode the CLI reports is read from its hook record, under the same binding and age rules (#362)', () => {
  const { runtime, at, hookFile, cleanup } = setup();
  try {
    const write = (hook, offset, id = 'abc123') => fs.writeFileSync(hookFile, JSON.stringify({ schemaVersion: 1, eventId: `p-${offset}`, observedAt: iso(offset), sequence: T0 + offset, providerSessionId: id, hook }));
    assert.equal(runtime.permissionMode('session-a'), null, 'nothing reported yet');
    write({ hookEventName: 'PreToolUse' }, 0);
    assert.equal(runtime.permissionMode('session-a'), null, 'an event without a mode says nothing about it');
    write({ hookEventName: 'PreToolUse', permissionMode: 'default' }, 1000);
    at(2000);
    assert.deepEqual(runtime.permissionMode('session-a'), { mode: 'default', since: iso(1000) });
    write({ hookEventName: 'PreToolUse', permissionMode: 'made-up' }, 3000);
    assert.equal(runtime.permissionMode('session-a'), null, 'an undocumented mode makes the record unreadable');
    assert.equal(readRecord(hookFile, 'hook'), null);
    write({ hookEventName: 'PreToolUse', permissionMode: 'auto', extra: 1 }, 4000);
    assert.equal(readRecord(hookFile, 'hook'), null, 'no other field is accepted');
    write({ hookEventName: 'Stop', permissionMode: 'auto' }, 5000);
    at(5000 + 13 * 60 * 60 * 1000);
    assert.equal(runtime.permissionMode('session-a'), null, 'too old');
    at(6000);
    write({ hookEventName: 'Stop', permissionMode: 'auto' }, 6000, 'another-cli');
    assert.equal(runtime.permissionMode('session-a'), null, 'another CLI session is not this one');
    assert.equal(runtime.permissionMode('no-such-session'), null);
  } finally { cleanup(); }
});
