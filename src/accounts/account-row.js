'use strict';

const { formatResetTime, formatReadTime, UNKNOWN_REASONS } = require('./quota-gate');
const { REASONS } = require('./identity-check');

/**
 * What one account row of the Accounts view says (#352): which account it is (the e-mail address and organization the CLI reported,
 * shown only here), its plan, whether it is signed in and when that was checked, and its usage, as one line, with the details below
 * it. When there is no usage number the row says why and what to do, never only "unknown". Pure: it is given what was read.
 */

const WINDOW_NAMES = Object.freeze({ five_hour: '5h', seven_day: '7d', seven_day_opus: '7d Opus', seven_day_sonnet: '7d Sonnet' });
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
const windowName = (window) => (typeof window === 'string' && Object.hasOwn(WINDOW_NAMES, window) ? WINDOW_NAMES[window] : 'usage');

/**
 * The usage part of the row from `quotaDetail`. `attention` when the person should do something.
 * @returns {{ text: string, attention: boolean }}
 */
function quotaSummary(detail, now = new Date()) {
  if (!isPlain(detail) || detail.ok !== true || !Array.isArray(detail.windows)) return { text: 'usage could not be read', attention: true };
  const shown = detail.windows.filter((window) => isPlain(window) && Number.isFinite(window.usedPercent));
  const current = shown.filter((window) => window.fresh === true);
  if (current.length > 0) {
    return {
      text: current.map((window) => {
        const reset = typeof window.resetsAt === 'string' ? formatResetTime(window.resetsAt, now) : null;
        return `${windowName(window.window)} ${window.usedPercent}%${reset && reset !== 'reset time unknown' ? ` (${reset})` : ''}`;
      }).join(' · '),
      attention: false
    };
  }
  const reason = typeof detail.unknownReason === 'string' ? detail.unknownReason : null;
  const step = reason && Object.hasOwn(NEXT_STEPS, reason) ? NEXT_STEPS[reason] : reason && Object.hasOwn(UNKNOWN_REASONS, reason) ? UNKNOWN_REASONS[reason].short : 'no usage reading for this account yet';
  // An out-of-date number is shown as such, beside why there is no current one.
  const stale = shown.map((window) => `${windowName(window.window)} ${window.usedPercent}% (out of date, ${formatReadTime(window.observedAt, now)})`);
  return { text: [`usage unknown: ${step}`, ...stale].join(' · '), attention: reason === 'bridge-not-enabled' || reason === 'bridge-other-statusline' || reason === 'file-unreadable' || reason === 'bridge-state-unknown' };
}

const PLAN_LABELS = Object.freeze({ free: 'Free', pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise' });

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

module.exports = { quotaSummary, identitySummary, accountsOverview, duplicateLine, NEXT_STEPS, WINDOW_NAMES };
