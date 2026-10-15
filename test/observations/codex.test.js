'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('../fixtures/codex-app-server-v2/thread-status-waiting.json');
const generatedSchema = require('../fixtures/codex-app-server-v2/ThreadStatusChangedNotification.schema.json');
const { SessionObservationCore, USAGE_FIELDS } = require('../../src/observations/session');
const {
  createCodexSessionEvidenceAdapter,
  CODEX_APP_SERVER_SCHEMA_VERSION,
  CODEX_APP_SERVER_SOURCE
} = require('../../src/observations/codex');

const START = '2026-01-01T00:00:00.000Z';

function setup(suffix = 'a') {
  const binding = { sessionId: `session-${suffix}`, provider: 'codex', accountProfileId: `account-${suffix}` };
  const core = new SessionObservationCore({ now: () => START, ttlMs: 1000 });
  core.register(binding);
  const adapter = createCodexSessionEvidenceAdapter({
    core,
    ...binding,
    threadId: `thread-${suffix}`,
    schemaVersion: CODEX_APP_SERVER_SCHEMA_VERSION
  });
  return { binding, core, adapter };
}

const notification = (threadId, status) => ({
  method: 'thread/status/changed', params: { threadId, status }
});

const evidence = (threadId, status, extra = {}) => ({
  eventId: 'event-1', observedAt: START, sequence: 1,
  notification: notification(threadId, status), ...extra
});

test('official waiting fixture derives waiting and keeps usage unknown', () => {
  const { core, adapter } = setup();
  const input = evidence('thread-a', fixture.notification.params.status, { notification: {
    ...fixture.notification,
    params: { ...fixture.notification.params, threadId: 'thread-a' }
  } });
  assert.deepEqual(adapter.accept(input), { ok: true, reason: 'accepted', accepted: true });
  const value = core.snapshot('session-a', START);
  assert.deepEqual([value.status.value, value.status.source, value.status.confidence],
    ['waiting', CODEX_APP_SERVER_SOURCE, 'actual']);
  assert.deepEqual(adapter.acceptedUsageFields, []);
  assert.deepEqual(value.usage.map(item => item.field), USAGE_FIELDS);
  assert.equal(value.usage.every(item => item.confidence === 'unknown'), true);
});

test('documented active and idle states derive working and completed', () => {
  const { core, adapter } = setup();
  assert.equal(adapter.accept(evidence('thread-a', { type: 'active', activeFlags: [] })).reason, 'accepted');
  assert.equal(core.snapshot('session-a', START).status.value, 'working');
  assert.equal(adapter.accept(evidence('thread-a', { type: 'idle' }, {
    eventId: 'event-2', sequence: 2
  })).reason, 'accepted');
  assert.equal(core.snapshot('session-a', START).status.value, 'completed');
});

test('both versioned waiting flags derive waiting', () => {
  const schemaFlags = generatedSchema.definitions.ThreadActiveFlag.enum;
  assert.deepEqual(schemaFlags, ['waitingOnApproval', 'waitingOnUserInput']);
  for (const flag of schemaFlags) {
    const { core, adapter } = setup(flag);
    assert.equal(adapter.accept(evidence(`thread-${flag}`, { type: 'active', activeFlags: [flag] })).reason, 'accepted');
    assert.equal(core.snapshot(`session-${flag}`, START).status.value, 'waiting');
  }
});

test('unknown flags and non-observable status types fail closed', () => {
  const { core, adapter } = setup();
  for (const [index, status] of [
    { type: 'active', activeFlags: ['futureFlag'] },
    { type: 'systemError' },
    { type: 'notLoaded' }
  ].entries()) {
    const result = adapter.accept(evidence('thread-a', status, { eventId: `event-${index}`, sequence: index }));
    assert.equal(result.reason, 'codex-state-unknown');
  }
  assert.equal(core.snapshot('session-a', START).status.confidence, 'unknown');
});

test('thread and account bindings keep two profiles isolated in one core', () => {
  const core = new SessionObservationCore({ now: () => START, ttlMs: 1000 });
  for (const suffix of ['a', 'b']) {
    core.register({ sessionId: `session-${suffix}`, provider: 'codex', accountProfileId: `account-${suffix}` });
  }
  const makeAdapter = suffix => createCodexSessionEvidenceAdapter({
    core, sessionId: `session-${suffix}`, accountProfileId: `account-${suffix}`,
    threadId: `thread-${suffix}`, schemaVersion: CODEX_APP_SERVER_SCHEMA_VERSION
  });
  const first = makeAdapter('a');
  const second = makeAdapter('b');
  assert.equal(first.accept(evidence('thread-b', { type: 'idle' })).reason, 'thread-binding-mismatch');
  assert.equal(core.snapshot('session-a', START).status.confidence, 'unknown');
  assert.equal(second.accept(evidence('thread-b', { type: 'active', activeFlags: [] })).reason, 'accepted');
  assert.deepEqual([core.snapshot('session-b', START).accountProfileId,
    core.snapshot('session-b', START).status.value], ['account-b', 'working']);
  assert.equal(core.snapshot('session-a', START).status.confidence, 'unknown');
});

test('raw CLI text, extra content and unrelated notifications are rejected', () => {
  const { adapter } = setup();
  assert.equal(adapter.accept('codex appears busy').reason, 'codex-evidence-invalid');
  assert.equal(adapter.accept(evidence('thread-a', { type: 'idle' }, { transcript: 'private' })).reason,
    'codex-evidence-invalid');
  assert.equal(adapter.accept(evidence('thread-a', { type: 'idle' }, {
    notification: { method: 'thread/tokenUsage/updated', params: { threadId: 'thread-a', tokenUsage: {} } }
  })).reason, 'codex-evidence-invalid');
});

test('schema version must match the reviewed generated schema', () => {
  const core = new SessionObservationCore({ now: () => START });
  core.register({ sessionId: 'session-a', provider: 'codex', accountProfileId: 'account-a' });
  assert.throws(() => createCodexSessionEvidenceAdapter({
    core, sessionId: 'session-a', accountProfileId: 'account-a', threadId: 'thread-a', schemaVersion: 'future'
  }), /unsupported Codex app-server schema version/);
});
