'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGitHubReadAdapter, isSuccess } = require('../src');
const { API, TOKEN, json, createFakeTransport, sequence, createClock, createFakeSleep } = require('./helpers/fake');
const fx = require('./helpers/fixtures');

function setup(extra = {}) {
  const transport = createFakeTransport();
  const clock = createClock();
  const adapter = createGitHubReadAdapter({ transport, getToken: () => TOKEN, now: clock, sleep: createFakeSleep(), ...extra });
  return { transport, clock, adapter, reader: adapter.useRepository(fx.REPO) };
}

const linkTo = (path, page) => `<${API}${path}?per_page=100&page=${page}>; rel="next"`;

test('issues are normalized, with the right page URL', async () => {
  const { transport, reader } = setup();
  transport.get(`${fx.BASE}/issues/15`, json(200, fx.issue(15, { assignees: [{ login: 'worker-user' }], labels: [{ name: 'ready' }, 'p2'] })));
  const result = await reader.getIssue(15);
  assert.equal(result.kind, 'ok');
  assert.equal(result.data.number, 15);
  assert.deepEqual(result.data.assignees, ['worker-user']);
  assert.deepEqual(result.data.labels, ['ready', 'p2']);
  assert.equal(result.data.htmlUrl, `${fx.WEB}/issues/15`);
  assert.equal(reader.links.issue(15), `${fx.WEB}/issues/15`);
});

test('a hostile html_url from the API is replaced by the deterministic GitHub URL', async () => {
  const { transport, reader } = setup();
  transport.get(`${fx.BASE}/issues/15`, json(200, fx.issue(15, { html_url: 'https://evil.example.invalid/phish' })));
  const result = await reader.getIssue(15);
  assert.equal(result.data.htmlUrl, `${fx.WEB}/issues/15`);
});

test('listIssues spans pages, drops pull requests, and says empty only when the server did', async () => {
  const { transport, reader } = setup();
  transport.get(`${fx.BASE}/issues`, (call) =>
    Number(call.query.page || 1) === 1
      ? json(200, [fx.issue(1), fx.issue(2, { pull_request: {} })], { link: linkTo(`${fx.BASE}/issues`, 2) })
      : json(200, [fx.issue(3)])
  );
  const result = await reader.listIssues({ state: 'open', labels: ['ready'] });
  assert.equal(result.kind, 'ok');
  assert.deepEqual(result.data.map((issue) => issue.number), [1, 3]);
  assert.equal(transport.calls[0].query.state, 'open');
  assert.equal(transport.calls[0].query.labels, 'ready');

  const onlyPulls = setup();
  onlyPulls.transport.get(`${fx.BASE}/issues`, json(200, [fx.issue(2, { pull_request: {} })]));
  assert.equal((await onlyPulls.reader.listIssues()).kind, 'empty');

  const none = setup();
  none.transport.get(`${fx.BASE}/issues`, json(200, []));
  assert.equal((await none.reader.listIssues()).kind, 'empty');
});

test('empty, missing, denied, rate limited, transient and offline are all different kinds', async () => {
  const kinds = {};
  const cases = {
    empty: json(200, []),
    not_found: json(404, { message: 'Not Found' }),
    denied: json(403, { message: 'Resource not accessible by integration' }),
    rate_limited: json(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' }),
    transient: json(502, {})
  };
  for (const [name, response] of Object.entries(cases)) {
    const { transport, reader } = setup();
    transport.get(`${fx.BASE}/pulls/7/reviews`, response);
    kinds[name] = (await reader.getReviews(7)).kind;
  }
  const offline = createGitHubReadAdapter({ transport: async () => { const e = new Error('x'); e.code = 'ENOTFOUND'; throw e; }, getToken: () => TOKEN });
  kinds.offline = (await offline.useRepository(fx.REPO).getReviews(7)).kind;
  assert.deepEqual(kinds, { empty: 'empty', not_found: 'not_found', denied: 'denied', rate_limited: 'rate_limited', transient: 'transient', offline: 'offline' });
});

test('pull requests expose head SHA, merge state and declared issue links', async () => {
  const { transport, reader } = setup();
  transport.get(`${fx.BASE}/pulls/7`, json(200, fx.pull(7, { body: 'Closes #15 and refs #16', mergeable: null, mergeable_state: 'unknown', head: { sha: fx.SHA_B.toUpperCase(), ref: 'feat/x', repo: null } })));
  const { data } = await reader.getPullRequest(7);
  assert.equal(data.headSha, fx.SHA_B);
  assert.equal(data.mergeable, null, 'not-yet-computed mergeability stays unknown');
  assert.equal(data.headRepository, null);
  assert.deepEqual(data.referencedIssues, [{ number: 15, closes: true }, { number: 16, closes: false }]);
});

test('a payload missing required fields is invalid, not a crash or a silent success', async () => {
  const { transport, reader } = setup();
  transport.get(`${fx.BASE}/pulls/7`, json(200, { number: 7, state: 'open' }));
  const result = await reader.getPullRequest(7);
  assert.equal(result.kind, 'invalid');
  assert.equal(result.reason, 'malformed_payload');
  assert.equal(result.field, 'pull_request.head.sha');
});

test('reviews and comments are normalized across pages', async () => {
  const { transport, reader } = setup();
  transport.get(`${fx.BASE}/pulls/7/reviews`, (call) =>
    Number(call.query.page || 1) === 1
      ? json(200, [fx.review('pm-user', 'APPROVED', fx.SHA_A, '2026-10-14T10:00:00Z')], { link: linkTo(`${fx.BASE}/pulls/7/reviews`, 2) })
      : json(200, [fx.review('pm-user', 'COMMENTED', fx.SHA_A, '2026-10-14T11:00:00Z')])
  );
  transport.get(`${fx.BASE}/issues/7/comments`, json(200, [{ id: 1, user: fx.user('pm-user'), body: 'hi', html_url: `${fx.WEB}/pull/7#issuecomment-1` }]));
  transport.get(`${fx.BASE}/pulls/7/comments`, json(200, [{ id: 2, user: fx.user('pm-user'), body: 'nit', path: 'a.js', line: 3, commit_id: fx.SHA_A, in_reply_to_id: 9 }]));
  const reviews = await reader.getReviews(7);
  assert.deepEqual(reviews.data.map((review) => review.state), ['APPROVED', 'COMMENTED']);
  const conversation = await reader.getIssueComments(7);
  assert.equal(conversation.data[0].kind, 'issue_comment');
  const inline = await reader.getReviewComments(7);
  assert.equal(inline.data[0].path, 'a.js');
  assert.equal(inline.data[0].htmlUrl, `${fx.WEB}/pull/7#discussion_r2`);
});

test('checks combine check runs and commit statuses, requesting only the latest runs', async () => {
  const { transport, reader } = setup();
  transport.get(`${fx.BASE}/commits/${fx.SHA_A}/check-runs`, json(200, { total_count: 1, check_runs: [fx.checkRun('build', 'completed', 'success')] }));
  transport.get(`${fx.BASE}/commits/${fx.SHA_A}/status`, json(200, { state: 'pending', total_count: 1, statuses: [fx.commitStatus('legacy/ci', 'pending')] }));
  const result = await reader.getChecks(fx.SHA_A);
  assert.equal(result.kind, 'ok');
  assert.deepEqual(result.data.checkRuns.map((c) => c.state), ['passing']);
  assert.deepEqual(result.data.statuses.map((c) => c.state), ['pending']);
  assert.equal(transport.calls.find((call) => call.path.endsWith('/check-runs')).query.filter, 'latest');
});

test('checks: both empty is "empty"; one source unreadable is "partial"; both unreadable is a failure', async () => {
  const none = setup();
  none.transport.get(`${fx.BASE}/commits/${fx.SHA_A}/check-runs`, json(200, { total_count: 0, check_runs: [] }));
  none.transport.get(`${fx.BASE}/commits/${fx.SHA_A}/status`, json(200, { state: 'pending', total_count: 0, statuses: [] }));
  assert.equal((await none.reader.getChecks(fx.SHA_A)).kind, 'empty');

  const half = setup();
  half.transport.get(`${fx.BASE}/commits/${fx.SHA_A}/check-runs`, json(200, { total_count: 1, check_runs: [fx.checkRun('build', 'completed', 'success')] }));
  half.transport.get(`${fx.BASE}/commits/${fx.SHA_A}/status`, json(403, { message: 'Resource not accessible by integration' }));
  const partial = await half.reader.getChecks(fx.SHA_A);
  assert.equal(partial.kind, 'partial');
  assert.deepEqual(partial.unavailable, { statuses: 'denied' });
  assert.equal(partial.data.checkRuns.length, 1);

  const both = setup();
  both.transport.get(`${fx.BASE}/commits/${fx.SHA_A}/check-runs`, json(500, {}));
  both.transport.get(`${fx.BASE}/commits/${fx.SHA_A}/status`, json(403, { message: 'nope' }));
  const failure = await both.reader.getChecks(fx.SHA_A);
  assert.equal(failure.kind, 'denied');
  assert.deepEqual(failure.components, { checkRuns: 'transient', statuses: 'denied' });
});

test('an unknown commit SHA is not_found, not a generic error', async () => {
  const { transport, reader } = setup();
  transport.get(`${fx.BASE}/commits/${fx.SHA_B}/check-runs`, json(422, { message: 'No commit found for SHA: ' + fx.SHA_B }));
  transport.get(`${fx.BASE}/commits/${fx.SHA_B}/status`, json(422, { message: 'No commit found for SHA: ' + fx.SHA_B }));
  assert.equal((await reader.getChecks(fx.SHA_B)).kind, 'not_found');
});

test('review threads: paged GraphQL read with resolved state, via a query-only POST', async () => {
  const { transport, reader } = setup();
  transport.post('/graphql', (call) => {
    const { variables, query } = JSON.parse(call.body);
    assert.doesNotMatch(query, /mutation/);
    assert.equal(variables.owner, fx.REPO.owner);
    return json(200, variables.after === null
      ? fx.threadsResponse([fx.threadNode('T1', true), fx.threadNode('T2', false)], { hasNextPage: true, endCursor: 'c1', reviewDecision: 'REVIEW_REQUIRED' })
      : fx.threadsResponse([fx.threadNode('T3', false)]));
  });
  const result = await reader.getReviewThreads(7);
  assert.equal(result.kind, 'ok');
  assert.equal(result.pages, 2);
  assert.equal(result.data.threads.length, 3);
  assert.equal(result.data.unresolvedCount, 2);
  assert.equal(result.data.reviewDecision, 'REVIEW_REQUIRED');
  assert.equal(result.data.headSha, fx.SHA_A);
});

test('review threads: none is empty; anonymous access is denied (unknown), not "no threads"', async () => {
  const none = setup();
  none.transport.post('/graphql', json(200, fx.threadsResponse([])));
  assert.equal((await none.reader.getReviewThreads(7)).kind, 'empty');

  const anonymous = setup({ getToken: () => undefined });
  anonymous.transport.post('/graphql', json(401, { message: 'Requires authentication' }));
  assert.equal((await anonymous.reader.getReviewThreads(7)).kind, 'denied');

  const missing = setup();
  missing.transport.post('/graphql', json(200, { data: { repository: { pullRequest: null } } }));
  assert.equal((await missing.reader.getReviewThreads(7)).kind, 'not_found');
});

test('review threads: a failure on a later page keeps earlier threads as partialData only', async () => {
  const { transport, reader } = setup();
  transport.post('/graphql', (call) =>
    JSON.parse(call.body).variables.after === null
      ? json(200, fx.threadsResponse([fx.threadNode('T1', false)], { hasNextPage: true, endCursor: 'c1' }))
      : json(502, {})
  );
  const result = await reader.getReviewThreads(7);
  assert.equal(result.kind, 'transient');
  assert.equal(result.partialData.length, 1);
  assert.equal(result.data, undefined);
});

test('branch rules: rulesets and classic protection are read and merged', async () => {
  const { transport, reader } = setup();
  transport.get(`${fx.BASE}/rules/branches/main`, json(200, [{ type: 'pull_request', ruleset_id: 5, parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: true } }, { type: 'required_status_checks', ruleset_id: 5, parameters: { required_status_checks: [{ context: 'build' }] } }]));
  transport.get(`${fx.BASE}/branches/main/protection`, json(404, { message: 'Branch not protected' }));
  const result = await reader.getBranchRequirements('main');
  assert.equal(result.kind, 'ok');
  assert.equal(result.data.complete, true);
  assert.equal(result.data.requiredApprovingReviewCount, 1);
  assert.deepEqual(result.data.requiredStatusChecks, ['build']);
});

test('branch rules: "Branch not protected" means no protection, but 403 means unknown', async () => {
  const bare = setup();
  bare.transport.get(`${fx.BASE}/rules/branches/main`, json(200, []));
  bare.transport.get(`${fx.BASE}/branches/main/protection`, json(404, { message: 'Branch not protected' }));
  const none = await bare.reader.getBranchRequirements('main');
  assert.equal(none.kind, 'empty');
  assert.equal(none.data.complete, true);

  const locked = setup();
  locked.transport.get(`${fx.BASE}/rules/branches/main`, json(200, []));
  locked.transport.get(`${fx.BASE}/branches/main/protection`, json(403, { message: 'Resource not accessible by integration' }));
  const partial = await locked.reader.getBranchRequirements('main');
  assert.equal(partial.kind, 'partial');
  assert.deepEqual(partial.unavailable, { protection: 'denied' });
  assert.equal(partial.data.complete, false);

  const gone = setup();
  gone.transport.get(`${fx.BASE}/rules/branches/main`, json(404, { message: 'Not Found' }));
  gone.transport.get(`${fx.BASE}/branches/main/protection`, json(404, { message: 'Not Found' }));
  assert.equal((await gone.reader.getBranchRequirements('main')).kind, 'not_found');
});

test('branch names with slashes are percent-encoded into one path segment', async () => {
  const { transport, reader } = setup();
  transport.get(/rules\/branches\//, json(200, []));
  transport.get(/protection$/, json(404, { message: 'Branch not protected' }));
  await reader.getBranchRequirements('release/1.0');
  assert.ok(transport.calls.some((call) => call.path.endsWith('/rules/branches/release%2F1.0')));
});

test('inputs are validated before any request is made', async () => {
  const { transport, reader, adapter } = setup();
  assert.throws(() => reader.getIssue(0), TypeError);
  assert.throws(() => reader.getIssue('7'), TypeError);
  assert.throws(() => reader.getChecks('main'), TypeError);
  assert.throws(() => reader.getBranchRules(''), TypeError);
  assert.throws(() => reader.listIssues({ state: 'everything' }), TypeError);
  assert.throws(() => adapter.useRepository({ owner: '../x', name: 'y' }), TypeError);
  assert.throws(() => adapter.useRepository({ owner: 'a', name: 'b/c' }), TypeError);
  assert.equal(transport.calls.length, 0);
});

test('switching repository cancels in-flight reads and retires the old reader', async () => {
  const { transport, adapter, reader } = setup();
  let release;
  transport.get(`${fx.BASE}/issues/1`, () => new Promise((resolve) => { release = () => resolve(json(200, fx.issue(1))); }));
  const pending = reader.getIssue(1);
  await new Promise((resolve) => setImmediate(resolve));

  const other = adapter.useRepository({ owner: 'another-org', name: 'another-repo' });
  assert.notEqual(other, reader);
  assert.equal((await pending).kind, 'cancelled');
  assert.equal(transport.calls[0].signal.aborted, true, 'the transport is told to stop');
  release();

  const late = await reader.getIssue(1);
  assert.equal(late.kind, 'cancelled');
  assert.equal(late.reason, 'repository_changed');
  assert.equal(transport.calls.length, 1, 'a retired reader makes no further requests');
});

test('a response that arrives after the switch is discarded, even from a transport that ignores abort', async () => {
  const { transport, adapter, reader } = setup();
  transport.get(`${fx.BASE}/issues/1`, async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return json(200, fx.issue(1));
  });
  const pending = reader.getIssue(1);
  adapter.useRepository({ owner: 'another-org', name: 'another-repo' });
  const result = await pending;
  assert.equal(result.kind, 'cancelled');
  assert.equal(result.reason, 'repository_changed');
});

test('repositories never share cached data; selecting the same repository again keeps the reader', async () => {
  const { transport, adapter, reader } = setup();
  const otherRepo = { owner: 'another-org', name: 'another-repo' };
  transport.get(`${fx.BASE}/issues/1`, json(200, fx.issue(1, { title: 'first repo' })));
  transport.get('/repos/another-org/another-repo/issues/1', json(200, fx.issue(1, { title: 'second repo', html_url: 'https://github.com/another-org/another-repo/issues/1' })));
  assert.equal((await reader.getIssue(1)).data.title, 'first repo');
  assert.equal(adapter.useRepository({ owner: fx.REPO.owner.toUpperCase(), name: fx.REPO.name }), reader, 'names are case-insensitive');
  const second = adapter.useRepository(otherRepo);
  const result = await second.getIssue(1);
  assert.equal(result.data.title, 'second repo');
  assert.equal(result.data.htmlUrl, 'https://github.com/another-org/another-repo/issues/1');
  assert.deepEqual(adapter.getActiveRepository(), otherRepo);
});

test('caller cancellation is honoured per read', async () => {
  const { transport, reader } = setup();
  transport.get(`${fx.BASE}/issues/1`, () => new Promise(() => {}));
  const controller = new AbortController();
  const pending = reader.getIssue(1, { signal: controller.signal });
  setTimeout(() => controller.abort(), 5);
  const result = await pending;
  assert.equal(result.kind, 'cancelled');
  assert.equal(result.reason, 'aborted');
});

test('repository metadata exposes the default branch and viewer permissions', async () => {
  const { transport, reader } = setup();
  transport.get(fx.BASE, json(200, { id: 99, full_name: 'example-org/example-repo', default_branch: 'main', private: true, has_issues: true, permissions: { admin: false, push: true, pull: true }, html_url: fx.WEB }));
  const { data } = await reader.getRepository();
  assert.equal(data.defaultBranch, 'main');
  assert.deepEqual(data.viewerPermissions, { admin: false, push: true, pull: true });
});

test('every request the adapter makes is a GET, except fixed GraphQL queries', async () => {
  const { transport, reader } = setup();
  transport.get(/.*/, json(200, []));
  transport.post('/graphql', json(200, fx.threadsResponse([])));
  await Promise.all([reader.getRepository(), reader.listIssues(), reader.listPullRequests(), reader.getReviews(7), reader.getIssueComments(7), reader.getReviewComments(7), reader.getBranchRules('main'), reader.getReviewThreads(7)]);
  for (const call of transport.calls) {
    if (call.method === 'GET') continue;
    assert.equal(call.method, 'POST');
    assert.equal(call.path, '/graphql');
    assert.doesNotMatch(call.body, /mutation|subscription/);
  }
  assert.ok(transport.calls.length >= 8);
});
