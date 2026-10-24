'use strict';

const { formatResetTime, formatReadTime, UNKNOWN_REASONS } = require('./quota-gate');
const { REASONS } = require('./identity-check');

/**
 * What one account row of the Accounts view says (#352): which account it is (the e-mail address and organization the CLI reported,
 * shown only here), its plan, whether it is signed in and when that was checked, and its usage, as one line, with the details below
 * it. When there is no usage number the row says why and what to do, never only "unknown". Pure: it is given what was read.
 */

const WINDOW_NAMES = Object.freeze({ five_hour: '5h', seven_day: '7d', seven_day_opus: '7d Opus', seven_day_sonnet: '7d Sonnet' });
// The 5-hour and weekly windows always have a place in the row, read or not; per-model weekly windows follow when there are any.
const BASE_WINDOWS = Object.freeze(['five_hour', 'seven_day']);
const SEVEN_DAY_MODEL = /^seven_day_[a-z][a-z0-9_]{0,39}$/;
// What to do when there is no current usage number, for the reasons a person can act on; the rest say what the reason says.
const NEXT_STEPS = Object.freeze({
  'bridge-not-enabled': 'status line not set up: use Configure Claude Status Line Bridge',
  'bridge-other-statusline': 'another status line is set: use Configure Claude Status Line Bridge to review it',
  'bridge-no-data': 'no agent has run on this account yet: start one and its usage appears',
  'reading-expired': 'last reading is out of date: it refreshes while an agent runs on this account',
  'window-reset-passed': 'the usage window has reset since the last reading: it refreshes while an agent runs',
  'codex-no-sessions': 'no Codex session has run on this account yet: start one and its usage appears',
  'codex-no-events': 'no usage reported yet: it appears after a Codex reply on this account',
  'codex-reading-expired': 'last reading is out of date: it refreshes when Codex runs on this account',
  'rate-limits-absent': 'this account reports no usage limits (likely not a subscription account)'
});

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const capital = (word) => word.charAt(0).toUpperCase() + word.slice(1);
function windowName(window) {
  if (typeof window === 'string' && Object.hasOwn(WINDOW_NAMES, window)) return WINDOW_NAMES[window];
  if (typeof window === 'string' && SEVEN_DAY_MODEL.test(window)) return `7d ${window.slice('seven_day_'.length).split('_').filter(Boolean).map(capital).join(' ')}`;
  return 'usage';
}

/**
 * The usage part of the row from `quotaDetail`. `attention` when the person should do something. 5h and 7d always have a part:
 * the current number with its reset, an out-of-date number with when it was read, or why there is none.
 * @returns {{ text: string, attention: boolean }}
 */
function quotaSummary(detail, now = new Date()) {
  if (!isPlain(detail) || detail.ok !== true || !Array.isArray(detail.windows)) return { text: 'usage could not be read', attention: true };
  const byName = new Map(detail.windows.filter((window) => isPlain(window) && typeof window.window === 'string').map((window) => [window.window, window]));
  const reason = typeof detail.unknownReason === 'string' ? detail.unknownReason : null;
  const step = reason && Object.hasOwn(NEXT_STEPS, reason) ? NEXT_STEPS[reason] : reason && Object.hasOwn(UNKNOWN_REASONS, reason) ? UNKNOWN_REASONS[reason].short : 'no usage reading for this account yet';
  const attention = reason === 'bridge-not-enabled' || reason === 'bridge-other-statusline' || reason === 'file-unreadable' || reason === 'bridge-state-unknown';
  const numbered = [...byName.values()].filter((window) => Number.isFinite(window.usedPercent));
  // No number at all: one reason for the whole account, with what to do.
  if (numbered.length === 0) return { text: `usage unknown: ${step}`, attention };
  const names = [...BASE_WINDOWS, ...[...byName.keys()].filter((name) => SEVEN_DAY_MODEL.test(name)).sort()];
  const parts = names.map((name) => {
    const window = byName.get(name);
    const label = windowName(name);
    if (!window) return `${label}: not reported in the last reading`;
    if (!Number.isFinite(window.usedPercent)) return `${label}: the last reading has no usable number`;
    if (window.fresh === true) {
      const reset = typeof window.resetsAt === 'string' ? formatResetTime(window.resetsAt, now) : null;
      return `${label} ${window.usedPercent}%${reset && reset !== 'reset time unknown' ? ` (${reset})` : ''}`;
    }
    return `${label} ${window.usedPercent}% (out of date, ${formatReadTime(window.observedAt, now)})`;
  });
  const current = numbered.some((window) => window.fresh === true);
  return current ? { text: parts.join(' · '), attention: false } : { text: [`usage unknown: ${step}`, ...parts].join(' · '), attention };
}

const PLAN_LABELS = Object.freeze({ free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', max: 'Max', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu' });

/**
 * Which account it is and whether it is signed in. `display` is the e-mail address and organization from this window's last check
 * (memory only); after a reload it is missing until the check that runs on start has answered.
 * @returns {{ text: string, signedIn: boolean | null, attention: boolean, lines: string[] }}
 */
function identitySummary({ check, display, now = new Date(), checking = false } = {}) {
  if (!isPlain(check)) return { text: checking ? 'checking sign-in…' : 'sign-in not checked yet', signedIn: null, attention: !checking, lines: [checking ? 'The sign-in is being checked.' : 'The sign-in has not been checked yet. Use Check Sign-in.'] };
  const when = `checked ${formatReadTime(check.checkedAt, now).replace(/^read /, '')}${check.restored ? ' (before this window opened)' : ''}`;
  if (check.state !== 'checked' || !isPlain(check.identity)) {
    const words = REASONS[check.reason] ?? REASONS['run-failed'];
    return { text: `sign-in unknown · ${when}`, signedIn: null, attention: true, lines: [`Sign-in: unknown. ${words.summary}`, `Next: ${words.hint}`, `Last check: ${check.checkedAt}`] };
  }
  const identity = check.identity;
  if (identity.loggedIn !== true) return { text: `not signed in · ${when}`, signedIn: false, attention: true, lines: ['Sign-in: not signed in.', 'Next: open the login terminal (Sign In to Account), sign in, then check again.', `Last check: ${check.checkedAt}`] };
  const email = isPlain(display) && typeof display.email === 'string' ? display.email : null;
  const organization = isPlain(display) && typeof display.organization === 'string' ? display.organization : null;
  const planValue = isPlain(identity.plan) && typeof identity.plan.value === 'string' && Object.hasOwn(PLAN_LABELS, identity.plan.value) ? PLAN_LABELS[identity.plan.value] : null;
  const who = email ? `${email}${organization ? ` (${organization})` : ''}` : checking ? 'account: checking…' : 'account: shown after the next check';
  const parts = [who, planValue ? `${planValue} plan` : 'plan unknown', 'signed in', when];
  const lines = [
    `Account: ${email ?? (checking ? 'checking…' : 'not known in this window yet (it is shown after the next check)')}${organization ? ` · Organization: ${organization}` : ''}`,
    `Plan: ${planValue ?? 'unknown (the CLI did not report a known plan)'}`,
    'Sign-in: signed in.',
    `Last check: ${check.checkedAt}${check.restored ? ' (saved from before this window opened)' : ''}`
  ];
  return { text: parts.join(' · '), signedIn: true, attention: false, lines };
}

/** The line above all accounts: how many there are, how many are signed in, how many need something. */
function accountsOverview(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const signedIn = list.filter((row) => row && row.signedIn === true).length;
  const attention = list.filter((row) => row && row.attention === true).length;
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  return `${plural(list.length, 'account')} · ${signedIn} signed in · ${attention === 0 ? 'nothing needs attention' : `${attention} need${attention === 1 ? 's' : ''} attention`}`;
}

/** The words for an account that logs in to the same real account as others: which ones, and how to fix it. */
function duplicateLine(duplicateLabels) {
  const labels = (Array.isArray(duplicateLabels) ? duplicateLabels : []).filter((label) => typeof label === 'string' && label !== '');
  if (labels.length === 0) return null;
  return `Same account as ${labels.map((label) => `“${label}”`).join(', ')}: both folders are signed in to one real account, so their usage is counted together. Sign one of them in to another account (Sign In to Account), or remove it.`;
}

module.exports = { quotaSummary, identitySummary, accountsOverview, duplicateLine, NEXT_STEPS, WINDOW_NAMES, PLAN_LABELS };
