'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { describeEvidence, evidenceState, isResolved } = require('../../src/plan/evidence');

test('evidenceState reads an issue or pull request into plain words, or unknown when it cannot', () => {
  assert.equal(evidenceState('issue', { state: 'open' }), 'open');
  assert.equal(evidenceState('issue', { state: 'closed' }), 'closed');
  assert.equal(evidenceState('issue', { state: 'weird' }), 'unknown');
  assert.equal(evidenceState('issue', null), 'unknown');
  assert.equal(evidenceState('issue', undefined), 'unknown');
  assert.equal(evidenceState('issue', 'not-an-object'), 'unknown');
  assert.equal(evidenceState('pullRequest', { state: 'open', draft: false, merged: false }), 'open');
  assert.equal(evidenceState('pullRequest', { state: 'open', draft: true, merged: false }), 'draft');
  assert.equal(evidenceState('pullRequest', { state: 'closed', draft: false, merged: true }), 'merged');
  assert.equal(evidenceState('pullRequest', { state: 'closed', draft: false, merged: false }), 'closed (not merged)');
  assert.equal(evidenceState('pullRequest', { merged: true, state: 'open' }), 'merged', 'merged wins even if state looks stale');
  assert.equal(evidenceState('pullRequest', {}), 'unknown');
});

test('isResolved: an issue resolves by closing; a pull request resolves only by merging, never merely by closing', () => {
  assert.equal(isResolved('issue', 'open'), false);
  assert.equal(isResolved('issue', 'closed'), true);
  assert.equal(isResolved('pullRequest', 'merged'), true);
  assert.equal(isResolved('pullRequest', 'closed (not merged)'), false);
  assert.equal(isResolved('pullRequest', 'draft'), false);
  assert.equal(isResolved('pullRequest', 'open'), false);
});

test('a dependency link never produces a conflict, whatever its live state or the checkbox say', () => {
  for (const done of [true, false]) {
    for (const live of [{ state: 'open' }, { state: 'closed' }, { state: 'open', merged: true }, null]) {
      for (const kind of ['issue', 'pullRequest']) {
        assert.equal(describeEvidence({ field: 'dependency', done, kind, live }).conflict, false, JSON.stringify({ done, live, kind }));
      }
    }
  }
});

test('an evidence link with an unknown live state never produces a conflict: nothing is asserted without a source', () => {
  assert.deepEqual(describeEvidence({ field: 'evidence', done: true, kind: 'issue', live: null }), { state: 'unknown', conflict: false });
  assert.deepEqual(describeEvidence({ field: 'evidence', done: false, kind: 'pullRequest', live: {} }), { state: 'unknown', conflict: false });
});

test('an evidence Issue conflicts exactly when the checkbox disagrees with open/closed', () => {
  assert.deepEqual(describeEvidence({ field: 'evidence', done: true, kind: 'issue', live: { state: 'closed' } }), { state: 'closed', conflict: false });
  assert.deepEqual(describeEvidence({ field: 'evidence', done: false, kind: 'issue', live: { state: 'closed' } }), { state: 'closed', conflict: true }, 'recorded evidence is already closed but the TODO is still unchecked: needs human review');
  assert.deepEqual(describeEvidence({ field: 'evidence', done: true, kind: 'issue', live: { state: 'open' } }), { state: 'open', conflict: true }, 'the TODO is checked but its evidence Issue is still open: needs human review');
  assert.deepEqual(describeEvidence({ field: 'evidence', done: false, kind: 'issue', live: { state: 'open' } }), { state: 'open', conflict: false });
});

test('an evidence pull request conflicts exactly when the checkbox disagrees with having actually merged', () => {
  assert.deepEqual(describeEvidence({ field: 'evidence', done: true, kind: 'pullRequest', live: { state: 'closed', merged: true } }), { state: 'merged', conflict: false });
  assert.deepEqual(describeEvidence({ field: 'evidence', done: false, kind: 'pullRequest', live: { state: 'closed', merged: true } }), { state: 'merged', conflict: true });
  assert.deepEqual(describeEvidence({ field: 'evidence', done: true, kind: 'pullRequest', live: { state: 'open', draft: false } }), { state: 'open', conflict: true });
  assert.deepEqual(describeEvidence({ field: 'evidence', done: true, kind: 'pullRequest', live: { state: 'open', draft: true } }), { state: 'draft', conflict: true });
  // Closed-without-merging never counts as the TODO being delivered, even though it is no longer open.
  assert.deepEqual(describeEvidence({ field: 'evidence', done: true, kind: 'pullRequest', live: { state: 'closed', merged: false } }), { state: 'closed (not merged)', conflict: true });
  assert.deepEqual(describeEvidence({ field: 'evidence', done: false, kind: 'pullRequest', live: { state: 'closed', merged: false } }), { state: 'closed (not merged)', conflict: false });
});
