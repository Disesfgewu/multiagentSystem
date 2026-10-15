'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { claimIssue, assessAvailability, verifyClaim } = require('../../src/work/coordinator');
const { createMemoryLinkStore } = require('../../src/work/links');
const { DEFAULT_LABELS } = require('../../src/work/labels');
const { REPO, PRIVATE, issue, createRemote } = require('./helpers');

const claim = (remote, store, extra = {}) => claimIssue({
  reader: remote.reader, writer: remote.writer, store, repo: REPO, issueNumber: 7, role: 'worker', ...PRIVATE, ...extra
});
const fresh = (initial = { 7: {} }) => ({ remote: createRemote(initial), store: createMemoryLinkStore() });

test('a free, ready issue is claimed: the remote shows the neutral label, and this machine records who holds it', async () => {
  const { remote, store } = fresh();
  const result = await claim(remote, store);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual([result.link.state, result.link.sync, result.link.sessionId, result.link.worktree, result.link.branch],
    ['claimed', 'confirmed', PRIVATE.sessionId, PRIVATE.worktree, PRIVATE.branch]);
  assert.equal(result.link.repoId, 'example-org/example-repo');
  assert.deepEqual((await store.list()).map((link) => [link.issueNumber, link.state, link.sync]), [[7, 'claimed', 'confirmed']]);

  const shown = remote.issues.get(7);
  assert.deepEqual(shown.labels, ['in-progress'], 'the ready label was replaced by the status label');
  assert.equal(remote.writes.length, 1);
  assert.deepEqual(remote.writes[0], {
    op: 'claim',
    payload: { repo: REPO, issueNumber: 7, label: 'in-progress', expectedUpdatedAt: '2026-10-14T12:00:00.000Z' }
  });
});

test('nothing private reaches GitHub: not the session, the worktree, the branch or a path', async () => {
  const { remote, store } = fresh();
  assert.equal((await claim(remote, store)).ok, true);
  const everything = JSON.stringify([remote.writes, remote.reads, [...remote.issues.values()]]);
  for (const secret of [PRIVATE.sessionId, PRIVATE.worktree, PRIVATE.branch, 'synthetic', '/']) {
    if (secret === 'synthetic') continue; // part of the fixture's own title
    assert.equal(everything.includes(secret), false, `${secret} must not appear in what is read or written`);
  }
  for (const write of remote.writes) assert.deepEqual(Object.keys(write.payload).sort(), ['expectedUpdatedAt', 'issueNumber', 'label', 'repo']);
});

test('an issue that is not clearly free is never claimed, and the reason says why; no write is attempted', async () => {
  const cases = [
    ['closed', { state: 'closed' }, 'closed'],
    ['a pull request', { isPullRequest: true }, 'is-pull-request'],
    ['blocked', { labels: ['ready', 'blocked'] }, 'blocked'],
    ['already shown as claimed', { labels: ['ready', 'in-progress'] }, 'already-claimed'],
    ['claimed by label only', { labels: ['in-progress'] }, 'already-claimed'],
    ['assigned to someone', { assignees: ['someone'] }, 'already-claimed'],
    ['not marked ready', { labels: [] }, 'not-ready'],
    ['labelled something else', { labels: ['bug'] }, 'not-ready'],
    ['without a version to check against', { updatedAt: undefined }, 'no-version'],
    ['with an unreadable version', { updatedAt: 'last tuesday' }, 'no-version'],
    ['with no label list', { labels: undefined }, 'cannot-verify'],
    ['with no assignee list', { assignees: undefined }, 'cannot-verify'],
    ['with labels of the wrong type', { labels: 'ready' }, 'cannot-verify']
  ];
  for (const [name, change, reason] of cases) {
    const { remote, store } = fresh({ 7: change });
    const result = await claim(remote, store);
    assert.deepEqual([result.ok, result.reason], [false, reason], name);
    assert.equal(remote.writes.length, 0, `${name}: no write`);
    assert.deepEqual(await store.list(), [], `${name}: nothing recorded`);
  }
});

test('a reader response must identify the issue that was requested', async () => {
  const before = fresh();
  before.remote.onRead = () => ({ kind: 'ok', data: issue({ number: 8 }) });
  assert.equal((await claim(before.remote, before.store)).reason, 'cannot-verify');
  assert.equal(before.remote.writes.length, 0, 'another issue is never used as the basis for a write');
  assert.deepEqual(await before.store.list(), []);

  const after = fresh();
  after.remote.onRead = (number, call) => call === 1
    ? undefined
    : { kind: 'ok', data: issue({ number: 8, labels: ['in-progress'], assignees: ['x'], updatedAt: '2026-10-14T12:00:05.000Z' }) };
  assert.equal((await claim(after.remote, after.store)).reason, 'conflict-detected', 'a mismatched confirmation cannot confirm the write');
  assert.deepEqual((await after.store.list()).map((link) => link.sync), ['conflict']);
});

test('an issue that cannot be read is not treated as claimable, whatever the reason', async () => {
  const cases = [
    [{ kind: 'not_found', possiblyHidden: true }, 'issue-not-found'],
    [{ kind: 'denied', reason: 'forbidden' }, 'access-denied'],
    [{ kind: 'rate_limited' }, 'cannot-verify'],
    [{ kind: 'transient' }, 'cannot-verify'],
    [{ kind: 'offline' }, 'cannot-verify'],
    [{ kind: 'invalid' }, 'cannot-verify'],
    [{ kind: 'cancelled', reason: 'aborted' }, 'cancelled'],
    [{ kind: 'something-new' }, 'cannot-verify'],
    [{ kind: 'empty' }, 'cannot-verify'],
    [{ kind: 'partial', data: issue() }, 'cannot-verify'],
    [{ kind: 'truncated', partialData: issue() }, 'cannot-verify'],
    [undefined, 'cannot-verify'],
    [null, 'cannot-verify']
  ];
  for (const [read, reason] of cases) {
    const { remote, store } = fresh();
    remote.onRead = () => read ?? { kind: 'nothing' };
    if (read === undefined || read === null) remote.reader.getIssue = async () => read;
    const result = await claim(remote, store);
    assert.deepEqual([result.ok, result.reason], [false, reason], JSON.stringify(read));
    assert.equal(remote.writes.length, 0);
    assert.deepEqual(await store.list(), []);
  }
  const { remote, store } = fresh();
  remote.reader.getIssue = async () => { throw new Error('boom'); };
  assert.deepEqual((await claim(remote, store)).reason, 'cannot-verify', 'a reader that throws did not read');
  assert.equal(remote.writes.length, 0);
});

test('only a worker or the PM may claim, and a refused role does not even read the issue', async () => {
  for (const role of ['human', 'system', 'admin', '', undefined]) {
    const { remote, store } = fresh();
    const result = await claim(remote, store, { role: role ?? 'worker', ...(role === undefined ? { role: 'nobody' } : {}) });
    assert.deepEqual([result.ok, result.reason], [false, 'role-forbidden'], String(role));
    assert.equal(remote.reads.length, 0);
    assert.equal(remote.writes.length, 0);
  }
  for (const role of ['worker', 'pm']) {
    const { remote, store } = fresh();
    assert.equal((await claim(remote, store, { role })).ok, true, role);
  }
});

test('what this machine already holds is checked first: the same issue, an unresolved claim, an agent already busy', async () => {
  const { remote, store } = fresh({ 7: {}, 8: {} });
  assert.equal((await claim(remote, store)).ok, true);
  remote.reads.length = 0;

  const again = await claim(remote, store, { sessionId: 'other-session-0002' });
  assert.deepEqual([again.ok, again.reason], [false, 'already-claimed-locally']);
  const busy = await claim(remote, store, { issueNumber: 8 });
  assert.deepEqual([busy.ok, busy.reason], [false, 'session-busy'], 'one agent, one current issue');
  assert.equal(remote.reads.length, 0, 'decided without asking GitHub');
  assert.equal(remote.writes.length, 1);

  const other = await claim(remote, store, { issueNumber: 8, sessionId: 'other-session-0002' });
  assert.equal(other.ok, true, 'a different agent may take a different issue');

  for (const sync of ['claiming', 'conflict', 'needs_confirmation', 'unverified']) {
    const held = createMemoryLinkStore();
    await held.save({ repoId: 'example-org/example-repo', issueNumber: 7, state: 'ready', sync, sessionId: 'earlier-session-0003', claimedAt: null, lastSyncedAt: null });
    const result = await claim(createRemote({ 7: {} }), held);
    assert.deepEqual([result.ok, result.reason, result.sync], [false, 'needs-reconcile', sync]);
  }
});

test('two claims started at once: exactly one goes ahead', async () => {
  const { remote, store } = fresh();
  const [first, second] = await Promise.all([
    claim(remote, store, { sessionId: 'session-one-0001' }),
    claim(remote, store, { sessionId: 'session-two-0002' })
  ]);
  const results = [first, second];
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.deepEqual(results.find((result) => !result.ok).reason, 'claim-in-progress');
  assert.equal(remote.writes.length, 1, 'only one write was ever made');
  assert.equal((await store.list()).length, 1);

  // And one agent cannot claim two issues at once either.
  const two = fresh({ 7: {}, 8: {} });
  const [a, b] = await Promise.all([claim(two.remote, two.store), claim(two.remote, two.store, { issueNumber: 8 })]);
  assert.equal([a, b].filter((result) => result.ok).length, 1);
  assert.equal([a, b].find((result) => !result.ok).reason, 'claim-in-progress');
});

test('a change between reading and writing is refused by the writer; the issue is read again and decided afresh', async () => {
  // Someone else takes the issue after it was read. The writer refuses; the second read sees why.
  const taken = fresh();
  taken.remote.onClaim = (payload, call) => {
    if (call === 1) {
      taken.remote.touch(7, { labels: ['in-progress'], assignees: ['someone-else'] });
      return { ok: false, reason: 'conflict' };
    }
    return undefined;
  };
  const refused = await claim(taken.remote, taken.store);
  assert.deepEqual([refused.ok, refused.reason], [false, 'already-claimed']);
  assert.equal(taken.remote.writes.length, 1, 'no second write once it is seen to be taken');
  assert.deepEqual(await taken.store.list(), [], 'the intent was withdrawn');

  // The issue was only touched (a comment, say): the second attempt, on the new version, succeeds.
  const touched = fresh();
  touched.remote.onClaim = (payload, call) => {
    if (call === 1) {
      touched.remote.touch(7, {});
      return { ok: false, reason: 'conflict' };
    }
    return undefined;
  };
  const result = await claim(touched.remote, touched.store);
  assert.equal(result.ok, true);
  assert.equal(touched.remote.writes.length, 2);
  assert.notEqual(touched.remote.writes[1].payload.expectedUpdatedAt, touched.remote.writes[0].payload.expectedUpdatedAt, 'the second write carries the version just read');
  assert.ok(touched.remote.reads.filter((read) => read.options && read.options.forceRefresh).length >= 2, 'every read is fresh');
});

test('a conflict that keeps happening stops after the retry budget and asks for a sync, never loops', async () => {
  for (const retries of [0, 1, 2, 4]) {
    const { remote, store } = fresh();
    remote.onClaim = () => { remote.touch(7, {}); return { ok: false, reason: 'conflict' }; };
    const result = await claim(remote, store, { maxSyncRetries: retries });
    assert.deepEqual([result.ok, result.reason, result.syncRequired], [false, 'conflict', true], `retries ${retries}`);
    assert.equal(remote.writes.length, retries + 1, `retries ${retries}: attempts made`);
    assert.deepEqual(await store.list(), []);
  }
  const { remote, store } = fresh();
  remote.onClaim = () => { remote.touch(7, {}); return { ok: false, reason: 'conflict' }; };
  await claim(remote, store);
  assert.equal(remote.writes.length, 3, 'the default is two retries');
});

test('a refused write is reported as what it is, and leaves nothing recorded', async () => {
  for (const [reason, expected] of [['denied', 'write-denied'], ['rate_limited', 'cannot-write'], ['invalid', 'cannot-write']]) {
    const { remote, store } = fresh();
    remote.onClaim = () => ({ ok: false, reason });
    const result = await claim(remote, store);
    assert.deepEqual([result.ok, result.reason], [false, expected], reason);
    assert.equal(remote.writes.length, 1, `${reason}: not retried`);
    assert.deepEqual(await store.list(), [], `${reason}: no record`);
  }
});

test('a write whose outcome is not known is not retried; the intent stays so a restart can find out', async () => {
  const cases = [
    ['unavailable', () => ({ ok: false, reason: 'unavailable' })],
    ['a failure with no reason', () => ({ ok: false })],
    ['no answer at all', () => undefined],
    ['an answer of the wrong shape', () => ({ fine: true })],
    ['an exception', () => { throw new Error('connection reset'); }]
  ];
  for (const [name, script] of cases) {
    const { remote, store } = fresh();
    remote.writer.claim = async (payload) => { remote.writes.push({ op: 'claim', payload }); return script(); };
    const result = await claim(remote, store);
    assert.deepEqual([result.ok, result.reason], [false, 'outcome-unknown'], name);
    assert.equal(remote.writes.length, 1, `${name}: never retried blindly`);
    const kept = await store.list();
    assert.deepEqual(kept.map((link) => [link.state, link.sync]), [['ready', 'claiming']], `${name}: the intent is on record`);
  }
});

test('after a write the remote is read again: if it cannot be read, or shows more than one claim, the claim is not confirmed', async () => {
  const unread = fresh();
  unread.remote.onRead = (number, call) => (call === 1 ? undefined : { kind: 'offline' });
  const first = await claim(unread.remote, unread.store);
  assert.deepEqual([first.ok, first.reason, first.kind], [false, 'claim-unverified', 'offline']);
  assert.deepEqual((await unread.store.list()).map((link) => link.sync), ['unverified']);

  const twice = fresh();
  twice.remote.onClaim = (payload) => {
    twice.remote.touch(7, { labels: ['in-progress'], assignees: ['one', 'two'] });
    return { ok: true };
  };
  const conflict = await claim(twice.remote, twice.store);
  assert.deepEqual([conflict.ok, conflict.reason], [false, 'conflict-detected']);
  assert.deepEqual((await twice.store.list()).map((link) => [link.state, link.sync]), [['ready', 'conflict']], 'dispatching stops here until it is resolved');

  const noLabel = fresh();
  noLabel.remote.onClaim = () => { noLabel.remote.touch(7, {}); return { ok: true }; };
  assert.equal((await claim(noLabel.remote, noLabel.store)).reason, 'conflict-detected', 'a write reported as done that is not visible');

  const blockedAfter = fresh();
  blockedAfter.remote.onClaim = () => { blockedAfter.remote.touch(7, { labels: ['in-progress', 'blocked'], assignees: ['x'] }); return { ok: true }; };
  assert.equal((await claim(blockedAfter.remote, blockedAfter.store)).reason, 'conflict-detected');
});

test('verification knows what a claim looks like', () => {
  const before = issue();
  const after = (change) => issue({ labels: ['in-progress'], assignees: ['x'], updatedAt: '2026-10-14T12:00:05.000Z', ...change });
  assert.equal(verifyClaim(before, after(), DEFAULT_LABELS), true);
  for (const change of [{ state: 'closed' }, { isPullRequest: true }, { labels: ['ready'] }, { labels: ['in-progress', 'blocked'] }, { assignees: ['a', 'b'] },
    { updatedAt: '2026-10-14T11:00:00.000Z' }, { updatedAt: undefined }, { labels: 'in-progress' }, { assignees: null }]) {
    assert.equal(verifyClaim(before, after(change), DEFAULT_LABELS), false, JSON.stringify(change));
  }
  assert.equal(verifyClaim(before, null, DEFAULT_LABELS), false);
  assert.equal(assessAvailability(issue(), DEFAULT_LABELS).updatedAt, '2026-10-14T12:00:00.000Z');
  assert.equal(assessAvailability(null, DEFAULT_LABELS).reason, 'cannot-verify');
});

test('cancelling stops the claim before anything is written, and withdraws the intent', async () => {
  const before = fresh();
  const controller = new AbortController();
  controller.abort();
  const early = await claim(before.remote, before.store, { signal: controller.signal });
  assert.deepEqual([early.ok, early.reason], [false, 'cancelled']);
  assert.equal(before.remote.writes.length, 0);

  const during = fresh();
  const late = new AbortController();
  during.remote.onRead = () => { late.abort(); return undefined; };
  const result = await claim(during.remote, during.store, { signal: late.signal });
  assert.deepEqual([result.ok, result.reason], [false, 'cancelled']);
  assert.equal(during.remote.writes.length, 0, 'aborted after the read and before the write');
  assert.deepEqual(await during.store.list(), [], 'the intent is withdrawn');
});

test('labels may be configured, but only as plain status names', async () => {
  const { remote, store } = fresh({ 7: { labels: ['todo'] } });
  const result = await claim(remote, store, { labels: { ready: 'todo', claimed: 'doing', blocked: 'stuck' } });
  assert.equal(result.ok, true);
  assert.equal(remote.writes[0].payload.label, 'doing');
  for (const bad of ['', 'Has Capitals', 'agent@laptop', '/synthetic/path', 'a'.repeat(51), 'with.dot', 7, null]) {
    await assert.rejects(() => claim(createRemote({ 7: {} }), createMemoryLinkStore(), { labels: { claimed: bad } }), TypeError, String(bad));
  }
  await assert.rejects(() => claim(createRemote({ 7: {} }), createMemoryLinkStore(), { labels: { ready: 'same', claimed: 'same' } }), TypeError);
});

test('a programming mistake is an exception; anything that can happen is a result', async () => {
  const { remote, store } = fresh();
  const base = { reader: remote.reader, writer: remote.writer, store, repo: REPO, issueNumber: 7, role: 'worker', sessionId: 'session-synthetic-0001' };
  for (const change of [{ reader: null }, { reader: {} }, { writer: null }, { writer: {} }, { store: null }, { store: {} },
    { repo: null }, { repo: { owner: 'a' } }, { repo: { owner: '..', name: 'b' } }, { issueNumber: 0 }, { issueNumber: 1.5 }, { issueNumber: '7' },
    { role: undefined }, { sessionId: '' }, { sessionId: undefined }]) {
    await assert.rejects(() => claimIssue({ ...base, ...change }), TypeError, JSON.stringify(Object.keys(change)));
  }
  assert.equal(remote.reads.length, 0);
});

// ---- label names are compared without regard to case ------------------------

test('GitHub does not distinguish label case, so neither does the decision: Blocked, In-Progress and READY', async () => {
  const refusals = [
    ['Blocked', { labels: ['ready', 'Blocked'] }, 'blocked'],
    ['BLOCKED', { labels: ['READY', 'BLOCKED'] }, 'blocked'],
    ['In-Progress', { labels: ['ready', 'In-Progress'] }, 'already-claimed'],
    ['IN-PROGRESS only', { labels: ['IN-PROGRESS'] }, 'already-claimed'],
    ['Ready is the only label but with a claim', { labels: ['Ready', 'in-PROGRESS'] }, 'already-claimed'],
    ['spaces around Blocked', { labels: ['ready', ' Blocked '] }, 'blocked'],
    ['spaces around In-Progress', { labels: ['ready', ' In-Progress '] }, 'already-claimed']
  ];
  for (const [name, change, reason] of refusals) {
    const { remote, store } = fresh({ 7: change });
    const result = await claim(remote, store);
    assert.deepEqual([result.ok, result.reason], [false, reason], name);
    assert.equal(remote.writes.length, 0, `${name}: no write`);
  }
  for (const spelling of ['READY', 'Ready', 'rEaDy', ' ready ']) {
    const { remote, store } = fresh({ 7: { labels: [spelling] } });
    const result = await claim(remote, store);
    assert.equal(result.ok, true, `${spelling} is the ready label`);
  }
  // The configured names are folded too, so a repository can write them as it likes in its own docs.
  const { remote, store } = fresh({ 7: { labels: ['Ready'] } });
  assert.equal((await claim(remote, store, { labels: { ready: 'ready', claimed: 'doing', blocked: 'stuck' } })).ok, true);
});

test('what is read back after a write is judged the same way: a claim shown as In-Progress is a claim', async () => {
  const before = issue();
  const after = (change) => issue({ labels: ['In-Progress'], assignees: ['x'], updatedAt: '2026-10-14T12:00:05.000Z', ...change });
  assert.equal(verifyClaim(before, after(), DEFAULT_LABELS), true);
  assert.equal(verifyClaim(before, after({ labels: ['IN-PROGRESS', 'Blocked'] }), DEFAULT_LABELS), false, 'and a block shown in capitals is still a block');
  assert.equal(verifyClaim(before, after({ labels: ['ready'] }), DEFAULT_LABELS), false);
});

// ---- an answer that is missing what the decision needs is not read ----------

test('an answer reported as ok but missing what is needed is not a free issue, and the reason is that it could not be verified', async () => {
  const incomplete = [
    ['no data', undefined],
    ['null data', null],
    ['data is a list', []],
    ['data is a string', 'open'],
    ['empty data', {}],
    ['no state', { labels: ['ready'], assignees: [], updatedAt: '2026-10-14T12:00:00.000Z' }],
    ['unknown state', { state: 'merged', labels: ['ready'], assignees: [], updatedAt: '2026-10-14T12:00:00.000Z' }],
    ['upper-case state', { state: 'OPEN', labels: ['ready'], assignees: [], updatedAt: '2026-10-14T12:00:00.000Z' }],
    ['no labels', { state: 'open', assignees: [], updatedAt: '2026-10-14T12:00:00.000Z' }],
    ['labels null', { state: 'open', labels: null, assignees: [], updatedAt: '2026-10-14T12:00:00.000Z' }],
    ['labels an object', { state: 'open', labels: { ready: true }, assignees: [], updatedAt: '2026-10-14T12:00:00.000Z' }],
    ['labels are objects', { state: 'open', labels: [{ name: 'ready' }], assignees: [], updatedAt: '2026-10-14T12:00:00.000Z' }],
    ['a label that is not text', { state: 'open', labels: ['ready', 7], assignees: [], updatedAt: '2026-10-14T12:00:00.000Z' }],
    ['no assignees', { state: 'open', labels: ['ready'], updatedAt: '2026-10-14T12:00:00.000Z' }],
    ['assignees null', { state: 'open', labels: ['ready'], assignees: null, updatedAt: '2026-10-14T12:00:00.000Z' }],
    ['an assignee that is not text', { state: 'open', labels: ['ready'], assignees: [null], updatedAt: '2026-10-14T12:00:00.000Z' }]
  ];
  for (const [name, data] of incomplete) {
    const { remote, store } = fresh();
    remote.onRead = () => ({ kind: 'ok', data });
    const result = await claim(remote, store);
    assert.deepEqual([result.ok, result.reason], [false, 'cannot-verify'], name);
    assert.equal(remote.writes.length, 0, `${name}: no write`);
    assert.deepEqual(await store.list(), [], `${name}: nothing recorded`);
  }
});
