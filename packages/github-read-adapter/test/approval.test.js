'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assessApprovals } = require('../src');
const { SHA_A, SHA_B } = require('./helpers/fixtures');

let nextId = 1;
// Normalized review shape (what the adapter produces).
function r(reviewer, state, commitId, submittedAt) {
  nextId += 1;
  return { id: nextId, reviewer, state, commitId, submittedAt };
}
const t = (minute) => `2026-10-14T10:${String(minute).padStart(2, '0')}:00Z`;

test('an approval on the current head is valid', () => {
  const result = assessApprovals({ reviews: [r('pm', 'APPROVED', SHA_A, t(1))], headSha: SHA_A, prAuthor: 'worker' });
  assert.equal(result.status, 'approved');
  assert.equal(result.currentApprovals.length, 1);
  assert.equal(result.staleApprovals.length, 0);
});

test('a new head commit makes the earlier approval stale and not approved', () => {
  const reviews = [r('pm', 'APPROVED', SHA_A, t(1))];
  const before = assessApprovals({ reviews, headSha: SHA_A, prAuthor: 'worker' });
  const after = assessApprovals({ reviews, headSha: SHA_B, prAuthor: 'worker' });
  assert.equal(before.status, 'approved');
  assert.equal(after.status, 'not_approved');
  assert.equal(after.reason, 'approval_stale');
  assert.equal(after.currentApprovals.length, 0);
  assert.equal(after.staleApprovals[0].commitId, SHA_A);
});

test('re-approving the new head restores approval', () => {
  const reviews = [r('pm', 'APPROVED', SHA_A, t(1)), r('pm', 'APPROVED', SHA_B, t(5))];
  const result = assessApprovals({ reviews, headSha: SHA_B, prAuthor: 'worker' });
  assert.equal(result.status, 'approved');
  assert.equal(result.staleApprovals.length, 0, 'only the latest review per reviewer counts');
});

test('an approval with an unknown commit is never current', () => {
  const result = assessApprovals({ reviews: [r('pm', 'APPROVED', null, t(1))], headSha: SHA_A, prAuthor: 'worker' });
  assert.equal(result.status, 'not_approved');
  assert.equal(result.staleApprovals.length, 1);
});

test('commit comparison ignores case', () => {
  const result = assessApprovals({ reviews: [r('pm', 'APPROVED', SHA_A, t(1))], headSha: SHA_A.toUpperCase(), prAuthor: 'worker' });
  assert.equal(result.status, 'approved');
});

test('changes requested blocks, even when it was filed on an older commit', () => {
  const reviews = [r('pm', 'CHANGES_REQUESTED', SHA_A, t(1))];
  const result = assessApprovals({ reviews, headSha: SHA_B, prAuthor: 'worker' });
  assert.equal(result.status, 'changes_requested');
  assert.equal(result.changesRequested[0].onCurrentHead, false);
});

test('a later approval by the same reviewer replaces their changes request', () => {
  const reviews = [r('pm', 'CHANGES_REQUESTED', SHA_A, t(1)), r('pm', 'APPROVED', SHA_B, t(9))];
  assert.equal(assessApprovals({ reviews, headSha: SHA_B, prAuthor: 'worker' }).status, 'approved');
});

test('a later changes request replaces the same reviewer approval', () => {
  const reviews = [r('pm', 'APPROVED', SHA_B, t(1)), r('pm', 'CHANGES_REQUESTED', SHA_B, t(9))];
  assert.equal(assessApprovals({ reviews, headSha: SHA_B, prAuthor: 'worker' }).status, 'changes_requested');
});

test('a plain comment review neither approves nor withdraws an approval or a block', () => {
  const approved = [r('pm', 'APPROVED', SHA_A, t(1)), r('pm', 'COMMENTED', SHA_A, t(5))];
  assert.equal(assessApprovals({ reviews: approved, headSha: SHA_A, prAuthor: 'worker' }).status, 'approved');
  const blocked = [r('pm', 'CHANGES_REQUESTED', SHA_A, t(1)), r('pm', 'COMMENTED', SHA_A, t(5))];
  assert.equal(assessApprovals({ reviews: blocked, headSha: SHA_A, prAuthor: 'worker' }).status, 'changes_requested');
});

test('a dismissed review does not count and does not revive an earlier approval', () => {
  const dismissedBlock = [r('pm', 'CHANGES_REQUESTED', SHA_A, t(5)), r('pm', 'DISMISSED', SHA_A, t(6))];
  const none = assessApprovals({ reviews: dismissedBlock, headSha: SHA_A, prAuthor: 'worker' });
  assert.equal(none.status, 'not_approved');
  assert.equal(none.reason, 'no_approval');

  const earlierApproval = [r('pm', 'APPROVED', SHA_A, t(1)), r('pm', 'DISMISSED', SHA_A, t(7))];
  assert.equal(assessApprovals({ reviews: earlierApproval, headSha: SHA_A, prAuthor: 'worker' }).status, 'not_approved');
});

test('pending and undated reviews are ignored', () => {
  const reviews = [r('pm', 'PENDING', SHA_A, null), r('pm', 'APPROVED', SHA_A, null)];
  assert.equal(assessApprovals({ reviews, headSha: SHA_A, prAuthor: 'worker' }).status, 'not_approved');
});

test("the PR author's own approval is ignored", () => {
  const result = assessApprovals({ reviews: [r('Worker', 'APPROVED', SHA_A, t(1))], headSha: SHA_A, prAuthor: 'worker' });
  assert.equal(result.status, 'not_approved');
  assert.equal(result.reason, 'self_approval_only');
  assert.equal(result.selfApprovalsIgnored.length, 1);
});

test('required approvals are counted per distinct reviewer on the current head', () => {
  const one = [r('pm', 'APPROVED', SHA_A, t(1))];
  const two = [...one, r('other', 'APPROVED', SHA_A, t(2))];
  const mixed = [...one, r('other', 'APPROVED', SHA_B, t(2))];
  assert.equal(assessApprovals({ reviews: one, headSha: SHA_A, prAuthor: 'w', requiredApprovals: 2 }).reason, 'insufficient_approvals');
  assert.equal(assessApprovals({ reviews: two, headSha: SHA_A, prAuthor: 'w', requiredApprovals: 2 }).status, 'approved');
  assert.equal(assessApprovals({ reviews: mixed, headSha: SHA_A, prAuthor: 'w', requiredApprovals: 2 }).status, 'not_approved');
  const duplicate = [r('pm', 'APPROVED', SHA_A, t(1)), r('PM', 'APPROVED', SHA_A, t(2))];
  assert.equal(assessApprovals({ reviews: duplicate, headSha: SHA_A, prAuthor: 'w', requiredApprovals: 2 }).status, 'not_approved');
});

test('no reviews at all is not_approved/no_approval; input order does not matter', () => {
  assert.equal(assessApprovals({ reviews: [], headSha: SHA_A, prAuthor: 'w' }).reason, 'no_approval');
  const reviews = [r('pm', 'APPROVED', SHA_B, t(9)), r('pm', 'CHANGES_REQUESTED', SHA_A, t(1))];
  assert.equal(assessApprovals({ reviews, headSha: SHA_B, prAuthor: 'w' }).status, 'approved');
});

test('a malformed head SHA is rejected', () => {
  assert.throws(() => assessApprovals({ reviews: [], headSha: 'main' }), TypeError);
});
