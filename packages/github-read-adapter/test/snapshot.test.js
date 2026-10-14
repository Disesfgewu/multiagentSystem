'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGitHubReadAdapter } = require('../src');
const { json, createFakeTransport, sequence, createClock, createFakeSleep, TOKEN } = require('./helpers/fake');
const fx = require('./helpers/fixtures');

function setup() {
  const transport = createFakeTransport();
  const adapter = createGitHubReadAdapter({ transport, getToken: () => TOKEN, now: createClock(), sleep: createFakeSleep() });
  return { transport, reader: adapter.useRepository(fx.REPO) };
}

function stub(transport, { pullResponses, reviews, checks, statuses, threads, rules, protection }) {
  transport.get(`${fx.BASE}/pulls/7`, sequence(...pullResponses));
  transport.get(`${fx.BASE}/pulls/7/reviews`, reviews);
  transport.get(new RegExp(`${fx.BASE}/commits/[0-9a-f]{40}/check-runs$`), checks);
  transport.get(new RegExp(`${fx.BASE}/commits/[0-9a-f]{40}/status$`), statuses);
  transport.post('/graphql', threads);
  transport.get(`${fx.BASE}/rules/branches/main`, rules);
  transport.get(`${fx.BASE}/branches/main/protection`, protection);
}

const green = (head = fx.SHA_A) => ({
  checks: json(200, { total_count: 1, check_runs: [fx.checkRun('build', 'completed', 'success', head)] }),
  statuses: json(200, { state: 'success', total_count: 0, statuses: [] })
});
const rulesetRequiringOneApproval = json(200, [
  { type: 'pull_request', ruleset_id: 1, parameters: { required_approving_review_count: 1 } },
  { type: 'required_status_checks', ruleset_id: 1, parameters: { required_status_checks: [{ context: 'build' }] } }
]);
const unprotected = json(404, { message: 'Branch not protected' });

test('a fully readable PR yields a complete snapshot with consistent evidence', async () => {
  const { transport, reader } = setup();
  stub(transport, {
    pullResponses: [json(200, fx.pull(7))],
    reviews: json(200, [fx.review('pm-user', 'APPROVED', fx.SHA_A, '2026-10-14T10:00:00Z')]),
    ...green(),
    threads: json(200, fx.threadsResponse([fx.threadNode('T1', true)])),
    rules: rulesetRequiringOneApproval,
    protection: unprotected
  });
  const snapshot = await reader.getPullRequestSnapshot(7);
  assert.equal(snapshot.status, 'complete');
  assert.equal(snapshot.consistent, true);
  assert.equal(snapshot.headSha, fx.SHA_A);
  assert.equal(snapshot.approval.status, 'approved');
  assert.equal(snapshot.checksSummary.state, 'passing');
  assert.equal(snapshot.checksSummary.requiredState, 'passing');
  assert.equal(snapshot.unresolvedThreads, 0);
  assert.equal(snapshot.links.pullRequest, `${fx.WEB}/pull/7`);
  assert.equal(snapshot.links.checks, `${fx.WEB}/pull/7/checks`);
});

test('after a new commit the earlier approval is stale in the snapshot', async () => {
  const { transport, reader } = setup();
  stub(transport, {
    pullResponses: [json(200, fx.pull(7, { head: { sha: fx.SHA_B, ref: 'feat/example', repo: null } }))],
    reviews: json(200, [fx.review('pm-user', 'APPROVED', fx.SHA_A, '2026-10-14T10:00:00Z')]),
    ...green(fx.SHA_B),
    threads: json(200, fx.threadsResponse([], { headRefOid: fx.SHA_B })),
    rules: rulesetRequiringOneApproval,
    protection: unprotected
  });
  const snapshot = await reader.getPullRequestSnapshot(7);
  assert.equal(snapshot.headSha, fx.SHA_B);
  assert.equal(snapshot.approval.status, 'not_approved');
  assert.equal(snapshot.approval.reason, 'approval_stale');
  assert.equal(snapshot.approval.staleApprovals.length, 1);
  assert.equal(snapshot.approval.currentApprovals.length, 0);
});

test('if the head moves while the snapshot is being read, evidence is judged against the newest head', async () => {
  const { transport, reader } = setup();
  stub(transport, {
    // first PR read sees head A, the verification read sees head B
    pullResponses: [json(200, fx.pull(7)), json(200, fx.pull(7, { head: { sha: fx.SHA_B, ref: 'feat/example', repo: null } }))],
    reviews: json(200, [fx.review('pm-user', 'APPROVED', fx.SHA_A, '2026-10-14T10:00:00Z')]),
    ...green(fx.SHA_A),
    threads: json(200, fx.threadsResponse([])),
    rules: rulesetRequiringOneApproval,
    protection: unprotected
  });
  const snapshot = await reader.getPullRequestSnapshot(7);
  assert.equal(snapshot.consistent, false);
  assert.equal(snapshot.status, 'partial');
  assert.equal(snapshot.headSha, fx.SHA_B);
  assert.equal(snapshot.approval.status, 'not_approved', 'approval of head A must not pass for head B');
  assert.equal(snapshot.checksSummary.state, 'unknown');
  assert.equal(snapshot.checksSummary.reason, 'checks_for_previous_head');
});

test('changes requested and failing/unresolved evidence surface in the snapshot', async () => {
  const { transport, reader } = setup();
  stub(transport, {
    pullResponses: [json(200, fx.pull(7))],
    reviews: json(200, [fx.review('pm-user', 'CHANGES_REQUESTED', fx.SHA_A, '2026-10-14T10:00:00Z')]),
    checks: json(200, { total_count: 2, check_runs: [fx.checkRun('build', 'completed', 'failure'), fx.checkRun('lint', 'in_progress', null)] }),
    statuses: json(200, { state: 'failure', total_count: 0, statuses: [] }),
    threads: json(200, fx.threadsResponse([fx.threadNode('T1', false), fx.threadNode('T2', true)])),
    rules: rulesetRequiringOneApproval,
    protection: unprotected
  });
  const snapshot = await reader.getPullRequestSnapshot(7);
  assert.equal(snapshot.approval.status, 'changes_requested');
  assert.equal(snapshot.checksSummary.state, 'failing');
  assert.equal(snapshot.checksSummary.requiredState, 'failing');
  assert.equal(snapshot.unresolvedThreads, 1);
});

test('an unreadable review list makes approval unknown instead of "no approvals"', async () => {
  for (const [response, kind] of [[json(403, { message: 'Resource not accessible' }), 'denied'], [json(500, {}), 'transient']]) {
    const { transport, reader } = setup();
    stub(transport, {
      pullResponses: [json(200, fx.pull(7))],
      reviews: response,
      ...green(),
      threads: json(200, fx.threadsResponse([])),
      rules: rulesetRequiringOneApproval,
      protection: unprotected
    });
    const snapshot = await reader.getPullRequestSnapshot(7);
    assert.equal(snapshot.status, 'partial');
    assert.equal(snapshot.approval.status, 'unknown');
    assert.equal(snapshot.approval.reason, `reviews_${kind}`);
  }
});

test('threads that cannot be read stay unknown (null), never zero', async () => {
  const { transport, reader } = setup();
  stub(transport, {
    pullResponses: [json(200, fx.pull(7))],
    reviews: json(200, []),
    ...green(),
    threads: json(401, { message: 'Requires authentication' }),
    rules: rulesetRequiringOneApproval,
    protection: unprotected
  });
  const snapshot = await reader.getPullRequestSnapshot(7);
  assert.equal(snapshot.unresolvedThreads, null);
  assert.equal(snapshot.threads.kind, 'denied');
  assert.equal(snapshot.status, 'partial');
});

test('unreadable branch protection leaves required checks unknown rather than "not required"', async () => {
  const { transport, reader } = setup();
  stub(transport, {
    pullResponses: [json(200, fx.pull(7))],
    reviews: json(200, []),
    ...green(),
    threads: json(200, fx.threadsResponse([])),
    rules: json(200, []),
    protection: json(403, { message: 'Resource not accessible by integration' })
  });
  const snapshot = await reader.getPullRequestSnapshot(7);
  assert.equal(snapshot.requirements.kind, 'partial');
  assert.equal(snapshot.checksSummary.state, 'passing');
  assert.equal(snapshot.checksSummary.requiredState, 'unknown');
});

test('a missing PR yields an unavailable snapshot carrying the real failure kind', async () => {
  const { transport, reader } = setup();
  transport.get(`${fx.BASE}/pulls/7`, json(404, { message: 'Not Found' }));
  const snapshot = await reader.getPullRequestSnapshot(7);
  assert.equal(snapshot.status, 'unavailable');
  assert.equal(snapshot.pullRequest.kind, 'not_found');
  assert.equal(snapshot.approval, undefined);
  assert.equal(transport.calls.length, 1, 'no further reads for a PR that does not exist');
});

test('switching repository mid-snapshot cancels it', async () => {
  const transport = createFakeTransport();
  const adapter = createGitHubReadAdapter({ transport, getToken: () => TOKEN, now: createClock(), sleep: createFakeSleep() });
  const reader = adapter.useRepository(fx.REPO);
  transport.get(`${fx.BASE}/pulls/7`, json(200, fx.pull(7)));
  transport.get(/.*/, async () => {
    adapter.useRepository({ owner: 'another-org', name: 'another-repo' });
    return json(200, []);
  });
  transport.post('/graphql', json(200, fx.threadsResponse([])));
  const snapshot = await reader.getPullRequestSnapshot(7);
  assert.equal(snapshot.kind, 'cancelled');
  assert.equal(snapshot.reason, 'repository_changed');
});
