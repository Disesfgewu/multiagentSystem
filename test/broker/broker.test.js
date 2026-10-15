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
      getIssue: async () => ({ kind: 'ok', data: { state: 'open', assignees: [] } }),
      getPullRequestSnapshot: async () => snapshot(),
      getPullRequestPublication: async () => ({ kind: 'ok', data: { complete: true, number: 7, headSha: HEAD, diff: 'diff --git a/a.js b/a.js\n+const safe = 1;\n' } }),
      ...(over.reader || {})
    },
    content: { getCommitContent: async (sha) => ({ complete: true, headSha: sha, message: 'Add safe change', diff: 'diff --git a/a.js b/a.js\n+const safe = 1;\n' }), ...(over.content || {}) },
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
    createIssue: { title: 't', body: 'b' }, editIssue: { number: 3, title: 't' }, claimIssue: { number: 3 },
    createPr: { title: 't', body: 'b', headBranch: 'feat/x', headSha: HEAD, baseBranch: 'main' }, commit: { headSha: HEAD },
    push: { branch: 'feat/x', headSha: HEAD }, comment: { target: 'issue', number: 3, body: 'hi' },
    reviewPr: { number: 7, decision: 'approve', body: 'ok', expectedHeadSha: HEAD }, mergePr: { number: 7 }
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
