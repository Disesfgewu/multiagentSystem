'use strict';

const { CONFIDENCE, unknown, observe, isFresh } = require('../accounts/observation');

const SCHEMA_VERSION = 1;
const DEFAULT_TTL_MS = 30 * 1000;
const MAX_SEEN_EVENTS = 256;
const SESSION_STATES = Object.freeze(['working', 'waiting', 'completed', 'ended']);
const USAGE_FIELDS = Object.freeze([
  'usage.input_tokens',
  'usage.output_tokens',
  'usage.cache_read_tokens',
  'usage.cache_write_tokens',
  'usage.cost_usd'
]);
const TOKEN_FIELDS = new Set(USAGE_FIELDS.filter(field => field.endsWith('_tokens')));
const EVENT_KEYS = new Set([
  'schemaVersion', 'eventId', 'sessionId', 'provider', 'accountProfileId',
  'source', 'observedAt', 'sequence', 'state', 'model', 'usage'
]);
const USAGE_KEYS = new Set(['field', 'value', 'measurement', 'scope']);

const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const result = (ok, reason, extra = {}) => ({ ok, reason, ...extra });
const validText = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\x00-\x1f\x7f]/.test(value);
const validCode = value => typeof value === 'string' && /^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$/.test(value) && value.length <= 80;
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

function copyObservation(value) {
  return value ? { ...value } : value;
}

function validateBinding(binding) {
  if (!isPlain(binding)) throw new TypeError('binding is required');
  for (const field of ['sessionId', 'accountProfileId']) {
    if (!validText(binding[field])) throw new TypeError(`${field} is invalid`);
  }
  if (!validCode(binding.provider)) throw new TypeError('provider is invalid');
  return {
    sessionId: binding.sessionId,
    provider: binding.provider,
    accountProfileId: binding.accountProfileId
  };
}

function validateUsage(items) {
  if (items === undefined) return { ok: true, values: new Map() };
  if (!Array.isArray(items)) return result(false, 'usage-invalid');
  const values = new Map();
  for (const item of items) {
    if (!isPlain(item) || Object.keys(item).some(key => !USAGE_KEYS.has(key))) return result(false, 'usage-invalid');
    if (!USAGE_FIELDS.includes(item.field) || values.has(item.field)) return result(false, 'usage-invalid');
    if (typeof item.value !== 'number' || !Number.isFinite(item.value) || item.value < 0) return result(false, 'usage-invalid');
    if (!['actual', 'estimated'].includes(item.measurement)) return result(false, 'usage-invalid');
    if (!validCode(item.scope)) return result(false, 'usage-invalid');
    values.set(item.field, item);
  }
  return { ok: true, values };
}

function unknownSnapshot(binding, now, reason, source = 'not-observed') {
  const status = unknown('session.state', { source, observedAt: now, reason });
  const model = unknown('session.model', { source, observedAt: now, reason });
  const usage = USAGE_FIELDS.map(field => unknown(field, { source, observedAt: now, reason }));
  return { ...binding, status, model, usage, freshness: 'unknown' };
}

class SessionObservationCore {
  constructor({ now = () => new Date().toISOString(), ttlMs = DEFAULT_TTL_MS } = {}) {
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('ttlMs must be positive');
    this.now = now;
    this.ttlMs = ttlMs;
    this.sessions = new Map();
  }

  register(binding) {
    const fixed = validateBinding(binding);
    if (this.sessions.has(fixed.sessionId)) throw new TypeError('session already registered');
    this.sessions.set(fixed.sessionId, {
      binding: fixed,
      lastSequence: -1,
      lastObservedAt: null,
      status: null,
      model: null,
      usage: new Map(),
      ended: false,
      seen: new Set(),
      seenOrder: []
    });
    return { ...fixed };
  }

  ingest(event) {
    if (!isPlain(event) || Object.keys(event).some(key => !EVENT_KEYS.has(key))) return result(false, 'event-invalid');
    if (event.schemaVersion !== SCHEMA_VERSION) return result(false, 'schema-unsupported');
    if (!validText(event.eventId) || !validText(event.sessionId) || !validCode(event.provider) ||
        !validText(event.accountProfileId) || !validCode(event.source)) return result(false, 'event-invalid');
    const session = this.sessions.get(event.sessionId);
    if (!session) return result(false, 'session-unknown');
    if (event.provider !== session.binding.provider || event.accountProfileId !== session.binding.accountProfileId) {
      return result(false, 'binding-mismatch');
    }
    if (session.seen.has(event.eventId)) return result(true, 'duplicate', { accepted: false });
    if (session.ended) return result(false, 'session-ended');
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 0 || event.sequence <= session.lastSequence) {
      return result(false, 'out-of-order');
    }
    if (!validTime(event.observedAt)) return result(false, 'observed-at-invalid');
    const eventMs = Date.parse(event.observedAt);
    const nowMs = Date.parse(this.now());
    if (!Number.isFinite(nowMs)) throw new TypeError('now returned an invalid time');
    if (eventMs > nowMs) return result(false, 'future-event');
    if (session.lastObservedAt !== null && eventMs < Date.parse(session.lastObservedAt)) return result(false, 'out-of-order');
    if (!SESSION_STATES.includes(event.state)) return result(false, 'state-unknown');
    if (event.model !== undefined && !validCode(event.model)) return result(false, 'model-invalid');
    const checkedUsage = validateUsage(event.usage);
    if (!checkedUsage.ok) return checkedUsage;

    const status = observe('session.state', event.state, {
      source: event.source,
      observedAt: event.observedAt,
      scope: 'bound local session',
      confidence: CONFIDENCE.ACTUAL,
      validForMs: this.ttlMs
    });
    const model = event.model === undefined
      ? unknown('session.model', { source: event.source, observedAt: event.observedAt, reason: 'not-reported' })
      : observe('session.model', event.model, {
        source: event.source,
        observedAt: event.observedAt,
        scope: 'bound local session',
        confidence: CONFIDENCE.ACTUAL,
        validForMs: this.ttlMs
      });
    const usage = new Map();
    for (const field of USAGE_FIELDS) {
      const metric = checkedUsage.values.get(field);
      usage.set(field, metric
        ? observe(field, metric.value, {
          source: metric.measurement === 'actual' ? event.source : `${event.source}.local-estimate`,
          observedAt: event.observedAt,
          scope: metric.scope,
          unit: TOKEN_FIELDS.has(field) ? 'tokens' : 'usd',
          confidence: metric.measurement === 'actual' ? CONFIDENCE.ACTUAL : CONFIDENCE.ESTIMATED,
          validForMs: this.ttlMs
        })
        : unknown(field, { source: event.source, observedAt: event.observedAt, reason: 'not-reported' }));
    }

    // Commit only after the entire envelope is valid.
    session.lastSequence = event.sequence;
    session.lastObservedAt = event.observedAt;
    session.status = status;
    session.model = model;
    session.usage = usage;
    session.ended = event.state === 'ended';
    session.seen.add(event.eventId);
    session.seenOrder.push(event.eventId);
    if (session.seenOrder.length > MAX_SEEN_EVENTS) session.seen.delete(session.seenOrder.shift());
    return result(true, 'accepted', { accepted: true });
  }

  snapshot(sessionId, at = this.now()) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (!validTime(at)) throw new TypeError('snapshot time is invalid');
    if (!session.status) return unknownSnapshot(session.binding, at, 'not-observed');

    const statusFresh = isFresh(session.status, at);
    const status = statusFresh
      ? copyObservation(session.status)
      : unknown('session.state', { source: session.status.source, observedAt: at, reason: 'stale' });
    const model = !session.model || session.model.confidence === CONFIDENCE.UNKNOWN
      ? copyObservation(session.model)
      : (isFresh(session.model, at)
        ? copyObservation(session.model)
        : unknown('session.model', { source: session.model.source, observedAt: at, reason: 'stale' }));
    const usage = USAGE_FIELDS.map(field => {
      const value = session.usage.get(field);
      if (!value || value.confidence === CONFIDENCE.UNKNOWN) return copyObservation(value);
      return isFresh(value, at)
        ? copyObservation(value)
        : unknown(field, { source: value.source, observedAt: at, reason: 'stale' });
    });
    return {
      ...session.binding,
      status,
      model,
      usage,
      freshness: statusFresh ? 'fresh' : 'stale'
    };
  }
}

module.exports = {
  SessionObservationCore,
  SCHEMA_VERSION,
  DEFAULT_TTL_MS,
  SESSION_STATES,
  USAGE_FIELDS
};
