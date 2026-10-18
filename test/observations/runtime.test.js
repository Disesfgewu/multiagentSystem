'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SessionObservationRuntime, SESSION_ID_ENV, observationPath } = require('../../src/observations/runtime');

const NOW = '2026-01-01T00:00:00.000Z';

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
