'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isGateEligible } = require('../../src/accounts/observation');
const { SessionObservationCore, SCHEMA_VERSION, USAGE_FIELDS } = require('../../src/observations/session');
const { createClaudeSessionEvidenceAdapter, CLAUDE_SOURCE } = require('../../src/observations/claude');

const START = '2026-01-01T00:00:00.000Z';
const binding = { sessionId: 'session-a', provider: 'claude', accountProfileId: 'account-a' };

function setup(ttlMs = 1000) {
  let now = Date.parse(START);
  const core = new SessionObservationCore({ now: () => new Date(now).toISOString(), ttlMs });
  core.register(binding);
  const adapter = createClaudeSessionEvidenceAdapter({ core, sessionId: binding.sessionId, accountProfileId: binding.accountProfileId });
  const advance = ms => { now += ms; };
  return { core, adapter, advance, now: () => new Date(now).toISOString() };
}

const evidence = (extra = {}) => ({
  eventId: 'event-1', observedAt: START, sequence: 1, state: 'working', usage: [], ...extra
});

function byField(snapshot) {
  return Object.fromEntries(snapshot.usage.map(item => [item.field, item]));
}

test('without provider evidence every state and usage field is explicitly unknown', () => {
  const { core } = setup();
  const value = core.snapshot('session-a', START);
  assert.equal(value.status.value, null);
  assert.equal(value.status.confidence, 'unknown');
  assert.equal(value.status.reason, 'not-observed');
  assert.deepEqual([value.model.field, value.model.confidence, value.model.reason], ['session.model', 'unknown', 'not-observed']);
  assert.deepEqual(value.usage.map(item => item.field), USAGE_FIELDS);
  assert.equal(value.usage.every(item => item.confidence === 'unknown'), true);
});

test('structured Claude evidence carries model, source, time, freshness and fixed binding', () => {
  const { core, adapter } = setup();
  assert.deepEqual(adapter.accept(evidence({ model: 'documented-model-id' })), { ok: true, reason: 'accepted', accepted: true });
  const value = core.snapshot('session-a', START);
  assert.deepEqual([value.status.value, value.status.source, value.status.observedAt, value.freshness],
    ['working', CLAUDE_SOURCE, START, 'fresh']);
  assert.deepEqual([value.provider, value.accountProfileId], ['claude', 'account-a']);
  assert.deepEqual([value.model.value, value.model.source, value.model.confidence], ['documented-model-id', CLAUDE_SOURCE, 'actual']);
});

test('model-only status-line evidence stays useful without inventing a provider state', () => {
  const { core, adapter } = setup();
  assert.deepEqual(adapter.accept({
    eventId: 'status-1', observedAt: START, sequence: 1,
    statusLine: { model: { id: 'claude-sonnet-4-5' }, cost: { total_cost_usd: 0.25 } }
  }), { ok: true, reason: 'accepted', accepted: true });
  const value = core.snapshot('session-a', START);
  assert.deepEqual([value.status.confidence, value.status.reason], ['unknown', 'not-reported']);
  assert.deepEqual([value.model.value, value.model.confidence, value.freshness], ['claude-sonnet-4-5', 'actual', 'fresh']);
  assert.equal(byField(value)['usage.cost_usd'].confidence, 'estimated');
});

test('expired state and usage become unknown instead of being carried forward', () => {
  const { core, adapter, advance, now } = setup();
  adapter.accept(evidence({ model: 'documented-model-id', usage: [{ field: 'usage.input_tokens', value: 12, measurement: 'actual', scope: 'session-cumulative' }] }));
  advance(1000);
  const value = core.snapshot('session-a', now());
  assert.deepEqual([value.status.confidence, value.status.reason, value.freshness], ['unknown', 'stale', 'stale']);
  assert.deepEqual([value.model.confidence, value.model.reason], ['unknown', 'stale']);
  assert.deepEqual([byField(value)['usage.input_tokens'].confidence, byField(value)['usage.input_tokens'].reason], ['unknown', 'stale']);
});

test('actual and estimated usage stay distinct; only fresh actual observations may gate', () => {
  const { core, adapter } = setup();
  adapter.accept(evidence({ usage: [
    { field: 'usage.input_tokens', value: 20, measurement: 'actual', scope: 'session-cumulative' },
    { field: 'usage.cost_usd', value: 0.02, measurement: 'estimated', scope: 'local-estimate' }
  ] }));
  const usage = byField(core.snapshot('session-a', START));
  assert.deepEqual([usage['usage.input_tokens'].confidence, usage['usage.input_tokens'].unit], ['actual', 'tokens']);
  assert.deepEqual([usage['usage.cost_usd'].confidence, usage['usage.cost_usd'].unit], ['estimated', 'usd']);
  assert.equal(usage['usage.cost_usd'].source, `${CLAUDE_SOURCE}.local-estimate`);
  assert.equal(isGateEligible(usage['usage.input_tokens'], START), true);
  assert.equal(isGateEligible(usage['usage.cost_usd'], START), false);
  assert.equal(usage['usage.output_tokens'].reason, 'not-reported');
});

test('duplicate events are idempotent and out-of-order evidence cannot replace newer state', () => {
  const { core, adapter } = setup();
  assert.equal(adapter.accept(evidence()).reason, 'accepted');
  assert.deepEqual(adapter.accept(evidence({ state: 'waiting' })), { ok: true, reason: 'duplicate', accepted: false });
  assert.equal(adapter.accept(evidence({ eventId: 'event-0', sequence: 0, state: 'waiting' })).reason, 'out-of-order');
  assert.equal(core.snapshot('session-a', START).status.value, 'working');
});

test('a higher sequence with an older timestamp is rejected atomically', () => {
  const { core, adapter, advance } = setup();
  advance(1000);
  adapter.accept(evidence({ observedAt: '2026-01-01T00:00:01.000Z' }));
  const rejected = adapter.accept(evidence({ eventId: 'event-2', sequence: 2, observedAt: START, state: 'waiting' }));
  assert.equal(rejected.reason, 'out-of-order');
  assert.equal(core.snapshot('session-a', '2026-01-01T00:00:01.000Z').status.value, 'working');
});

test('schema changes, future events, binding mismatches and malformed usage fail closed', () => {
  const { core, adapter } = setup();
  assert.equal(core.ingest({ ...evidence(), schemaVersion: 2, sessionId: 'session-a', provider: 'claude', accountProfileId: 'account-a', source: 'x' }).reason, 'schema-unsupported');
  assert.equal(adapter.accept(evidence({ observedAt: '2026-01-01T00:00:01.000Z' })).reason, 'future-event');
  assert.equal(core.ingest({ ...evidence(), schemaVersion: SCHEMA_VERSION, sessionId: 'session-a', provider: 'claude', accountProfileId: 'account-b', source: 'x' }).reason, 'binding-mismatch');
  assert.equal(adapter.accept(evidence({ usage: [{ field: 'usage.input_tokens', value: -1, measurement: 'actual', scope: 'turn' }] })).reason, 'usage-invalid');
  assert.equal(adapter.accept(evidence({ eventId: 'event-2', sequence: 2, usage: [{ field: 'usage.input_tokens', value: 1, measurement: 'actual', scope: '/private/path' }] })).reason, 'usage-invalid');
  assert.equal(core.snapshot('session-a', START).status.reason, 'not-observed');
});

test('ending a session is observable, and later events cannot revive it', () => {
  const { core, adapter } = setup();
  assert.equal(adapter.accept(evidence({ state: 'ended' })).reason, 'accepted');
  assert.equal(core.snapshot('session-a', START).status.value, 'ended');
  assert.equal(adapter.accept(evidence({ eventId: 'event-2', sequence: 2, state: 'working' })).reason, 'session-ended');
  assert.equal(core.snapshot('session-a', START).status.value, 'ended');
});

test('working, waiting and completed are provider evidence, not terminal guesses', () => {
  const { core, adapter } = setup();
  for (const [sequence, state] of [[1, 'working'], [2, 'waiting'], [3, 'completed']]) {
    const accepted = adapter.accept(evidence({ eventId: `event-${sequence}`, sequence, state }));
    assert.equal(accepted.reason, 'accepted');
    assert.equal(core.snapshot('session-a', START).status.value, state);
  }
});

test('Claude adapter fixes provider/source and rejects raw or extra CLI content', () => {
  const { core, adapter } = setup();
  assert.equal(adapter.accept('shell says working').reason, 'claude-evidence-invalid');
  assert.equal(adapter.accept({ ...evidence(), transcript: 'private terminal content' }).reason, 'claude-evidence-invalid');
  assert.equal(adapter.accept(evidence({ model: '' })).reason, 'model-invalid');
  assert.equal(adapter.accept(evidence({ model: '/private/model/path' })).reason, 'model-invalid');
  adapter.accept(evidence());
  const serialized = JSON.stringify(core.snapshot('session-a', START));
  assert.equal(serialized.includes('private terminal content'), false);
  assert.equal(serialized.includes('shell says working'), false);
});

test('events cannot be attributed to an unregistered session and snapshots do not throw for it', () => {
  const core = new SessionObservationCore({ now: () => START });
  assert.equal(core.ingest({
    schemaVersion: 1, eventId: 'event-1', sessionId: 'missing', provider: 'claude',
    accountProfileId: 'account-a', source: CLAUDE_SOURCE, observedAt: START,
    sequence: 1, state: 'working', usage: []
  }).reason, 'session-unknown');
  assert.equal(core.snapshot('missing', START), null);
});

test('event objects are copied into observations and never retained by reference', () => {
  const { core, adapter } = setup();
  const input = evidence({ usage: [{ field: 'usage.output_tokens', value: 3, measurement: 'actual', scope: 'turn' }] });
  adapter.accept(input);
  input.state = 'waiting';
  input.usage[0].value = 999;
  const value = core.snapshot('session-a', START);
  assert.equal(value.status.value, 'working');
  assert.equal(byField(value)['usage.output_tokens'].value, 3);
});

test('retract withdraws everything for a session, refuses later evidence, and reads as unknown with the reason', () => {
  const NOW = '2026-01-01T00:00:00.000Z';
  const core = new SessionObservationCore({ now: () => NOW, ttlMs: 60_000 });
  core.register({ sessionId: 's1', provider: 'codex', accountProfileId: 'a1' });
  const event = (sequence) => ({
    schemaVersion: 1, eventId: `e${sequence}`, sessionId: 's1', provider: 'codex',
    accountProfileId: 'a1', source: 'codex-app-server-v2', observedAt: NOW,
    sequence, state: 'working', usage: []
  });
  assert.equal(core.ingest(event(1)).ok, true);
  assert.equal(core.retract('s1', 'thread-binding-mismatch').ok, true);
  const snapshot = core.snapshot('s1', NOW);
  assert.deepEqual([snapshot.status.confidence, snapshot.model.confidence, snapshot.status.reason], ['unknown', 'unknown', 'thread-binding-mismatch']);
  assert.deepEqual(core.ingest(event(2)), { ok: false, reason: 'thread-binding-mismatch' });
  assert.equal(core.retract('nobody', 'thread-binding-mismatch').ok, false);
  assert.throws(() => core.retract('s1', 'Not A Code'), TypeError);
});

