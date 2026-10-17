'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { describeEvidence, evidenceState, isResolved } = require('../../src/plan/evidence');

const head = 'a'.repeat(40);
const issue = (number, state) => ({ number, state });
const pr = (number, state, merged = false, draft = false, headSha = head) => ({ number, state, merged, draft, headSha });

test('evidenceState accepts only a complete matching Issue or PR shape', () => {
  assert.equal(evidenceState('issue', issue(7, 'open'), 7), 'open');
  assert.equal(evidenceState('issue', issue(7, 'closed'), 7), 'closed');
  assert.equal(evidenceState('issue', issue(8, 'closed'), 7), 'unknown', 'a response for another number is not evidence');
  assert.equal(evidenceState('issue', { state: 'closed' }, 7), 'unknown');
  assert.equal(evidenceState('pullRequest', pr(7, 'open'), 7), 'open');
  assert.equal(evidenceState('unknown', pr(7, 'closed', true), 7), 'unknown');
  assert.equal(evidenceState('pullRequest', pr(7, 'open', false, true), 7), 'draft');
  assert.equal(evidenceState('pullRequest', pr(7, 'closed', true), 7), 'merged');
  assert.equal(evidenceState('pullRequest', pr(7, 'closed'), 7), 'closed (not merged)');
  for (const malformed of [
    { number: 7, state: 'open', merged: false, draft: false },
    { number: 7, state: 'odd', merged: false, draft: false, headSha: head },
    { number: 7, state: 'open', merged: true, draft: false, headSha: head },
    { number: 7, state: 'closed', merged: true, draft: true, headSha: head },
    null, undefined, 'not-an-object', {}
  ]) assert.equal(evidenceState('pullRequest', malformed, 7), 'unknown');
});

test('isResolved: an issue resolves by closing; a pull request resolves only by merging', () => {
  assert.equal(isResolved('issue', 'open'), false);
  assert.equal(isResolved('issue', 'closed'), true);
  assert.equal(isResolved('pullRequest', 'merged'), true);
  assert.equal(isResolved('pullRequest', 'closed (not merged)'), false);
});

test('dependencies and ordinary evidence never infer the TODO completion state', () => {
  for (const field of ['dependency', 'evidence']) for (const done of [true, false]) {
    assert.equal(describeEvidence({ field, done, kind: 'issue', number: 7, live: issue(7, 'closed') }).conflict, false);
    assert.equal(describeEvidence({ field, done, kind: 'pullRequest', number: 7, live: pr(7, 'closed', true) }).conflict, false);
  }
});

test('unknown or mismatched acceptance data never produces a conflict', () => {
  assert.deepEqual(describeEvidence({ field: 'acceptance', done: true, kind: 'issue', number: 7, live: null }), { state: 'unknown', conflict: false });
  assert.deepEqual(describeEvidence({ field: 'acceptance', done: false, kind: 'issue', number: 7, live: issue(8, 'closed') }), { state: 'unknown', conflict: false });
  assert.deepEqual(describeEvidence({ field: 'acceptance', done: false, kind: 'pullRequest', number: 7, live: { merged: true } }), { state: 'unknown', conflict: false });
});

test('acceptance Issue conflicts exactly when its matching complete state disagrees with the checkbox', () => {
  assert.deepEqual(describeEvidence({ field: 'acceptance', done: true, kind: 'issue', number: 7, live: issue(7, 'closed') }), { state: 'closed', conflict: false });
  assert.deepEqual(describeEvidence({ field: 'acceptance', done: false, kind: 'issue', number: 7, live: issue(7, 'closed') }), { state: 'closed', conflict: true });
  assert.deepEqual(describeEvidence({ field: 'acceptance', done: true, kind: 'issue', number: 7, live: issue(7, 'open') }), { state: 'open', conflict: true });
});

test('acceptance PR conflicts exactly when its matching stable head has merged', () => {
  assert.deepEqual(describeEvidence({ field: 'acceptance', done: true, kind: 'pullRequest', number: 7, live: pr(7, 'closed', true) }), { state: 'merged', conflict: false });
  assert.deepEqual(describeEvidence({ field: 'acceptance', done: false, kind: 'pullRequest', number: 7, live: pr(7, 'closed', true) }), { state: 'merged', conflict: true });
  assert.deepEqual(describeEvidence({ field: 'acceptance', done: true, kind: 'pullRequest', number: 7, live: pr(7, 'open') }), { state: 'open', conflict: true });
  assert.deepEqual(describeEvidence({ field: 'acceptance', done: true, kind: 'pullRequest', number: 7, live: pr(7, 'closed') }), { state: 'closed (not merged)', conflict: true });
});
