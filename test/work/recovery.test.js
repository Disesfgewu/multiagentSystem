'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { claimIssue, reconcile } = require('../../src/work/coordinator');
const { createMemoryLinkStore } = require('../../src/work/links');
const { REPO, PRIVATE, createRemote } = require('./helpers');

const claim = (remote, store, extra = {}) => claimIssue({
  reader: remote.reader, writer: remote.writer, store, repo: REPO, issueNumber: 7, role: 'worker', ...PRIVATE, ...extra
});
const sync = (remote, store, extra = {}) => reconcile({ reader: remote.reader, store, ...extra });

// A restart keeps only what the store kept: a new store built from the old one's export.
const restart = (store) => createMemoryLinkStore(store.export());

async function claimed(initial = { 7: {} }) {
  const remote = createRemote(initial);
  const store = createMemoryLinkStore();
  assert.equal((await claim(remote, store)).ok, true);
  return { remote, store };
}

test('after a restart the record survives, and a remote that still agrees confirms it', async () => {
  const { remote, store } = await claimed();
  const after = restart(store);
  assert.deepEqual((await after.list()).map((link) => [link.sessionId, link.worktree, link.branch]), [[PRIVATE.sessionId, PRIVATE.worktree, PRIVATE.branch]]);
  const writesBefore = remote.writes.length;
  const report = await sync(remote, after, { now: () => Date.parse('2026-10-14T13:00:00Z') });
  assert.deepEqual(report.results, [{ repoId: 'example-org/example-repo', issueNumber: 7, outcome: 'confirmed' }]);
  assert.equal(remote.writes.length, writesBefore, 'reconciling only reads');
  const [link] = await after.list();
  assert.deepEqual([link.state, link.sync, link.lastSyncedAt], ['claimed', 'confirmed', '2026-10-14T13:00:00.000Z']);
});

test('a claim the remote no longer shows is dropped, so this machine does not go on thinking it holds the issue', async () => {
  const { remote, store } = await claimed();
  remote.touch(7, { labels: ['ready'], assignees: [] }); // the PM handed it back
  const report = await sync(remote, restart(store));
  assert.equal(report.results[0].outcome, 'claim-lost');
  const again = restart(store);
  await sync(remote, again);
  assert.deepEqual(await again.list(), []);
  // ...and the issue can be claimed again.
  const fresh = createMemoryLinkStore();
  assert.equal((await claim(remote, fresh, { sessionId: 'new-session-0009' })).ok, true);
});

test('an issue closed on GitHub ends the record', async () => {
  const { remote, store } = await claimed();
  remote.touch(7, { state: 'closed' });
  const after = restart(store);
  assert.equal((await sync(remote, after)).results[0].outcome, 'closed-remotely');
  assert.deepEqual(await after.list(), []);
});

test('an issue that cannot be read is not assumed to be anything: the record is kept and marked as not verified', async () => {
  const kinds = ['offline', 'transient', 'rate_limited', 'denied', 'not_found', 'invalid', 'something-new'];
  for (const kind of kinds) {
    const { remote, store } = await claimed();
    remote.onRead = () => ({ kind });
    const after = restart(store);
    const report = await sync(remote, after);
    assert.deepEqual([report.results[0].outcome, report.results[0].kind], ['could-not-read', kind]);
    const [link] = await after.list();
    assert.deepEqual([link.state, link.sync], ['claimed', 'unverified'], `${kind}: kept, unverified`);
    // Once it can be read again and agrees, it is confirmed.
    remote.onRead = null;
    await sync(remote, after);
    assert.equal((await after.list())[0].sync, 'confirmed');
  }
  const { remote, store } = await claimed();
  remote.reader.getIssue = async () => { throw new Error('boom'); };
  assert.equal((await sync(remote, store)).results[0].outcome, 'could-not-read');
});

test('a crash between the intent and the write: nothing happened remotely, so the intent is cleared', async () => {
  const remote = createRemote({ 7: {} });
  const store = createMemoryLinkStore();
  remote.writer.claim = async () => { throw new Error('process died'); };
  assert.equal((await claim(remote, store)).reason, 'outcome-unknown');
  const after = restart(store);
  assert.deepEqual((await after.list()).map((link) => link.sync), ['claiming']);
  const report = await sync(remote, after);
  assert.equal(report.results[0].outcome, 'claim-did-not-happen');
  assert.deepEqual(await after.list(), []);
});

test('a crash after the write but before the record: the remote shows a claim this machine cannot tell is its own, so a person confirms', async () => {
  const remote = createRemote({ 7: {} });
  const store = createMemoryLinkStore();
  // The write goes through, then the process dies before the answer is handled.
  const apply = remote.writer.claim;
  remote.writer.claim = async (payload) => { await apply(payload); throw new Error('process died after the write'); };
  assert.equal((await claim(remote, store)).reason, 'outcome-unknown');

  const after = restart(store);
  const report = await sync(remote, after);
  assert.equal(report.results[0].outcome, 'needs-confirmation');
  const [link] = await after.list();
  assert.deepEqual([link.state, link.sync], ['ready', 'needs_confirmation'], 'not assumed to be ours');
  // It stays that way until a person resolves it; reconciling again does not promote it.
  const again = await sync(remote, after);
  assert.equal(again.results[0].outcome, 'still-needs-attention');
  assert.equal((await after.list())[0].sync, 'needs_confirmation');
  // And a new claim of the same issue is refused until then.
  assert.equal((await claim(createRemote({ 7: {} }), after, { sessionId: 'someone-0099' })).reason, 'needs-reconcile');
});

test('more than one claim on the remote is a conflict: it is recorded, and stays until resolved', async () => {
  const { remote, store } = await claimed();
  remote.touch(7, { assignees: ['one', 'two'] });
  const after = restart(store);
  assert.equal((await sync(remote, after)).results[0].outcome, 'conflict-detected');
  assert.equal((await after.list())[0].sync, 'conflict');
  remote.touch(7, { assignees: ['one'] });
  assert.equal((await sync(remote, after)).results[0].outcome, 'still-needs-attention');
  assert.equal((await after.list())[0].sync, 'conflict', 'a conflict is not cleared by looking again');
});

test('a block set on GitHub is followed by the record', async () => {
  const { remote, store } = await claimed();
  remote.touch(7, { labels: ['in-progress', 'blocked'] });
  const after = restart(store);
  assert.equal((await sync(remote, after)).results[0].outcome, 'remote-blocked');
  assert.equal((await after.list())[0].state, 'blocked');
});

test('reconciling can be limited to one repository, and cancelled', async () => {
  const remote = createRemote({ 7: {} });
  const store = createMemoryLinkStore();
  assert.equal((await claim(remote, store)).ok, true);
  await store.save({ repoId: 'other-org/other-repo', issueNumber: 3, state: 'claimed', sync: 'confirmed', sessionId: 'other-session-0001', claimedAt: null, lastSyncedAt: null });
  remote.reads.length = 0;
  const only = await sync(remote, store, { repo: REPO });
  assert.deepEqual(only.results.map((entry) => entry.repoId), ['example-org/example-repo']);
  assert.equal(remote.reads.length, 1);

  const stop = new AbortController();
  stop.abort();
  const cancelled = await sync(remote, store, { signal: stop.signal });
  assert.deepEqual(cancelled.results.map((entry) => entry.outcome), ['cancelled']);

  remote.onRead = () => ({ kind: 'cancelled' });
  const mid = await sync(remote, store);
  assert.equal(mid.results[0].outcome, 'cancelled');
  assert.equal(mid.results.length, 1, 'it stops at the first cancelled read');
});

test('a snapshot that is not a valid list of links is refused, not half loaded', () => {
  assert.throws(() => createMemoryLinkStore('{"not":"a list"}'), TypeError);
  assert.throws(() => createMemoryLinkStore('[{"repoId":"a/b"}]'), TypeError);
  assert.throws(() => createMemoryLinkStore(JSON.stringify([{ repoId: 'a/b', issueNumber: 1, state: 'merged', sync: 'confirmed', sessionId: 'session-0001' }])), TypeError, 'a finished issue is not kept');
  assert.throws(() => createMemoryLinkStore('not json'));
  assert.deepEqual(createMemoryLinkStore('[]').export(), '[]');
});

test('reconciling takes a reader and a store, and says so when they are missing', async () => {
  await assert.rejects(() => reconcile({ store: createMemoryLinkStore() }), TypeError);
  await assert.rejects(() => reconcile({ reader: {}, store: createMemoryLinkStore() }), TypeError);
  await assert.rejects(() => reconcile({ reader: createRemote().reader }), TypeError);
});

// ---- reconcile reads an answer as strictly as a claim does -------------------

const GOOD_DATA = (change) => ({ state: 'open', labels: ['in-progress'], assignees: ['shared-account'], updatedAt: '2026-10-14T12:00:09.000Z', ...change });

test('an answer reported as ok but missing what is needed never deletes the only local record', async () => {
  const incomplete = [
    ['no data', undefined],
    ['null data', null],
    ['data is a list', []],
    ['data is text', 'closed'],
    ['empty data', {}],
    ['no state', { labels: ['in-progress'], assignees: [] }],
    ['unknown state', GOOD_DATA({ state: 'archived' })],
    ['no labels', { state: 'open', assignees: ['x'] }],
    ['labels null', GOOD_DATA({ labels: null })],
    ['labels an object', GOOD_DATA({ labels: {} })],
    ['labels are objects', GOOD_DATA({ labels: [{ name: 'in-progress' }] })],
    ['a label that is not text', GOOD_DATA({ labels: ['in-progress', 5] })],
    ['no assignees', { state: 'open', labels: ['in-progress'] }],
    ['assignees null', GOOD_DATA({ assignees: null })],
    ['an assignee that is not text', GOOD_DATA({ assignees: [{}] })]
  ];
  for (const [name, data] of incomplete) {
    const { remote, store } = await claimed();
    remote.onRead = () => ({ kind: 'ok', data });
    const after = restart(store);
    const writes = remote.writes.length;
    const report = await sync(remote, after);
    assert.deepEqual([report.results[0].outcome, report.results[0].kind], ['could-not-read', 'incomplete'], name);
    const [link] = await after.list();
    assert.ok(link, `${name}: the record is still there`);
    assert.deepEqual([link.state, link.sync, link.sessionId, link.worktree, link.branch],
      ['claimed', 'unverified', PRIVATE.sessionId, PRIVATE.worktree, PRIVATE.branch], `${name}: kept, as it was, marked unverified`);
    assert.equal(remote.writes.length, writes, `${name}: still only reads`);
  }
});

test('an intent being resolved is not resolved by an incomplete answer either', async () => {
  const remote = createRemote({ 7: {} });
  const store = createMemoryLinkStore();
  const apply = remote.writer.claim;
  remote.writer.claim = async (payload) => { await apply(payload); throw new Error('process died after the write'); };
  assert.equal((await claim(remote, store)).reason, 'outcome-unknown');
  const after = restart(store);
  remote.onRead = () => ({ kind: 'ok', data: {} });
  assert.equal((await sync(remote, after)).results[0].outcome, 'could-not-read');
  assert.deepEqual((await after.list()).map((link) => link.sync), ['claiming'], 'still an intent: nothing was decided');
  remote.onRead = null;
  assert.equal((await sync(remote, after)).results[0].outcome, 'needs-confirmation', 'decided once it can be read');
});

test('a response for another issue never removes or confirms this issue\'s local record', async () => {
  const { remote, store } = await claimed();
  const after = restart(store);
  remote.onRead = () => ({ kind: 'ok', data: { number: 8, state: 'closed', labels: [], assignees: [], updatedAt: '2026-10-14T12:00:09.000Z' } });
  const report = await sync(remote, after);
  assert.deepEqual([report.results[0].outcome, report.results[0].kind], ['could-not-read', 'incomplete']);
  const [link] = await after.list();
  assert.deepEqual([link.issueNumber, link.state, link.sync], [7, 'claimed', 'unverified']);
});

test('label case does not change what reconcile concludes: a claim shown as In-Progress is a claim, Blocked is a block', async () => {
  const { remote, store } = await claimed();
  remote.touch(7, { labels: ['In-Progress'] });
  const after = restart(store);
  assert.equal((await sync(remote, after)).results[0].outcome, 'confirmed', 'not "claim-lost"');
  assert.equal((await after.list()).length, 1);

  // The label alone shows the claim: no assignee, so only the label can say it is still held.
  remote.touch(7, { labels: ['In-Progress'], assignees: [] });
  assert.equal((await sync(remote, after)).results[0].outcome, 'confirmed', 'a claim shown by its label alone, in capitals');
  assert.equal((await after.list()).length, 1);

  remote.touch(7, { labels: ['IN-PROGRESS', 'Blocked'] });
  assert.equal((await sync(remote, after)).results[0].outcome, 'remote-blocked');
  assert.equal((await after.list())[0].state, 'blocked');

  remote.touch(7, { labels: [' IN-PROGRESS ', ' Blocked '] });
  assert.equal((await sync(remote, after)).results[0].outcome, 'confirmed', 'surrounding spaces do not hide either status label');

  // And an intent that finds a claim shown in capitals still waits for a person.
  const crashed = createRemote({ 7: {} });
  const intent = createMemoryLinkStore();
  const apply = crashed.writer.claim;
  crashed.writer.claim = async (payload) => { await apply(payload); throw new Error('died'); };
  await claim(crashed, intent);
  crashed.touch(7, { labels: ['In-Progress'] });
  assert.equal((await sync(crashed, intent)).results[0].outcome, 'needs-confirmation');
});
