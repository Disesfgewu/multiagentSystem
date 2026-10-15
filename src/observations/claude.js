'use strict';

const { SCHEMA_VERSION, SESSION_STATES, USAGE_FIELDS } = require('./session');

const CLAUDE_SOURCE = 'claude-structured-evidence-v1';
const INPUT_KEYS = new Set(['eventId', 'observedAt', 'sequence', 'state', 'model', 'usage']);

const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Defines the Claude evidence boundary without parsing terminal text, transcripts, hooks,
 * status-line JSON, or login files. A future host adapter may call accept only after it has
 * validated an officially documented Claude event and bound it to this local session.
 */
function createClaudeSessionEvidenceAdapter({ core, sessionId, accountProfileId } = {}) {
  if (!core || typeof core.ingest !== 'function') throw new TypeError('core.ingest is required');
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw new TypeError('sessionId is required');
  if (typeof accountProfileId !== 'string' || accountProfileId.length === 0) throw new TypeError('accountProfileId is required');

  return Object.freeze({
    source: CLAUDE_SOURCE,
    acceptedStates: SESSION_STATES,
    acceptedUsageFields: USAGE_FIELDS,
    accept(input) {
      if (!isPlain(input) || Object.keys(input).some(key => !INPUT_KEYS.has(key))) {
        return { ok: false, reason: 'claude-evidence-invalid' };
      }
      return core.ingest({
        schemaVersion: SCHEMA_VERSION,
        eventId: input.eventId,
        sessionId,
        provider: 'claude',
        accountProfileId,
        source: CLAUDE_SOURCE,
        observedAt: input.observedAt,
        sequence: input.sequence,
        state: input.state,
        model: input.model,
        usage: input.usage
      });
    }
  });
}

module.exports = { createClaudeSessionEvidenceAdapter, CLAUDE_SOURCE };
