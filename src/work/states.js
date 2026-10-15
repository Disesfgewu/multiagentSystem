'use strict';

// The work states of one GitHub issue, and which events may move it between them.
//
//   ready -> claimed -> in_progress -> pr_open -> review_pending
//     review_pending -> changes_requested <-> worker_updates -> review_pending
//     review_pending -> pm_passed -> ready_to_merge -> merged
//   blocked can be entered while work is under way and leaves only through the PM.
//
// This module is a pure decision table. It reads and writes nothing; a result says whether
// an event is allowed and what the next state is. Anything it is not sure about is refused:
// an unknown state, an unknown event, a role that may not do it, or evidence that is
// missing, stale or unknown. "Unknown" is never read as "fine".

const STATES = Object.freeze([
  'ready', 'claimed', 'in_progress', 'blocked', 'pr_open', 'review_pending', 'changes_requested',
  'worker_updates', 'pm_passed', 'ready_to_merge', 'merged', 'closed'
]);
const TERMINAL = Object.freeze(['merged', 'closed']);
const ROLES = Object.freeze(['pm', 'worker', 'human', 'system']);

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// event -> { from, to, roles }. `to` may be a function of the link for events whose target
// depends on the state they start from.
const TABLE = Object.freeze({
  claim: { from: ['ready'], to: 'claimed', roles: ['worker', 'pm'] },
  start: { from: ['claimed'], to: 'in_progress', roles: ['worker'] },
  release: { from: ['claimed', 'in_progress'], to: 'ready', roles: ['worker', 'pm', 'human'] },
  block: { from: ['claimed', 'in_progress', 'pr_open', 'changes_requested', 'worker_updates'], to: 'blocked', roles: ['worker', 'pm'] },
  unblock: { from: ['blocked'], to: 'ready', roles: ['pm'] },
  open_pr: { from: ['in_progress'], to: 'pr_open', roles: ['worker'] },
  request_review: { from: ['pr_open'], to: 'review_pending', roles: ['worker'] },
  request_changes: { from: ['review_pending'], to: 'changes_requested', roles: ['pm'] },
  worker_update: { from: ['changes_requested'], to: 'worker_updates', roles: ['worker'] },
  resubmit: { from: ['worker_updates'], to: 'review_pending', roles: ['worker'] },
  pm_pass: { from: ['review_pending'], to: 'pm_passed', roles: ['pm'] },
  head_changed: {
    from: ['pr_open', 'review_pending', 'changes_requested', 'worker_updates', 'pm_passed', 'ready_to_merge'],
    to: (state) => (state === 'pm_passed' || state === 'ready_to_merge' ? 'review_pending' : state),
    roles: ['system']
  },
  mark_ready_to_merge: { from: ['pm_passed'], to: 'ready_to_merge', roles: ['system'] },
  conditions_failed: { from: ['ready_to_merge'], to: 'pm_passed', roles: ['system'] },
  merge: { from: ['ready_to_merge'], to: 'merged', roles: ['human', 'pm'] },
  close: { from: ['ready', 'claimed', 'in_progress', 'blocked', 'pr_open', 'review_pending', 'changes_requested', 'worker_updates', 'pm_passed', 'ready_to_merge'], to: 'closed', roles: ['pm', 'human'] }
});
const EVENTS = Object.freeze(Object.keys(TABLE));

const refuse = (reason, extra = {}) => ({ ok: false, reason, ...extra });
const isSha = (value) => typeof value === 'string' && SHA.test(value);
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// What the remote shows about a pull request's review and checks, in the shape the read-only
// adapter's pull request snapshot has. Every field the decision needs must be present and
// known; a missing or `unknown` value stops the transition.
function readyToMergeProblems(evidence, link, config) {
  const problems = [];
  if (!isPlain(evidence)) return ['evidence-missing'];
  if (!isSha(evidence.headSha)) problems.push('head-unknown');
  else if (evidence.headSha !== link.headSha) problems.push('head-changed');
  if (evidence.consistent !== true) problems.push('snapshot-inconsistent');

  // Which kind of review the pull request passed on decides what is checked now. A formal
  // approval is re-checked against the current head. An informal one (a technical review left
  // as a comment) is accepted only when the configuration allows it. A link that does not
  // say which kind it has is not ready.
  if (link.reviewKind === 'formal') {
    const approval = evidence.approval;
    if (!isPlain(approval) || approval.status !== 'approved') problems.push('approval-not-current');
    else if (approval.headSha !== link.headSha) problems.push('approval-for-older-head');
  } else if (link.reviewKind === 'informal') {
    if (config.allowInformalPass !== true) problems.push('formal-review-required');
  } else {
    problems.push('review-kind-unknown');
  }

  const checks = evidence.checks;
  if (!isPlain(checks) || checks.state === 'unknown' || checks.requiredState === 'unknown') problems.push('checks-unknown');
  else if (checks.state === 'failing' || checks.requiredState === 'failing') problems.push('checks-failing');
  else if (checks.state === 'pending' || checks.requiredState === 'pending') problems.push('checks-pending');
  else if (!['passing', 'none'].includes(checks.state) || !['passing', 'not_required'].includes(checks.requiredState)) problems.push('checks-not-passing');

  if (!Number.isInteger(evidence.unresolvedThreads)) problems.push('threads-unknown');
  else if (evidence.unresolvedThreads > 0) problems.push('threads-unresolved');

  if (evidence.mergeable === false) problems.push('merge-conflict');
  else if (evidence.mergeable !== true) problems.push('mergeability-unknown');
  return problems;
}

// Checks the evidence an event needs. Returns null when it is fine, else a refusal.
function evidenceProblem(event, link, evidence, config) {
  switch (event) {
    case 'open_pr':
      if (!isPlain(evidence) || !Number.isSafeInteger(evidence.prNumber) || evidence.prNumber < 1) return refuse('evidence-missing', { need: 'prNumber' });
      if (!isSha(evidence.headSha)) return refuse('evidence-missing', { need: 'headSha' });
      return null;
    case 'request_changes':
      if (!isPlain(evidence) || !isPlain(evidence.review) || evidence.review.state !== 'CHANGES_REQUESTED') return refuse('evidence-missing', { need: 'review CHANGES_REQUESTED' });
      return null;
    case 'resubmit':
      if (!isPlain(evidence) || !isSha(evidence.headSha)) return refuse('evidence-missing', { need: 'headSha' });
      if (evidence.headSha === link.headSha) return refuse('no-new-commit');
      return null;
    case 'head_changed':
      if (!isPlain(evidence) || !isSha(evidence.headSha)) return refuse('evidence-missing', { need: 'headSha' });
      if (evidence.headSha === link.headSha) return refuse('head-unchanged');
      return null;
    case 'pm_pass': {
      if (!isPlain(evidence) || !isSha(evidence.headSha)) return refuse('evidence-missing', { need: 'headSha' });
      if (evidence.headSha !== link.headSha) return refuse('evidence-stale', { current: 'head-changed' });
      const approval = evidence.approval;
      if (isPlain(approval) && approval.status === 'approved') {
        return approval.headSha === link.headSha ? null : refuse('evidence-stale', { current: 'approval-for-older-head' });
      }
      // GitHub cannot record a formal approval when the author and the reviewer are the same
      // account. A technical review left as a comment may count only when the configuration
      // says so, and the link then remembers that it was not formal.
      if (isPlain(evidence.informalReview) && config.allowInformalPass === true) {
        return evidence.informalReview.commitId === link.headSha ? null : refuse('evidence-stale', { current: 'review-for-older-head' });
      }
      return refuse(isPlain(approval) ? 'approval-not-current' : 'evidence-missing', { need: 'formal approval on the current head' });
    }
    case 'mark_ready_to_merge': {
      const problems = readyToMergeProblems(evidence, link, config);
      return problems.length === 0 ? null : refuse('not-ready-to-merge', { problems });
    }
    case 'conditions_failed': {
      // Only when the conditions really do not hold any longer.
      const problems = readyToMergeProblems(evidence, link, config);
      return problems.length > 0 ? null : refuse('conditions-still-hold');
    }
    case 'merge':
      if (!isPlain(evidence) || (evidence.mergeAuthority !== 'human' && evidence.mergeAuthority !== 'pm')) return refuse('evidence-missing', { need: 'mergeAuthority' });
      return null;
    default:
      return null;
  }
}

/**
 * Decides one event for one link.
 *
 * @param {{ state: string, headSha?: string|null, reviewKind?: string|null }} link the current record
 * @param {string} event one of EVENTS
 * @param {{ role: string, evidence?: object, config?: object }} context
 * @returns {{ ok: true, state: string, headSha?: string, prNumber?: number, reviewKind?: string|null } | { ok: false, reason: string }}
 */
function transition(link, event, { role, evidence, config = {} } = {}) {
  if (!isPlain(link) || !STATES.includes(link.state)) return refuse('unknown-state');
  if (!EVENTS.includes(event)) return refuse('unknown-event');
  if (!ROLES.includes(role)) return refuse('unknown-role');
  if (TERMINAL.includes(link.state)) return refuse('terminal-state');

  const rule = TABLE[event];
  if (!rule.from.includes(link.state)) return refuse('illegal-transition', { from: link.state, event });
  if (!rule.roles.includes(role)) return refuse('role-forbidden', { role, event });
  // Merging is by a person unless the repository is set to merge by the PM, and a worker never merges.
  if (event === 'merge' && role === 'pm' && !(isPlain(evidence) && evidence.mergeAuthority === 'pm')) return refuse('role-forbidden', { role, event, why: 'merge-authority-is-human' });

  const problem = evidenceProblem(event, link, evidence, config);
  if (problem) return problem;

  const to = typeof rule.to === 'function' ? rule.to(link.state) : rule.to;
  const next = { ok: true, state: to };
  if (event === 'open_pr') {
    next.prNumber = evidence.prNumber;
    next.headSha = evidence.headSha;
    next.reviewKind = null;
  } else if (event === 'head_changed' || event === 'resubmit') {
    next.headSha = evidence.headSha;
    next.reviewKind = null; // a review of an older head is not a review of this one
  } else if (event === 'pm_pass') {
    next.reviewKind = isPlain(evidence.approval) && evidence.approval.status === 'approved' ? 'formal' : 'informal';
  }
  return next;
}

module.exports = { STATES, TERMINAL, ROLES, EVENTS, TABLE, transition, readyToMergeProblems };
