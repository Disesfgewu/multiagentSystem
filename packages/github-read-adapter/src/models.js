'use strict';

const { isSha } = require('./validate');
const { extractIssueReferences } = require('./references');

class MalformedPayloadError extends Error {
  constructor(field) {
    super(`malformed payload: ${field}`);
    this.name = 'MalformedPayloadError';
    this.field = field;
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const optString = (value) => (typeof value === 'string' ? value : null);
const login = (user) => (isObject(user) && typeof user.login === 'string' ? user.login : null);

function need(condition, field) {
  if (!condition) throw new MalformedPayloadError(field);
}

function positiveInteger(value, field) {
  need(Number.isSafeInteger(value) && value > 0, field);
  return value;
}

function labelNames(labels) {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label) => (typeof label === 'string' ? label : isObject(label) ? label.name : undefined))
    .filter((name) => typeof name === 'string');
}

function logins(users) {
  return Array.isArray(users) ? users.map(login).filter((name) => name !== null) : [];
}

function normalizeRepository(raw, urls, repo) {
  need(isObject(raw), 'repository');
  const permissions = isObject(raw.permissions)
    ? { admin: raw.permissions.admin === true, push: raw.permissions.push === true, pull: raw.permissions.pull === true }
    : null;
  return {
    id: positiveInteger(raw.id, 'repository.id'),
    fullName: optString(raw.full_name) || `${repo.owner}/${repo.name}`,
    defaultBranch: optString(raw.default_branch),
    private: raw.private === true,
    archived: raw.archived === true,
    hasIssues: raw.has_issues !== false,
    viewerPermissions: permissions,
    htmlUrl: urls.safe(raw.html_url, urls.repository(repo))
  };
}

function normalizeIssue(raw, urls, repo) {
  need(isObject(raw), 'issue');
  const number = positiveInteger(raw.number, 'issue.number');
  need(raw.state === 'open' || raw.state === 'closed', 'issue.state');
  return {
    number,
    title: optString(raw.title) || '',
    state: raw.state,
    stateReason: optString(raw.state_reason),
    body: optString(raw.body),
    author: login(raw.user),
    labels: labelNames(raw.labels),
    assignees: logins(raw.assignees),
    isPullRequest: isObject(raw.pull_request),
    commentCount: Number.isSafeInteger(raw.comments) ? raw.comments : 0,
    createdAt: optString(raw.created_at),
    updatedAt: optString(raw.updated_at),
    closedAt: optString(raw.closed_at),
    htmlUrl: urls.safe(raw.html_url, urls.issue(repo, number))
  };
}

function normalizePullRequest(raw, urls, repo) {
  need(isObject(raw), 'pull_request');
  const number = positiveInteger(raw.number, 'pull_request.number');
  need(raw.state === 'open' || raw.state === 'closed', 'pull_request.state');
  need(isObject(raw.head) && isSha(raw.head.sha), 'pull_request.head.sha');
  need(isObject(raw.base) && typeof raw.base.ref === 'string' && raw.base.ref.length > 0, 'pull_request.base.ref');
  const body = optString(raw.body);
  return {
    number,
    title: optString(raw.title) || '',
    state: raw.state,
    merged: raw.merged === true || typeof raw.merged_at === 'string',
    draft: raw.draft === true,
    author: login(raw.user),
    headSha: raw.head.sha.toLowerCase(),
    headRef: optString(raw.head.ref),
    headRepository: isObject(raw.head.repo) ? optString(raw.head.repo.full_name) : null,
    baseRef: raw.base.ref,
    baseSha: isSha(raw.base.sha) ? raw.base.sha.toLowerCase() : null,
    // null means GitHub has not computed mergeability yet (or the list endpoint omitted it).
    mergeable: typeof raw.mergeable === 'boolean' ? raw.mergeable : null,
    mergeableState: optString(raw.mergeable_state),
    body,
    labels: labelNames(raw.labels),
    referencedIssues: extractIssueReferences(body, repo),
    createdAt: optString(raw.created_at),
    updatedAt: optString(raw.updated_at),
    closedAt: optString(raw.closed_at),
    mergedAt: optString(raw.merged_at),
    htmlUrl: urls.safe(raw.html_url, urls.pullRequest(repo, number))
  };
}

const REVIEW_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING']);

function normalizeReview(raw, urls, repo, pullNumber) {
  need(isObject(raw), 'review');
  const id = positiveInteger(raw.id, 'review.id');
  need(typeof raw.state === 'string', 'review.state');
  const state = raw.state.toUpperCase();
  return {
    id,
    reviewer: login(raw.user),
    state: REVIEW_STATES.has(state) ? state : 'UNKNOWN',
    commitId: isSha(raw.commit_id) ? raw.commit_id.toLowerCase() : null,
    submittedAt: optString(raw.submitted_at),
    authorAssociation: optString(raw.author_association),
    body: optString(raw.body),
    htmlUrl: urls.safe(raw.html_url, `${urls.pullRequest(repo, pullNumber)}#pullrequestreview-${id}`)
  };
}

function normalizeComment(raw, kind, urls, repo, number) {
  need(isObject(raw), 'comment');
  const id = positiveInteger(raw.id, 'comment.id');
  const fallback =
    kind === 'review_comment'
      ? `${urls.pullRequest(repo, number)}#discussion_r${id}`
      : `${urls.issue(repo, number)}#issuecomment-${id}`;
  return {
    id,
    kind,
    author: login(raw.user),
    authorType: isObject(raw.user) ? optString(raw.user.type) : null,
    body: optString(raw.body) || '',
    createdAt: optString(raw.created_at),
    updatedAt: optString(raw.updated_at),
    path: optString(raw.path),
    line: Number.isSafeInteger(raw.line) ? raw.line : null,
    commitId: isSha(raw.commit_id) ? raw.commit_id.toLowerCase() : null,
    inReplyToId: Number.isSafeInteger(raw.in_reply_to_id) ? raw.in_reply_to_id : null,
    reviewId: Number.isSafeInteger(raw.pull_request_review_id) ? raw.pull_request_review_id : null,
    htmlUrl: urls.safe(raw.html_url, fallback)
  };
}

const CHECK_PASSING = new Set(['success', 'neutral', 'skipped']);

/** Check run → 'passing' | 'failing' | 'pending'. Unknown conclusions are treated as failing. */
function checkRunState(status, conclusion) {
  if (status !== 'completed') return 'pending';
  return CHECK_PASSING.has(conclusion) ? 'passing' : 'failing';
}

function normalizeCheckRun(raw, urls) {
  need(isObject(raw), 'check_run');
  need(typeof raw.name === 'string' && raw.name.length > 0, 'check_run.name');
  const status = optString(raw.status);
  const conclusion = optString(raw.conclusion);
  return {
    source: 'check_run',
    id: Number.isSafeInteger(raw.id) ? raw.id : null,
    name: raw.name,
    state: checkRunState(status, conclusion),
    status,
    conclusion,
    headSha: isSha(raw.head_sha) ? raw.head_sha.toLowerCase() : null,
    appSlug: isObject(raw.app) ? optString(raw.app.slug) : null,
    completedAt: optString(raw.completed_at),
    url: urls.safe(raw.html_url, null) || urls.safe(raw.details_url, null)
  };
}

function statusState(state) {
  if (state === 'success') return 'passing';
  if (state === 'pending') return 'pending';
  return 'failing';
}

function normalizeCommitStatus(raw, urls) {
  need(isObject(raw), 'status');
  need(typeof raw.context === 'string' && raw.context.length > 0, 'status.context');
  return {
    source: 'status',
    id: Number.isSafeInteger(raw.id) ? raw.id : null,
    name: raw.context,
    state: statusState(raw.state),
    status: optString(raw.state),
    conclusion: null,
    headSha: null,
    appSlug: null,
    completedAt: optString(raw.updated_at),
    url: urls.safe(raw.target_url, null)
  };
}

module.exports = {
  MalformedPayloadError,
  normalizeRepository,
  normalizeIssue,
  normalizePullRequest,
  normalizeReview,
  normalizeComment,
  normalizeCheckRun,
  normalizeCommitStatus,
  checkRunState
};
