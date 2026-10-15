'use strict';

const { SCHEMA_VERSION, SESSION_STATES } = require('./session');

const CODEX_APP_SERVER_SCHEMA_VERSION = '0.162.1';
const CODEX_APP_SERVER_SOURCE = 'codex-app-server-v2';
const STATUS_METHOD = 'thread/status/changed';
const WAITING_FLAGS = Object.freeze(['waitingOnApproval', 'waitingOnUserInput']);
const INPUT_KEYS = new Set(['eventId', 'observedAt', 'sequence', 'notification']);
const NOTIFICATION_KEYS = new Set(['method', 'params']);
const PARAM_KEYS = new Set(['threadId', 'status']);

const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasOnly = (value, keys) => isPlain(value) && Object.keys(value).every(key => keys.has(key));

function deriveState(status) {
  if (!isPlain(status) || typeof status.type !== 'string') return null;
  if (status.type === 'idle' && Object.keys(status).length === 1) return 'completed';
  if (status.type !== 'active' || Object.keys(status).some(key => !['type', 'activeFlags'].includes(key)) ||
      !Array.isArray(status.activeFlags)) return null;

  const flags = status.activeFlags;
  if (new Set(flags).size !== flags.length || flags.some(flag => !WAITING_FLAGS.includes(flag))) return null;
  return flags.length === 0 ? 'working' : 'waiting';
}

/**
 * Accepts only the documented Codex app-server v2 thread/status/changed
 * notification. Receipt metadata is supplied by the local host because the
 * notification has no timestamp, sequence, or event id.
 */
function createCodexSessionEvidenceAdapter({
  core, sessionId, accountProfileId, threadId, schemaVersion
} = {}) {
  if (!core || typeof core.ingest !== 'function') throw new TypeError('core.ingest is required');
  for (const [field, value] of Object.entries({ sessionId, accountProfileId, threadId })) {
    if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${field} is required`);
  }
  if (schemaVersion !== CODEX_APP_SERVER_SCHEMA_VERSION) {
    throw new TypeError('unsupported Codex app-server schema version');
  }

  return Object.freeze({
    source: CODEX_APP_SERVER_SOURCE,
    protocol: 'v2',
    schemaVersion: CODEX_APP_SERVER_SCHEMA_VERSION,
    acceptedStates: SESSION_STATES,
    acceptedUsageFields: Object.freeze([]),
    accept(input) {
      if (!hasOnly(input, INPUT_KEYS) ||
          !hasOnly(input.notification, NOTIFICATION_KEYS) || input.notification.method !== STATUS_METHOD ||
          !hasOnly(input.notification.params, PARAM_KEYS)) {
        return { ok: false, reason: 'codex-evidence-invalid' };
      }
      const { params } = input.notification;
      if (params.threadId !== threadId) return { ok: false, reason: 'thread-binding-mismatch' };
      const state = deriveState(params.status);
      if (!state) return { ok: false, reason: 'codex-state-unknown' };

      return core.ingest({
        schemaVersion: SCHEMA_VERSION,
        eventId: input.eventId,
        sessionId,
        provider: 'codex',
        accountProfileId,
        source: CODEX_APP_SERVER_SOURCE,
        observedAt: input.observedAt,
        sequence: input.sequence,
        state,
        usage: []
      });
    }
  });
}

module.exports = {
  createCodexSessionEvidenceAdapter,
  deriveState,
  CODEX_APP_SERVER_SCHEMA_VERSION,
  CODEX_APP_SERVER_SOURCE,
  WAITING_FLAGS
};
