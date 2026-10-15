'use strict';

// The overview data model: one row per session, joined with the account's display data and the
// GitHub read result. It is pure: it runs nothing, reads no file and imports no `vscode`.
//
// Every field that has no source is `{ state: 'unknown', reason }`. Nothing is guessed and no
// progress percentage is made up. The local worktree path is never part of a row, because rows
// feed UI text and may be copied elsewhere.

const UNKNOWN = (reason) => Object.freeze({ state: 'unknown', reason });
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value : null);
const GITHUB_URL = /^https:\/\/github\.com\/[A-Za-z0-9._\-/#?=&%]*$/;

function accountField(session, accountsById) {
  const account = accountsById.get(session.accountProfileId);
  if (!account) return { state: 'unknown', reason: 'account-not-found', id: text(session.accountProfileId) };
  return {
    state: 'known',
    id: account.id,
    provider: account.provider,
    label: account.label?.value ?? null,
    health: account.health,
    verified: account.verifiedIdentity?.state === 'verified',
    issues: (account.issues || []).map((issue) => ({ code: issue.code, hint: issue.hint }))
  };
}

function checksField(checks) {
  if (!isPlain(checks) || typeof checks.state !== 'string') return UNKNOWN('checks-not-read');
  return { state: 'known', value: checks.state, required: typeof checks.requiredState === 'string' ? checks.requiredState : 'unknown', headSha: checks.headSha ?? null };
}

function pullRequestField(branch, github) {
  if (!branch) return { pullRequest: UNKNOWN('no-branch'), ci: UNKNOWN('no-branch') };
  if (!github || github.state !== 'ok' || !Array.isArray(github.pullRequests)) {
    return { pullRequest: UNKNOWN('github-unavailable'), ci: UNKNOWN('github-unavailable') };
  }
  const matches = github.pullRequests.filter((entry) => isPlain(entry?.pullRequest) && entry.pullRequest.headRef === branch && entry.pullRequest.state === 'open');
  if (matches.length === 0) return { pullRequest: { state: 'none' }, ci: UNKNOWN('no-pull-request') };
  if (matches.length > 1) return { pullRequest: UNKNOWN('ambiguous-branch'), ci: UNKNOWN('ambiguous-branch') };
  const [{ pullRequest, checks }] = matches;
  const url = typeof pullRequest.htmlUrl === 'string' && GITHUB_URL.test(pullRequest.htmlUrl) ? pullRequest.htmlUrl : null;
  return {
    pullRequest: { state: 'open', number: pullRequest.number, title: text(pullRequest.title) ?? '', draft: pullRequest.draft === true, url },
    ci: checksField(checks)
  };
}

/**
 * @param {{
 *   sessions: object[],
 *   accounts?: object[],
 *   roleGroups?: Record<string, string>,
 *   branches?: Record<string, string>,
 *   github?: { state: 'ok'|'unavailable', fetchedAt?: string, pullRequests?: Array<{ pullRequest: object, checks?: object }> }
 * }} input `accounts` is the output of `describeAccounts`; `branches` maps a session id to its branch.
 */
function buildOverview({ sessions, accounts = [], roleGroups = {}, branches = {}, github } = {}) {
  if (!Array.isArray(sessions)) throw new TypeError('sessions must be a list');
  const accountsById = new Map(accounts.map((account) => [account.id, account]));
  const rows = sessions.map((session) => {
    const branch = text(branches[session.id]);
    const roleName = text(roleGroups[session.roleGroupId]);
    return {
      sessionId: session.id,
      role: roleName ? { state: 'known', id: session.roleGroupId, name: roleName } : { state: 'unknown', reason: 'role-not-found', id: text(session.roleGroupId) },
      account: accountField(session, accountsById),
      branch: branch ? { state: 'known', value: branch } : UNKNOWN('branch-not-reported'),
      sessionState: session.state === 'unknown' || !text(session.state) ? UNKNOWN('not-observed') : { state: 'known', value: session.state, observedAt: session.observedAt ?? null },
      ...pullRequestField(branch, github)
    };
  });
  return {
    rows,
    empty: rows.length === 0 ? 'no-sessions' : null,
    github: github?.state === 'ok' ? { state: 'ok', fetchedAt: github.fetchedAt ?? null } : UNKNOWN('github-unavailable')
  };
}

module.exports = { buildOverview };
