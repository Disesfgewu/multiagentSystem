'use strict';

const { SCHEMA_VERSION, SESSION_STATES, USAGE_FIELDS } = require('./session');

const CLAUDE_SOURCE = 'claude-structured-evidence-v1';
const CLAUDE_HOOK_SOURCE = 'claude-hook-v1';
const CLAUDE_STATUSLINE_SOURCE = 'claude-statusline-v1';

const INPUT_KEYS = new Set(['eventId', 'observedAt', 'sequence', 'state', 'model', 'usage', 'statusLine', 'hook']);
const HOOK_INPUT_KEYS = new Set(['eventId', 'observedAt', 'sequence', 'notification']);

const CLAUDE_HOOK_STATES = Object.freeze({
  UserPromptSubmit: 'working',
  PreToolUse: 'working',
  PostToolUse: 'working',
  Notification: 'waiting',
  Stop: 'waiting',
  SessionEnd: 'ended'
});

const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function extractHookNotification(notification) {
  if (!isPlain(notification)) return null;
  const rawSessionId = notification.session_id ?? notification.sessionId;
  const rawEventName = notification.hook_event_name ?? notification.hookEventName;
  if (typeof rawSessionId !== 'string' || rawSessionId.length === 0) return null;
  if (typeof rawEventName !== 'string' || rawEventName.length === 0) return null;
  // Discard any other fields (e.g. transcript_path, cwd, prompt_id) to avoid leaking private data.
  return {
    sessionId: rawSessionId,
    hookEventName: rawEventName
  };
}

function deriveClaudeHookState(hookEventName) {
  if (typeof hookEventName !== 'string') return null;
  return Object.hasOwn(CLAUDE_HOOK_STATES, hookEventName) ? CLAUDE_HOOK_STATES[hookEventName] : null;
}

/**
 * Extracts verified model and estimated cumulative cost from Claude Code official status line JSON payload.
 *
 * Official schema fields:
 * - model.id -> model code
 * - cost.total_cost_usd -> usage.cost_usd (list price estimate, measurement: 'estimated', scope: 'session-cumulative')
 *
 * Note on context_window tokens:
 * context_window.total_input_tokens and total_output_tokens represent the tokens currently inside the context window
 * from the latest API response, and current_usage represents only the last request. They are NOT cumulative session usage
 * and decrease on /compact. They are kept as unknown here to prevent misrepresenting window size as accumulated consumption.
 */
function extractClaudeStatusLineUsage(payload) {
  if (!isPlain(payload)) return null;

  let model;
  if (isPlain(payload.model) && typeof payload.model.id === 'string' &&
      /^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$/.test(payload.model.id) && payload.model.id.length <= 80) {
    model = payload.model.id;
  }

  const usage = [];

  if (isPlain(payload.cost) && typeof payload.cost.total_cost_usd === 'number' &&
      Number.isFinite(payload.cost.total_cost_usd) && payload.cost.total_cost_usd >= 0) {
    usage.push({
      field: 'usage.cost_usd',
      value: payload.cost.total_cost_usd,
      measurement: 'estimated',
      scope: 'session-cumulative'
    });
  }

  return { model, usage };
}

/**
 * Defines the Claude evidence boundary without parsing terminal text or transcripts.
 * Accepts structured evidence, official status-line usage, and hook events.
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

      let state = input.state;
      let model = input.model;
      let usage = input.usage;
      let source = CLAUDE_SOURCE;

      if (input.hook !== undefined) {
        if (input.state !== undefined) {
          return { ok: false, reason: 'claude-evidence-invalid' };
        }
        const notif = extractHookNotification(input.hook);
        if (!notif) {
          return { ok: false, reason: 'claude-evidence-invalid' };
        }
        if (notif.sessionId !== sessionId) {
          return { ok: false, reason: 'session-binding-mismatch' };
        }
        const derivedState = deriveClaudeHookState(notif.hookEventName);
        if (!derivedState) {
          return { ok: false, reason: 'claude-state-unknown' };
        }
        state = derivedState;
        source = CLAUDE_HOOK_SOURCE;
      }

      if (input.statusLine !== undefined) {
        if (input.usage !== undefined || input.model !== undefined) {
          return { ok: false, reason: 'claude-evidence-invalid' };
        }
        const extracted = extractClaudeStatusLineUsage(input.statusLine);
        if (!extracted) {
          return { ok: false, reason: 'claude-evidence-invalid' };
        }
        model = extracted.model;
        usage = extracted.usage;
        if (source === CLAUDE_SOURCE) source = CLAUDE_STATUSLINE_SOURCE;
      }

      return core.ingest({
        schemaVersion: SCHEMA_VERSION,
        eventId: input.eventId,
        sessionId,
        provider: 'claude',
        accountProfileId,
        source,
        observedAt: input.observedAt,
        sequence: input.sequence,
        state,
        model,
        usage
      });
    }
  });
}

/**
 * Accepts officially documented Claude Code hook events via stdin JSON notifications.
 * Hook payload has { sessionId, hookEventName }.
 */
function createClaudeHookEvidenceAdapter({
  core,
  sessionId,
  accountProfileId,
  claudeSessionId
} = {}) {
  if (!core || typeof core.ingest !== 'function') throw new TypeError('core.ingest is required');
  for (const [field, value] of Object.entries({ sessionId, accountProfileId, claudeSessionId })) {
    if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${field} is required`);
  }

  return Object.freeze({
    source: CLAUDE_HOOK_SOURCE,
    acceptedStates: SESSION_STATES,
    acceptedUsageFields: Object.freeze([]),
    accept(input) {
      if (!isPlain(input) || Object.keys(input).some(key => !HOOK_INPUT_KEYS.has(key))) {
        return { ok: false, reason: 'claude-evidence-invalid' };
      }
      const notif = extractHookNotification(input.notification);
      if (!notif) {
        return { ok: false, reason: 'claude-evidence-invalid' };
      }
      if (notif.sessionId !== claudeSessionId) {
        return { ok: false, reason: 'session-binding-mismatch' };
      }
      const state = deriveClaudeHookState(notif.hookEventName);
      if (!state) {
        return { ok: false, reason: 'claude-state-unknown' };
      }

      return core.ingest({
        schemaVersion: SCHEMA_VERSION,
        eventId: input.eventId,
        sessionId,
        provider: 'claude',
        accountProfileId,
        source: CLAUDE_HOOK_SOURCE,
        observedAt: input.observedAt,
        sequence: input.sequence,
        state,
        usage: []
      });
    }
  });
}

module.exports = {
  createClaudeSessionEvidenceAdapter,
  createClaudeHookEvidenceAdapter,
  deriveClaudeHookState,
  extractClaudeStatusLineUsage,
  CLAUDE_SOURCE,
  CLAUDE_HOOK_SOURCE,
  CLAUDE_STATUSLINE_SOURCE,
  CLAUDE_HOOK_STATES
};
