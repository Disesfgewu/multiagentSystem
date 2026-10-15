'use strict';

const { assertSha } = require('./validate');

const DECISIVE = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);

// GitHub review ids only grow, so the id orders reviews; the time only breaks a tie. Input order
// never matters. A decisive review whose id or time cannot be read cannot be placed, so the
// whole assessment is unknown rather than silently ignoring it.
const parsedTime = (review) => (typeof review.submittedAt === 'string' ? Date.parse(review.submittedAt) : NaN);
const readableId = (review) => Number.isSafeInteger(review.id) && review.id > 0;

function compareReviews(a, b) {
  if (a.id !== b.id) return a.id - b.id;
  return parsedTime(a) - parsedTime(b);
}

function summarize(review) {
  return {
    reviewer: review.reviewer,
    reviewId: review.id,
    commitId: review.commitId,
    submittedAt: review.submittedAt
  };
}

/**
 * Decides which approvals still count for the *current* head commit.
 *
 * Rules (deliberately conservative):
 * - Only the latest APPROVED / CHANGES_REQUESTED / DISMISSED review of each reviewer counts;
 *   a later COMMENTED review changes nothing and PENDING reviews are ignored.
 * - An approval is current only when the commit it reviewed equals `headSha`. Any other
 *   commit (or an unknown one) makes it stale, whatever the repository's own
 *   "dismiss stale approvals" setting is, so a push always requires a fresh approval.
 * - A reviewer whose latest decisive review was dismissed has no effective review; an
 *   earlier approval is not revived.
 * - A decisive review without a readable id or submission time makes the result `unknown`.
 * - The PR author's own approval is ignored.
 * - Outstanding CHANGES_REQUESTED blocks until dismissed or replaced, on any commit.
 *
 * The result is review *evidence*. Whether the repository requires it, and whether the
 * reviewer has permission for it to count, is decided by GitHub's branch rules.
 *
 * @param {{ reviews: object[], headSha: string, prAuthor?: string|null, requiredApprovals?: number }} input
 */
function assessApprovals(input) {
  const headSha = assertSha(input.headSha, 'headSha');
  const required = Math.max(1, Number.isInteger(input.requiredApprovals) ? input.requiredApprovals : 1);
  const author = typeof input.prAuthor === 'string' ? input.prAuthor.toLowerCase() : null;

  const decisive = input.reviews.filter((review) => DECISIVE.has(review.state));
  if (decisive.some((review) => !readableId(review) || Number.isNaN(parsedTime(review)))) {
    return { status: 'unknown', reason: 'review_time_unreadable', headSha, required, currentApprovals: [], staleApprovals: [], changesRequested: [], selfApprovalsIgnored: [] };
  }

  const latestByReviewer = new Map();
  for (const review of [...decisive].sort(compareReviews)) {
    const key = review.reviewer ? review.reviewer.toLowerCase() : `unattributed:${review.id}`;
    latestByReviewer.set(key, review);
  }

  const currentApprovals = [];
  const staleApprovals = [];
  const changesRequested = [];
  const selfApprovalsIgnored = [];
  for (const review of latestByReviewer.values()) {
    if (review.state === 'APPROVED') {
      if (author && review.reviewer && review.reviewer.toLowerCase() === author) {
        selfApprovalsIgnored.push(summarize(review));
      } else if (review.commitId === headSha) {
        currentApprovals.push(summarize(review));
      } else {
        staleApprovals.push(summarize(review));
      }
    } else if (review.state === 'CHANGES_REQUESTED') {
      changesRequested.push({ ...summarize(review), onCurrentHead: review.commitId === headSha });
    }
  }

  let status;
  let reason;
  if (changesRequested.length > 0) {
    status = 'changes_requested';
    reason = 'changes_requested';
  } else if (currentApprovals.length >= required) {
    status = 'approved';
    reason = 'approved_on_current_head';
  } else {
    status = 'not_approved';
    if (currentApprovals.length > 0) reason = 'insufficient_approvals';
    else if (staleApprovals.length > 0) reason = 'approval_stale';
    else if (selfApprovalsIgnored.length > 0) reason = 'self_approval_only';
    else reason = 'no_approval';
  }

  return { status, reason, headSha, required, currentApprovals, staleApprovals, changesRequested, selfApprovalsIgnored };
}

module.exports = { assessApprovals };
