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
const reading = () => observe('quota.window.used_percent', 10, {
  unit: 'percent', scope: 'account', source: 'synthetic',
  observedAt: new Date(NOW.getTime() - 1_000), validForMs: 60_000
});

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

test('leases renew while owned and expire after an abandoned Extension Host', (t) => {
  const [firstWindow, secondWindow] = stores(t);
  assert.equal(savePolicy(firstWindow, ACCOUNT, { maxConcurrent: 1, unknownQuota: 'block' }).ok, true);
  const expected = loadPolicy(firstWindow, ACCOUNT);
  const first = reserveSlot({ store: firstWindow, accountKey: ACCOUNT, expectedPolicyRead: expected, observations: [reading()], now: NOW, leaseId: FIRST, leaseMs: 2_000 });
  assert.deepEqual(renewSlot(secondWindow, first.decision.reservation, new Date(NOW.getTime() + 1_000), 2_000), { ok: true, renewed: true });
  assert.equal(runningSlots(firstWindow, ACCOUNT, new Date(NOW.getTime() + 2_500)).running, 1);
  assert.deepEqual(runningSlots(secondWindow, ACCOUNT, new Date(NOW.getTime() + 3_000)), { ok: true, running: 0 });
  assert.deepEqual(renewSlot(firstWindow, first.decision.reservation, new Date(NOW.getTime() + 3_000), 2_000), { ok: true, renewed: false }, 'an expired lease is never revived');
});

test('malformed or unreadable shared state fails closed and is never replaced with an empty record', (t) => {
  const [firstWindow, secondWindow] = stores(t);
  assert.equal(savePolicy(firstWindow, ACCOUNT, { maxConcurrent: 1, unknownQuota: 'block' }).ok, true);
  assert.equal(firstWindow.put('quotaReservations', `slots-${ACCOUNT}`, { schemaVersion: 1, leases: [{ id: 'not-a-lease', expiresAt: NOW.toISOString() }] }).ok, true);
  const expected = loadPolicy(firstWindow, ACCOUNT);
  assert.deepEqual(runningSlots(secondWindow, ACCOUNT, NOW), { ok: false, reason: 'reservation-record-invalid' });
  assert.deepEqual(reserveSlot({ store: secondWindow, accountKey: ACCOUNT, expectedPolicyRead: expected, observations: [reading()], now: NOW, leaseId: SECOND }), { ok: false, reason: 'reservation-record-invalid' });
  assert.equal(firstWindow.get('quotaReservations', `slots-${ACCOUNT}`).value.leases[0].id, 'not-a-lease');

  const unavailable = { transact: () => ({ ok: false, reason: 'store-unavailable' }) };
  assert.deepEqual(runningSlots(unavailable, ACCOUNT, NOW), { ok: false, reason: 'store-unavailable' });
  assert.deepEqual(reserveSlot({ store: unavailable, accountKey: ACCOUNT, expectedPolicyRead: expected, observations: [reading()], now: NOW, leaseId: SECOND }), { ok: false, reason: 'store-unavailable' });
});

test('a policy changed by another window is detected inside the reservation transaction', (t) => {
  const [firstWindow, secondWindow] = stores(t);
  assert.equal(savePolicy(firstWindow, ACCOUNT, { maxConcurrent: 2, unknownQuota: 'block' }).ok, true);
  const stale = loadPolicy(firstWindow, ACCOUNT);
  assert.equal(savePolicy(secondWindow, ACCOUNT, { maxConcurrent: 1, unknownQuota: 'block' }).ok, true);
  assert.deepEqual(reserveSlot({ store: firstWindow, accountKey: ACCOUNT, expectedPolicyRead: stale, observations: [reading()], now: NOW, leaseId: FIRST }), { ok: false, reason: 'policy-changed' });
  assert.deepEqual(runningSlots(secondWindow, ACCOUNT, NOW), { ok: true, running: 0 });
});

test('an account with no policy is tracked across windows without adding a quota prompt', (t) => {
  const [firstWindow, secondWindow] = stores(t);
  const expected = loadPolicy(firstWindow, ACCOUNT);
  const result = reserveSlot({ store: firstWindow, accountKey: ACCOUNT, expectedPolicyRead: expected, now: NOW, leaseId: FIRST });
  assert.deepEqual([result.ok, result.decision.allowed, result.decision.approvedBy], [true, true, 'override']);
  assert.deepEqual(runningSlots(secondWindow, ACCOUNT, NOW), { ok: true, running: 1 });
});

test('the bounded record refuses another lease before writing an unreadable oversized record', (t) => {
  const [store] = stores(t);
  const expiresAt = new Date(NOW.getTime() + 60_000).toISOString();
  const leases = Array.from({ length: 64 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    expiresAt
  }));
  assert.equal(store.put('quotaReservations', `slots-${ACCOUNT}`, { schemaVersion: 1, leases }).ok, true);
  const result = reserveSlot({ store, accountKey: ACCOUNT, expectedPolicyRead: loadPolicy(store, ACCOUNT), now: NOW, leaseId: FIRST });
  assert.deepEqual(result, { ok: false, reason: 'reservation-capacity' });
  assert.deepEqual(runningSlots(store, ACCOUNT, NOW), { ok: true, running: 64 });
});
