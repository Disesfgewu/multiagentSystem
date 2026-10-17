'use strict';

const { decideDispatch, summarizeQuota, validatePolicy, DEFAULT_POLICY } = require('./quota-policy');

/**
 * Decides and, in the same step, atomically reserves a dispatch slot through `dispatcher`. This is
 * the one call that actually GRANTS a launch (made once, right when access is about to be given,
 * never for an earlier read-only preview that only decides what dialog to show): two callers racing
 * to reserve the last slot cannot both succeed, because `dispatcher.reserve` decides and records in
 * one synchronous step. An account with no stored policy, or an unreadable one, never touches the
 * dispatcher: with no policy there is nothing to protect, and with an unreadable one the launch is
 * already refused.
 *
 * @param {{ policyRead: object, observations?: object[], now: Date, dispatcher: object, accountKey: string, approval?: string }} input
 * @returns {{ ok: true, release: () => void } | { ok: false, code: string, message: string }}
 */
function commitDispatch({ policyRead, observations = [], now, dispatcher, accountKey, approval } = {}) {
  if (!policyRead || policyRead.ok !== true) {
    return { ok: false, code: 'quota-gate', message: 'The limits saved for this account could not be read, so no new agent was started.' };
  }
  if (policyRead.stored !== true) return { ok: true, release: () => {} };
  const reserved = dispatcher.reserve({ accountKey, policy: policyRead.policy, observations, now, approval });
  if (!reserved.allowed) return { ok: false, code: 'quota-gate', message: 'Another agent for this account was started first and took the last slot. Try again.' };
  let released = false;
  return { ok: true, release: () => { if (!released) { released = true; dispatcher.release(reserved.reservation); } } };
}

// What the person sees about an account's limits, in plain words, and the gate that runs before a new
// session starts on an account. The decision itself is `decideDispatch` (quota-policy.js); this module
// adds the part that turns it into an action and into sentences. An account with no stored policy has no
// limits and is never gated. A stored policy that cannot be read stops the launch (fail closed), because
// the person asked for limits and they cannot be checked.

const REASON_WORDS = Object.freeze({
  'concurrency-limit': (r) => `${r.running} agent${r.running === 1 ? ' is' : 's are'} already running on this account, and the limit is ${r.limit}.`,
  'quota-block-threshold': (r) => `A usage window (${safe(r.window)}) reported ${r.usedPercent}% used, at or above your pause level.`,
  'quota-warn-threshold': (r) => `A usage window (${safe(r.window)}) reported ${r.usedPercent}% used, above your warning level.`,
  'quota-unknown': (r) => `No verified, current usage reading is available for this account, and your setting is "${r.policy === 'block' ? 'do not start new agents' : 'ask me first'}".`,
  'window-unverified': (r) => `The reading for the ${safe(r.window)} window is an estimate or out of date, so it is shown but not used to block.`,
  'unverified-reading-over-warning': (r) => `The ${safe(r.window)} window looks high, but the reading is an estimate or out of date, so it only warns.`,
  'policy-invalid': () => 'The limits saved for this account are not valid.',
  'running-count-invalid': () => 'The number of running agents could not be worked out.',
  'time-invalid': () => 'The time could not be read.'
});

const LIMITS_NOTE = 'Usage can change between two readings, so these limits cannot promise to stop every request that would go over.';

// A window name comes from the CLI's report: only short, plain names are shown.
const safe = (value) => (typeof value === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value) ? value : 'unnamed');

function wordsFor(reason) {
  const make = reason && Object.hasOwn(REASON_WORDS, reason.code) ? REASON_WORDS[reason.code] : null;
  return make ? make(reason) : 'The account\'s limits stopped this.';
}

/**
 * @param {{ policyRead: { ok: boolean, policy?: object, stored?: boolean }, observations?: object[], now: Date, running: number, interactive?: boolean, approval?: string }} input
 *   `policyRead` is the result of `loadPolicy`
 * @returns {{ action: 'allow'|'warn'|'confirm'|'block', allowed: boolean, overridable: boolean, lines: string[], note: string|null, reasons: object[] }}
 */
function gateLaunch({ policyRead, observations = [], now, running, approval } = {}) {
  if (!policyRead || policyRead.ok !== true) {
    return { action: 'block', allowed: false, overridable: false, lines: ['The limits saved for this account could not be read, so no new agent was started.'], note: null, reasons: [{ code: 'policy-unreadable' }] };
  }
  if (policyRead.stored !== true) return { action: 'allow', allowed: true, overridable: false, lines: [], note: null, reasons: [] };
  const decision = decideDispatch({ policy: policyRead.policy, observations, now, running, approval });
  const reasons = decision.reasons;
  const overridable = !reasons.some((reason) => reason.overridable === false) && reasons.some((reason) => reason.overridable === true);
  return {
    action: decision.allowed && (decision.decision === 'confirm' || decision.decision === 'block') ? 'allow' : decision.decision,
    allowed: decision.allowed,
    overridable,
    lines: reasons.map(wordsFor),
    note: LIMITS_NOTE,
    reasons
  };
}

/** The limits as sentences, or "no limits". */
function describePolicy(policyRead) {
  if (!policyRead || policyRead.ok !== true) return 'Limits: could not be read.';
  if (policyRead.stored !== true) return 'Limits: none set. Use Set Account Limits to add a warning, pause level or running limit; new agents on this account are never held back.';
  const p = policyRead.policy;
  const parts = [];
  if (p.warnAtPercent !== undefined) parts.push(`warn at ${p.warnAtPercent}% used`);
  if (p.blockAtPercent !== undefined) parts.push(`pause new agents at ${p.blockAtPercent}%`);
  if (p.maxConcurrent !== undefined) parts.push(`at most ${p.maxConcurrent} running at once`);
  parts.push(p.unknownQuota === 'block' ? 'if usage is unknown, do not start new agents' : 'if usage is unknown, ask first');
  return `Limits: ${parts.join('; ')}.`;
}

/** What is known about this account's usage. Without a verified reading it says so and why. */
function describeQuota(observations, now) {
  const windows = summarizeQuota(observations, now);
  if (windows.length === 0) return ['Usage: unknown. No verified usage source is connected for this account, so no percentage is shown.'];
  return windows.map((w) => {
    const used = w.usedPercent === null ? 'unknown' : `${w.usedPercent}% used`;
    const observedMs = Date.parse(w.observedAt);
    const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
    const futureTime = Number.isFinite(observedMs) && Number.isFinite(nowMs) && observedMs > nowMs;
    const invalidTime = !Number.isFinite(observedMs) || !Number.isFinite(nowMs);
    const trust = futureTime ? 'timestamp is in the future (not used to block)' : invalidTime ? 'invalid read time (not used to block)' : w.usedPercent === null ? 'invalid or missing reading (not used to block)' : w.gateEligible ? 'verified and current' : w.fresh && w.confidence === 'estimated' ? 'estimate (not used to block)' : w.fresh ? 'source unverified (not used to block)' : 'out of date (not used to block)';
    const reset = w.resetsAt ? `, resets ${safeDetail(w.resetsAt, 40)}` : '';
    return `Usage (${safe(w.window)}): ${used}, ${trust}${reset}. Read ${safeDetail(w.observedAt, 40) || 'at an unknown time'} from ${safeDetail(w.source, 60) || 'an unknown source'}.`;
  });
}

const safeDetail = (value, max) => typeof value === 'string' ? Array.from(value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim()).slice(0, max).join('') : '';

/**
 * What starting a new agent on this account would do right now, in plain words, with a pointer to
 * the one action (Set Account Limits) that can change it. Takes a `gateLaunch` result directly, so a
 * caller computes the decision once and can both act on it and describe it from the same object; this
 * never re-decides anything on its own.
 *
 * @param {{ action: 'allow'|'warn'|'confirm'|'block', lines: string[] }} decision
 * @returns {string}
 */
function describeCurrentState(decision) {
  const reason = decision.lines[0];
  if (decision.action === 'allow') return 'Right now: a new agent on this account would start.';
  if (decision.action === 'warn') return `Right now: a new agent would start with a warning. ${reason ?? ''}`.trim();
  if (decision.action === 'confirm') return `Right now: a new agent would need your confirmation. ${reason ?? ''} Use Set Account Limits to change this.`.trim();
  return `Right now: a new agent would be held back. ${reason ?? ''} Use Set Account Limits to change this.`.trim();
}

/** Turns what a person typed into a stored policy, or the problems in plain words. */
function policyFromInput({ warn, block, max, unknownQuota }) {
  const number = (text) => (typeof text === 'string' && text.trim() !== '' ? Number(text.trim()) : undefined);
  const candidate = { unknownQuota: unknownQuota ?? DEFAULT_POLICY.unknownQuota };
  const warnAt = number(warn); const blockAt = number(block); const maxN = number(max);
  if (warn !== undefined && warn !== null && String(warn).trim() !== '') candidate.warnAtPercent = warnAt;
  if (block !== undefined && block !== null && String(block).trim() !== '') candidate.blockAtPercent = blockAt;
  if (max !== undefined && max !== null && String(max).trim() !== '') candidate.maxConcurrent = maxN;
  const checked = validatePolicy(candidate);
  if (checked.ok) return { ok: true, policy: checked.policy, problems: [] };
  const words = {
    'warn-percent-invalid': 'The warning level must be a number from 0 to 100.',
    'block-percent-invalid': 'The pause level must be a number from 0 to 100.',
    'warn-above-block': 'The warning level cannot be higher than the pause level.',
    'max-concurrent-invalid': 'The running limit must be a whole number from 1 to 64.',
    'unknown-quota-invalid': 'Choose what to do when usage is unknown.',
    'policy-unknown-field': 'An unknown setting was given.'
  };
  return { ok: false, problems: checked.problems.map((code) => words[code] ?? 'The limits are not valid.') };
}

module.exports = { gateLaunch, commitDispatch, describePolicy, describeQuota, describeCurrentState, policyFromInput, wordsFor, LIMITS_NOTE, REASON_WORDS };
