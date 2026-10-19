'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PrivateStore } = require('../../src/storage/private-store');
const { observe } = require('../../src/accounts/observation');
const { savePolicy, loadPolicy } = require('../../src/accounts/quota-policy');
const { runningSlots, reserveSlot, renewSlot, releaseSlot } = require('../../src/accounts/quota-reservations');
const { sandbox, COLLECTIONS } = require('../storage/helpers');

const COLLECTION_NAMES = [...COLLECTIONS, 'quotaReservations'];
const ACCOUNT = 'acct-shared';
const NOW = new Date('2026-10-18T12:00:00.000Z');
const FIRST = ['11111111', '1111', '4111', '8111', '111111111111'].join('-');
const SECOND = ['22222222', '2222', '4222', '8222', '222222222222'].join('-');
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
  assert.deepEqual(runningSlots(secondWindow, ACCOUNT, NOW), { ok: true, running: 1 });
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

test('a lease whose owner process is gone is reclaimed at once, expired or not: that window\'s agents are no longer tracked by anyone', (t) => {
  const { firstWindow, secondWindow, expected } = policyFor(t);
  const first = take(firstWindow, expected, FIRST, { now: NOW, leaseMs: 60_000, ownerPid: 4242, ownerHost: 'host-a', isOwnerAlive: () => true });
  assert.equal(first.decision.allowed, true);
  assert.equal(runningSlots(secondWindow, ACCOUNT, new Date(NOW.getTime() + 1_000), { ownerHost: 'host-a', isOwnerAlive: () => true }).running, 1);
  assert.deepEqual(runningSlots(secondWindow, ACCOUNT, new Date(NOW.getTime() + 1_000), { ownerHost: 'host-a', isOwnerAlive: () => false }), { ok: true, running: 0 }, 'the window closed or crashed');
  assert.deepEqual(renewSlot(firstWindow, first.decision.reservation, new Date(NOW.getTime() + 2_000), 60_000, { ownerHost: 'host-a', ...GONE }), { ok: true, renewed: false }, 'a reclaimed lease is not revived by default');
});

test('a window that was suspended or blocked past its lease still holds its slot while its process is running, so a second window cannot exceed the limit', (t) => {
  const { firstWindow, secondWindow, expected } = policyFor(t);
  const first = take(firstWindow, expected, FIRST, { now: NOW, leaseMs: 2_000, ownerPid: 4242, ownerHost: 'host-a', ...ALIVE });
  assert.equal(first.decision.allowed, true);
  // The machine sleeps for an hour: the lease is long expired, but its owner process is still there.
  const later = new Date(NOW.getTime() + 60 * 60_000);
  assert.deepEqual(runningSlots(secondWindow, ACCOUNT, later, { ownerHost: 'host-a', ...ALIVE }), { ok: true, running: 1 });
  const second = take(secondWindow, expected, SECOND, { now: later, ownerPid: 5252, ownerHost: 'host-a', ...ALIVE });
  assert.deepEqual([second.ok, second.decision.allowed, second.decision.reasons[0].code], [true, false, 'concurrency-limit'], 'the limit holds');
  // When the first window wakes up its heartbeat revives the very same lease.
  assert.deepEqual(renewSlot(firstWindow, first.decision.reservation, later, 2_000, { ownerPid: 4242, ownerHost: 'host-a', ...ALIVE }), { ok: true, renewed: true });
  assert.equal(runningSlots(secondWindow, ACCOUNT, later, { ownerHost: 'host-a', ...ALIVE }).running, 1);
});

test('only once the first owner is really gone can the second window take the slot, and a genuinely ended agent frees it for good', (t) => {
  const { firstWindow, secondWindow, expected } = policyFor(t);
  take(firstWindow, expected, FIRST, { now: NOW, leaseMs: 2_000, ownerPid: 4242, ownerHost: 'host-a', ...ALIVE });
  const later = new Date(NOW.getTime() + 60 * 60_000);
  assert.equal(take(secondWindow, expected, SECOND, { now: later, ownerPid: 5252, ownerHost: 'host-a', ...ALIVE }).decision.allowed, false);
  const afterExit = take(secondWindow, expected, SECOND, { now: later, ownerPid: 5252, ownerHost: 'host-a', isOwnerAlive: (pid) => pid !== 4242 });
  assert.equal(afterExit.decision.allowed, true, 'the first process is gone');
  assert.equal(runningSlots(firstWindow, ACCOUNT, later, { ownerHost: 'host-a', isOwnerAlive: (pid) => pid !== 4242 }).running, 1);
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

test('when the owner cannot be judged (an older record without an owner, another computer, or a liveness check that fails) the safe reading applies', (t) => {
  const { firstWindow, secondWindow } = policyFor(t);
  const lease = { id: FIRST, expiresAt: new Date(NOW.getTime() + 60_000).toISOString() };
  const later = new Date(NOW.getTime() + 120_000);
  // Reclaiming rewrites the record, so each reading starts from a freshly written one.
  const running = (leases, at, options) => {
    assert.equal(firstWindow.put('quotaReservations', `slots-${ACCOUNT}`, { schemaVersion: 1, leases }).ok, true);
    return runningSlots(secondWindow, ACCOUNT, at, options).running;
  };
  assert.equal(running([lease], NOW, GONE), 1, 'no owner recorded: the expiry decides, and it has not passed');
  assert.equal(running([lease], later, ALIVE), 0, 'no owner recorded and expired: reclaimed');
  const elsewhere = { ...lease, ownerPid: 4242, ownerHost: 'another-computer' };
  assert.equal(running([elsewhere], NOW, { ownerHost: 'this-computer', ...ALIVE }), 1, 'another computer\'s lease, not yet expired');
  assert.equal(running([elsewhere], later, { ownerHost: 'this-computer', ...ALIVE }), 0, 'another computer\'s process cannot be checked here: only the expiry applies');
  const local = { ...lease, ownerPid: 4242, ownerHost: 'this-computer' };
  const throwing = { ownerHost: 'this-computer', isOwnerAlive: () => { throw new Error('cannot tell'); } };
  assert.equal(running([local], later, throwing), 1, 'a failed liveness check counts the slot (assume busy)');
});

test('the default liveness check uses the operating system: this process is running, a finished child process is not', (t) => {
  const { spawnSync } = require('node:child_process');
  const os = require('node:os');
  const finished = spawnSync(process.execPath, ['-e', '0']);
  assert.equal(finished.status, 0);
  const [store] = stores(t);
  const lease = (id, pid) => ({ id, expiresAt: new Date(NOW.getTime() - 60_000).toISOString(), ownerPid: pid, ownerHost: os.hostname() });
  assert.equal(store.put('quotaReservations', `slots-${ACCOUNT}`, { schemaVersion: 1, leases: [lease(FIRST, process.pid), lease(SECOND, finished.pid)] }).ok, true);
  assert.deepEqual(runningSlots(store, ACCOUNT, NOW), { ok: true, running: 1 }, 'only the live process\'s lease still holds a slot');
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
