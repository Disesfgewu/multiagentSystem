'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Broker, OPERATIONS, EXPECTED_PERMISSIONS } = require('../../src/broker/broker');

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const REPO = { owner: 'example', name: 'project' };
const CONFIG = { pmActorId: '10', pmLogin: 'pm-user', mergeAuthority: 'pm' };
const TOKEN = `ghp_${'x'.repeat(36)}`;

function snapshot(over = {}) {
  return {
    repository: REPO, number: 7, status: 'complete', consistent: true, headSha: HEAD,
    pullRequest: { kind: 'ok', data: { number: 7, state: 'open', merged: false, draft: false, author: 'worker-user', title: 'Safe change', body: 'Refs #24', headSha: HEAD, mergeable: true, baseRef: 'main', ...(over.pr || {}) } },
    reviews: { kind: 'ok', data: [] },
    approval: { status: 'approved', reason: 'approved_on_current_head', headSha: HEAD, currentApprovals: [{ reviewer: 'pm-user', reviewId: 1, commitId: HEAD }], staleApprovals: [], changesRequested: [], selfApprovalsIgnored: [] },
    checks: { kind: 'ok', data: { headSha: HEAD, checkRuns: [{}], statuses: [] } },
    checksSummary: { headSha: HEAD, state: 'passing', requiredState: 'passing', counts: { passing: 1, failing: 0, pending: 0 }, failing: [], pending: [], missingRequired: [] },
    threads: { kind: 'empty', data: { headSha: HEAD, threads: [], unresolvedCount: 0 } },
    unresolvedThreads: 0,
    requirements: { kind: 'ok', data: { complete: true, ruleTypes: ['pull_request', 'required_status_checks'], requireCodeOwnerReview: false, requireLastPushApproval: false, strictStatusChecks: false } }
  };
}

function setup(over = {}) {
  const calls = [];
  const audits = [];
  const locks = new Map();
  let actor = over.actor === undefined ? { actorId: '20', role: 'worker' } : over.actor;
  const transport = new Proxy({}, {
    get: (_t, name) => async (input) => {
      calls.push([name, input]);
      if (over.transport?.[name]) return over.transport[name](input);
      return { ok: true, number: 5 };
    }
  });
  const deps = {
    identity: { current: () => { if (actor instanceof Error) throw actor; return actor; }, actorIdForLogin: (login) => (login === 'worker-user' ? '20' : login === 'pm-user' ? '10' : null) },
    reader: {
      getIssue: async () => ({ kind: 'ok', data: { state: 'open', isPullRequest: false, assignees: [] } }),
      getPullRequestSnapshot: async () => snapshot(),
      getPullRequestPublication: async () => ({ kind: 'ok', data: { complete: true, number: 7, headSha: HEAD, diff: 'diff --git a/a.js b/a.js\n+const safe = 1;\n' } }),
      ...(over.reader || {})
    },
    content: { getCommitContent: async (sha) => ({ complete: true, headSha: sha, message: 'Add safe change', diff: 'diff --git a/a.js b/a.js\n+const safe = 1;\n' }), getRangeMessages: async ({ headSha }) => ({ complete: true, headSha, messages: [{ sha: headSha, message: 'Add safe change' }] }), ...(over.content || {}) },
    transport,
    audit: over.audit || { record: (entry) => audits.push(entry) },
    config: { ...CONFIG, ...(over.config || {}) },
    project: { repository: REPO },
    lock: over.lock === undefined ? { acquire: (key) => (locks.has(key) ? null : (locks.set(key, 't'), 't')), release: (key) => locks.delete(key) } : over.lock,
    privateReferencesChecked: true
  };
  const broker = new Broker(deps);
  return { broker, calls, audits, locks, setActor: (next) => { actor = next; } };
}
let counter = 0;
const id = () => `req-${String(++counter).padStart(8, '0')}`;
const asPm = { actorId: '10', role: 'pm' };

test('every operation is denied unless listed; unknown, prototype and non-string operations never reach the transport', async () => {
  const { broker, calls } = setup();
  for (const operation of ['deleteRepo', 'forcePush', 'constructor', '__proto__', 'toString', '', undefined, 5, null]) {
    const result = await broker.request({ operation, requestId: id() });
    assert.deepEqual([result.ok, result.reason], [false, 'operation-unsupported'], String(operation));
  }
  assert.equal((await broker.request(null)).reason, 'operation-unsupported');
  assert.equal(calls.length, 0);
  assert.deepEqual(Object.keys(OPERATIONS).sort(), Object.keys(EXPECTED_PERMISSIONS).sort());
});

test('request shape: id, unknown fields and bad values are refused before anything else', async () => {
  const { broker, calls } = setup({ actor: asPm });
  for (const requestId of [undefined, '', 'short', 'x'.repeat(65), 'bad id here', 5]) {
    assert.equal((await broker.request({ operation: 'createIssue', requestId, title: 't', body: 'b' })).reason, 'request-id-invalid', String(requestId));
  }
  assert.equal((await broker.request({ operation: 'createIssue', requestId: id(), title: 't', body: 'b', labels: ['x'] })).reason, 'unknown-field');
  for (const bad of [{ title: '' }, { title: 5 }, { body: '  ' }, { title: undefined }]) {
    assert.equal((await broker.request({ operation: 'createIssue', requestId: id(), title: 't', body: 'b', ...bad })).reason, 'invalid-field', JSON.stringify(bad));
  }
  assert.equal((await broker.request({ operation: 'editIssue', requestId: id(), number: 3 })).reason, 'invalid-field', 'an edit must change something');
  assert.equal((await broker.request({ operation: 'claimIssue', requestId: id(), number: 0 })).reason, 'invalid-field');
  assert.equal(calls.length, 0);
});

test('identity comes only from the trusted source: forged fields are refused and a failing source denies', async () => {
  const { broker, calls, setActor } = setup({ actor: asPm });
  for (const field of ['actorId', 'role', 'token', 'credential', 'authorization', 'password', 'secret', 'headers']) {
    const result = await broker.request({ operation: 'createIssue', requestId: id(), title: 't', body: 'b', [field]: 'x' });
    assert.equal(result.reason, 'identity-or-credential-in-request', field);
  }
  for (const actor of [null, undefined, {}, { actorId: '', role: 'pm' }, { actorId: '10', role: 'admin' }, { actorId: '10' }, 'pm', new Error('auth down')]) {
    setActor(actor);
    assert.equal((await broker.request({ operation: 'createIssue', requestId: id(), title: 't', body: 'b' })).reason, 'identity-unverified', String(actor));
  }
  assert.equal(calls.length, 0);
});

test('roles: each operation only for its role; the PM cannot claim or open a PR; a worker cannot define issues, review or merge', async () => {
  const asks = {
    createIssue: { title: 't', body: 'b' }, editIssue: { number: 3, title: 't' }, closeIssue: { number: 3, reason: 'completed' }, claimIssue: { number: 3 },
    createPr: { title: 't', body: 'b', headBranch: 'feat/x', headSha: HEAD, baseBranch: 'main' }, commit: { headSha: HEAD },
    push: { branch: 'feat/x', headSha: HEAD }, comment: { target: 'issue', number: 3, body: 'hi' },
    reviewPr: { number: 7, decision: 'approve', body: 'ok', expectedHeadSha: HEAD }, mergePr: { number: 7 }, deleteBranch: { number: 7, expectedHeadSha: HEAD }
  };
  for (const [operation, fields] of Object.entries(asks)) {
    const allowed = OPERATIONS[operation].roles;
    for (const actor of [{ actorId: '20', role: 'worker' }, asPm]) {
      if (allowed.includes(actor.role)) continue;
      const { broker, calls } = setup({ actor });
      const result = await broker.request({ operation, requestId: id(), ...fields });
      assert.deepEqual([result.ok, result.reason], [false, 'role-forbidden'], `${operation} as ${actor.role}`);
      assert.equal(calls.length, 0);
    }
  }
});

test('identity separation: a worker with the PM actor id, or a PM with another id, is refused', async () => {
  for (const [actor, op] of [[{ actorId: '10', role: 'worker' }, { operation: 'claimIssue', number: 3 }], [{ actorId: '99', role: 'pm' }, { operation: 'createIssue', title: 't', body: 'b' }], [{ actorId: '99', role: 'pm' }, { operation: 'mergePr', number: 7 }]]) {
    const { broker, calls } = setup({ actor });
    const result = await broker.request({ requestId: id(), ...op });
    assert.equal(result.ok, false);
    assert.match(result.reason, /identit/);
    assert.equal(calls.length, 0);
  }
});

test('content violations are blocked before the transport, for every kind of text, without echoing it', async () => {
  const cases = [
    [asPm, { operation: 'createIssue', title: 'ok', body: `leak ${TOKEN}` }],
    [asPm, { operation: 'createIssue', title: `leak ${TOKEN}`, body: 'ok' }],
    [asPm, { operation: 'editIssue', number: 3, body: `leak ${TOKEN}` }],
    [asPm, { operation: 'comment', target: 'pr', number: 7, body: 'see C:\\\\Users\\\\someone\\\\x' }],
    [asPm, { operation: 'reviewPr', number: 7, decision: 'comment', body: `leak ${TOKEN}`, expectedHeadSha: HEAD }],
    [undefined, { operation: 'createPr', title: 'ok', body: `leak ${TOKEN}`, headBranch: 'feat/x', headSha: HEAD, baseBranch: 'main' }]
  ];
  for (const [actor, op] of cases) {
    const { broker, calls, audits } = setup({ actor });
    const result = await broker.request({ requestId: id(), ...op });
    assert.deepEqual([result.ok, result.reason], [false, 'content-blocked'], JSON.stringify(op));
    assert.equal(calls.length, 0);
    assert.equal(JSON.stringify([result, audits]).includes(TOKEN), false);
  }
});

test('commit, push and PR content is the trusted reader\'s, not the caller\'s; unreadable or mismatched content is refused', async () => {
  const dirty = { getCommitContent: async (sha) => ({ complete: true, headSha: sha, message: 'ok', diff: `+const k = "${TOKEN}";\n` }) };
  for (const [operation, fields] of [['commit', { headSha: HEAD }], ['push', { branch: 'feat/x', headSha: HEAD }], ['createPr', { title: 't', body: 'b', headBranch: 'feat/x', headSha: HEAD, baseBranch: 'main' }]]) {
    const blocked = setup({ content: dirty });
    assert.equal((await blocked.broker.request({ operation, requestId: id(), ...fields })).reason, 'content-blocked', operation);
    assert.equal(blocked.calls.length, 0);
    for (const content of [
      { getCommitContent: async () => { throw new Error('offline'); } },
      { getCommitContent: async (sha) => ({ complete: false, headSha: sha, message: 'm', diff: 'd' }) },
      { getCommitContent: async () => ({ complete: true, headSha: OTHER, message: 'm', diff: 'd' }) },
      { getCommitContent: async (sha) => ({ complete: true, headSha: sha, message: 'm' }) },
      { getCommitContent: async () => null }
    ]) {
      const bad = setup({ content });
      assert.equal((await bad.broker.request({ operation, requestId: id(), ...fields })).reason, 'content-unverified', operation);
      assert.equal(bad.calls.length, 0);
    }
  }
  const ok = setup();
  assert.equal((await ok.broker.request({ operation: 'push', requestId: id(), branch: 'feat/x', headSha: HEAD })).ok, true);
  assert.deepEqual(ok.calls[0], ['push', { repository: REPO, branch: 'feat/x', headSha: HEAD }]);
  assert.equal((await ok.broker.request({ operation: 'commit', requestId: id(), headSha: HEAD })).ok, true);
  assert.equal(ok.calls[1][0], 'commit');
});

test('a scan that was given no private material is refused unless the broker was told it was checked', async () => {
  const { broker, calls } = setup({ actor: asPm });
  const loose = new Broker({ ...broker.d, privateReferencesChecked: undefined });
  assert.equal((await loose.request({ operation: 'createIssue', requestId: id(), title: 't', body: 'b' })).reason, 'private-reference-unchecked');
  const withMaterial = new Broker({ ...broker.d, privateReferencesChecked: undefined, scanOptions: { knownValues: [{ id: 'label', value: 'private-label-value' }] } });
  assert.equal((await withMaterial.request({ operation: 'createIssue', requestId: id(), title: 't', body: 'b' })).ok, true);
  assert.equal(calls.length, 1);
});

test('the text sent is exactly the text scanned', async () => {
  const { broker, calls } = setup({ actor: asPm });
  await broker.request({ operation: 'createIssue', requestId: id(), title: 'The title', body: 'The body' });
  await broker.request({ operation: 'comment', requestId: id(), target: 'pr', number: 7, body: 'A comment' });
  assert.deepEqual(calls[0], ['createIssue', { repository: REPO, title: 'The title', body: 'The body' }]);
  assert.deepEqual(calls[1], ['comment', { repository: REPO, target: 'pr', number: 7, body: 'A comment' }]);
});

test('a retry of a finished request is replayed, never written twice; a different payload under the same id is a conflict', async () => {
  const { broker, calls } = setup({ actor: asPm });
  const requestId = id();
  const first = await broker.request({ operation: 'createIssue', requestId, title: 't', body: 'b' });
  const second = await broker.request({ operation: 'createIssue', requestId, title: 't', body: 'b' });
  assert.deepEqual([first.ok, first.replay, second.ok, second.replay, second.number], [true, undefined, true, true, 5]);
  assert.equal(calls.length, 1);
  assert.equal((await broker.request({ operation: 'createIssue', requestId, title: 'other', body: 'b' })).reason, 'request-id-conflict');
  assert.equal((await broker.request({ operation: 'comment', requestId, target: 'issue', number: 3, body: 'b' })).reason, 'request-id-conflict');
  assert.equal(calls.length, 1);
});

test('an unknown outcome is never retried automatically, whatever the failure looked like', async () => {
  for (const transport of [{ createIssue: async () => { throw new Error('connection reset'); } }, { createIssue: async () => ({}) }, { createIssue: async () => 'yes' }, { createIssue: async () => ({ ok: 'true' }) }]) {
    const { broker, calls, audits } = setup({ actor: asPm, transport });
    const requestId = id();
    const first = await broker.request({ operation: 'createIssue', requestId, title: 't', body: 'b' });
    const again = await broker.request({ operation: 'createIssue', requestId, title: 't', body: 'b' });
    assert.deepEqual([first.reason, again.reason, again.replay], ['outcome-unknown', 'outcome-unknown', true]);
    assert.equal((await broker.request({ operation: 'createIssue', requestId, title: 'changed', body: 'b' })).reason, 'request-id-conflict');
    assert.equal(calls.length, 1);
    assert.equal(audits.at(-1).outcome, 'unknown');
  }
});

test('a refusal by the transport is not recorded as done, so a corrected retry may run', async () => {
  let refuse = true;
  const { broker, calls } = setup({ actor: asPm, transport: { createIssue: async () => (refuse ? { ok: false, reason: 'secret backend text' } : { ok: true, number: 9 }) } });
  const requestId = id();
  const first = await broker.request({ operation: 'createIssue', requestId, title: 't', body: 'b' });
  assert.deepEqual([first.ok, first.reason], [false, 'write-refused']);
  refuse = false;
  assert.equal((await broker.request({ operation: 'createIssue', requestId, title: 't', body: 'b' })).ok, true);
  assert.equal(calls.length, 2);
});

test('the same request id from two callers at once writes once', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { broker, calls } = setup({ actor: asPm, transport: { createIssue: async () => { await gate; return { ok: true, number: 2 }; } } });
  const requestId = id();
  const a = broker.request({ operation: 'createIssue', requestId, title: 't', body: 'b' });
  const b = await broker.request({ operation: 'createIssue', requestId, title: 't', body: 'b' });
  assert.equal(b.reason, 'request-in-progress');
  release();
  assert.equal((await a).ok, true);
  assert.equal(calls.length, 1);
});

test('the same request id from two different actors does not collide', async () => {
  const { broker, calls, setActor } = setup({ actor: asPm });
  const requestId = id();
  assert.equal((await broker.request({ operation: 'comment', requestId, target: 'issue', number: 3, body: 'hi' })).ok, true);
  setActor({ actorId: '20', role: 'worker' });
  const other = await broker.request({ operation: 'comment', requestId, target: 'issue', number: 3, body: 'hi' });
  assert.deepEqual([other.ok, other.replay], [true, undefined]);
  assert.equal(calls.length, 2);
});

test('audit: an intent is recorded before the write and a failing audit stops it; entries carry no content', async () => {
  const { broker, calls, audits } = setup({ actor: asPm });
  await broker.request({ operation: 'createIssue', requestId: id(), title: 'Private-looking title', body: 'Body text here' });
  assert.deepEqual(audits.map((entry) => entry.stage), ['intent', 'result']);
  assert.equal(audits[1].outcome, 'done');
  assert.equal(JSON.stringify(audits).includes('Private-looking'), false);
  assert.equal(JSON.stringify(audits).includes('Body text'), false);

  for (const audit of [{ record: () => { throw new Error('disk full'); } }]) {
    const broken = setup({ actor: asPm, audit });
    assert.equal((await broken.broker.request({ operation: 'createIssue', requestId: id(), title: 't', body: 'b' })).reason, 'audit-unavailable');
    assert.equal(broken.calls.length, 0);
  }
  assert.equal(calls.length, 1);
});

test('claims: one writer per issue, the issue is re-read, and an assigned or closed issue is refused', async () => {
  const worker = { actorId: '20', role: 'worker' };
  const taken = setup({ actor: worker, reader: { getIssue: async () => ({ kind: 'ok', data: { state: 'open', assignees: ['someone'] } }) } });
  assert.equal((await taken.broker.request({ operation: 'claimIssue', requestId: id(), number: 3 })).reason, 'issue-already-claimed');
  for (const issue of [{ kind: 'denied' }, { kind: 'ok', data: { state: 'closed', assignees: [] } }, { kind: 'ok', data: { state: 'open' } }, { kind: 'partial', data: { state: 'open', assignees: [] } }, null]) {
    const bad = setup({ actor: worker, reader: { getIssue: async () => issue } });
    assert.equal((await bad.broker.request({ operation: 'claimIssue', requestId: id(), number: 3 })).reason, 'issue-unverified', JSON.stringify(issue));
    assert.equal(bad.calls.length, 0);
    assert.equal(bad.locks.size, 0, 'the lock is released');
  }
  const offline = setup({ actor: worker, reader: { getIssue: async () => { throw new Error('offline'); } } });
  assert.equal((await offline.broker.request({ operation: 'claimIssue', requestId: id(), number: 3 })).reason, 'cannot-verify');
  assert.equal(offline.locks.size, 0);

  const ok = setup({ actor: worker });
  assert.equal((await ok.broker.request({ operation: 'claimIssue', requestId: id(), number: 3 })).ok, true);
  assert.deepEqual(ok.calls[0], ['claimIssue', { repository: REPO, number: 3, actorId: '20' }]);
  assert.equal(ok.locks.size, 0, 'released after the write');
});

test('two claims for one issue at once: the second cannot take the lock; no lock means no claim', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { broker, calls } = setup({ actor: { actorId: '20', role: 'worker' }, transport: { claimIssue: async () => { await gate; return { ok: true }; } } });
  const first = broker.request({ operation: 'claimIssue', requestId: id(), number: 3 });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await broker.request({ operation: 'claimIssue', requestId: id(), number: 3 });
  assert.equal(second.reason, 'claim-in-progress');
  release();
  assert.equal((await first).ok, true);
  assert.equal(calls.length, 1);

  for (const lock of [null, {}, { acquire: () => { throw new Error('x'); }, release() {} }]) {
    const bare = setup({ actor: { actorId: '20', role: 'worker' }, lock });
    assert.equal((await bare.broker.request({ operation: 'claimIssue', requestId: id(), number: 3 })).reason, 'claim-lock-unavailable');
    assert.equal(bare.calls.length, 0);
  }
});

test('review: head must match, the PR is re-read, and a self-review is refused', async () => {
  const ask = { operation: 'reviewPr', number: 7, decision: 'approve', body: 'Looks good', expectedHeadSha: HEAD };
  const ok = setup({ actor: asPm });
  assert.equal((await ok.broker.request({ requestId: id(), ...ask })).ok, true);
  assert.deepEqual(ok.calls[0], ['reviewPullRequest', { repository: REPO, number: 7, decision: 'approve', body: 'Looks good', expectedHeadSha: HEAD }]);

  const moved = setup({ actor: asPm });
  assert.equal((await moved.broker.request({ requestId: id(), ...ask, expectedHeadSha: OTHER })).reason, 'head-changed');
  assert.equal(moved.calls.length, 0);

  const own = setup({ actor: asPm, reader: { getPullRequestSnapshot: async () => snapshot({ pr: { author: 'pm-user' } }) } });
  assert.equal((await own.broker.request({ requestId: id(), ...ask })).reason, 'self-review-forbidden');
  for (const reader of [{ getPullRequestSnapshot: async () => { throw new Error('x'); } }, { getPullRequestSnapshot: async () => ({ status: 'partial' }) }, { getPullRequestSnapshot: async () => snapshot({ pr: { author: 'unknown-person' } }) }, { getPullRequestSnapshot: async () => snapshot({ pr: { state: 'closed' } }) }]) {
    const bad = setup({ actor: asPm, reader });
    const result = await bad.broker.request({ requestId: id(), ...ask });
    assert.equal(result.ok, false);
    assert.equal(bad.calls.length, 0);
  }
});

test('merge: delegated to the decision core with the expected head; human mode and stale state refuse; writer outcome is tracked', async () => {
  const ok = setup({ actor: asPm });
  const merged = await ok.broker.request({ operation: 'mergePr', requestId: id(), number: 7 });
  assert.deepEqual([merged.ok, merged.reason, merged.headSha], [true, 'merged', HEAD]);
  assert.equal(ok.calls[0][0], 'mergePullRequest');
  assert.equal(ok.calls[0][1].expectedHeadSha, HEAD);
  assert.deepEqual(ok.calls[0][1].repository, REPO);

  const human = setup({ actor: asPm, config: { mergeAuthority: 'human' } });
  assert.equal((await human.broker.request({ operation: 'mergePr', requestId: id(), number: 7 })).reason, 'human-merge-required');
  assert.equal(human.calls.length, 0);

  const stale = setup({ actor: asPm, reader: { getPullRequestSnapshot: async () => ({ ...snapshot(), approval: { ...snapshot().approval, headSha: OTHER } }) } });
  assert.equal((await stale.broker.request({ operation: 'mergePr', requestId: id(), number: 7 })).reason, 'approval-stale');
  assert.equal(stale.calls.length, 0);

  const dirty = setup({ actor: asPm, reader: { getPullRequestSnapshot: async () => snapshot({ pr: { body: `leak ${TOKEN}` } }) } });
  assert.equal((await dirty.broker.request({ operation: 'mergePr', requestId: id(), number: 7 })).reason, 'publication-blocked');
  assert.equal(dirty.calls.length, 0);

  const lost = setup({ actor: asPm, transport: { mergePullRequest: async () => { throw new Error('reset'); } } });
  const requestId = id();
  assert.equal((await lost.broker.request({ operation: 'mergePr', requestId, number: 7 })).reason, 'outcome-unknown');
  assert.deepEqual(await lost.broker.request({ operation: 'mergePr', requestId, number: 7 }), { ok: false, reason: 'outcome-unknown', replay: true });
  assert.equal(lost.calls.length, 1);

  const replay = await ok.broker.request({ operation: 'mergePr', requestId: id(), number: 7 });
  assert.equal(replay.ok, true, 'a new request id is a new decision');
});

test('a merge that is replayed returns the earlier result and writes once', async () => {
  const { broker, calls } = setup({ actor: asPm });
  const requestId = id();
  await broker.request({ operation: 'mergePr', requestId, number: 7 });
  const again = await broker.request({ operation: 'mergePr', requestId, number: 7 });
  assert.deepEqual([again.ok, again.replay], [true, true]);
  assert.equal(calls.length, 1);
});

test('no credential is stored, read or logged: the broker has no field for one, and results and audits carry none', async () => {
  const { broker, audits } = setup({ actor: asPm });
  const result = await broker.request({ operation: 'createIssue', requestId: id(), title: 't', body: 'b' });
  assert.equal(/token|credential|authorization|secret/i.test(JSON.stringify([result, audits])), false);
  assert.equal(/token|credential|authorization/i.test(Object.keys(broker).join(',')), false);
});

test('construction needs its dependencies', () => {
  for (const missing of ['identity', 'reader', 'transport', 'audit']) {
    const { broker } = setup();
    assert.throws(() => new Broker({ ...broker.d, [missing]: undefined }), TypeError, missing);
  }
  const { broker } = setup();
  assert.throws(() => new Broker({ ...broker.d, config: { pmActorId: '10' } }), TypeError);
  assert.throws(() => new Broker({ ...broker.d, project: {} }), TypeError);
  assert.throws(() => new Broker(), TypeError);
});

test('expected permissions are listed for every operation and marked as unverified expectations', () => {
  for (const operation of Object.keys(OPERATIONS)) assert.equal(typeof EXPECTED_PERMISSIONS[operation], 'string', operation);
});

test('a branch name that holds a secret is blocked on push', async () => {
  const { broker, calls } = setup();
  const result = await broker.request({ operation: 'push', requestId: id(), branch: `feat/${TOKEN}`, headSha: HEAD });
  assert.deepEqual([result.ok, result.reason], [false, 'content-blocked']);
  assert.equal(calls.length, 0);
});

test('review refuses an inconsistent snapshot', async () => {
  const { broker, calls } = setup({ actor: asPm, reader: { getPullRequestSnapshot: async () => ({ ...snapshot(), consistent: false }) } });
  assert.equal((await broker.request({ operation: 'reviewPr', requestId: id(), number: 7, decision: 'approve', body: 'ok', expectedHeadSha: HEAD })).reason, 'pr-unverified');
  assert.equal(calls.length, 0);
});

test('a merge that cannot even be set up is refused, not recorded as unknown, and may be retried', async () => {
  const { broker, calls, audits } = setup({ actor: asPm, reader: { getPullRequestPublication: undefined } });
  const requestId = id();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.equal((await broker.request({ operation: 'mergePr', requestId, number: 7 })).reason, 'merge-unavailable');
  }
  assert.equal(calls.length, 0);
  assert.equal(audits.at(-1).outcome, 'refused');
});

// Every string the transport receives must have been scanned. For each operation, a synthetic
// token is put into each text field in turn; none may reach the transport.
const TEXT_FIELDS = {
  createIssue: { base: { title: 't', body: 'b' }, fields: ['title', 'body'], actor: asPm },
  editIssue: { base: { number: 3, title: 't', body: 'b' }, fields: ['title', 'body'], actor: asPm },
  createPr: { base: { title: 't', body: 'b', headBranch: 'feat/x', headSha: HEAD, baseBranch: 'main' }, fields: ['title', 'body', 'headBranch', 'baseBranch'], actor: undefined },
  push: { base: { branch: 'feat/x', headSha: HEAD }, fields: ['branch'], actor: undefined },
  comment: { base: { target: 'issue', number: 3, body: 'b' }, fields: ['body'], actor: asPm },
  reviewPr: { base: { number: 7, decision: 'comment', body: 'b', expectedHeadSha: HEAD }, fields: ['body'], actor: asPm }
};

test('a synthetic token in any text field of any operation never reaches the transport', async () => {
  for (const [operation, { base, fields, actor }] of Object.entries(TEXT_FIELDS)) {
    for (const field of fields) {
      for (const value of [TOKEN, `C:\\Users\\someone\\x`, '/Users/someone/private-project']) {
        const { broker, calls } = setup({ actor });
        const result = await broker.request({ operation, requestId: id(), ...base, [field]: value });
        assert.equal(result.ok, false, `${operation}.${field}`);
        assert.ok(['content-blocked', 'invalid-field'].includes(result.reason), `${operation}.${field}: ${result.reason}`);
        assert.equal(calls.length, 0, `${operation}.${field}`);
      }
    }
  }
});

test('every field of every operation is either scanned, a fixed value set, a number or a hash', () => {
  const covered = new Set(Object.values(TEXT_FIELDS).flatMap(({ fields }, index) => fields.map((f) => `${Object.keys(TEXT_FIELDS)[index]}.${f}`)));
  for (const [operation, spec] of Object.entries(OPERATIONS)) {
    for (const field of [...Object.keys(spec.fields), ...Object.keys(spec.optional || {})]) {
      const probe = { operation, field };
      const kind = ['number', 'target', 'decision', 'reason', 'headSha', 'expectedHeadSha'].includes(field) ? 'fixed' : 'text';
      if (kind === 'text') assert.ok(covered.has(`${operation}.${field}`), `${operation}.${field} is a text field and must be in the leak test`, probe);
    }
  }
});

test('createPr scans the base branch', async () => {
  const { broker, calls } = setup();
  const result = await broker.request({ operation: 'createPr', requestId: id(), title: 't', body: 'b', headBranch: 'feat/x', headSha: HEAD, baseBranch: TOKEN });
  assert.deepEqual([result.ok, result.reason], [false, 'content-blocked']);
  assert.equal(calls.length, 0);
});

test('scan options may only add private reference material; a detectors option can neither be set nor sneak in', async () => {
  const { broker } = setup({ actor: asPm });
  for (const scanOptions of [{ detectors: [] }, { scan: () => ({ status: 'clear', blocked: false }) }, { budgetMs: 1 }, { now: () => 0 }, 'x', [], null]) {
    assert.throws(() => new Broker({ ...broker.d, scanOptions }), TypeError, JSON.stringify(scanOptions));
  }
  const loose = new Broker({ ...broker.d, scanOptions: { knownValues: [{ id: 'k', value: 'private-label-value' }] } });
  loose.d.scanOptions = { ...loose.d.scanOptions, detectors: [] };
  const leaked = await loose.request({ operation: 'createIssue', requestId: id(), title: 'ok', body: `leak ${TOKEN}` });
  assert.deepEqual([leaked.ok, leaked.reason], [false, 'content-blocked'], 'a detectors key set later is ignored');
  const caught = new Broker({ ...broker.d, scanOptions: { knownValues: [{ id: 'k', value: 'private-label-value' }] } });
  const stopped = await caught.request({ operation: 'createIssue', requestId: id(), title: 'about private-label-value', body: 'b' });
  assert.equal(stopped.reason, 'content-blocked');
  // What was found goes back by kind and the caller's id, so the person can be told which kind of data it is (#389); never the value.
  assert.deepEqual(stopped.found, [{ category: 'known-value', id: 'k' }]);
  assert.equal(JSON.stringify(stopped).includes('private-label-value'), false);
});

test('text fields have a size limit and over-long text is refused before any scan', async () => {
  const { broker, calls } = setup({ actor: asPm });
  assert.equal((await broker.request({ operation: 'createIssue', requestId: id(), title: 't', body: 'x'.repeat(262145) })).reason, 'invalid-field');
  assert.equal((await broker.request({ operation: 'createIssue', requestId: id(), title: 't', body: 'x'.repeat(262144) })).ok, true);
  assert.equal(calls.length, 1);
});

test('trusted commit message and diff have size limits and over-long or blank content is refused before transport', async () => {
  const { MAX_TEXT_CHARS, MAX_DIFF_CHARS } = require('../../src/broker/broker');
  for (const [label, content, expectedReason] of [
    ['blank message', { getCommitContent: async (sha) => ({ complete: true, headSha: sha, message: '   ', diff: 'diff --git a/a.js b/a.js\n+const x = 1;\n' }) }, 'content-blocked'],
    ['oversized message', { getCommitContent: async (sha) => ({ complete: true, headSha: sha, message: 'm'.repeat(MAX_TEXT_CHARS + 1), diff: 'diff --git a/a.js b/a.js\n+const x = 1;\n' }) }, 'content-blocked'],
    ['oversized diff', { getCommitContent: async (sha) => ({ complete: true, headSha: sha, message: 'ok', diff: 'd'.repeat(MAX_DIFF_CHARS + 1) }) }, 'content-blocked']
  ]) {
    for (const [operation, fields] of [
      ['commit', { headSha: HEAD }],
      ['push', { branch: 'feat/x', headSha: HEAD }],
      ['createPr', { title: 't', body: 'b', headBranch: 'feat/x', headSha: HEAD, baseBranch: 'main' }]
    ]) {
      const { broker, calls } = setup({ content });
      const res = await broker.request({ operation, requestId: id(), ...fields });
      assert.deepEqual([res.ok, res.reason], [false, expectedReason], `${label} on ${operation}`);
      assert.equal(calls.length, 0);
    }
  }
});

test('scanner exceptions and internal scanner errors fail closed and never reach the transport', async () => {
  const { broker, calls } = setup({ actor: asPm });
  const throwingScanOptions = {};
  Object.defineProperty(throwingScanOptions, 'knownValues', {
    enumerable: true,
    get() {
      throw new Error('synthetic scanner exception');
    }
  });
  const throwingBroker = new Broker({ ...broker.d, scanOptions: throwingScanOptions });
  const thrownResult = await throwingBroker.request({ operation: 'createIssue', requestId: id(), title: 't', body: 'b' });
  assert.deepEqual([thrownResult.ok, thrownResult.reason], [false, 'content-scan-failed']);
  assert.equal(calls.length, 0);

  const malformedScanBroker = new Broker({ ...broker.d, scanOptions: { knownValues: [null] } });
  const malformedResult = await malformedScanBroker.request({ operation: 'createIssue', requestId: id(), title: 't', body: 'b' });
  assert.deepEqual([malformedResult.ok, malformedResult.reason, malformedResult.scanStatus], [false, 'content-blocked', 'error']);
  assert.equal(calls.length, 0);
});

test('persistent idempotency via PrivateStore: a new Broker instance after restart replays completed requests without writing twice and stores no content or secrets', async (t) => {
  const { PrivateStore } = require('../../src/storage/private-store');
  const { sandbox, COLLECTIONS } = require('../storage/helpers');
  const box = sandbox(t);
  const openStore = () => new PrivateStore({ dir: box.dir, repoRoot: box.repoRoot, collections: COLLECTIONS });

  const firstRun = setup({ actor: asPm });
  const firstBroker = new Broker({ ...firstRun.broker.d, store: openStore() });
  const issueReq = id();
  const mergeReq = id();

  const created = await firstBroker.request({ operation: 'createIssue', requestId: issueReq, title: 'Sensitive-looking public title', body: 'Detailed issue body' });
  assert.deepEqual(created, { ok: true, number: 5 });
  const merged = await firstBroker.request({ operation: 'mergePr', requestId: mergeReq, number: 7 });
  assert.deepEqual(merged, { ok: true, reason: 'merged', pullNumber: 7, headSha: HEAD });
  assert.equal(firstRun.calls.length, 2);

  // Restart with a fresh Broker instance backed by a freshly opened PrivateStore on the same directory.
  const secondRun = setup({ actor: asPm });
  const storeAfterRestart = openStore();
  const secondBroker = new Broker({ ...secondRun.broker.d, store: storeAfterRestart });

  const replayedIssue = await secondBroker.request({ operation: 'createIssue', requestId: issueReq, title: 'Sensitive-looking public title', body: 'Detailed issue body' });
  assert.deepEqual(replayedIssue, { ok: true, number: 5, replay: true });
  const replayedMerge = await secondBroker.request({ operation: 'mergePr', requestId: mergeReq, number: 7 });
  assert.deepEqual(replayedMerge, { ok: true, reason: 'merged', pullNumber: 7, headSha: HEAD, replay: true });
  assert.equal(secondRun.calls.length, 0, 'new Broker instance never writes a completed request a second time');

  // A different payload with the same requestId after restart is rejected as a conflict.
  const conflict = await secondBroker.request({ operation: 'createIssue', requestId: issueReq, title: 'Different title', body: 'Detailed issue body' });
  assert.deepEqual([conflict.ok, conflict.reason], [false, 'request-id-conflict']);
  assert.equal(secondRun.calls.length, 0);

  // Verify the persisted records in PrivateStore never contain the title, body, diff, or any secret.
  const listed = storeAfterRestart.list('policies');
  assert.equal(listed.ok, true);
  assert.equal(listed.items.length, 2);
  const serialized = JSON.stringify(listed.items);
  assert.equal(serialized.includes('Sensitive-looking'), false);
  assert.equal(serialized.includes('Detailed issue body'), false);
});

test('restart reconciliation: unresolved (unknown/pending) requests in PrivateStore check remote state before deciding whether to replay, resend, or keep unknown', async (t) => {
  const { PrivateStore } = require('../../src/storage/private-store');
  const { sandbox, COLLECTIONS } = require('../storage/helpers');
  const box = sandbox(t);
  const openStore = () => new PrivateStore({ dir: box.dir, repoRoot: box.repoRoot, collections: COLLECTIONS });

  // 1. mergePr: transport throws (outcome-unknown). On restart:
  //    (a) if remote PR is already merged, reconcile to done without calling transport;
  //    (b) if remote PR is still open & unmerged, allow resend;
  //    (c) if remote PR cannot be verified, stay outcome-unknown without calling transport.
  const mergeAlreadyLandedId = id();
  const mergeNotLandedId = id();
  const mergeUnverifiedId = id();
  const crashRun = setup({
    actor: asPm,
    transport: { mergePullRequest: async () => { throw new Error('network reset during merge'); } }
  });
  const crashingBroker = new Broker({ ...crashRun.broker.d, store: openStore() });
  assert.equal((await crashingBroker.request({ operation: 'mergePr', requestId: mergeAlreadyLandedId, number: 7 })).reason, 'outcome-unknown');
  assert.equal((await crashingBroker.request({ operation: 'mergePr', requestId: mergeNotLandedId, number: 7 })).reason, 'outcome-unknown');
  assert.equal((await crashingBroker.request({ operation: 'mergePr', requestId: mergeUnverifiedId, number: 7 })).reason, 'outcome-unknown');
  assert.equal(crashRun.calls.length, 3);

  // Restart (a): remote shows PR #7 is already merged.
  const restartMerged = setup({
    actor: asPm,
    reader: { getPullRequestSnapshot: async () => snapshot({ pr: { state: 'closed', merged: true } }) }
  });
  const brokerMerged = new Broker({ ...restartMerged.broker.d, store: openStore() });
  const reconciledMerge = await brokerMerged.request({ operation: 'mergePr', requestId: mergeAlreadyLandedId, number: 7 });
  assert.deepEqual(reconciledMerge, { ok: true, reason: 'merged', pullNumber: 7, headSha: HEAD, replay: true });
  assert.equal(restartMerged.calls.length, 0, 'already merged remotely: never calls mergePullRequest again');

  // Restart (c): remote snapshot is partial/unreadable -> fail closed as outcome-unknown.
  const restartUnverified = setup({
    actor: asPm,
    reader: { getPullRequestSnapshot: async () => ({ status: 'partial' }) }
  });
  const brokerUnverified = new Broker({ ...restartUnverified.broker.d, store: openStore() });
  const unverifiedRes = await brokerUnverified.request({ operation: 'mergePr', requestId: mergeUnverifiedId, number: 7 });
  assert.deepEqual(unverifiedRes, { ok: false, reason: 'outcome-unknown', replay: true });
  assert.equal(restartUnverified.calls.length, 0);

  // Restart (b): remote shows PR #7 is still open and unmerged -> safely resends once and records done.
  const restartOpen = setup({ actor: asPm });
  const brokerOpen = new Broker({ ...restartOpen.broker.d, store: openStore() });
  const resentMerge = await brokerOpen.request({ operation: 'mergePr', requestId: mergeNotLandedId, number: 7 });
  assert.deepEqual(resentMerge, { ok: true, reason: 'merged', pullNumber: 7, headSha: HEAD });
  assert.equal(restartOpen.calls.length, 1, 'confirmed not merged remotely: resends once');

  // 2. comment: transport throws. On restart, if getIssueComments shows the comment already exists, replay without reposting; if empty, resend once.
  const commentLandedId = id();
  const commentMissingId = id();
  const crashComment = setup({
    actor: asPm,
    transport: { comment: async () => { throw new Error('timeout'); } }
  });
  const crashCommentBroker = new Broker({ ...crashComment.broker.d, store: openStore() });
  assert.equal((await crashCommentBroker.request({ operation: 'comment', requestId: commentLandedId, target: 'issue', number: 3, body: 'Landed comment' })).reason, 'outcome-unknown');
  assert.equal((await crashCommentBroker.request({ operation: 'comment', requestId: commentMissingId, target: 'issue', number: 3, body: 'Missing comment' })).reason, 'outcome-unknown');

  const restartComment = setup({
    actor: asPm,
    reader: {
      getIssueComments: async () => ({ kind: 'ok', data: [{ id: 88, author: 'pm-user', body: 'Landed comment' }] })
    }
  });
  const brokerComment = new Broker({ ...restartComment.broker.d, store: openStore() });
  const landedCommentRes = await brokerComment.request({ operation: 'comment', requestId: commentLandedId, target: 'issue', number: 3, body: 'Landed comment' });
  assert.deepEqual(landedCommentRes, { ok: true, number: 88, replay: true });
  assert.equal(restartComment.calls.length, 0, 'comment already on GitHub is not posted twice');

  const resentCommentRes = await brokerComment.request({ operation: 'comment', requestId: commentMissingId, target: 'issue', number: 3, body: 'Missing comment' });
  assert.deepEqual(resentCommentRes, { ok: true, number: 5 });
  assert.equal(restartComment.calls.length, 1, 'comment confirmed absent on GitHub is sent once');

  // 3. claimIssue & editIssue & reviewPr reconciliation on restart.
  const claimId = id();
  const editId = id();
  const reviewId = id();
  const crashOps = setup({
    actor: { actorId: '20', role: 'worker' },
    transport: { claimIssue: async () => { throw new Error('reset'); } }
  });
  const crashWorkerBroker = new Broker({ ...crashOps.broker.d, store: openStore() });
  assert.equal((await crashWorkerBroker.request({ operation: 'claimIssue', requestId: claimId, number: 3 })).reason, 'outcome-unknown');

  const crashPmOps = setup({
    actor: asPm,
    transport: {
      editIssue: async () => { throw new Error('reset'); },
      reviewPullRequest: async () => { throw new Error('reset'); }
    }
  });
  const crashPmBroker = new Broker({ ...crashPmOps.broker.d, store: openStore() });
  assert.equal((await crashPmBroker.request({ operation: 'editIssue', requestId: editId, number: 3, title: 'Updated title' })).reason, 'outcome-unknown');
  assert.equal((await crashPmBroker.request({ operation: 'reviewPr', requestId: reviewId, number: 7, decision: 'approve', body: 'LGTM', expectedHeadSha: HEAD })).reason, 'outcome-unknown');

  const restartClaim = setup({
    actor: { actorId: '20', role: 'worker' },
    reader: { getIssue: async () => ({ kind: 'ok', data: { state: 'open', assignees: ['worker-user'] } }) }
  });
  const brokerClaim = new Broker({ ...restartClaim.broker.d, store: openStore() });
  assert.deepEqual(await brokerClaim.request({ operation: 'claimIssue', requestId: claimId, number: 3 }), { ok: true, number: 3, replay: true });
  assert.equal(restartClaim.calls.length, 0);

  const restartPm = setup({
    actor: asPm,
    reader: {
      getIssue: async () => ({ kind: 'ok', data: { number: 3, state: 'open', title: 'Updated title', body: 'old' } }),
      getPullRequestSnapshot: async () => ({
        ...snapshot(),
        reviews: { kind: 'ok', data: [{ reviewId: 77, reviewer: 'pm-user', commitId: HEAD, state: 'APPROVED', body: 'LGTM' }] }
      })
    }
  });
  const brokerPm = new Broker({ ...restartPm.broker.d, store: openStore() });
  assert.deepEqual(await brokerPm.request({ operation: 'editIssue', requestId: editId, number: 3, title: 'Updated title' }), { ok: true, number: 3, replay: true });
  assert.deepEqual(await brokerPm.request({ operation: 'reviewPr', requestId: reviewId, number: 7, decision: 'approve', body: 'LGTM', expectedHeadSha: HEAD }), { ok: true, number: 77, replay: true });
  assert.equal(restartPm.calls.length, 0);
});

test('an unusable or invalid store is rejected and fails closed before any write', async () => {
  const { broker, calls } = setup({ actor: asPm });
  for (const badStore of [null, 'store', {}, { get: () => {} }, { put: () => {} }]) {
    assert.throws(() => new Broker({ ...broker.d, store: badStore }), TypeError);
  }
  assert.throws(() => new Broker({ ...broker.d, storeCollection: 'bad/name' }), TypeError);

  const failingRead = new Broker({ ...broker.d, store: { get: () => ({ ok: false, reason: 'corrupt' }), put: () => ({ ok: true }) } });
  assert.equal((await failingRead.request({ operation: 'createIssue', requestId: id(), title: 't', body: 'b' })).reason, 'store-unavailable');
  assert.equal(calls.length, 0);

  const failingWrite = new Broker({ ...broker.d, store: { get: () => ({ ok: true, found: false, value: null }), put: () => ({ ok: false, reason: 'locked' }) } });
  assert.equal((await failingWrite.request({ operation: 'createIssue', requestId: id(), title: 't', body: 'b' })).reason, 'store-unavailable');
  assert.equal(calls.length, 0);
});

// A merged pull request whose head branch may go: every fact comes from a fresh read.
const MERGED = { merged: true, state: 'closed', headRef: 'feat/done', headRepository: 'example/project', baseRef: 'main' };
const deletable = (over = {}) => setup({
  actor: asPm,
  reader: {
    getPullRequestSnapshot: async () => snapshot({ pr: { ...MERGED, ...(over.pr || {}) } }),
    getRepository: async () => ({ kind: 'ok', data: { defaultBranch: 'main' }, ...(over.repo || {}) }),
    getBranchRequirements: async () => ({ kind: 'empty', data: { complete: true, ruleTypes: [] }, ...(over.requirements || {}) }),
    getBranchHead: async () => ({ kind: 'ok', data: { sha: HEAD }, ...(over.tip || {}) }),
    ...(over.reader || {})
  }
});
const askDelete = (broker, extra = {}) => broker.request({ operation: 'deleteBranch', requestId: id(), number: 7, expectedHeadSha: HEAD, ...extra });

test('deleteBranch: a merged pull request with the reviewed head and an unprotected, non-default branch in this repository is deleted, and the transport gets exactly that', async () => {
  const { broker, calls } = deletable();
  assert.deepEqual(await askDelete(broker), { ok: true, number: 5 });
  assert.deepEqual(calls, [['deleteBranch', { repository: REPO, branch: 'feat/done', expectedHeadSha: HEAD }]]);
});

test('deleteBranch refuses, and sends nothing, unless every fact is confirmed', async () => {
  const cases = {
    'pr-not-merged': { pr: { merged: false, state: 'open' } },
    'pr-not-merged ': { pr: { merged: true, state: 'open' } },
    'branch-not-in-repository': { pr: { headRepository: 'someone/fork' } },
    'branch-invalid': { pr: { headRef: '-x' } },
    'branch-is-default': { pr: { headRef: 'main' } },
    'branch-is-default ': { pr: { headRef: 'release', baseRef: 'release' } },
    'default-branch-unverified': { repo: { kind: 'unavailable', data: null } },
    'branch-protected': { requirements: { kind: 'ok', data: { complete: true, ruleTypes: ['pull_request'] } } },
    'protection-unverified': { requirements: { kind: 'partial', data: { complete: false, ruleTypes: [] } } },
    'protection-unverified ': { requirements: { kind: 'unavailable' } },
    'head-changed': { askHead: OTHER },
    'head-changed ': { tip: { data: { sha: OTHER } } },
    'branch-tip-unverified': { tip: { kind: 'unavailable', data: null } },
    'branch-tip-unverified ': { tip: { data: { sha: 'not-a-sha' } } },
    'branch-invalid': { pr: { headRef: 'feat/../../heads/main' } },
    'branch-invalid ': { pr: { headRef: 'feat/.hidden' } },
    'branch-invalid  ': { pr: { headRef: 'feat/x.lock' } },
    'branch-invalid   ': { pr: { headRef: 'feat//x' } },
    'branch-invalid    ': { pr: { headRef: 'feat/x/' } }
  };
  for (const [expected, setting] of Object.entries(cases)) {
    const { broker, calls } = deletable(setting);
    const result = await askDelete(broker, setting.askHead ? { expectedHeadSha: setting.askHead } : {});
    assert.deepEqual([result.ok, result.reason], [false, expected.trim()], expected);
    assert.equal(calls.length, 0, expected);
  }
  for (const reader of [
    { getPullRequestSnapshot: async () => { throw new Error('offline'); } },
    { getBranchRequirements: async () => { throw new Error('offline'); } },
    { getBranchHead: async () => { throw new Error('offline'); } },
    { getBranchHead: undefined },
    { getPullRequestSnapshot: async () => ({ ...snapshot({ pr: MERGED }), consistent: false }) },
    { getRepository: undefined }
  ]) {
    const { broker, calls } = deletable({ reader });
    assert.equal((await askDelete(broker)).ok, false);
    assert.equal(calls.length, 0, 'unreadable state never deletes');
  }
  const worker = setup({ actor: { actorId: '20', role: 'worker' } });
  assert.equal((await askDelete(worker.broker)).reason, 'role-forbidden');
  assert.equal(worker.calls.length, 0);
});

test('deleteBranch scans the branch name, and an unknown outcome is never sent again', async () => {
  const leak = deletable({ pr: { headRef: `feat/${TOKEN}` } });
  assert.deepEqual([(await askDelete(leak.broker)).ok, leak.calls.length], [false, 0]);
  const crash = setup({ actor: asPm, reader: deletable().broker.d.reader, transport: { deleteBranch: async () => { throw new Error('reset'); } } });
  const requestId = id();
  assert.equal((await crash.broker.request({ operation: 'deleteBranch', requestId, number: 7, expectedHeadSha: HEAD })).reason, 'outcome-unknown');
  assert.equal((await crash.broker.request({ operation: 'deleteBranch', requestId, number: 7, expectedHeadSha: HEAD })).reason, 'outcome-unknown');
  assert.equal(crash.calls.length, 1);
});

test('deleteBranch: work pushed to the branch after the merge is never deleted, whether it arrives before the first read or between the last read and the write', async () => {
  // The pull request's own head is fixed at the merge; only the branch's tip shows a later push.
  const late = deletable({ tip: { data: { sha: OTHER } } });
  assert.equal((await askDelete(late.broker)).reason, 'head-changed');
  assert.equal(late.calls.length, 0);
  let reads = 0;
  const racing = deletable({ reader: { getBranchHead: async () => ({ kind: 'ok', data: { sha: ++reads === 1 ? HEAD : OTHER } }) } });
  assert.equal((await askDelete(racing.broker)).reason, 'head-changed', 'a push between the checks and the write is caught by the read right before it');
  assert.equal(racing.calls.length, 0);
  assert.equal(reads, 2, 'the tip is read twice');
});

test('closeIssue: PM only, a fixed reason, the issue must be open right now, and exactly that goes to the transport', async () => {
  const closed = { state: 'closed', isPullRequest: false, stateReason: 'completed', assignees: [] };
  const { broker, calls } = setup({ actor: asPm });
  assert.deepEqual(await broker.request({ operation: 'closeIssue', requestId: id(), number: 3, reason: 'completed' }), { ok: true, number: 5 });
  assert.deepEqual(calls, [['closeIssue', { repository: REPO, number: 3, reason: 'not_planned'.replace('not_planned', 'completed') }]]);
  const second = setup({ actor: asPm });
  await second.broker.request({ operation: 'closeIssue', requestId: id(), number: 4, reason: 'not_planned' });
  assert.equal(second.calls[0][1].reason, 'not_planned');

  for (const bad of [undefined, '', 'done', 'Completed', 'not planned', 5, null, ['completed']]) {
    const probe = setup({ actor: asPm });
    assert.equal((await probe.broker.request({ operation: 'closeIssue', requestId: id(), number: 3, reason: bad })).reason, 'invalid-field', String(bad));
    assert.equal(probe.calls.length, 0);
  }
  for (const extra of [{ body: 'x' }, { state: 'open' }, { comment: 'x' }]) {
    const probe = setup({ actor: asPm });
    assert.equal((await probe.broker.request({ operation: 'closeIssue', requestId: id(), number: 3, reason: 'completed', ...extra })).reason, 'unknown-field');
    assert.equal(probe.calls.length, 0);
  }

  const alreadyClosed = setup({ actor: asPm, reader: { getIssue: async () => ({ kind: 'ok', data: closed }) } });
  assert.equal((await alreadyClosed.broker.request({ operation: 'closeIssue', requestId: id(), number: 3, reason: 'completed' })).reason, 'issue-not-open');
  for (const reader of [
    { getIssue: async () => ({ kind: 'unavailable' }) },
    { getIssue: async () => { throw new Error('offline'); } },
    { getIssue: async () => ({ kind: 'ok', data: { state: 'merged' } }) },
    { getIssue: async () => ({ kind: 'ok', data: null }) }
  ]) {
    const probe = setup({ actor: asPm, reader });
    const result = await probe.broker.request({ operation: 'closeIssue', requestId: id(), number: 3, reason: 'completed' });
    assert.equal(result.ok, false);
    assert.equal(probe.calls.length, 0, 'an issue whose state cannot be read is never closed');
  }
  // A pull request number is answered by the issues endpoint too; it is never closed through here.
  for (const [isPullRequest, expected] of [[true, 'target-is-pull-request'], [undefined, 'issue-unverified'], ['false', 'issue-unverified'], [null, 'issue-unverified']]) {
    const probe = setup({ actor: asPm, reader: { getIssue: async () => ({ kind: 'ok', data: { state: 'open', ...(isPullRequest === undefined ? {} : { isPullRequest }), assignees: [] } }) } });
    assert.equal((await probe.broker.request({ operation: 'closeIssue', requestId: id(), number: 7, reason: 'completed' })).reason, expected, String(isPullRequest));
    assert.equal(probe.calls.length, 0, 'a pull request is never closed as an Issue');
  }
  const worker = setup({ actor: { actorId: '20', role: 'worker' } });
  assert.equal((await worker.broker.request({ operation: 'closeIssue', requestId: id(), number: 3, reason: 'completed' })).reason, 'role-forbidden');
  assert.equal(worker.calls.length, 0);
});

test('closeIssue after a restart with an unknown outcome: closed with the same reason is done, closed for another reason stays unknown, still open is sent once', async () => {
  const store = (() => { const data = new Map(); return { get: (c, k) => (data.has(`${c}/${k}`) ? { ok: true, found: true, value: JSON.parse(data.get(`${c}/${k}`)) } : { ok: true, found: false }), put: (c, k, v) => { data.set(`${c}/${k}`, JSON.stringify(v)); return { ok: true }; }, delete: (c, k) => { data.delete(`${c}/${k}`); return { ok: true }; } }; })();
  const ask = (requestId, reason = 'completed') => ({ operation: 'closeIssue', requestId, number: 3, reason });
  const crash = async (requestId) => {
    const first = setup({ actor: asPm, transport: { closeIssue: async () => { throw new Error('reset'); } } });
    const broker = new Broker({ ...first.broker.d, store });
    assert.equal((await broker.request(ask(requestId))).reason, 'outcome-unknown');
  };
  const restart = (data) => { const restarted = setup({ actor: asPm, reader: { getIssue: async () => ({ kind: 'ok', data: { isPullRequest: false, ...data } }) } }); return { ...restarted, broker: new Broker({ ...restarted.broker.d, store }) }; };

  const sameReason = id(); await crash(sameReason);
  const landed = restart({ state: 'closed', stateReason: 'completed', assignees: [] });
  assert.deepEqual(await landed.broker.request(ask(sameReason)), { ok: true, number: 3, replay: true });
  assert.equal(landed.calls.length, 0, 'closed already: nothing is sent again');

  const otherReason = id(); await crash(otherReason);
  const different = restart({ state: 'closed', stateReason: 'not_planned', assignees: [] });
  assert.equal((await different.broker.request(ask(otherReason))).reason, 'outcome-unknown');
  assert.equal(different.calls.length, 0);

  const pullRequestId = id(); await crash(pullRequestId);
  const wrongTarget = restart({ state: 'closed', stateReason: 'completed', isPullRequest: true });
  assert.equal((await wrongTarget.broker.request(ask(pullRequestId))).reason, 'outcome-unknown', 'a pull request that is closed is not this write');
  assert.equal(wrongTarget.calls.length, 0);

  const notApplied = id(); await crash(notApplied);
  const stillOpen = restart({ state: 'open', assignees: [] });
  assert.deepEqual(await stillOpen.broker.request(ask(notApplied)), { ok: true, number: 5 });
  assert.equal(stillOpen.calls.length, 1, 'confirmed still open: sent once');
});

// The researcher role reads and reports; it never writes to GitHub. The broker knows two callers, the PM and a worker.
const researcherRequests = {
  createIssue: { title: 't', body: 'b' },
  editIssue: { number: 3, title: 't' },
  closeIssue: { number: 3, reason: 'completed' },
  claimIssue: { number: 3 },
  createPr: { title: 't', body: 'b', headBranch: 'feat/x', headSha: HEAD, baseBranch: 'main' },
  commit: { headSha: HEAD },
  push: { branch: 'feat/x', headSha: HEAD },
  comment: { target: 'issue', number: 3, body: 'hi' },
  reviewPr: { number: 7, decision: 'approve', body: 'ok', expectedHeadSha: HEAD },
  mergePr: { number: 7 },
  deleteBranch: { number: 7, expectedHeadSha: HEAD }
};

test('a researcher can write nothing to GitHub: every operation is refused before the transport, whatever identity it claims', async () => {
  assert.deepEqual(Object.keys(researcherRequests).sort(), Object.keys(OPERATIONS).sort(), 'this test covers every operation the broker has');
  for (const [operation, fields] of Object.entries(researcherRequests)) {
    for (const actor of [{ actorId: '30', role: 'researcher' }, { actorId: '10', role: 'researcher' }, { actorId: '20', role: 'Researcher' }, { actorId: '20', role: 'worker ' }, { actorId: '20', role: 'researcher', extra: 'pm' }]) {
      const { broker, calls } = setup({ actor });
      const result = await broker.request({ operation, requestId: id(), ...fields });
      assert.equal(result.ok, false, `${operation} as ${actor.role}`);
      assert.ok(['identity-unverified', 'role-forbidden'].includes(result.reason), `${operation}: ${result.reason}`);
      assert.equal(calls.length, 0, `${operation} reached the transport`);
    }
    // The role cannot be claimed in the request either: the identity comes from the trusted source only.
    const { broker, calls } = setup({ actor: { actorId: '30', role: 'researcher' } });
    const claimed = await broker.request({ operation, requestId: id(), ...fields, role: 'pm', actorId: '10' });
    assert.equal(claimed.ok, false);
    assert.equal(calls.length, 0);
    // And no operation lists the researcher among the roles that may ask.
    assert.equal(OPERATIONS[operation].roles.includes('researcher'), false, `${operation} must not allow the researcher`);
    assert.ok(OPERATIONS[operation].roles.every((role) => role === 'pm' || role === 'worker'), `${operation}: ${OPERATIONS[operation].roles}`);
  }
});

test('the publish policy has no operation for the researcher either', () => {
  const { evaluatePublishRequest } = require('../../src/publish-policy');
  for (const operation of ['createIssue', 'editIssue', 'closeIssue', 'claimIssue', 'createPr', 'reviewPr', 'mergePr', 'deleteBranch']) {
    for (const actorId of ['30', '10', '20']) {
      const verdict = evaluatePublishRequest({ operation, role: 'researcher', actorId }, { pmActorId: '10' });
      assert.equal(verdict.allowed, false, `${operation} as researcher ${actorId}`);
    }
  }
});

// ---- attribution lines are refused (issue #293) ----
const PM = { actorId: '10', role: 'pm' };
const TRAILER = 'Co-authored-by: Someone <someone@example.invalid>';
const text = (label) => `Refs #1\n${label}\nmore`;
const FIELDS = [
  ['createIssue', PM, (value) => ({ title: 'A title', body: value }), 'issue-body'],
  ['createIssue', PM, (value) => ({ title: value, body: 'body' }), 'issue-title'],
  ['editIssue', PM, (value) => ({ number: 5, body: value }), 'issue-body'],
  ['createPr', undefined, (value) => ({ title: 't', body: value, headBranch: 'feat/x', headSha: HEAD, baseBranch: 'main' }), 'pr-body'],
  ['createPr', undefined, (value) => ({ title: value, body: 'b', headBranch: 'feat/x', headSha: HEAD, baseBranch: 'main' }), 'pr-title'],
  ['comment', undefined, (value) => ({ target: 'issue', number: 5, body: value }), 'comment'],
  ['reviewPr', PM, (value) => ({ number: 7, decision: 'comment', body: value, expectedHeadSha: HEAD }), 'review']
];

test('a Co-authored-by or Generated-with line in any text field is refused, whatever the case or leading space, and nothing is written', async () => {
  const variants = [TRAILER, 'co-authored-by: x', 'CO-AUTHORED-BY: x', '   Co-Authored-By: x', '\tco-authored-by : x', 'Co-authored-by:x',
    '🤖 Generated with [Claude Code](https://claude.com/claude-code)', 'Generated with Claude Code', 'generated  with   claude code', '> Generated with Claude Code', 'Co-auth​ored-by: x'];
  for (const [operation, actor, build, field] of FIELDS) {
    for (const variant of variants) {
      const value = field.endsWith('title') ? variant.split('\n')[0] : text(variant);
      const { broker, calls, audits } = setup(actor ? { actor } : {});
      const result = await broker.request({ operation, requestId: id(), ...build(value) });
      assert.equal(result.ok, false, `${operation} ${field} ${JSON.stringify(variant)}`);
      assert.equal(result.reason, 'co-author-forbidden');
      assert.equal(calls.length, 0, 'nothing reached the transport');
      assert.deepEqual(result.problems.map((problem) => problem.field), [field]);
      assert.ok(result.problems[0].lines.every((line) => Number.isInteger(line)), 'line numbers, never the text');
      assert.equal(JSON.stringify([result, audits]).includes('someone@example.invalid'), false, 'the line is not echoed');
    }
  }
});

test('co-authored-by in the middle of a line, or an ordinary body, is not refused', async () => {
  for (const body of ['Refs #1. We reject any Co-authored-by: line.', 'Refs #90\nplain text', 'Co-authored is a word', 'see the co-authored-by trailer rules']) {
    const { broker, calls } = setup({ actor: PM });
    const result = await broker.request({ operation: 'createIssue', requestId: id(), title: 'A title', body });
    assert.equal(result.ok, true, body);
    assert.equal(calls.length, 1);
  }
});

test('the Claude Code footer is refused as a line of its own, and a sentence that quotes it is not', async () => {
  for (const [body, refused] of [
    ['Done.\nGenerated with Claude Code', true], ['> Generated with Claude Code', true], ['*Generated with Claude Code*', true], ['- generated with claude code', true],
    ['Done. The Generated with Claude Code footer is removed by hand.', false], ['we said "Generated with Claude Code" is forbidden', false]
  ]) {
    const { broker, calls } = setup({ actor: PM });
    const result = await broker.request({ operation: 'createIssue', requestId: id(), title: 'A title', body });
    assert.equal(result.ok, !refused, body);
    if (refused) { assert.equal(result.reason, 'co-author-forbidden'); assert.equal(calls.length, 0); }
  }
});

test('a diff that contains these words (a test of this rule, say) is not refused: only messages are read', async () => {
  const diff = 'diff --git a/t.js b/t.js\n+const line = "Co-authored-by: x";\n+// the footer is "Generated with Claude Code"\n';
  const { broker, calls } = setup({ content: { getCommitContent: async (sha) => ({ complete: true, headSha: sha, message: 'Add test', diff }) } });
  assert.equal((await broker.request({ operation: 'push', requestId: id(), branch: 'feat/x', headSha: HEAD })).ok, true);
  assert.equal(calls.length, 1);
});

test('push and createPr refuse when any commit in the range has a co-author line, naming the short SHAs', async () => {
  const messages = [{ sha: 'c'.repeat(40), message: 'First' }, { sha: 'd'.repeat(40), message: `Second\n\n${TRAILER}` }, { sha: HEAD, message: 'Third' }];
  const content = { getRangeMessages: async ({ headSha }) => ({ complete: true, headSha, messages }) };
  for (const [operation, fields] of [['push', { branch: 'feat/x', headSha: HEAD }], ['createPr', { title: 't', body: 'b', headBranch: 'feat/x', headSha: HEAD, baseBranch: 'main' }]]) {
    const { broker, calls } = setup({ content });
    const result = await broker.request({ operation, requestId: id(), ...fields });
    assert.equal(result.reason, 'co-author-forbidden', operation);
    assert.deepEqual(result.problems, [{ field: 'commit-message', commits: ['ddddddd'] }]);
    assert.equal(calls.length, 0);
  }
});

test('a commit range that cannot be read, is partial, is for another head or is malformed refuses (fail closed); so does a reader without the method', async () => {
  const bad = [
    { getRangeMessages: async () => { throw new Error('offline'); } },
    { getRangeMessages: async ({ headSha }) => ({ complete: false, headSha, messages: [{ sha: HEAD, message: 'm' }] }) },
    { getRangeMessages: async () => ({ complete: true, headSha: OTHER, messages: [{ sha: OTHER, message: 'm' }] }) },
    { getRangeMessages: async ({ headSha }) => ({ complete: true, headSha, messages: [] }) },
    { getRangeMessages: async ({ headSha }) => ({ complete: true, headSha, messages: [{ sha: 'zz', message: 'm' }] }) },
    { getRangeMessages: async ({ headSha }) => ({ complete: true, headSha, messages: [{ sha: HEAD }] }) },
    { getRangeMessages: async () => null },
    { getRangeMessages: undefined }
  ];
  for (const [operation, fields] of [['push', { branch: 'feat/x', headSha: HEAD }], ['createPr', { title: 't', body: 'b', headBranch: 'feat/x', headSha: HEAD, baseBranch: 'main' }]]) {
    for (const content of bad) {
      const { broker, calls } = setup({ content });
      assert.equal((await broker.request({ operation, requestId: id(), ...fields })).reason, 'content-unverified', `${operation} ${Object.keys(content)}`);
      assert.equal(calls.length, 0);
    }
  }
});

test('the head commit\'s own message is refused too, for commit, push and createPr', async () => {
  for (const [operation, fields] of [['commit', { headSha: HEAD }], ['push', { branch: 'feat/x', headSha: HEAD }], ['createPr', { title: 't', body: 'b', headBranch: 'feat/x', headSha: HEAD, baseBranch: 'main' }]]) {
    const { broker, calls } = setup({ content: { getCommitContent: async (sha) => ({ complete: true, headSha: sha, message: `Add change\n\n${TRAILER}`, diff: 'diff --git a/a.js b/a.js\n+const safe = 1;\n' }) } });
    assert.equal((await broker.request({ operation, requestId: id(), ...fields })).reason, 'co-author-forbidden', operation);
    assert.equal(calls.length, 0);
  }
});
