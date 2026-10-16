'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pmReport, classifyPullRequest, classifyIssue, MARKER } = require('../../src/reports/decision-queue');
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
    assert.equal(pmReport({ kind: 'ok', data: [comment('owner', broken)] }, 'owner/repo', A).state, 'missing');
  }
  const hostile = pmReport({ kind: 'ok', data: [comment('owner', marked({ ...data, risks: 'bad\u202E\nname' }))] }, 'owner/repo', A);
  assert.equal(hostile.fields.risks.includes('\u202E'), false);
  assert.equal(hostile.fields.risks.includes('\n'), false);
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
