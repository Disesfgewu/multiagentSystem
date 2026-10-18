'use strict';

const { SCHEMA_VERSION, SESSION_STATES, USAGE_FIELDS } = require('./session');

const CLAUDE_SOURCE = 'claude-structured-evidence-v1';
const CLAUDE_HOOK_SOURCE = 'claude-hook-v1';
const CLAUDE_STATUSLINE_SOURCE = 'claude-statusline-v1';

const INPUT_KEYS = new Set(['eventId', 'observedAt', 'sequence', 'state', 'model', 'usage', 'statusLine', 'hook']);
const HOOK_INPUT_KEYS = new Set(['eventId', 'observedAt', 'sequence', 'notification']);
const HOOK_NOTIFICATION_KEYS = new Set(['sessionId', 'hookEventName']);

const CLAUDE_HOOK_STATES = Object.freeze({
  UserPromptSubmit: 'working',
  PreToolUse: 'working',
  PostToolUse: 'working',
  Notification: 'waiting',
  Stop: 'waiting',
  SessionEnd: 'ended'
});

const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function deriveClaudeHookState(hookEventName) {
  if (typeof hookEventName !== 'string') return null;
  return Object.hasOwn(CLAUDE_HOOK_STATES, hookEventName) ? CLAUDE_HOOK_STATES[hookEventName] : null;
}

/**
 * Extracts verified model and usage from Claude Code official status line JSON payload.
 * Official schema fields:
 * - model.id
 * - cost.total_cost_usd -> usage.cost_usd
 * - context_window.total_input_tokens -> usage.input_tokens
 * - context_window.total_output_tokens -> usage.output_tokens
 * - context_window.current_usage.cache_read_input_tokens -> usage.cache_read_tokens
 * - context_window.current_usage.cache_creation_input_tokens -> usage.cache_write_tokens
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
      measurement: 'actual',
      scope: 'session-cumulative'
    });
  }

  if (isPlain(payload.context_window)) {
    const cw = payload.context_window;
    if (typeof cw.total_input_tokens === 'number' && Number.isFinite(cw.total_input_tokens) && cw.total_input_tokens >= 0) {
      usage.push({
        field: 'usage.input_tokens',
        value: cw.total_input_tokens,
        measurement: 'actual',
        scope: 'session-cumulative'
      });
    }
    if (typeof cw.total_output_tokens === 'number' && Number.isFinite(cw.total_output_tokens) && cw.total_output_tokens >= 0) {
      usage.push({
        field: 'usage.output_tokens',
        value: cw.total_output_tokens,
        measurement: 'actual',
        scope: 'session-cumulative'
      });
    }
    if (isPlain(cw.current_usage)) {
      if (typeof cw.current_usage.cache_read_input_tokens === 'number' &&
          Number.isFinite(cw.current_usage.cache_read_input_tokens) && cw.current_usage.cache_read_input_tokens >= 0) {
        usage.push({
          field: 'usage.cache_read_tokens',
          value: cw.current_usage.cache_read_input_tokens,
          measurement: 'actual',
          scope: 'session-cumulative'
        });
      }
      if (typeof cw.current_usage.cache_creation_input_tokens === 'number' &&
          Number.isFinite(cw.current_usage.cache_creation_input_tokens) && cw.current_usage.cache_creation_input_tokens >= 0) {
        usage.push({
          field: 'usage.cache_write_tokens',
          value: cw.current_usage.cache_creation_input_tokens,
          measurement: 'actual',
          scope: 'session-cumulative'
        });
      }
    }
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
        if (!isPlain(input.hook) || Object.keys(input.hook).some(key => !HOOK_NOTIFICATION_KEYS.has(key))) {
          return { ok: false, reason: 'claude-evidence-invalid' };
        }
        if (input.hook.sessionId !== sessionId) {
          return { ok: false, reason: 'session-binding-mismatch' };
        }
        const derivedState = deriveClaudeHookState(input.hook.hookEventName);
        if (!derivedState) {
          return { ok: false, reason: 'claude-state-unknown' };
        }
        state = derivedState;
        source = CLAUDE_HOOK_SOURCE;
      }

      if (input.statusLine !== undefined) {
        const extracted = extractClaudeStatusLineUsage(input.statusLine);
        if (!extracted) {
          return { ok: false, reason: 'claude-evidence-invalid' };
        }
        if (model === undefined) model = extracted.model;
        if (usage === undefined) usage = extracted.usage;
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
      if (!isPlain(input.notification) || Object.keys(input.notification).some(key => !HOOK_NOTIFICATION_KEYS.has(key))) {
        return { ok: false, reason: 'claude-evidence-invalid' };
      }
      const { notification } = input;
      if (notification.sessionId !== claudeSessionId) {
        return { ok: false, reason: 'session-binding-mismatch' };
      }
      const state = deriveClaudeHookState(notification.hookEventName);
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
