'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionObservationCore, USAGE_FIELDS } = require('../../src/observations/session');
const {
  createAgySessionEvidenceAdapter,
  createFallbackSessionEvidenceAdapter,
  AGY_SOURCE,
  FALLBACK_SOURCE
} = require('../../src/observations/agy');

const START = '2026-01-01T00:00:00.000Z';
const binding = { sessionId: 'session-agy', provider: 'agy', accountProfileId: 'account-agy' };

function setup() {
  const core = new SessionObservationCore({ now: () => START, ttlMs: 1000 });
  core.register(binding);
  const adapter = createAgySessionEvidenceAdapter({
    core,
    sessionId: binding.sessionId,
    accountProfileId: binding.accountProfileId
  });
  return { core, adapter };
}

test('agy fallback adapter defines zero accepted states and zero accepted usage fields', () => {
  const { adapter } = setup();
  assert.equal(adapter.source, AGY_SOURCE);
  assert.equal(adapter.provider, 'agy');
  assert.deepEqual(adapter.acceptedStates, []);
  assert.deepEqual(adapter.acceptedUsageFields, []);
  assert.ok(Object.isFrozen(adapter));
  assert.ok(Object.isFrozen(adapter.acceptedStates));
  assert.ok(Object.isFrozen(adapter.acceptedUsageFields));
});

test('snapshot for an agy session is completely unknown for status, model, and all usage fields', () => {
  const { core } = setup();
  const snapshot = core.snapshot('session-agy', START);
  assert.equal(snapshot.provider, 'agy');
  assert.equal(snapshot.accountProfileId, 'account-agy');
  assert.equal(snapshot.status.value, null);
  assert.equal(snapshot.status.confidence, 'unknown');
  assert.equal(snapshot.status.reason, 'not-observed');
  assert.deepEqual([snapshot.model.field, snapshot.model.confidence, snapshot.model.reason],
    ['session.model', 'unknown', 'not-observed']);
  assert.deepEqual(snapshot.usage.map(u => u.field), USAGE_FIELDS);
  assert.equal(snapshot.usage.every(u => u.confidence === 'unknown'), true);
  assert.equal(snapshot.usage.every(u => u.reason === 'not-observed'), true);
});

test('shell presence or terminal open state must never be treated as working model evidence', () => {
  const { adapter, core } = setup();
  const aliveResult = adapter.accept({ shellAlive: true });
  assert.deepEqual(aliveResult, { ok: false, reason: 'shell-presence-is-not-working-evidence' });

  const terminalResult = adapter.accept({ terminalOpen: true });
  assert.deepEqual(terminalResult, { ok: false, reason: 'shell-presence-is-not-working-evidence' });

  const snapshot = core.snapshot('session-agy', START);
  assert.equal(snapshot.status.confidence, 'unknown');
});

test('synthetic, terminal, or guessed events fail closed as unsupported provider', () => {
  const { adapter, core } = setup();
  for (const input of [
    { eventId: 'ev-1', state: 'working' },
    { state: 'waiting' },
    'shell is active',
    null,
    undefined,
    123
  ]) {
    const res = adapter.accept(input);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'unsupported-provider');
  }

  const snapshot = core.snapshot('session-agy', START);
  assert.equal(snapshot.status.confidence, 'unknown');
});

test('createFallbackSessionEvidenceAdapter supports generic unverified providers', () => {
  const core = new SessionObservationCore({ now: () => START, ttlMs: 1000 });
  const openBinding = { sessionId: 'session-open', provider: 'opencode', accountProfileId: 'acct-1' };
  core.register(openBinding);
  const adapter = createFallbackSessionEvidenceAdapter({
    core,
    sessionId: openBinding.sessionId,
    accountProfileId: openBinding.accountProfileId,
    provider: 'opencode'
  });
  assert.equal(adapter.source, FALLBACK_SOURCE);
  assert.equal(adapter.provider, 'opencode');
  assert.equal(adapter.accept({ state: 'working' }).reason, 'unsupported-provider');
  assert.equal(core.snapshot('session-open', START).status.confidence, 'unknown');
});

test('parameter validation throws TypeError on invalid arguments', () => {
  const core = new SessionObservationCore({ now: () => START });
  assert.throws(() => createAgySessionEvidenceAdapter(), /core\.ingest is required/);
  assert.throws(() => createAgySessionEvidenceAdapter({ core }), /sessionId is required/);
  assert.throws(() => createAgySessionEvidenceAdapter({ core, sessionId: 's1' }), /accountProfileId is required/);
  assert.throws(() => createFallbackSessionEvidenceAdapter({ core, sessionId: 's1', accountProfileId: 'a1', provider: '' }), /provider is required/);
});
