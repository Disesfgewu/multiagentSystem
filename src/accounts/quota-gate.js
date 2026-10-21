'use strict';

const { decideDispatch, summarizeQuota, validatePolicy, DEFAULT_POLICY } = require('./quota-policy');

/**
 * Decides and, in the same step, atomically reserves a dispatch slot through `dispatcher`. This is
 * the one call that actually GRANTS a launch (made once, right when access is about to be given,
 * never for an earlier read-only preview that only decides what dialog to show): two callers racing
 * to reserve the last slot cannot both succeed, because `dispatcher.reserve` decides and records in
 * one synchronous step. Even an account with no stored policy takes a tracking slot, so setting
 * limits later counts its already-open sessions. With no policy the reservation has no limits
 * and needs no quota confirmation; an unreadable policy still refuses the launch.
 *
 * @param {{ policyRead: object, observations?: object[], now: Date, dispatcher: object, accountKey: string, approval?: string }} input
 * @returns {{ ok: true, release: () => void } | { ok: false, code: string, message: string }}
 */
function commitDispatch({ policyRead, observations = [], now, dispatcher, accountKey, approval } = {}) {
  if (!policyRead || policyRead.ok !== true) {
    return { ok: false, code: 'quota-gate', message: 'The limits saved for this account could not be read, so no new agent was started.' };
  }
  const constrained = policyRead.stored === true;
  const reserved = dispatcher.reserve({ accountKey, policy: constrained ? policyRead.policy : DEFAULT_POLICY, observations: constrained ? observations : [], now, approval: constrained ? approval : 'override' });
  if (!reserved.allowed) return { ok: false, code: 'quota-gate', message: reserved.reasons.map(wordsFor).join(' ') };
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

// Why an account has no usable usage number. A code is one specific, checkable situation; `short` is the
// phrase for a list row, `detail` the sentence for the account details. Where the cause is inferred rather
// than observed, the words say "likely". Unknown codes are ignored (the generic sentence stays).
const UNKNOWN_REASONS = Object.freeze({
  'no-source-agy': { short: 'no verified usage source for agy', detail: 'agy has no verified usage source, so its usage stays unknown and is never estimated.' },
  'codex-no-sessions': { short: 'no Codex session log yet', detail: 'This account\'s Codex home has no session log yet, so there is nothing to read. Usage appears after the first Codex session in this account.' },
  'codex-no-events': { short: 'no usage in the Codex log yet', detail: 'The newest Codex session logs of this account hold no usage report yet, so nothing is shown.' },
  'codex-format-changed': { short: 'Codex log format not recognized', detail: 'The Codex session log has usage reports, but not in the form this extension understands (Codex may have changed its log format), so none is used.' },
  'codex-reading-expired': { short: 'last Codex reading is out of date', detail: 'The last usage report in the Codex session log is out of date, so it is not used to block and is listed below for reference only. It is the snapshot of the last Codex activity and is refreshed when Codex runs again.' },
  'no-source-provider': { short: 'no verified usage source for this provider', detail: 'This provider has no verified usage source, so its usage stays unknown and is never estimated.' },
  'bridge-not-enabled': { short: 'usage bridge not enabled', detail: 'The Claude status line bridge is not enabled for this account, so nothing reports its usage. Use Configure Claude Status Line Bridge to turn it on; readings then arrive only from a running session.' },
  'bridge-other-statusline': { short: 'usage bridge not active', detail: 'A different status line command is set for this account, so the usage bridge is not active and nothing reports its usage. Use Configure Claude Status Line Bridge to review it.' },
  'bridge-state-unknown': { short: 'bridge state unknown', detail: 'The Claude settings for this account could not be read, so it is not known whether the usage bridge is enabled.' },
  'bridge-no-data': { short: 'bridge on, no reading yet', detail: 'The usage bridge is enabled but has not written a reading. Readings arrive only while a Claude session is running, so likely no session has run since it was enabled.' },
  'reading-expired': { short: 'last reading is out of date', detail: 'The last reading is out of date, so it is not used to block and is listed below for reference only. A running Claude session refreshes it.' },
  'file-unreadable': { short: 'usage file unreadable or unsafe', detail: 'The usage file for this account could not be read safely (missing permissions, a link, an unexpected shape or too large), so it was ignored.' },
  'timestamp-future': { short: 'reading time is in the future', detail: 'The usage file claims it was written in the future, so it is not trusted and no percentage is shown.' },
  'timestamp-invalid': { short: 'reading has no valid time', detail: 'The usage file has no valid read time, so it is not trusted and no percentage is shown.' },
  'rate-limits-absent': { short: 'no rate limits reported', detail: 'The session reported no rate limits. Likely this account type does not report them (subscription accounts only), or no reply had completed yet.' },
  'window-reset-passed': { short: 'window reset since the reading', detail: 'The usage window in the last reading has since reset, so that reading no longer describes the account.' }
});

const SECOND = 1000; const MINUTE = 60 * SECOND; const HOUR = 60 * MINUTE; const DAY = 24 * HOUR;
const MAX_SPAN = 366 * DAY;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

function toMs(value) {
  if (!(typeof value === 'string' && ISO_TIME.test(value))) return NaN;
  return Date.parse(value);
}

function nowMs(now) {
  const ms = now instanceof Date ? now.getTime() : typeof now === 'number' ? now : NaN;
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * "resets in 2h 10m" for a reset time (ISO-8601 string) after `now`. A value that is not a valid time, is
 * not after `now`, or is more than a year away shows "reset time unknown": it is never shown as a number.
 */
function formatResetTime(value, now) {
  const at = toMs(value); const base = nowMs(now);
  const span = at - base;
  if (!Number.isFinite(span) || span <= 0 || span > MAX_SPAN) return 'reset time unknown';
  if (span < MINUTE) return 'resets in under 1m';
  if (span < HOUR) return `resets in ${Math.floor(span / MINUTE)}m`;
  if (span < DAY) {
    const m = Math.floor((span % HOUR) / MINUTE);
    return `resets in ${Math.floor(span / HOUR)}h${m > 0 ? ` ${m}m` : ''}`;
  }
  const h = Math.floor((span % DAY) / HOUR);
  return `resets in ${Math.floor(span / DAY)}d${h > 0 ? ` ${h}h` : ''}`;
}

/** "read 3 min ago" for the time a reading was taken. Invalid or future times show "read time unknown". */
function formatReadTime(value, now) {
  const at = toMs(value); const base = nowMs(now);
  const age = base - at;
  if (!Number.isFinite(age) || age < 0) return 'read time unknown';
  if (age > MAX_SPAN) return 'read over a year ago';
  if (age < MINUTE) return 'read just now';
  if (age < HOUR) return `read ${Math.floor(age / MINUTE)} min ago`;
  if (age < DAY) return `read ${Math.floor(age / HOUR)} h ago`;
  return `read ${Math.floor(age / DAY)} d ago`;
}

/** What is known about this account's usage. Without a verified reading it says so and why. */
function describeQuota(observations, now, unknownReason) {
  const windows = summarizeQuota(observations, now);
  const reason = typeof unknownReason === 'string' && Object.hasOwn(UNKNOWN_REASONS, unknownReason) ? UNKNOWN_REASONS[unknownReason] : null;
  // The reason is only shown when no window has a current number: it never sits beside a current percentage.
  // An out-of-date number may still be listed below it, labelled as not used.
  const unknownLines = reason && windows.every((w) => !w.fresh)
    ? [`Usage: unknown (${reason.short}).`, `Why: ${reason.detail}`]
    : [];
  if (windows.length === 0) return unknownLines.length > 0 ? unknownLines : ['Usage: unknown. No verified usage source is connected for this account, so no percentage is shown.'];
  return [...unknownLines, ...windows.map((w) => {
    const used = w.usedPercent === null ? 'unknown' : `${w.usedPercent}% used`;
    const observedMs = Date.parse(w.observedAt);
    const nowValue = nowMs(now);
    const futureTime = Number.isFinite(observedMs) && Number.isFinite(nowValue) && observedMs > nowValue;
    const invalidTime = !Number.isFinite(observedMs) || !Number.isFinite(nowValue);
    const trust = futureTime ? 'timestamp is in the future (not used to block)' : invalidTime ? 'invalid read time (not used to block)' : w.usedPercent === null ? 'invalid or missing reading (not used to block)' : w.gateEligible ? 'verified and current' : w.fresh && w.confidence === 'estimated' ? 'estimate (not used to block)' : w.fresh ? 'source unverified (not used to block)' : 'out of date (not used to block)';
    const reset = w.resetsAt ? `, ${formatResetTime(w.resetsAt, now)}` : '';
    return `Usage (${safe(w.window)}): ${used}, ${trust}${reset}. ${capital(formatReadTime(w.observedAt, now))} from ${safeDetail(w.source, 60) || 'an unknown source'}.`;
  })];
}

const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);
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

module.exports = { gateLaunch, commitDispatch, describePolicy, describeQuota, formatResetTime, formatReadTime, UNKNOWN_REASONS, describeCurrentState, policyFromInput, wordsFor, LIMITS_NOTE, REASON_WORDS };
