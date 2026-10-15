'use strict';

const { evaluatePublishRequest } = require('../publish-policy');
const { scanPublication } = require('../publish/scan');

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SUCCESS_KINDS = new Set(['ok', 'empty']);
const SUPPORTED_BRANCH_RULES = new Set([
  'pull_request',
  'required_status_checks',
  'protection:required_pull_request_reviews',
  'protection:required_status_checks',
  'protection:required_conversation_resolution'
]);
const SAFE_WRITER_REASONS = new Set([
  'conflict', 'head-changed', 'denied', 'not-found', 'rate-limited',
  'validation-failed', 'not-mergeable'
]);

const refuse = (reason, extra = {}) => ({ ok: false, reason, ...extra });
const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isSha = value => typeof value === 'string' && SHA.test(value);
const isSuccess = value => isPlain(value) && SUCCESS_KINDS.has(value.kind);
const sameLogin = (left, right) => typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase();

function reviewProblem(snapshot, headSha, pmLogin) {
  if (!isSuccess(snapshot.reviews)) return 'approval-unknown';
  const approval = snapshot.approval;
  if (!isPlain(approval) || approval.status === 'unknown') return 'approval-unknown';
  if (approval.headSha !== headSha) return 'approval-stale';
  if (approval.status === 'changes_requested' || approval.reason === 'changes_requested') return 'changes-requested';
  if (approval.status !== 'approved') {
    if (approval.reason === 'approval_stale') return 'approval-stale';
    if (approval.reason === 'self_approval_only') return 'self-approval-forbidden';
    return 'approval-required';
  }
  if (!Array.isArray(approval.currentApprovals)) return 'approval-unknown';
  if (!approval.currentApprovals.some(review => isPlain(review) && sameLogin(review.reviewer, pmLogin) && review.commitId === headSha)) {
    return 'current-pm-approval-required';
  }
  if (Array.isArray(approval.changesRequested) && approval.changesRequested.length > 0) return 'changes-requested';
  return null;
}

function checksProblem(snapshot, headSha) {
  if (!isSuccess(snapshot.checks)) return 'ci-unknown';
  if (!isPlain(snapshot.checks.data) || snapshot.checks.data.headSha !== headSha) return 'ci-stale';
  const checks = snapshot.checksSummary;
  if (!isPlain(checks) || checks.headSha !== headSha) return 'ci-unknown';
  if (checks.state === 'failing' || checks.requiredState === 'failing') return 'ci-failing';
  if (checks.state === 'pending' || checks.requiredState === 'pending') return 'ci-pending';
  if (checks.state === 'none') return 'ci-missing';
  if (checks.state !== 'passing' || !['passing', 'not_required'].includes(checks.requiredState)) return 'ci-unknown';
  return null;
}

function threadsProblem(snapshot, headSha) {
  if (!isSuccess(snapshot.threads) || !isPlain(snapshot.threads.data)) return 'threads-unknown';
  if (snapshot.threads.data.headSha !== headSha) return 'threads-stale';
  if (!Number.isSafeInteger(snapshot.unresolvedThreads) || snapshot.unresolvedThreads < 0) return 'threads-unknown';
  if (snapshot.threads.data.unresolvedCount !== snapshot.unresolvedThreads) return 'threads-unknown';
  if (snapshot.unresolvedThreads > 0) return 'threads-unresolved';
  return null;
}

function branchRulesProblem(snapshot) {
  const requirements = snapshot.requirements;
  if (!isSuccess(requirements) || !isPlain(requirements.data) || requirements.data.complete !== true) return 'branch-rules-unknown';
  const types = requirements.data.ruleTypes;
  if (!Array.isArray(types) || types.some(type => !SUPPORTED_BRANCH_RULES.has(type))) return 'branch-rules-unsupported';
  // These requirements need evidence the current read adapter does not expose. Refuse until
  // that evidence is available instead of assuming GitHub will reject the writer later.
  if (requirements.data.requireCodeOwnerReview === true || requirements.data.requireLastPushApproval === true || requirements.data.strictStatusChecks === true) {
    return 'branch-rules-unsupported';
  }
  return null;
}

/**
 * Decide whether one authoritative GitHub read-adapter snapshot may be merged.
 * `authorId` and actor ids are trusted broker identities; logins only bind the formal
 * GitHub review in this snapshot to the configured PM account.
 */
function assessMerge(snapshot, { role, actorId, authorId, pmLogin, policyConfig = {}, expectedNumber } = {}) {
  if (!isPlain(snapshot) || snapshot.status !== 'complete') return refuse('snapshot-incomplete');
  if (snapshot.consistent !== true) return refuse('snapshot-inconsistent');
  if (!Number.isSafeInteger(snapshot.number) || snapshot.number < 1) return refuse('pr-unverified');
  if (expectedNumber !== undefined && snapshot.number !== expectedNumber) return refuse('pr-mismatch');
  if (!isPlain(snapshot.pullRequest) || snapshot.pullRequest.kind !== 'ok' || !isPlain(snapshot.pullRequest.data)) return refuse('pr-unverified');

  const pr = snapshot.pullRequest.data;
  if (pr.number !== snapshot.number) return refuse('pr-mismatch');
  if (!isSha(snapshot.headSha) || pr.headSha !== snapshot.headSha) return refuse('head-unverified');
  if (typeof pr.author !== 'string' || typeof pr.title !== 'string' || (pr.body !== null && typeof pr.body !== 'string')) return refuse('pr-unverified');
  if (pr.state !== 'open' || pr.merged === true) return refuse('pr-not-open');
  if (pr.draft !== false) return refuse('pr-draft');
  if (pr.mergeable === false) return refuse('merge-conflict');
  if (pr.mergeable !== true) return refuse('mergeability-unknown');
  if (typeof pmLogin !== 'string' || pmLogin.length === 0) return refuse('pm-github-identity-unverified');
  if (sameLogin(pr.author, pmLogin)) return refuse('github-identities-not-separated');

  const reviewReason = reviewProblem(snapshot, snapshot.headSha, pmLogin);
  const checkReason = checksProblem(snapshot, snapshot.headSha);
  const threadReason = threadsProblem(snapshot, snapshot.headSha);
  const branchReason = branchRulesProblem(snapshot);
  const matchingApproval = !reviewReason;

  const policyPullRequest = {
    authorId,
    headSha: snapshot.headSha,
    state: pr.state,
    isDraft: pr.draft,
    mergeable: pr.mergeable,
    review: matchingApproval ? { state: 'approved', reviewerId: policyConfig.pmActorId, headSha: snapshot.headSha } : undefined,
    checksState: checkReason ? 'unknown' : 'passed',
    checksHeadSha: checkReason ? null : snapshot.headSha,
    hasBlockingReviews: reviewReason !== null,
    unresolvedConversations: threadReason ? null : snapshot.unresolvedThreads,
    branchRulesSatisfied: branchReason === null
  };
  const policy = evaluatePublishRequest(
    { operation: 'mergePr', role, actorId, pullRequest: policyPullRequest },
    policyConfig
  );

  // Identity, role, self-review and configured merge authority remain owned by the shared
  // publication policy. Snapshot-specific evidence below supplies more precise reason codes.
  if (!policy.allowed && !['pr-not-mergeable', 'current-pm-approval-required', 'current-checks-required', 'review-or-branch-rules-blocked'].includes(policy.reason)) {
    return refuse(policy.reason);
  }
  if (reviewReason) return refuse(reviewReason);
  if (checkReason) return refuse(checkReason);
  if (threadReason) return refuse(threadReason);
  if (branchReason) return refuse(branchReason);
  if (!policy.allowed) return refuse(policy.reason);
  return { ok: true, reason: 'merge-ready', pullNumber: snapshot.number, headSha: snapshot.headSha };
}

function sameRepository(left, right) {
  return isPlain(left) && isPlain(right) && sameLogin(left.owner, right.owner) && sameLogin(left.name, right.name);
}

/**
 * Re-read immediately before merge, read content bound to that head, scan it, and invoke
 * an injected writer.
 * The writer contract is `mergePullRequest({ repository, number, expectedHeadSha, commitTitle,
 * commitMessage })`. It must enforce `expectedHeadSha` atomically at GitHub and must merge with
 * exactly `commitTitle` and `commitMessage`, which are the scanned PR title and body.
 * `privateReferencesChecked: true` is the caller's statement that it compared against its private
 * material and had none to supply; without it a scan that was given none is refused. Unknown outcomes are never retried.
 */
async function mergePullRequest({
  reader, writer, repository, pullNumber, role, actorId, authorId, pmLogin,
  policyConfig = {}, scanOptions = {}, privateReferencesChecked = false
} = {}) {
  if (!reader || typeof reader.getPullRequestSnapshot !== 'function') throw new TypeError('reader.getPullRequestSnapshot is required');
  if (typeof reader.getPullRequestPublication !== 'function') throw new TypeError('reader.getPullRequestPublication is required');
  if (!writer || typeof writer.mergePullRequest !== 'function') throw new TypeError('writer.mergePullRequest is required');
  if (!isPlain(repository) || typeof repository.owner !== 'string' || typeof repository.name !== 'string') throw new TypeError('repository is required');
  if (!Number.isSafeInteger(pullNumber) || pullNumber < 1) throw new TypeError('pullNumber must be a positive integer');
  if (!isPlain(scanOptions)) return refuse('publication-scan-failed');

  let snapshot;
  try {
    snapshot = await reader.getPullRequestSnapshot(pullNumber, { forceRefresh: true });
  } catch {
    return refuse('cannot-verify');
  }
  const decision = assessMerge(snapshot, { role, actorId, authorId, pmLogin, policyConfig, expectedNumber: pullNumber });
  if (!decision.ok) return decision;
  if (!sameRepository(snapshot.repository, repository)) return refuse('repository-mismatch');

  // The content reader is a trusted boundary: it must fetch the complete diff for exactly
  // this PR head. A free-form caller payload is deliberately not accepted here.
  let publication;
  try {
    publication = await reader.getPullRequestPublication(pullNumber, decision.headSha, { forceRefresh: true });
  } catch {
    return refuse('publication-unverified');
  }
  if (
    !isPlain(publication) || publication.kind !== 'ok' || !isPlain(publication.data) ||
    publication.data.complete !== true || publication.data.number !== pullNumber ||
    publication.data.headSha !== decision.headSha || typeof publication.data.diff !== 'string'
  ) {
    return refuse('publication-unverified');
  }

  const pr = snapshot.pullRequest.data;
  const units = [
    { kind: 'pr-title', text: pr.title },
    { kind: 'pr-body', text: pr.body || '' },
    { kind: 'diff', text: publication.data.diff }
  ];

  let scanResult;
  try {
    // Keep the standard detectors mandatory. These options may add private reference material,
    // but cannot replace the scanner's credential, path, and private-fragment detectors.
    const safeScanOptions = {};
    for (const key of ['memories', 'rules', 'knownValues']) {
      if (Object.hasOwn(scanOptions, key)) safeScanOptions[key] = scanOptions[key];
    }
    scanResult = scanPublication(units, safeScanOptions);
  } catch {
    return refuse('publication-scan-failed');
  }
  if (!isPlain(scanResult) || scanResult.status !== 'clear' || scanResult.blocked !== false) {
    return refuse('publication-blocked', {
      scanStatus: isPlain(scanResult) && typeof scanResult.status === 'string' ? scanResult.status : 'error',
      ...(isPlain(scanResult) && typeof scanResult.reason === 'string' ? { scanReason: scanResult.reason } : {})
    });
  }

  // A clear scan that had no private memory, rules or known values to compare against says
  // nothing about private material. The caller must state that it checked and found none.
  if (scanResult.privateReference !== 'supplied' && privateReferencesChecked !== true) {
    return refuse('private-reference-unchecked');
  }

  let result;
  try {
    // GitHub builds the merge commit text from the PR title and body at merge time. The
    // scanned title and body are passed explicitly so the writer must merge with exactly that
    // text; a title changed after the scan cannot reach the commit.
    result = await writer.mergePullRequest({
      repository: { owner: repository.owner, name: repository.name },
      number: pullNumber,
      expectedHeadSha: decision.headSha,
      commitTitle: units[0].text,
      commitMessage: units[1].text
    });
  } catch {
    return refuse('merge-outcome-unknown');
  }
  if (!isPlain(result) || typeof result.ok !== 'boolean') return refuse('merge-outcome-unknown');
  if (result.ok !== true) {
    const writerReason = SAFE_WRITER_REASONS.has(result.reason) ? result.reason : 'unknown';
    return refuse('merge-refused', { writerReason });
  }
  return { ok: true, reason: 'merged', pullNumber, headSha: decision.headSha };
}

module.exports = { assessMerge, mergePullRequest, SUPPORTED_BRANCH_RULES };
