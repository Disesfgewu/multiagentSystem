'use strict';

// Compares a Core Plan TODO's checkbox against the live GitHub state of ONE thing it names, so a
// person can see "Core Plan 與 GitHub 狀態不一致時顯示衝突，不能自動勾選" (M1-024) without the
// plan being rewritten automatically. This module never reads or writes the plan file itself: it
// only classifies a state it is given.
//
// Only an explicit 'acceptance' link may produce a conflict. Dependencies and ordinary evidence
// remain useful links, but neither is proof that the whole TODO passed acceptance.

/** The live state in plain words, independent of what the TODO claims. */
function evidenceState(kind, live, expectedNumber) {
  if (!live || typeof live !== 'object') return 'unknown';
  if (!Number.isSafeInteger(live.number) || live.number < 1) return 'unknown';
  if (expectedNumber !== undefined && live.number !== expectedNumber) return 'unknown';
  if (kind === 'issue') {
    if (live.state === 'closed') return 'closed';
    if (live.state === 'open') return 'open';
    return 'unknown';
  }
  if (kind !== 'pullRequest') return 'unknown';
  if ((live.state !== 'open' && live.state !== 'closed') || typeof live.merged !== 'boolean' ||
      typeof live.draft !== 'boolean' || typeof live.headSha !== 'string' || !/^[0-9a-f]{40}$/i.test(live.headSha)) return 'unknown';
  if (live.merged === true && live.state === 'closed' && live.draft === false) return 'merged';
  if (live.draft === true && live.state === 'open' && live.merged === false) return 'draft';
  if (live.state === 'closed' && live.merged === false && live.draft === false) return 'closed (not merged)';
  if (live.state === 'open' && live.merged === false && live.draft === false) return 'open';
  return 'unknown';
}

/** Whether this state means the referenced work actually landed. A closed-but-unmerged PR did not. */
function isResolved(kind, state) {
  return kind === 'issue' ? state === 'closed' : state === 'merged';
}

/**
 * @param {{ field: 'dependency' | 'evidence' | 'acceptance', done: boolean, kind: 'issue' | 'pullRequest', number?: number, live: unknown }} input
 * @returns {{ state: string, conflict: boolean }}
 */
function describeEvidence({ field, done, kind, number, live }) {
  const state = evidenceState(kind, live, number);
  if (field !== 'acceptance' || state === 'unknown') return { state, conflict: false };
  return { state, conflict: done !== isResolved(kind, state) };
}

module.exports = { describeEvidence, evidenceState, isResolved };
