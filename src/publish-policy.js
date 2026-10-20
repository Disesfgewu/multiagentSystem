'use strict';

const roles = Object.freeze({
  createIssue: 'pm',
  editIssue: 'pm',
  closeIssue: 'pm',
  claimIssue: 'worker',
  createPr: 'worker',
  reviewPr: 'pm',
  mergePr: 'pm',
  deleteBranch: 'pm'
});

const decision = (allowed, reason) => ({ allowed, reason });
const validId = value => typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
const validSha = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);

/**
 * Evaluate a trusted broker snapshot. This function does not authenticate callers,
 * fetch GitHub state, scan content, or prevent direct shell/network writes.
 */
function evaluatePublishRequest(request, config) {
  if (!request || !config || !validId(config.pmActorId) || !validId(request.actorId)) {
    return decision(false, 'identity-unverified');
  }
  if (!Object.hasOwn(roles, request.operation)) {
    return decision(false, 'operation-unsupported');
  }
  if (roles[request.operation] !== request.role) {
    return decision(false, 'role-forbidden');
  }
  if (request.role === 'pm' && request.actorId !== config.pmActorId) {
    return decision(false, 'pm-identity-mismatch');
  }
  if (request.role === 'worker' && request.actorId === config.pmActorId) {
    return decision(false, 'identities-not-separated');
  }
  if (request.operation !== 'reviewPr' && request.operation !== 'mergePr') {
    return decision(true, 'role-authorized');
  }

  const pr = request.pullRequest;
  if (!pr || !validId(pr.authorId) || !validSha(pr.headSha)) {
    return decision(false, 'pr-unverified');
  }
  if (pr.authorId === request.actorId) {
    return decision(false, 'self-review-forbidden');
  }
  if (pr.state !== 'open') {
    return decision(false, 'pr-not-open');
  }
  if (request.operation === 'reviewPr') {
    return decision(true, 'review-authorized');
  }

  const authority = config.mergeAuthority === undefined ? 'human' : config.mergeAuthority;
  if (authority === 'human') return decision(false, 'human-merge-required');
  if (authority !== 'pm') return decision(false, 'merge-authority-invalid');
  if (pr.isDraft !== false || pr.mergeable !== true) {
    return decision(false, 'pr-not-mergeable');
  }
  const review = pr.review;
  if (!review || review.state !== 'approved' || review.reviewerId !== config.pmActorId || review.headSha !== pr.headSha) {
    return decision(false, 'current-pm-approval-required');
  }
  if (pr.checksState !== 'passed' || pr.checksHeadSha !== pr.headSha) {
    return decision(false, 'current-checks-required');
  }
  if (pr.hasBlockingReviews !== false || pr.unresolvedConversations !== 0 || pr.branchRulesSatisfied !== true) {
    return decision(false, 'review-or-branch-rules-blocked');
  }
  return decision(true, 'pm-merge-authorized');
}

module.exports = { evaluatePublishRequest };
