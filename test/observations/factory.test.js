'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionObservationCore } = require('../../src/observations/session');
const { createSessionEvidenceAdapter } = require('../../src/observations/factory');
const { CLAUDE_SOURCE } = require('../../src/observations/claude');
const { CODEX_APP_SERVER_SCHEMA_VERSION, CODEX_APP_SERVER_SOURCE } = require('../../src/observations/codex');
const { AGY_SOURCE, FALLBACK_SOURCE } = require('../../src/observations/agy');

const START = '2026-01-01T00:00:00.000Z';

test('createSessionEvidenceAdapter creates provider-appropriate adapter', () => {
  const core = new SessionObservationCore({ now: () => START });
  const binding = { sessionId: 's1', accountProfileId: 'a1' };

  // Claude
  const claude = createSessionEvidenceAdapter('claude', { core, ...binding });
  assert.equal(claude.source, CLAUDE_SOURCE);

  // Codex
  const codex = createSessionEvidenceAdapter('codex', {
    core,
    ...binding,
    threadId: 't1',
    schemaVersion: CODEX_APP_SERVER_SCHEMA_VERSION
  });
  assert.equal(codex.source, CODEX_APP_SERVER_SOURCE);

  // Agy
  const agy = createSessionEvidenceAdapter('agy', { core, ...binding });
  assert.equal(agy.source, AGY_SOURCE);
  assert.equal(agy.provider, 'agy');

  // Generic fallback
  const fallback = createSessionEvidenceAdapter('custom-provider', { core, ...binding });
  assert.equal(fallback.source, FALLBACK_SOURCE);
  assert.equal(fallback.provider, 'custom-provider');
});

test('createSessionEvidenceAdapter validates providerId', () => {
  assert.throws(() => createSessionEvidenceAdapter(''), /providerId is required/);
  assert.throws(() => createSessionEvidenceAdapter(null), /providerId is required/);
});
