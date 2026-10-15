'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assessMerge, mergePullRequest } = require('../../src/delivery/merge');

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const REPOSITORY = { owner: 'example', name: 'project' };
const CONFIG = { pmActorId: '10', pmLogin: 'pm-user', mergeAuthority: 'pm' };

function snapshot(extra = {}) {
  const pr = {
    number: 7, state: 'open', merged: false, draft: false, author: 'worker-user',
    title: 'Safe change', body: 'Refs #17', headSha: HEAD, mergeable: true, baseRef: 'main', ...(extra.pr || {})
  };
  const value = {
    repository: REPOSITORY,
    number: 7,
    status: 'complete',
    consistent: true,
    headSha: HEAD,
    pullRequest: { kind: 'ok', data: pr },
    reviews: { kind: 'ok', data: [] },
    approval: {
      status: 'approved', reason: 'approved_on_current_head', headSha: HEAD,
      currentApprovals: [{ reviewer: 'pm-user', reviewId: 1, commitId: HEAD }],
      staleApprovals: [], changesRequested: [], selfApprovalsIgnored: []
    },
    checks: { kind: 'ok', data: { headSha: HEAD, checkRuns: [{}], statuses: [] } },
    checksSummary: { headSha: HEAD, state: 'passing', requiredState: 'passing', counts: { passing: 1, failing: 0, pending: 0 }, failing: [], pending: [], missingRequired: [] },
    threads: { kind: 'empty', data: { headSha: HEAD, threads: [], unresolvedCount: 0 } },
    unresolvedThreads: 0,
    requirements: {
      kind: 'ok',
      data: {
        complete: true, ruleTypes: ['pull_request', 'required_status_checks'],
        requireCodeOwnerReview: false, requireLastPushApproval: false, strictStatusChecks: false
      }
    }
  };
  const { pr: ignored, ...rest } = extra;
  return { ...value, ...rest };
}

const context = (extra = {}) => ({
  role: 'pm', actorId: '10', authorId: '20', pmLogin: 'pm-user',
  policyConfig: CONFIG, privateReferencesChecked: true, ...extra
});

function readerFor(value = snapshot(), publication = {
  kind: 'ok', data: { complete: true, number: 7, headSha: HEAD, diff: 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -0,0 +1 @@\n+const safe = true;\n' }
}) {
  return {
    getPullRequestSnapshot: async () => value,
    getPullRequestPublication: async () => publication
  };
}

test('a complete current snapshot passes the pure merge decision', () => {
  assert.deepEqual(assessMerge(snapshot(), context()), {
    ok: true, reason: 'merge-ready', pullNumber: 7, headSha: HEAD
  });
});

test('worker merge and the default human mode are refused by the shared publication policy', () => {
  assert.equal(assessMerge(snapshot(), context({ role: 'worker', actorId: '20' })).reason, 'role-forbidden');
  assert.equal(assessMerge(snapshot(), context({ policyConfig: { ...CONFIG, mergeAuthority: 'human' } })).reason, 'human-merge-required');
});

test('only a formal PM approval bound to the latest head counts', () => {
  const cases = [
    [{ approval: { ...snapshot().approval, status: 'not_approved', reason: 'approval_stale', currentApprovals: [], staleApprovals: [{ reviewer: 'pm-user', commitId: OLD }] } }, 'approval-stale'],
    [{ approval: { ...snapshot().approval, status: 'not_approved', reason: 'no_approval', currentApprovals: [] } }, 'approval-required'],
    [{ approval: { ...snapshot().approval, status: 'not_approved', reason: 'self_approval_only', currentApprovals: [], selfApprovalsIgnored: [{ reviewer: 'worker-user', commitId: HEAD }] } }, 'self-approval-forbidden'],
    [{ approval: { ...snapshot().approval, currentApprovals: [{ reviewer: 'another-reviewer', commitId: HEAD }] } }, 'current-pm-approval-required'],
    [{ approval: { ...snapshot().approval, status: 'changes_requested', reason: 'changes_requested', currentApprovals: [] } }, 'changes-requested']
  ];
  for (const [change, reason] of cases) assert.equal(assessMerge(snapshot(change), context()).reason, reason);
  assert.equal(assessMerge(snapshot({ reviews: { kind: 'partial', data: [] } }), context()).reason, 'approval-unknown');
  assert.equal(assessMerge(snapshot({ approval: { ...snapshot().approval, changesRequested: null } }), context()).reason, 'approval-unknown');
  assert.equal(assessMerge(snapshot({ approval: { ...snapshot().approval, changesRequested: [{ reviewer: 'someone' }] } }), context()).reason, 'changes-requested');
  assert.equal(assessMerge(snapshot({ approval: { ...snapshot().approval, headSha: OLD } }), context()).reason, 'approval-stale');
});

test('a shared GitHub login cannot supply a formal PM review of its own PR', () => {
  assert.equal(assessMerge(snapshot({ pr: { author: 'PM-USER' } }), context()).reason, 'github-identities-not-separated');
  assert.equal(assessMerge(snapshot(), context({ pmLogin: 'another-pm' })).reason, 'pm-github-identity-unverified');
});

test('missing, pending, failing, stale, and unreadable CI have distinct closed outcomes', () => {
  const cases = [
    [{ checks: { kind: 'empty', data: { headSha: HEAD, checkRuns: [], statuses: [] } }, checksSummary: { ...snapshot().checksSummary, state: 'none', requiredState: 'not_required', counts: { passing: 0, failing: 0, pending: 0 } } }, 'ci-missing'],
    [{ checksSummary: { ...snapshot().checksSummary, state: 'pending', requiredState: 'pending', pending: ['build'], counts: { passing: 0, failing: 0, pending: 1 } } }, 'ci-pending'],
    [{ checksSummary: { ...snapshot().checksSummary, state: 'failing', requiredState: 'failing', failing: ['build'], counts: { passing: 0, failing: 1, pending: 0 } } }, 'ci-failing'],
    [{ checksSummary: { headSha: HEAD, state: 'unknown', requiredState: 'unknown' } }, 'ci-unknown'],
    [{ checksSummary: { headSha: OLD, state: 'passing', requiredState: 'passing' } }, 'ci-unknown'],
    [{ checks: { kind: 'ok', data: { headSha: OLD } } }, 'ci-stale'],
    [{ checks: { kind: 'partial', data: { headSha: HEAD } } }, 'ci-unknown']
  ];
  for (const [change, reason] of cases) assert.equal(assessMerge(snapshot(change), context()).reason, reason);
  for (const checksSummary of [
    { ...snapshot().checksSummary, failing: ['build'] },
    { ...snapshot().checksSummary, pending: ['tests'] },
    { ...snapshot().checksSummary, missingRequired: ['lint'] },
    { ...snapshot().checksSummary, counts: { passing: 1, failing: 1, pending: 0 } }
  ]) assert.equal(assessMerge(snapshot({ checksSummary }), context()).reason, 'ci-unknown');
});

test('unknown or unresolved conversations and branch rules block merge', () => {
  assert.equal(assessMerge(snapshot({
    threads: { kind: 'ok', data: { headSha: HEAD, unresolvedCount: 1 } },
    unresolvedThreads: 1
  }), context()).reason, 'threads-unresolved');
  assert.equal(assessMerge(snapshot({ threads: { kind: 'denied' }, unresolvedThreads: null }), context()).reason, 'threads-unknown');
  assert.equal(assessMerge(snapshot({ threads: { kind: 'ok', data: { headSha: OLD } } }), context()).reason, 'threads-stale');
  assert.equal(assessMerge(snapshot({ threads: { kind: 'empty', data: { headSha: HEAD, unresolvedCount: 1 } } }), context()).reason, 'threads-unknown');
  assert.equal(assessMerge(snapshot({ requirements: { kind: 'partial', data: { complete: false } } }), context()).reason, 'branch-rules-unknown');
  const unsupported = snapshot();
  unsupported.requirements.data.ruleTypes.push('required_signatures');
  assert.equal(assessMerge(unsupported, context()).reason, 'branch-rules-unsupported');
  for (const key of ['requireCodeOwnerReview', 'requireLastPushApproval', 'strictStatusChecks']) {
    const required = snapshot();
    required.requirements.data[key] = true;
    assert.equal(assessMerge(required, context()).reason, 'branch-rules-unsupported', `${key}=true`);
    for (const invalid of [undefined, null, 'false']) {
      const malformed = snapshot();
      delete malformed.requirements.data[key];
      if (invalid !== undefined) malformed.requirements.data[key] = invalid;
      assert.equal(assessMerge(malformed, context()).reason, 'branch-rules-unknown', `${key}=${String(invalid)}`);
    }
  }
  assert.equal(assessMerge(snapshot({ requirements: { kind: 'ok', data: { ...snapshot().requirements.data, complete: null } } }), context()).reason, 'branch-rules-unknown');
});

test('inconsistent snapshots, changed heads, and mismatched PR identities are rejected', () => {
  assert.equal(assessMerge(snapshot({ consistent: false }), context()).reason, 'snapshot-inconsistent');
  assert.equal(assessMerge(snapshot({ headSha: OLD }), context()).reason, 'head-unverified');
  assert.equal(assessMerge(snapshot({ number: 8 }), context({ expectedNumber: 7 })).reason, 'pr-mismatch');
});

test('coordinator force-refreshes snapshot and bound content, then sends only the expected head to the writer', async () => {
  const reads = [];
  const contentReads = [];
  const writes = [];
  const reader = {
    getPullRequestSnapshot: async (...args) => { reads.push(args); return snapshot(); },
    getPullRequestPublication: async (...args) => {
      contentReads.push(args);
      return { kind: 'ok', data: { complete: true, number: 7, headSha: HEAD, diff: 'safe diff' } };
    }
  };
  const writer = { mergePullRequest: async payload => { writes.push(payload); return { ok: true }; } };
  const result = await mergePullRequest({
    reader, writer, repository: REPOSITORY, pullNumber: 7,
    ...context()
  });
  assert.deepEqual(result, { ok: true, reason: 'merged', pullNumber: 7, headSha: HEAD });
  assert.deepEqual(reads, [[7, { forceRefresh: true }]]);
  assert.deepEqual(contentReads, [[7, HEAD, { forceRefresh: true }]]);
  assert.deepEqual(writes, [{ repository: REPOSITORY, number: 7, expectedHeadSha: HEAD, commitTitle: 'Safe change', commitMessage: 'Refs #17' }]);
});

test('a secret in the current PR body is scanned even when the bound diff is benign', async () => {
  const writes = [];
  const common = {
    writer: { mergePullRequest: async payload => { writes.push(payload); return { ok: true }; } },
    repository: REPOSITORY, pullNumber: 7, ...context()
  };
  const bodySecret = await mergePullRequest({
    ...common, reader: readerFor(snapshot({ pr: { body: `accidental ghp_${'x'.repeat(36)}` } }))
  });
  assert.deepEqual([bodySecret.ok, bodySecret.reason, bodySecret.scanStatus], [false, 'publication-blocked', 'blocked']);

  const diffSecret = await mergePullRequest({
    ...common,
    reader: readerFor(snapshot(), { kind: 'ok', data: {
      complete: true, number: 7, headSha: HEAD,
      diff: `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+ghp_${'x'.repeat(36)}\n`
    } })
  });
  assert.deepEqual([diffSecret.ok, diffSecret.reason, diffSecret.scanStatus], [false, 'publication-blocked', 'blocked']);
  assert.equal(writes.length, 0);
});

test('caller scan overrides cannot bypass the mandatory publication detectors', async () => {
  let writes = 0;
  const result = await mergePullRequest({
    reader: readerFor(snapshot({ pr: { body: `accidental ghp_${'x'.repeat(36)}` } })),
    writer: { mergePullRequest: async () => { writes += 1; return { ok: true }; } },
    repository: REPOSITORY, pullNumber: 7, ...context(),
    scan: () => ({ status: 'clear', blocked: false }),
    scanOptions: { detectors: [] }
  });
  assert.deepEqual([result.ok, result.reason, result.scanStatus], [false, 'publication-blocked', 'blocked']);
  assert.equal(writes, 0);
});

test('missing, partial, stale, or mismatched publication evidence fails closed', async () => {
  const cases = [
    { kind: 'partial', data: { complete: false, number: 7, headSha: HEAD, diff: 'safe' } },
    { kind: 'ok', data: { complete: false, number: 7, headSha: HEAD, diff: 'safe' } },
    { kind: 'ok', data: { complete: true, number: 7, headSha: OLD, diff: 'safe' } },
    { kind: 'ok', data: { complete: true, number: 8, headSha: HEAD, diff: 'safe' } },
    { kind: 'ok', data: { complete: true, number: 7, headSha: HEAD } },
    { kind: 'ok', data: { complete: true, number: 7, headSha: HEAD, diff: '' } }
  ];
  for (const publication of cases) {
    let writes = 0;
    const result = await mergePullRequest({
      reader: readerFor(snapshot(), publication),
      writer: { mergePullRequest: async () => { writes += 1; return { ok: true }; } },
      repository: REPOSITORY, pullNumber: 7, ...context()
    });
    assert.equal(result.reason, 'publication-unverified');
    assert.equal(writes, 0);
  }
});

test('a failed policy decision never scans or writes', async () => {
  let writes = 0;
  let contentReads = 0;
  const result = await mergePullRequest({
    reader: {
      getPullRequestSnapshot: async () => snapshot(),
      getPullRequestPublication: async () => { contentReads += 1; return {}; }
    },
    writer: { mergePullRequest: async () => { writes += 1; return { ok: true }; } },
    repository: REPOSITORY, pullNumber: 7, ...context({ role: 'worker', actorId: '20' })
  });
  assert.equal(result.reason, 'role-forbidden');
  assert.deepEqual([contentReads, writes], [0, 0]);
});

test('writer conflicts are returned and unknown outcomes are not retried', async () => {
  for (const [implementation, expected] of [
    [async () => ({ ok: false, reason: 'head-changed' }), ['merge-refused', 'head-changed']],
    [async () => ({ ok: false, reason: 'backend said secret text' }), ['merge-refused', 'unknown']],
    [async () => { throw new Error('connection reset'); }, ['merge-outcome-unknown', undefined]],
    [async () => ({}), ['merge-outcome-unknown', undefined]]
  ]) {
    let calls = 0;
    const result = await mergePullRequest({
      reader: readerFor(),
      writer: { mergePullRequest: async payload => { calls += 1; return implementation(payload); } },
      repository: REPOSITORY, pullNumber: 7, ...context()
    });
    assert.deepEqual([result.reason, result.writerReason], expected);
    assert.equal(calls, 1);
  }
});

test('read failures and repository confusion never reach scan or writer', async () => {
  let calls = 0;
  const base = {
    writer: { mergePullRequest: async () => { calls += 1; return { ok: true }; } },
    repository: REPOSITORY, pullNumber: 7, ...context()
  };
  assert.equal((await mergePullRequest({ ...base, reader: { ...readerFor(), getPullRequestSnapshot: async () => { throw new Error('offline'); } } })).reason, 'cannot-verify');
  assert.equal((await mergePullRequest({ ...base, reader: { ...readerFor(), getPullRequestSnapshot: async () => ({ kind: 'cancelled' }) } })).reason, 'snapshot-incomplete');
  assert.equal((await mergePullRequest({ ...base, reader: readerFor(snapshot({ repository: { owner: 'evil', name: 'project' } })) })).reason, 'repository-mismatch');
  assert.equal(calls, 0);
});

test('publication reader failures are closed and never expose their error', async () => {
  let writes = 0;
  const result = await mergePullRequest({
    reader: { ...readerFor(), getPullRequestPublication: async () => { throw new Error('private response'); } },
    writer: { mergePullRequest: async () => { writes += 1; return { ok: true }; } },
    repository: REPOSITORY, pullNumber: 7, ...context()
  });
  assert.deepEqual(result, { ok: false, reason: 'publication-unverified' });
  assert.equal(writes, 0);
});

test('missing adapters are programming errors', async () => {
  const base = { repository: REPOSITORY, pullNumber: 7, ...context() };
  await assert.rejects(() => mergePullRequest({ ...base, reader: {}, writer: { mergePullRequest() {} } }), TypeError);
  await assert.rejects(() => mergePullRequest({ ...base, reader: { getPullRequestSnapshot() {} }, writer: { mergePullRequest() {} } }), TypeError);
  await assert.rejects(() => mergePullRequest({ ...base, reader: readerFor(), writer: {} }), TypeError);
});

const attempt = async (extra, pr) => {
  const writes = [];
  const result = await mergePullRequest({
    reader: readerFor(snapshot(pr ? { pr } : {})),
    writer: { mergePullRequest: async (payload) => { writes.push(payload); return { ok: true }; } },
    repository: REPOSITORY, pullNumber: 7, ...context(), ...extra
  });
  return { result, writes };
};

test('a scan given no private material is refused unless the caller states it checked', async () => {
  for (const extra of [
    { privateReferencesChecked: undefined },
    { privateReferencesChecked: false },
    { privateReferencesChecked: 'true' },
    { privateReferencesChecked: 1 },
    { privateReferencesChecked: undefined, scanOptions: {} },
    { privateReferencesChecked: undefined, scanOptions: { memories: [], rules: [], knownValues: [] } },
    { privateReferencesChecked: undefined, scanOptions: { memories: undefined, rules: undefined, knownValues: undefined } }
  ]) {
    const { result, writes } = await attempt(extra);
    assert.equal(result.reason, 'private-reference-unchecked', JSON.stringify(extra));
    assert.equal(writes.length, 0);
  }
});

test('supplying private material, or stating it was checked, lets a clean PR through', async () => {
  const supplied = await attempt({ privateReferencesChecked: undefined, scanOptions: { knownValues: [{ id: 'label', value: 'private-label-value' }] } });
  assert.equal(supplied.result.ok, true);
  const stated = await attempt({ privateReferencesChecked: true });
  assert.equal(stated.result.ok, true);
});

test('supplied private memory still blocks text that repeats it, and a blocked scan is reported before the unchecked refusal', async () => {
  const memories = [{ id: 'm1', content: 'The release signing procedure uses the offline hardware token kept in the safe.' }];
  const { result, writes } = await attempt({ privateReferencesChecked: undefined, scanOptions: { memories } }, { body: 'Note: the release signing procedure uses the offline hardware token kept in the safe.' });
  assert.equal(result.reason, 'publication-blocked');
  assert.equal(writes.length, 0);
  const leaky = await attempt({ privateReferencesChecked: undefined }, { body: `accidental ghp_${'x'.repeat(36)}` });
  assert.equal(leaky.result.reason, 'publication-blocked');
});

test('the writer receives exactly the scanned title and body as the commit text', async () => {
  const { writes } = await attempt({}, { title: 'Scanned title', body: 'Scanned body, Refs #17' });
  assert.equal(writes[0].commitTitle, 'Scanned title');
  assert.equal(writes[0].commitMessage, 'Scanned body, Refs #17');
  const empty = await attempt({}, { body: null });
  assert.equal(empty.writes[0].commitMessage, '');
});
