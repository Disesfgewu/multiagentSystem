'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pmReport, issueEvidenceVersion, classifyPullRequest, classifyIssue, MARKER } = require('../../src/reports/decision-queue');
const A = 'a'.repeat(40); const B = 'b'.repeat(40);
const data = { operableResult: 'Can read two reports', solution: 'A read-only view', alternatives: 'Browser', acceptanceGap: 'Real use', risks: 'Stale head', recommendedAction: 'Review', evidenceTime: '2026-10-16T00:00:00Z', evidenceVersion: A };
const comment = (author, body) => ({ author, body });
const marked = (value = data) => `${MARKER}\n${JSON.stringify(value)}`;

test('only a complete, deliberately marked owner report is displayed; old versions stay stale', () => {
  const comments = { kind: 'ok', data: [comment('outsider', marked()), comment('owner', 'ordinary PM note'), comment('owner', marked())] };
  assert.equal(pmReport(comments, 'owner/repo', A).state, 'current');
  assert.equal(pmReport(comments, 'owner/repo', B).state, 'stale');
  assert.equal(pmReport({ kind: 'ok', data: [comment('outsider', marked())] }, 'owner/repo', A).state, 'missing');
  assert.equal(pmReport({ kind: 'empty' }, 'owner/repo', A).state, 'missing');
  assert.equal(pmReport({ kind: 'partial', data: comments.data }, 'owner/repo', A).state, 'unknown');
  for (const broken of [marked({ ...data, risks: undefined }), marked({ ...data, secret: 'x' }), `${MARKER}\nnot-json`]) {
    assert.equal(pmReport({ kind: 'ok', data: [comment('owner', broken)] }, 'owner/repo', A).state, 'unknown');
  }
  assert.equal(pmReport({ kind: 'empty', data: [comment('owner', marked())] }, 'owner/repo', A).state, 'unknown');
  assert.equal(pmReport({ kind: 'ok', data: [comment('owner', marked()), comment('owner', `${MARKER}\nnot-json`)] }, 'owner/repo', A).state, 'unknown', 'a broken newer report cannot revive an older one');
  const hostile = pmReport({ kind: 'ok', data: [comment('owner', marked({ ...data, risks: 'bad\u202E\nname' }))] }, 'owner/repo', A);
  assert.equal(hostile.fields.risks.includes('\u202E'), false);
  assert.equal(hostile.fields.risks.includes('\n'), false);
});

test('an Issue evidence version changes with the requirement, not with comment activity', () => {
  const requirement = { title: 'Keep feedback on its report', body: 'Bind it to the evidence the user read.', updatedAt: '2026-10-16T01:00:00Z' };
  const version = issueEvidenceVersion(requirement);
  assert.match(version, /^issue-sha256:[a-f0-9]{64}$/);
  assert.equal(issueEvidenceVersion({ ...requirement, updatedAt: '2026-10-16T02:00:00Z' }), version, 'a new comment only changes updatedAt');
  assert.notEqual(issueEvidenceVersion({ ...requirement, body: `${requirement.body} New acceptance.` }), version);
  assert.notEqual(issueEvidenceVersion({ ...requirement, title: 'Changed scope' }), version);
  for (const malformed of [null, {}, { title: 'x' }, { title: 'x', body: null }]) assert.equal(issueEvidenceVersion(malformed), null);
});

test('current-head formal approval and passing CI are both required for passed', () => {
  const pr = { state: 'open', headSha: A };
  const snapshot = { status: 'complete', consistent: true, headSha: A, approval: { status: 'approved', headSha: A }, checksSummary: { state: 'passing', requiredState: 'passing', headSha: A } };
  assert.equal(classifyPullRequest(pr, snapshot), 'passed');
  assert.equal(classifyPullRequest({ ...pr, headSha: B }, snapshot), 'pending');
  assert.equal(classifyPullRequest(pr, { ...snapshot, consistent: false }), 'pending');
  assert.equal(classifyPullRequest(pr, { ...snapshot, checksSummary: { ...snapshot.checksSummary, headSha: B } }), 'pending');
  assert.equal(classifyPullRequest(pr, { ...snapshot, approval: { status: 'changes_requested', headSha: A } }), 'changes');
  assert.equal(classifyPullRequest(pr, { ...snapshot, approval: { status: 'changes_requested', headSha: B } }), 'pending');
  assert.equal(classifyPullRequest({ ...pr, state: 'closed' }, null), 'processed');
  assert.equal(classifyIssue({ state: 'closed' }), 'processed');
  assert.equal(classifyIssue({ state: 'open' }), 'pending');
});
