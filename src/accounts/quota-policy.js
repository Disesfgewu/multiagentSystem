'use strict';

const { isGateEligible, isFresh, CONFIDENCE } = require('./observation');

// Per-account quota and concurrency policy. It decides whether a NEW task may start on an
// account; it never moves a running agent to another account and never picks another account.
//
// Inputs are injected: the policy, the account's observations (the output of the functions in
// `observation.js`) and the current time. Nothing here reads a file, a CLI or the network.
//
// Only a reading that is reported by the service, still within its lifetime and not from the
// future (`isGateEligible`) can become a hard gate. An estimate, an expired reading or a missing
// one can only warn. When no window has a usable reading, the quota is unknown and the policy's
// `unknownQuota` setting decides. Quota changes on the server between two readings, so this
// cannot promise to stop every request that would exceed it.

const UNKNOWN_QUOTA = Object.freeze(['require-confirmation', 'block']);
const POLICY_KEYS = new Set(['warnAtPercent', 'blockAtPercent', 'maxConcurrent', 'unknownQuota']);
const USED = /^quota\.(.+)\.used_percent$/;
const RESETS = (window) => `quota.${window}.resets_at`;
const MAX_CONCURRENT_LIMIT = 64;

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const percent = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
const credibleTime = (item, now) => {
  const observed = Date.parse(item?.observedAt);
  const current = now instanceof Date ? now.getTime() : Date.parse(now);
  return Number.isFinite(observed) && Number.isFinite(current) && observed <= current;
};

/** Defaults: no thresholds, no concurrency limit, and an unknown quota needs confirmation. */
const DEFAULT_POLICY = Object.freeze({ unknownQuota: 'require-confirmation' });

/** @returns {{ ok: boolean, problems: string[], policy?: object }} a frozen copy when valid */
function validatePolicy(input) {
  if (!isPlain(input)) return { ok: false, problems: ['policy-not-object'] };
  const problems = [];
  for (const key of Object.keys(input)) if (!POLICY_KEYS.has(key)) problems.push('policy-unknown-field');
  const { warnAtPercent, blockAtPercent, maxConcurrent } = input;
  if (warnAtPercent !== undefined && !percent(warnAtPercent)) problems.push('warn-percent-invalid');
  if (blockAtPercent !== undefined && !percent(blockAtPercent)) problems.push('block-percent-invalid');
  if (percent(warnAtPercent) && percent(blockAtPercent) && warnAtPercent > blockAtPercent) problems.push('warn-above-block');
  if (maxConcurrent !== undefined && (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > MAX_CONCURRENT_LIMIT)) problems.push('max-concurrent-invalid');
  const unknownQuota = input.unknownQuota === undefined ? DEFAULT_POLICY.unknownQuota : input.unknownQuota;
  if (!UNKNOWN_QUOTA.includes(unknownQuota)) problems.push('unknown-quota-invalid');
  if (problems.length > 0) return { ok: false, problems: [...new Set(problems)] };
  const policy = { unknownQuota };
  for (const key of ['warnAtPercent', 'blockAtPercent', 'maxConcurrent']) if (input[key] !== undefined) policy[key] = input[key];
  return { ok: true, problems: [], policy: Object.freeze(policy) };
}

function windowsOf(observations) {
  const found = new Map();
  for (const item of Array.isArray(observations) ? observations : []) {
    if (!isPlain(item) || typeof item.field !== 'string') continue;
    const match = USED.exec(item.field);
    if (match) found.set(match[1], item);
  }
  return found;
}

/**
 * What the account list may show for quota: one entry per window, with the source, when it was read,
 * how trustworthy it is, whether it is still fresh and the reset time when one was read.
 */
function summarizeQuota(observations, now) {
  const list = Array.isArray(observations) ? observations : [];
  return [...windowsOf(list)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([window, item]) => {
    const reset = list.find((other) => isPlain(other) && other.field === RESETS(window));
    const usable = item.unit === 'percent' && percent(item.value) && item.confidence !== CONFIDENCE.UNKNOWN && credibleTime(item, now);
    return {
      window,
      usedPercent: usable ? item.value : null,
      source: typeof item.source === 'string' ? item.source : null,
      observedAt: typeof item.observedAt === 'string' ? item.observedAt : null,
      confidence: usable ? item.confidence : CONFIDENCE.UNKNOWN,
      fresh: usable && isFresh(item, now),
      gateEligible: usable && isGateEligible(item, now),
      resetsAt: isPlain(reset) && typeof reset.value === 'string' ? reset.value : null
    };
  });
}

const LEVEL = Object.freeze({ allow: 0, warn: 1, confirm: 2, block: 3 });
const worst = (a, b) => (LEVEL[b] > LEVEL[a] ? b : a);

/**
 * Pure decision for one new task. `running` is how many agents already run on this REAL account
 * (the caller counts accounts that log in to the same real account once). `approval` is the user's
 * explicit answer: 'confirm' satisfies a confirmation request, 'override' also lifts a block that
 * comes from quota. A concurrency limit is never lifted by approval: change the limit instead.
 *
 * @returns {{ decision: 'allow'|'warn'|'confirm'|'block', allowed: boolean, reasons: object[] }}
 */
function decideDispatch({ policy, observations, now, running = 0, approval } = {}) {
  const checked = validatePolicy(policy);
  if (!checked.ok) return { decision: 'block', allowed: false, reasons: [{ code: 'policy-invalid' }] };
  const rules = checked.policy;
  if (!Number.isInteger(running) || running < 0) return { decision: 'block', allowed: false, reasons: [{ code: 'running-count-invalid' }] };
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowMs)) return { decision: 'block', allowed: false, reasons: [{ code: 'time-invalid' }] };
  const at = new Date(nowMs);

  const reasons = [];
  let level = 'allow';
  const raise = (to, reason) => { level = worst(level, to); reasons.push(reason); };

  let hardBlock = false;
  if (rules.maxConcurrent !== undefined && running >= rules.maxConcurrent) {
    hardBlock = true;
    raise('block', { code: 'concurrency-limit', running, limit: rules.maxConcurrent, overridable: false });
  }

  const windows = windowsOf(observations);
  let gated = 0;
  for (const [window, item] of [...windows].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (item.unit !== 'percent' || !isGateEligible(item, at)) {
      // An estimate, an expired reading or a missing value is shown, never used as a gate.
      if (item.unit === 'percent' && item.value !== null && item.value !== undefined && percent(item.value) && credibleTime(item, at) && rules.warnAtPercent !== undefined && item.value >= rules.warnAtPercent) {
        raise('warn', { code: 'unverified-reading-over-warning', window, confidence: item.confidence });
      } else {
        raise('warn', { code: 'window-unverified', window });
      }
      continue;
    }
    gated += 1;
    if (rules.blockAtPercent !== undefined && item.value >= rules.blockAtPercent) {
      raise('block', { code: 'quota-block-threshold', window, usedPercent: item.value, overridable: true });
    } else if (rules.warnAtPercent !== undefined && item.value >= rules.warnAtPercent) {
      raise('warn', { code: 'quota-warn-threshold', window, usedPercent: item.value });
    }
  }
  if (gated === 0) {
    const unknownLevel = rules.unknownQuota === 'block' ? 'block' : 'confirm';
    raise(unknownLevel, { code: 'quota-unknown', policy: rules.unknownQuota, overridable: true });
  }

  let allowed = level === 'allow' || level === 'warn';
  if (!allowed && !hardBlock) {
    if (level === 'confirm' && (approval === 'confirm' || approval === 'override')) allowed = true;
    if (level === 'block' && approval === 'override') allowed = true;
  }
  const result = { decision: level, allowed, reasons };
  if (allowed && LEVEL[level] >= LEVEL.confirm) result.approvedBy = approval;
  return result;
}

/**
 * Holds the slots of new tasks so that two requests for the same real account cannot both take
 * the last slot: `reserve` decides and records in one synchronous step.
 */
class QuotaDispatcher {
  constructor() {
    this.slots = new Map();
    this.next = 1;
  }

  running(accountKey) {
    return this.slots.get(accountKey)?.size ?? 0;
  }

  /** @param {{ accountKey: string, externalRunning?: number }} request plus the fields of decideDispatch */
  reserve({ accountKey, externalRunning = 0, ...rest } = {}) {
    if (typeof accountKey !== 'string' || accountKey === '') return { decision: 'block', allowed: false, reasons: [{ code: 'account-key-invalid' }] };
    if (!Number.isInteger(externalRunning) || externalRunning < 0) return { decision: 'block', allowed: false, reasons: [{ code: 'running-count-invalid' }] };
    const result = decideDispatch({ ...rest, running: this.running(accountKey) + externalRunning });
    if (!result.allowed) return result;
    const id = `slot-${this.next}`;
    this.next += 1;
    if (!this.slots.has(accountKey)) this.slots.set(accountKey, new Set());
    this.slots.get(accountKey).add(id);
    return { ...result, reservation: { accountKey, id } };
  }

  /** Frees a slot. Releasing twice, or a slot that never existed, changes nothing. */
  release(reservation) {
    if (!isPlain(reservation)) return false;
    const set = this.slots.get(reservation.accountKey);
    const had = Boolean(set && set.delete(reservation.id));
    if (set && set.size === 0) this.slots.delete(reservation.accountKey);
    return had;
  }
}

const COLLECTION = 'policies';
const recordId = (accountProfileId) => `quota-${accountProfileId}`;

/** Policies are kept in the private store's `policies` collection, one record per account profile. */
function savePolicy(store, accountProfileId, input) {
  const checked = validatePolicy(input);
  if (!checked.ok) return { ok: false, reason: 'policy-invalid', problems: checked.problems };
  return store.put(COLLECTION, recordId(accountProfileId), { ...checked.policy });
}

/** The stored policy, or the default when none is stored. A stored record that is invalid is an error, never the default. */
function loadPolicy(store, accountProfileId) {
  const read = store.get(COLLECTION, recordId(accountProfileId));
  if (!read.ok) return { ok: false, reason: read.reason || 'store-unavailable' };
  if (!read.found) return { ok: true, policy: DEFAULT_POLICY, stored: false };
  const checked = validatePolicy(read.value);
  return checked.ok ? { ok: true, policy: checked.policy, stored: true } : { ok: false, reason: 'stored-policy-invalid', problems: checked.problems };
}

module.exports = { validatePolicy, decideDispatch, summarizeQuota, QuotaDispatcher, savePolicy, loadPolicy, DEFAULT_POLICY, UNKNOWN_QUOTA };
