'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PrivateStore } = require('../../src/storage/private-store');
const { observe } = require('../../src/accounts/observation');
const { savePolicy, loadPolicy } = require('../../src/accounts/quota-policy');
const { runningSlots, recoverOrphanedSlots, reserveSlot, renewSlot, releaseSlot } = require('../../src/accounts/quota-reservations');
const { sandbox, COLLECTIONS } = require('../storage/helpers');

const COLLECTION_NAMES = [...COLLECTIONS, 'quotaReservations'];
const ACCOUNT = 'acct-shared';
const NOW = new Date('2026-10-18T12:00:00.000Z');
const FIRST = ['11111111', '1111', '4111', '8111', '111111111111'].join('-');
const SECOND = ['22222222', '2222', '4222', '8222', '222222222222'].join('-');
const THIRD_ID = ['33333333', '3333', '4333', '8333', '333333333333'].join('-');
const readingAt = (at = NOW) => observe('quota.window.used_percent', 10, {
  unit: 'percent', scope: 'account', source: 'synthetic',
  observedAt: new Date(at.getTime() - 1_000), validForMs: 60_000
});
const reading = () => readingAt(NOW);

function stores(t) {
  const box = sandbox(t);
  const options = { dir: box.dir, repoRoot: box.repoRoot, collections: COLLECTION_NAMES };
  return [new PrivateStore(options), new PrivateStore(options)];
}

test('two independent store instances cannot both take the last shared slot', (t) => {
  const [firstWindow, secondWindow] = stores(t);
  assert.equal(savePolicy(firstWindow, ACCOUNT, { maxConcurrent: 1, unknownQuota: 'block' }).ok, true);
  const expected = loadPolicy(firstWindow, ACCOUNT);
  const first = reserveSlot({ store: firstWindow, accountKey: ACCOUNT, expectedPolicyRead: expected, observations: [reading()], now: NOW, leaseId: FIRST });
  const second = reserveSlot({ store: secondWindow, accountKey: ACCOUNT, expectedPolicyRead: expected, observations: [reading()], now: NOW, leaseId: SECOND });
  assert.deepEqual([first.ok, first.decision.allowed], [true, true]);
  assert.deepEqual([second.ok, second.decision.allowed], [true, false]);
  assert.equal(second.decision.reasons[0].code, 'concurrency-limit');
  assert.deepEqual(runningSlots(secondWindow, ACCOUNT, NOW), { ok: true, running: 1, orphaned: 0 });
});

test('release is idempotent and immediately frees the slot for another window', (t) => {
  const [firstWindow, secondWindow] = stores(t);
  assert.equal(savePolicy(firstWindow, ACCOUNT, { maxConcurrent: 1, unknownQuota: 'block' }).ok, true);
  const expected = loadPolicy(firstWindow, ACCOUNT);
  const first = reserveSlot({ store: firstWindow, accountKey: ACCOUNT, expectedPolicyRead: expected, observations: [reading()], now: NOW, leaseId: FIRST });
  assert.deepEqual(releaseSlot(secondWindow, first.decision.reservation, NOW), { ok: true, released: true });
  assert.deepEqual(releaseSlot(firstWindow, first.decision.reservation, NOW), { ok: true, released: false });
  const second = reserveSlot({ store: secondWindow, accountKey: ACCOUNT, expectedPolicyRead: expected, observations: [reading()], now: NOW, leaseId: SECOND });
  assert.equal(second.decision.allowed, true);
});

const ALIVE = { isOwnerAlive: () => true };
const GONE = { isOwnerAlive: () => false };
const policyFor = (t, extra = {}) => {
  const [firstWindow, secondWindow] = stores(t);
  assert.equal(savePolicy(firstWindow, ACCOUNT, { maxConcurrent: 1, unknownQuota: 'block', ...extra }).ok, true);
  return { firstWindow, secondWindow, expected: loadPolicy(firstWindow, ACCOUNT) };
};
const take = (store, expected, leaseId, extra = {}) => reserveSlot({ store, accountKey: ACCOUNT, expectedPolicyRead: expected, observations: [readingAt(extra.now ?? NOW)], leaseId, ...extra });

test('a lease whose owner process is gone keeps its slot: that window\'s agents may still be running, so nothing is released by time or by the owner vanishing', (t) => {
  const { firstWindow, secondWindow, expected } = policyFor(t);
  const first = take(firstWindow, expected, FIRST, { now: NOW, leaseMs: 60_000, ownerPid: 4242, ownerHost: 'host-a', isOwnerAlive: () => true });
  assert.equal(first.decision.allowed, true);
  const gone = { ownerHost: 'host-a', isOwnerAlive: () => false };
  const later = new Date(NOW.getTime() + 60 * 60_000);
  assert.deepEqual(runningSlots(secondWindow, ACCOUNT, new Date(NOW.getTime() + 1_000), gone), { ok: true, running: 1, orphaned: 1 }, 'counted, and reported as orphaned');
  assert.deepEqual(runningSlots(secondWindow, ACCOUNT, later, gone), { ok: true, running: 1, orphaned: 1 }, 'an hour later too');
  const blocked = take(secondWindow, expected, SECOND, { now: later, ownerPid: 5252, ownerHost: 'host-a', isOwnerAlive: (pid) => pid !== 4242 });
  assert.deepEqual([blocked.decision.allowed, blocked.decision.reasons[0].code], [false, 'concurrency-limit']);
});

test('an orphaned slot is freed only by a confirmed recovery, and only for owners confirmed gone', (t) => {
  const { firstWindow, secondWindow, expected } = policyFor(t, { maxConcurrent: 2 });
  take(firstWindow, expected, FIRST, { now: NOW, ownerPid: 4242, ownerHost: 'host-a', ...ALIVE });
  take(firstWindow, expected, SECOND, { now: NOW, ownerPid: 5252, ownerHost: 'host-a', ...ALIVE });
  const only4242Gone = { ownerHost: 'host-a', isOwnerAlive: (pid) => pid !== 4242 };
  assert.deepEqual(recoverOrphanedSlots(secondWindow, ACCOUNT, NOW, { ownerHost: 'host-a', ...ALIVE }), { ok: true, recovered: 0 }, 'nothing is orphaned while owners run');
  assert.deepEqual(recoverOrphanedSlots(secondWindow, ACCOUNT, NOW, { ownerHost: 'host-a', isOwnerAlive: () => { throw new Error('cannot tell'); } }), { ok: true, recovered: 0 }, 'an uncertain check recovers nothing');
  assert.deepEqual(recoverOrphanedSlots(secondWindow, ACCOUNT, NOW, only4242Gone), { ok: true, recovered: 1 });
  assert.deepEqual(runningSlots(secondWindow, ACCOUNT, NOW, { ownerHost: 'host-a', ...ALIVE }), { ok: true, running: 1, orphaned: 0 }, 'the live owner\'s slot is untouched');
  const foreign = { id: THIRD_ID, expiresAt: new Date(NOW.getTime() + 60_000).toISOString(), ownerPid: 4242, ownerHost: 'another-computer' };
  assert.equal(firstWindow.put('quotaReservations', `slots-${ACCOUNT}`, { schemaVersion: 1, leases: [foreign] }).ok, true);
  assert.deepEqual(recoverOrphanedSlots(secondWindow, ACCOUNT, NOW, { ownerHost: 'host-a', isOwnerAlive: () => false }), { ok: true, recovered: 0 }, 'another computer\'s lease cannot be judged here');
});

test('a window that was suspended or blocked past its lease still holds its slot while its process is running, so a second window cannot exceed the limit', (t) => {
  const { firstWindow, secondWindow, expected } = policyFor(t);
  const first = take(firstWindow, expected, FIRST, { now: NOW, leaseMs: 2_000, ownerPid: 4242, ownerHost: 'host-a', ...ALIVE });
  assert.equal(first.decision.allowed, true);
  // The machine sleeps for an hour: the lease is long expired, but its owner process is still there.
  const later = new Date(NOW.getTime() + 60 * 60_000);
  assert.deepEqual(runningSlots(secondWindow, ACCOUNT, later, { ownerHost: 'host-a', ...ALIVE }), { ok: true, running: 1, orphaned: 0 });
  const second = take(secondWindow, expected, SECOND, { now: later, ownerPid: 5252, ownerHost: 'host-a', ...ALIVE });
  assert.deepEqual([second.ok, second.decision.allowed, second.decision.reasons[0].code], [true, false, 'concurrency-limit'], 'the limit holds');
  // When the first window wakes up its heartbeat revives the very same lease.
  assert.deepEqual(renewSlot(firstWindow, first.decision.reservation, later, 2_000, { ownerPid: 4242, ownerHost: 'host-a', ...ALIVE }), { ok: true, renewed: true });
  assert.equal(runningSlots(secondWindow, ACCOUNT, later, { ownerHost: 'host-a', ...ALIVE }).running, 1);
});

test('a second window gets the slot only after the first is released or a confirmed recovery', (t) => {
  const { firstWindow, secondWindow, expected } = policyFor(t);
  take(firstWindow, expected, FIRST, { now: NOW, leaseMs: 2_000, ownerPid: 4242, ownerHost: 'host-a', ...ALIVE });
  const later = new Date(NOW.getTime() + 60 * 60_000);
  assert.equal(take(secondWindow, expected, SECOND, { now: later, ownerPid: 5252, ownerHost: 'host-a', ...ALIVE }).decision.allowed, false);
  const gone = { ownerHost: 'host-a', isOwnerAlive: (pid) => pid !== 4242 };
  assert.equal(take(secondWindow, expected, SECOND, { now: later, ownerPid: 5252, ownerHost: 'host-a', isOwnerAlive: gone.isOwnerAlive }).decision.allowed, false, 'the first process is gone, but that alone frees nothing');
  assert.equal(recoverOrphanedSlots(secondWindow, ACCOUNT, later, gone).recovered, 1, 'confirmed recovery');
  assert.equal(take(secondWindow, expected, SECOND, { now: later, ownerPid: 5252, ownerHost: 'host-a', isOwnerAlive: gone.isOwnerAlive }).decision.allowed, true);
  assert.equal(runningSlots(firstWindow, ACCOUNT, later, gone).running, 1);
});

test('a lease lost from the record while its owner is running can be re-registered, so a running agent is counted again instead of hidden', (t) => {
  const { firstWindow, secondWindow, expected } = policyFor(t);
  const first = take(firstWindow, expected, FIRST, { now: NOW, ownerPid: 4242, ownerHost: 'host-a', ...ALIVE });
  assert.equal(firstWindow.delete('quotaReservations', `slots-${ACCOUNT}`).ok, true);
  assert.deepEqual(renewSlot(firstWindow, first.decision.reservation, NOW, 60_000, { ownerPid: 4242, ownerHost: 'host-a', ...ALIVE }), { ok: true, renewed: false });
  assert.deepEqual(renewSlot(firstWindow, first.decision.reservation, NOW, 60_000, { ownerPid: 4242, ownerHost: 'host-a', ...ALIVE, reacquire: true }), { ok: true, renewed: true, reacquired: true });
  assert.equal(runningSlots(secondWindow, ACCOUNT, NOW, { ownerHost: 'host-a', ...ALIVE }).running, 1);
  assert.equal(take(secondWindow, expected, SECOND, { now: NOW, ownerPid: 5252, ownerHost: 'host-a', ...ALIVE }).decision.allowed, false, 'new launches are blocked again');
});

test('a lease that cannot be judged here (no owner, another or renamed host, or a failing liveness check) is never dropped by time: it keeps blocking until a confirmed recovery', (t) => {
  const { firstWindow, secondWindow, expected } = policyFor(t);
  const lease = { id: FIRST, expiresAt: new Date(NOW.getTime() + 60_000).toISOString() };
  const later = new Date(NOW.getTime() + 120_000);
  const here = { ownerHost: 'this-computer', ...ALIVE };
  // Every reading starts from a freshly written record.
  const put = (leases) => assert.equal(firstWindow.put('quotaReservations', `slots-${ACCOUNT}`, { schemaVersion: 1, leases }).ok, true);
  const cases = {
    'no owner recorded': lease,
    'another or renamed computer': { ...lease, ownerPid: 4242, ownerHost: 'another-computer' }
  };
  for (const [name, entry] of Object.entries(cases)) {
    put([entry]);
    assert.deepEqual(runningSlots(secondWindow, ACCOUNT, NOW, here), { ok: true, running: 1, orphaned: 0 }, `${name}: counted, and not yet recoverable while unexpired`);
    assert.deepEqual(runningSlots(secondWindow, ACCOUNT, later, here), { ok: true, running: 1, orphaned: 1 }, `${name}: expired, still counted, offered for recovery`);
    assert.equal(take(secondWindow, expected, SECOND, { now: later, ownerPid: 5252, ownerHost: 'this-computer', ...ALIVE }).decision.allowed, false, `${name}: still blocks a new launch`);
    assert.deepEqual(recoverOrphanedSlots(secondWindow, ACCOUNT, NOW, here), { ok: true, recovered: 0 }, `${name}: an unexpired one is not recoverable`);
    assert.deepEqual(recoverOrphanedSlots(secondWindow, ACCOUNT, later, here), { ok: true, recovered: 1 }, `${name}: freed only by the confirmed recovery`);
    assert.equal(runningSlots(secondWindow, ACCOUNT, later, here).running, 0);
  }
  put([{ ...lease, ownerPid: 4242, ownerHost: 'this-computer' }]);
  const throwing = { ownerHost: 'this-computer', isOwnerAlive: () => { throw new Error('cannot tell'); } };
  assert.deepEqual(runningSlots(secondWindow, ACCOUNT, later, throwing), { ok: true, running: 1, orphaned: 0 }, 'a failed liveness check counts the slot and offers nothing');
  assert.deepEqual(recoverOrphanedSlots(secondWindow, ACCOUNT, later, throwing), { ok: true, recovered: 0 });
});

test('a renamed computer: a live process\'s lease recorded under the old host name still counts, with no liveness stub', (t) => {
  const { firstWindow, secondWindow, expected } = policyFor(t);
  const expired = new Date(Date.now() - 1_000).toISOString();
  assert.equal(firstWindow.put('quotaReservations', `slots-${ACCOUNT}`, { schemaVersion: 1, leases: [{ id: FIRST, expiresAt: expired, ownerPid: process.pid, ownerHost: 'the-old-host-name' }] }).ok, true);
  assert.deepEqual(runningSlots(secondWindow, ACCOUNT, new Date()), { ok: true, running: 1, orphaned: 1 });
  const blocked = take(secondWindow, expected, SECOND, { now: new Date() });
  assert.deepEqual([blocked.ok, blocked.decision.allowed], [true, false]);
  // The live owner's next heartbeat re-registers it under the current host name, so it is judged normally again.
  assert.deepEqual(renewSlot(firstWindow, { accountKey: ACCOUNT, id: FIRST }, new Date(), 60_000), { ok: true, renewed: true });
  assert.deepEqual(runningSlots(secondWindow, ACCOUNT, new Date()), { ok: true, running: 1, orphaned: 0 });
});

test('the default liveness check uses the operating system, and a finished owner never releases a slot that a still-running agent process depends on', (t) => {
  const { spawn, spawnSync } = require('node:child_process');
  const os = require('node:os');
  const finished = spawnSync(process.execPath, ['-e', '0']);
  assert.equal(finished.status, 0);
  // The "agent": a separate process that keeps running after its owner (the window) exited.
  const agent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => agent.kill());
  const [store] = stores(t);
  const lease = (id, pid) => ({ id, expiresAt: new Date(NOW.getTime() - 60_000).toISOString(), ownerPid: pid, ownerHost: os.hostname() });
  assert.equal(store.put('quotaReservations', `slots-${ACCOUNT}`, { schemaVersion: 1, leases: [lease(FIRST, process.pid), lease(SECOND, finished.pid)] }).ok, true);
  assert.deepEqual(runningSlots(store, ACCOUNT, NOW), { ok: true, running: 2, orphaned: 1 }, 'both still count; the vanished owner is only reported');
  assert.equal(process.kill(agent.pid, 0), true, 'the agent process is still running');
  assert.deepEqual(recoverOrphanedSlots(store, ACCOUNT, NOW), { ok: true, recovered: 1 }, 'only the confirmed-gone owner is recovered');
  assert.deepEqual(runningSlots(store, ACCOUNT, NOW), { ok: true, running: 1, orphaned: 0 });
});

test('owner fields are validated: a half-written or malformed owner makes the whole record invalid and nothing is overwritten', (t) => {
  const { firstWindow, secondWindow } = policyFor(t);
  const lease = { id: FIRST, expiresAt: new Date(NOW.getTime() + 60_000).toISOString() };
  for (const bad of [{ ownerPid: 4242 }, { ownerHost: 'h' }, { ownerPid: 0, ownerHost: 'h' }, { ownerPid: 1.5, ownerHost: 'h' }, { ownerPid: '4242', ownerHost: 'h' }, { ownerPid: 4242, ownerHost: '' }, { ownerPid: 4242, ownerHost: 'a\nb' }, { ownerPid: 4242, ownerHost: 'x'.repeat(256) }]) {
    assert.equal(firstWindow.put('quotaReservations', `slots-${ACCOUNT}`, { schemaVersion: 1, leases: [{ ...lease, ...bad }] }).ok, true);
    assert.deepEqual(runningSlots(secondWindow, ACCOUNT, NOW), { ok: false, reason: 'reservation-record-invalid' }, JSON.stringify(bad));
    assert.equal(firstWindow.get('quotaReservations', `slots-${ACCOUNT}`).value.leases.length, 1);
  }
});

test('two real processes racing for the last slot: exactly one gets it, while both are still running', async (t) => {
  const { spawn } = require('node:child_process');
  const box = sandbox(t);
  const options = { dir: box.dir, repoRoot: box.repoRoot, collections: COLLECTION_NAMES };
  const first = new PrivateStore(options);
  assert.equal(savePolicy(first, ACCOUNT, { maxConcurrent: 1, unknownQuota: 'block' }).ok, true);
  // Each child answers and then stays alive until told to stop: a finished process no longer holds its
  // slot, so both must be running for the race to mean anything.
  const child = `
    const { PrivateStore } = require(${JSON.stringify(require.resolve('../../src/storage/private-store'))});
    const { reserveSlot } = require(${JSON.stringify(require.resolve('../../src/accounts/quota-reservations'))});
    const { loadPolicy } = require(${JSON.stringify(require.resolve('../../src/accounts/quota-policy'))});
    const { observe } = require(${JSON.stringify(require.resolve('../../src/accounts/observation'))});
    const store = new PrivateStore(JSON.parse(process.argv[1]));
    const now = new Date(process.argv[3]);
    const result = reserveSlot({ store, accountKey: ${JSON.stringify(ACCOUNT)}, expectedPolicyRead: loadPolicy(store, ${JSON.stringify(ACCOUNT)}),
      observations: [observe('quota.window.used_percent', 10, { unit: 'percent', scope: 'account', source: 'synthetic', observedAt: new Date(now.getTime() - 1000), validForMs: 60000 })],
      now, leaseId: process.argv[2] });
    process.stdout.write(JSON.stringify({ ok: result.ok, allowed: result.decision && result.decision.allowed, reason: result.reason }) + '\\n');
    process.stdin.resume(); process.stdin.on('end', () => process.exit(0));
  `;
  const start = (id) => {
    const proc = spawn(process.execPath, ['-e', child, JSON.stringify(options), id, NOW.toISOString()]);
    const answer = new Promise((resolve, reject) => {
      let out = ''; let err = '';
      proc.stdout.on('data', (chunk) => { out += chunk; if (out.includes('\n')) resolve(JSON.parse(out.trim())); });
      proc.stderr.on('data', (chunk) => { err += chunk; });
      proc.on('close', (code) => { if (!out.includes('\n')) reject(new Error(`child exited ${code}: ${err}`)); });
    });
    return { proc, answer };
  };
  const children = [start(FIRST), start(SECOND)];
  t.after(() => { for (const { proc } of children) proc.kill(); });
  const results = await Promise.all(children.map(({ answer }) => answer));
  for (const { proc } of children) proc.stdin.end();
  const winners = results.filter((result) => result.ok && result.allowed);
  assert.equal(winners.length, 1, JSON.stringify(results));
});

test('linked account keys share concurrency limits: a lease on profile A blocks launch on duplicate profile B, and releasing on A frees capacity for B', (t) => {
  const [firstWindow, secondWindow] = stores(t);
  const ACCT_A = 'prof-dup-a';
  const ACCT_B = 'prof-dup-b';
  assert.equal(savePolicy(firstWindow, ACCT_A, { maxConcurrent: 1, unknownQuota: 'block' }).ok, true);
  assert.equal(savePolicy(firstWindow, ACCT_B, { maxConcurrent: 1, unknownQuota: 'block' }).ok, true);
  const expectedA = loadPolicy(firstWindow, ACCT_A);
  const expectedB = loadPolicy(firstWindow, ACCT_B);

  // Take a slot on Profile A, linked to Profile B
  const first = reserveSlot({
    store: firstWindow,
    accountKey: ACCT_A,
    linkedAccountKeys: [ACCT_B],
    expectedPolicyRead: expectedA,
    observations: [reading()],
    now: NOW,
    leaseId: FIRST
  });
  assert.deepEqual([first.ok, first.decision.allowed], [true, true]);

  // Running count on Profile B (linked to Profile A) shows 1 running
  assert.deepEqual(runningSlots(secondWindow, ACCT_B, NOW, { linkedAccountKeys: [ACCT_A] }), { ok: true, running: 1, orphaned: 0 });

  // Attempt to take a slot on Profile B: blocked by shared concurrency limit!
  const second = reserveSlot({
    store: secondWindow,
    accountKey: ACCT_B,
    linkedAccountKeys: [ACCT_A],
    expectedPolicyRead: expectedB,
    observations: [reading()],
    now: NOW,
    leaseId: SECOND
  });
  assert.deepEqual([second.ok, second.decision.allowed, second.decision.reasons[0].code], [true, false, 'concurrency-limit']);

  // Unlinked Profile C is independent and not blocked
  const ACCT_C = 'prof-independent';
  assert.equal(savePolicy(firstWindow, ACCT_C, { maxConcurrent: 1, unknownQuota: 'block' }).ok, true);
  const third = reserveSlot({
    store: secondWindow,
    accountKey: ACCT_C,
    linkedAccountKeys: [],
    expectedPolicyRead: loadPolicy(secondWindow, ACCT_C),
    observations: [reading()],
    now: NOW,
    leaseId: THIRD_ID
  });
  assert.deepEqual([third.ok, third.decision.allowed], [true, true]);

  // Release on Profile A
  assert.deepEqual(releaseSlot(firstWindow, first.decision.reservation, NOW), { ok: true, released: true });

  // Running count on Profile B is now 0
  assert.deepEqual(runningSlots(secondWindow, ACCT_B, NOW, { linkedAccountKeys: [ACCT_A] }), { ok: true, running: 0, orphaned: 0 });

  // Now Profile B can successfully take its slot
  const retryB = reserveSlot({
    store: secondWindow,
    accountKey: ACCT_B,
    linkedAccountKeys: [ACCT_A],
    expectedPolicyRead: expectedB,
    observations: [reading()],
    now: NOW,
    leaseId: SECOND
  });
  assert.deepEqual([retryB.ok, retryB.decision.allowed], [true, true]);

  // Now Profile A is blocked by Profile B's running lease
  const retryA = reserveSlot({
    store: firstWindow,
    accountKey: ACCT_A,
    linkedAccountKeys: [ACCT_B],
    expectedPolicyRead: expectedA,
    observations: [reading()],
    now: NOW,
    leaseId: FIRST
  });
  assert.deepEqual([retryA.ok, retryA.decision.allowed, retryA.decision.reasons[0].code], [true, false, 'concurrency-limit']);
});

test('invalid linkedAccountKeys fail closed with reservation-input-invalid', (t) => {
  const [store] = stores(t);
  assert.deepEqual(runningSlots(store, 'prof-a', NOW, { linkedAccountKeys: ['bad/key'] }), { ok: false, reason: 'reservation-input-invalid' });
  assert.deepEqual(reserveSlot({
    store,
    accountKey: 'prof-a',
    linkedAccountKeys: [null],
    expectedPolicyRead: { ok: true, stored: false },
    now: NOW
  }), { ok: false, reason: 'reservation-input-invalid' });
});
