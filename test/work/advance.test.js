'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { claimIssue, advance } = require('../../src/work/coordinator');
const { createMemoryLinkStore } = require('../../src/work/links');
const { REPO, PRIVATE, SHA, createRemote } = require('./helpers');

const A = SHA('a');
const B = SHA('b');
const GOOD = (head) => ({
  headSha: head, consistent: true, approval: { status: 'approved', headSha: head },
  checks: { state: 'passing', requiredState: 'passing' }, unresolvedThreads: 0, mergeable: true
});

async function setup() {
  const remote = createRemote({ 7: {} });
  const store = createMemoryLinkStore();
  const claimed = await claimIssue({ reader: remote.reader, writer: remote.writer, store, repo: REPO, issueNumber: 7, role: 'worker', ...PRIVATE });
  assert.equal(claimed.ok, true);
  const step = (event, role, extra = {}) => advance({
    reader: remote.reader, writer: remote.writer, store, repo: REPO, issueNumber: 7, event, role, sessionId: PRIVATE.sessionId, ...extra
  });
  const state = async () => (await store.get(REPO, 7));
  return { remote, store, step, state };
}

test('an issue goes from claimed to merged one allowed step at a time, and only the status label that GitHub shows is ever written', async () => {
  const { remote, store, step, state } = await setup();
  const writesAfterClaim = remote.writes.length;
  const run = async (event, role, extra) => {
    const result = await step(event, role, extra);
    assert.equal(result.ok, true, `${event}: ${JSON.stringify(result)}`);
    return result;
  };
  await run('start', 'worker');
  await run('open_pr', 'worker', { evidence: { prNumber: 9, headSha: A } });
  assert.deepEqual([(await state()).prNumber, (await state()).headSha], [9, A]);
  await run('request_review', 'worker');
  await run('request_changes', 'pm', { evidence: { review: { state: 'CHANGES_REQUESTED' } } });
  await run('worker_update', 'worker');
  await run('resubmit', 'worker', { evidence: { headSha: B } });
  await run('pm_pass', 'pm', { evidence: { headSha: B, approval: { status: 'approved', headSha: B } } });
  assert.equal((await state()).reviewKind, 'formal');
  await run('mark_ready_to_merge', 'system', { evidence: GOOD(B) });
  const merged = await run('merge', 'human', { evidence: { mergeAuthority: 'human' } });
  assert.deepEqual([merged.state, merged.link], ['merged', null]);
  assert.deepEqual(await store.list(), [], 'a finished issue leaves no record');
  assert.equal(remote.writes.length, writesAfterClaim, 'the shown label did not change, so nothing was written');
});

test('releasing sets the ready label first and only then forgets the claim', async () => {
  const { remote, store, step } = await setup();
  const result = await step('release', 'worker');
  assert.deepEqual([result.ok, result.state, result.link], [true, 'ready', null]);
  assert.deepEqual(remote.writes.map((write) => [write.op, write.payload.label]), [['claim', 'in-progress'], ['setLabel', 'ready']]);
  assert.deepEqual(remote.issues.get(7).labels, ['ready']);
  assert.deepEqual(await store.list(), []);
});

test('blocking shows the blocked label, and only the PM unblocks, back to ready', async () => {
  const { remote, step, state } = await setup();
  assert.equal((await step('block', 'worker')).ok, true);
  assert.deepEqual(remote.issues.get(7).labels, ['blocked']);
  assert.equal((await state()).state, 'blocked');
  assert.equal((await step('unblock', 'worker')).reason, 'role-forbidden');
  const unblocked = await step('unblock', 'pm');
  assert.deepEqual([unblocked.ok, unblocked.state], [true, 'ready']);
  assert.deepEqual(remote.issues.get(7).labels, ['ready']);
  assert.equal(await state(), null);
});

test('a refused write leaves the record exactly as it was, so the machine never says "released" while GitHub says "claimed"', async () => {
  for (const [script, reason] of [[{ ok: false, reason: 'denied' }, 'write-denied'], [{ ok: false, reason: 'conflict' }, 'conflict'], [{ ok: false, reason: 'rate_limited' }, 'cannot-write']]) {
    const { remote, step, state } = await setup();
    remote.onSetLabel = () => script;
    const result = await step('release', 'worker');
    assert.equal(result.reason, reason);
    assert.deepEqual([(await state()).state, (await state()).sync], ['claimed', 'confirmed'], reason);
  }
  const unknown = await setup();
  unknown.remote.onSetLabel = () => ({ ok: false, reason: 'unavailable' });
  assert.equal((await unknown.step('release', 'worker')).reason, 'outcome-unknown');
  assert.equal((await unknown.state()).sync, 'unverified', 'it may have happened, so the record says it is not verified');

  const thrown = await setup();
  thrown.remote.onSetLabel = () => { throw new Error('reset'); };
  assert.equal((await thrown.step('release', 'worker')).reason, 'outcome-unknown');
});

test('a change that needs the remote is refused when the remote cannot be read', async () => {
  const { remote, step, state } = await setup();
  remote.onRead = () => ({ kind: 'offline' });
  const result = await step('release', 'worker');
  assert.deepEqual([result.ok, result.reason, result.kind], [false, 'cannot-verify', 'offline']);
  assert.equal((await state()).state, 'claimed');
  assert.equal(remote.writes.length, 1, 'no label was written');
  remote.onRead = () => ({ kind: 'ok', data: { updatedAt: 7 } });
  assert.equal((await step('release', 'worker')).reason, 'cannot-verify', 'without a usable version');
});

test('only the worker that holds an issue can move it, and a record that is not confirmed cannot be moved by anyone but the PM or a person', async () => {
  const { store, step, state } = await setup();
  assert.equal((await step('start', 'worker', { sessionId: 'some-other-session-0002' })).reason, 'not-owner');
  assert.equal((await state()).state, 'claimed');
  assert.equal((await step('start', 'pm')).reason, 'role-forbidden', 'and the PM does not do a worker\'s steps for them');

  for (const sync of ['conflict', 'needs_confirmation', 'unverified', 'claiming']) {
    const link = await store.get(REPO, 7);
    await store.save({ ...link, sync });
    const blocked = await step('start', 'worker');
    assert.deepEqual([blocked.ok, blocked.reason, blocked.sync], [false, 'unresolved-sync', sync], sync);
  }
  // The PM or a person can resolve it by releasing or closing.
  const closed = await step('close', 'pm');
  assert.deepEqual([closed.ok, closed.state], [true, 'closed']);
  assert.deepEqual(await store.list(), []);
});

test('a PM or a person may release a claim that is stuck, and a worker may not release another worker\'s', async () => {
  const { store, step } = await setup();
  const link = await store.get(REPO, 7);
  await store.save({ ...link, sync: 'conflict' });
  assert.equal((await step('release', 'worker')).reason, 'unresolved-sync');
  assert.equal((await step('release', 'worker', { sessionId: 'another-session-0003' })).reason, 'not-owner');
  const released = await step('release', 'human');
  assert.deepEqual([released.ok, released.state], [true, 'ready']);
});

test('moves the state machine refuses are passed on with their reasons, and change nothing', async () => {
  const { remote, step, state } = await setup();
  const writes = remote.writes.length;
  assert.equal((await step('merge', 'human', { evidence: { mergeAuthority: 'human' } })).reason, 'illegal-transition');
  assert.equal((await step('open_pr', 'worker', { evidence: { prNumber: 3 } })).reason, 'illegal-transition', 'not yet started');
  await step('start', 'worker');
  assert.equal((await step('open_pr', 'worker', { evidence: { prNumber: 3 } })).reason, 'evidence-missing');
  assert.equal((await step('teleport', 'worker')).reason, 'unknown-event');
  assert.equal((await state()).state, 'in_progress');
  assert.equal(remote.writes.length, writes);
  assert.equal((await advance({ reader: remote.reader, writer: remote.writer, store: createMemoryLinkStore(), repo: REPO, issueNumber: 7, event: 'start', role: 'worker', sessionId: PRIVATE.sessionId })).reason, 'no-link');
});

test('a new head after a pass sends the record back to review', async () => {
  const { step, state } = await setup();
  await step('start', 'worker');
  await step('open_pr', 'worker', { evidence: { prNumber: 9, headSha: A } });
  await step('request_review', 'worker');
  await step('pm_pass', 'pm', { evidence: { headSha: A, approval: { status: 'approved', headSha: A } } });
  assert.equal((await state()).state, 'pm_passed');
  const moved = await step('head_changed', 'system', { evidence: { headSha: B } });
  assert.deepEqual([moved.ok, moved.state], [true, 'review_pending']);
  assert.deepEqual([(await state()).headSha, (await state()).reviewKind], [B, null]);
  assert.equal((await step('mark_ready_to_merge', 'system', { evidence: GOOD(B) })).reason, 'illegal-transition', 'it has to be reviewed again first');
});

test('arguments are checked: a missing store, writer or reader is a programming error', async () => {
  const { remote, store } = await setup();
  const base = { reader: remote.reader, writer: remote.writer, store, repo: REPO, issueNumber: 7, event: 'start', role: 'worker', sessionId: PRIVATE.sessionId };
  for (const change of [{ store: null }, { store: {} }, { writer: null }, { writer: {} }, { reader: null }, { reader: {} }, { labels: { claimed: 'Not Plain' } }]) {
    await assert.rejects(() => advance({ ...base, ...change }), TypeError, JSON.stringify(Object.keys(change)));
  }
});
