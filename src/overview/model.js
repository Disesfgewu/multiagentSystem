'use strict';

// The overview data model: one row per session, joined with the account's display data and the
// GitHub read result. It is pure: it runs nothing, reads no file and imports no `vscode`.
//
// Every field that has no source, or whose source cannot be tied to this session, is
// `{ state: 'unknown', reason }`. Nothing is guessed and no progress percentage is made up.
// The local worktree path is never part of a row, because rows feed UI text.
//
// Where the inputs come from (the caller supplies them; this module reads nothing itself):
//   sessions     the SessionRegistry list
//   accounts     the output of `describeAccounts`
//   branches     session id -> branch, found by the caller from the worktree service's `list()`,
//                matching the session's worktree by its canonical path identity (never by name).
//                The branch is not a session field. A session without a match has no entry and
//                its branch is unknown.
//   repository   `owner/name` of the current project
//   github       the adapter's result for the pull request list: `{ kind, fetchedAt, pullRequests }`
//                where `pullRequests` is `[{ pullRequest, checks }]`. Only `ok` and `empty` are
//                complete answers; every other kind (`partial`, `truncated`, failures) is unknown.

const UNKNOWN = (reason, extra = {}) => Object.freeze({ state: 'unknown', reason, ...extra });
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) => isPlain(object) && typeof key === 'string' && Object.hasOwn(object, key);
const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value : null);
const REPOSITORY = /^([A-Za-z0-9_-][A-Za-z0-9_.-]*)\/([A-Za-z0-9_-][A-Za-z0-9_.-]*)$/;
const SHA = /^[0-9a-f]{40}$/i;
const COMPLETE = new Set(['ok', 'empty']);
const TITLE_LIMIT = 200;

// Control, format (bidirectional overrides, zero-width) and line/paragraph separator characters
// are removed from text taken from GitHub, and its length is limited.
function cleanTitle(value) {
  if (typeof value !== 'string') return '';
  return Array.from(value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim()).slice(0, TITLE_LIMIT).join('');
}

function accountField(session, accountsById, ambiguous) {
  const id = text(session.accountProfileId);
  if (id && ambiguous.has(id)) return { state: 'unknown', reason: 'ambiguous-account', id };
  const account = id ? accountsById.get(id) : undefined;
  if (!account) return { state: 'unknown', reason: 'account-not-found', id };
  if (typeof account.health !== 'string') return { state: 'unknown', reason: 'account-health-missing', id };
  return {
    state: 'known',
    id: account.id,
    provider: account.provider,
    label: account.label?.value ?? null,
    health: account.health,
    verified: account.verifiedIdentity?.state === 'verified',
    issues: Array.isArray(account.issues) ? account.issues.map((issue) => ({ code: issue.code, hint: issue.hint })) : []
  };
}

function checksField(checks, pullRequest) {
  if (!isPlain(checks) || typeof checks.state !== 'string') return UNKNOWN('checks-not-read');
  if (typeof checks.headSha !== 'string' || typeof pullRequest.headSha !== 'string' || !SHA.test(checks.headSha) || !SHA.test(pullRequest.headSha) || checks.headSha.toLowerCase() !== pullRequest.headSha.toLowerCase()) {
    return UNKNOWN('checks-for-other-head');
  }
  return { state: 'known', value: checks.state, required: typeof checks.requiredState === 'string' ? checks.requiredState : 'unknown', headSha: pullRequest.headSha.toLowerCase() };
}

const both = (reason) => ({ pullRequest: UNKNOWN(reason), ci: UNKNOWN(reason) });

function pullRequestField(branch, repository, github) {
  if (!branch) return both('no-branch');
  const match = typeof repository === 'string' ? REPOSITORY.exec(repository) : null;
  if (!match) return both('repository-unknown');
  if (!isPlain(github) || !COMPLETE.has(github.kind)) return both(isPlain(github) && ['partial', 'truncated'].includes(github.kind) ? 'github-incomplete' : 'github-unavailable');
  if (!Array.isArray(github.pullRequests)) return both('github-unavailable');

  const sameBranch = github.pullRequests.filter((entry) => isPlain(entry?.pullRequest) && entry.pullRequest.headRef === branch && entry.pullRequest.state === 'open');
  const ours = sameBranch.filter((entry) => typeof entry.pullRequest.headRepository === 'string' && entry.pullRequest.headRepository.toLowerCase() === repository.toLowerCase());
  // A same-named branch that cannot be shown to be in this repository (a fork, or no repository
  // reported) is not "no pull request": it may or may not be this session's.
  if (ours.length < sameBranch.length) return both('pull-request-repository-unverified');
  if (ours.length === 0) return { pullRequest: { state: 'none' }, ci: UNKNOWN('no-pull-request') };
  if (ours.length > 1) return both('ambiguous-branch');
  const [{ pullRequest, checks }] = ours;
  if (!Number.isSafeInteger(pullRequest.number) || pullRequest.number <= 0) return both('pull-request-unreadable');
  return {
    pullRequest: {
      state: 'open',
      number: pullRequest.number,
      title: cleanTitle(pullRequest.title),
      draft: pullRequest.draft === true,
      // built here from the repository and the number; a URL passed in is never trusted
      url: `https://github.com/${match[1]}/${match[2]}/pull/${pullRequest.number}`
    },
    ci: checksField(checks, pullRequest)
  };
}

function unreadableRow() {
  return { sessionId: null, malformed: true, role: UNKNOWN('session-unreadable'), account: UNKNOWN('session-unreadable'), branch: UNKNOWN('session-unreadable'), sessionState: UNKNOWN('session-unreadable'), ...both('session-unreadable') };
}

/**
 * @param {{ sessions: object[], accounts?: object[], roleGroups?: Record<string, string>,
 *           branches?: Record<string, string>, repository?: string, github?: object }} input
 */
function buildOverview({ sessions, accounts = [], roleGroups = {}, branches = {}, repository, github } = {}) {
  if (!Array.isArray(sessions)) throw new TypeError('sessions must be a list');
  let problems = 0;
  const accountsById = new Map();
  const ambiguous = new Set();
  for (const account of Array.isArray(accounts) ? accounts : []) {
    if (!isPlain(account) || typeof account.id !== 'string') { problems += 1; continue; }
    if (accountsById.has(account.id)) ambiguous.add(account.id);
    accountsById.set(account.id, account);
  }

  const rows = sessions.map((session) => {
    if (!isPlain(session) || typeof session.id !== 'string') { problems += 1; return unreadableRow(); }
    const branch = own(branches, session.id) ? text(branches[session.id]) : null;
    const roleName = own(roleGroups, session.roleGroupId) ? text(roleGroups[session.roleGroupId]) : null;
    return {
      sessionId: session.id,
      role: roleName ? { state: 'known', id: session.roleGroupId, name: roleName } : { state: 'unknown', reason: 'role-not-found', id: text(session.roleGroupId) },
      account: accountField(session, accountsById, ambiguous),
      branch: branch ? { state: 'known', value: branch } : UNKNOWN('branch-not-reported'),
      sessionState: !text(session.state) || session.state === 'unknown' ? UNKNOWN('not-observed') : { state: 'known', value: session.state, observedAt: session.observedAt ?? null },
      ...pullRequestField(branch, repository, github)
    };
  });
  return {
    rows,
    problems,
    empty: rows.length === 0 ? 'no-sessions' : null,
    github: isPlain(github) && COMPLETE.has(github.kind) ? { state: 'ok', fetchedAt: github.fetchedAt ?? null } : UNKNOWN(isPlain(github) && ['partial', 'truncated'].includes(github.kind) ? 'github-incomplete' : 'github-unavailable')
  };
}

module.exports = { buildOverview };
