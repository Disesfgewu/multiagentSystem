'use strict';

// Compares a Core Plan TODO's checkbox against the live GitHub state of ONE thing it names, so a
// person can see "Core Plan 與 GitHub 狀態不一致時顯示衝突，不能自動勾選" (M1-024) without the
// plan being rewritten automatically. This module never reads or writes the plan file itself: it
// only classifies a state it is given.
//
// Only a 'evidence' link may ever produce a conflict. A 'dependency' link is informational only: a
// dependency Issue being open must never be read as this TODO having failed, and a dependency PR
// being merged must never be read as this TODO being done.

/** The live state in plain words, independent of what the TODO claims. */
function evidenceState(kind, live) {
  if (!live || typeof live !== 'object') return 'unknown';
  if (kind === 'issue') {
    if (live.state === 'closed') return 'closed';
    if (live.state === 'open') return 'open';
    return 'unknown';
  }
  if (live.merged === true) return 'merged';
  if (live.draft === true) return 'draft';
  if (live.state === 'closed') return 'closed (not merged)';
  if (live.state === 'open') return 'open';
  return 'unknown';
}

/** Whether this state means the referenced work actually landed. A closed-but-unmerged PR did not. */
function isResolved(kind, state) {
  return kind === 'issue' ? state === 'closed' : state === 'merged';
}

/**
 * @param {{ field: 'dependency' | 'evidence', done: boolean, kind: 'issue' | 'pullRequest', live: unknown }} input
 * @returns {{ state: string, conflict: boolean }}
 */
function describeEvidence({ field, done, kind, live }) {
  const state = evidenceState(kind, live);
  if (field !== 'evidence' || state === 'unknown') return { state, conflict: false };
  return { state, conflict: done !== isResolved(kind, state) };
}

module.exports = { describeEvidence, evidenceState, isResolved };
