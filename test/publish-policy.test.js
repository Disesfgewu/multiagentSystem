'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluatePublishRequest } = require('../src/publish-policy');

const config = { pmActorId: '10', mergeAuthority: 'pm' };
const headSha = 'a'.repeat(40);
const olderSha = 'b'.repeat(40);
const readyPr = () => ({
  authorId: '20', headSha, state: 'open', isDraft: false, mergeable: true,
  review: { state: 'approved', reviewerId: '10', headSha },
  checksState: 'passed', checksHeadSha: headSha,
  hasBlockingReviews: false, unresolvedConversations: 0, branchRulesSatisfied: true
});
const mergeRequest = () => ({ operation: 'mergePr', role: 'pm', actorId: '10', pullRequest: readyPr() });

test('worker can claim and deliver, but cannot define requirements, review, or merge', () => {
  for (const operation of ['claimIssue', 'createPr']) {
    assert.equal(evaluatePublishRequest({ operation, role: 'worker', actorId: '20' }, config).allowed, true);
  }
  for (const operation of ['createIssue', 'editIssue', 'reviewPr', 'mergePr']) {
    assert.equal(evaluatePublishRequest({ operation, role: 'worker', actorId: '20' }, config).allowed, false);
  }
});

test('PM identity must match configuration and must be separate from worker identity', () => {
  assert.equal(evaluatePublishRequest({ operation: 'createIssue', role: 'pm', actorId: '10' }, config).allowed, true);
  assert.equal(evaluatePublishRequest({ operation: 'createIssue', role: 'pm', actorId: '30' }, config).allowed, false);
  assert.equal(evaluatePublishRequest({ operation: 'createPr', role: 'worker', actorId: '10' }, config).allowed, false);
});

test('missing identity, unknown operation, and inherited object properties are denied', () => {
  for (const request of [undefined, {}, { operation: 'createPr', role: 'worker' },
    { operation: 'toString', role: 'worker', actorId: '20' },
    { operation: '__proto__', role: 'worker', actorId: '20' }]) {
    assert.equal(evaluatePublishRequest(request, config).allowed, false);
  }
  assert.equal(evaluatePublishRequest(mergeRequest(), {}).allowed, false);
});

test('PM may review another author, including a draft, but cannot review own PR', () => {
  const request = { ...mergeRequest(), operation: 'reviewPr' };
  request.pullRequest.isDraft = true;
  assert.equal(evaluatePublishRequest(request, config).allowed, true);
  request.pullRequest.authorId = '10';
  assert.equal(evaluatePublishRequest(request, config).allowed, false);
});

test('human merge is the default and cannot be triggered by PM', () => {
  assert.equal(evaluatePublishRequest(mergeRequest(), { pmActorId: '10' }).reason, 'human-merge-required');
  assert.equal(evaluatePublishRequest(mergeRequest(), { ...config, mergeAuthority: 'human' }).allowed, false);
  for (const mergeAuthority of ['', null, 'automatic']) {
    assert.equal(evaluatePublishRequest(mergeRequest(), { ...config, mergeAuthority }).allowed, false);
  }
});

test('explicit PM merge permits a fully verified snapshot', () => {
  assert.equal(evaluatePublishRequest(mergeRequest(), config).allowed, true);
});

test('stale approval, stale CI, changes requested, and wrong reviewer each block merge', () => {
  const cases = [
    pr => { pr.review.headSha = olderSha; },
    pr => { pr.checksHeadSha = olderSha; },
    pr => { pr.review.state = 'changes_requested'; },
    pr => { pr.review.reviewerId = '30'; },
    pr => { delete pr.review; }
  ];
  for (const mutate of cases) {
    const request = mergeRequest();
    mutate(request.pullRequest);
    assert.equal(evaluatePublishRequest(request, config).allowed, false);
  }
});

test('incomplete or blocked GitHub state always blocks merge', () => {
  const cases = {
    state: ['closed', undefined], authorId: [undefined], headSha: ['unknown', undefined],
    isDraft: [true, undefined], mergeable: [false, null, undefined],
    checksState: ['pending', 'failed', undefined], checksHeadSha: [undefined],
    hasBlockingReviews: [true, undefined], unresolvedConversations: [1, undefined],
    branchRulesSatisfied: [false, undefined]
  };
  for (const [key, values] of Object.entries(cases)) {
    for (const value of values) {
      const request = mergeRequest();
      request.pullRequest[key] = value;
      assert.equal(evaluatePublishRequest(request, config).allowed, false, `${key}=${value}`);
    }
  }
});
