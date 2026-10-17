'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PrivateStore } = require('../../src/storage/private-store');
const { BroadcastStore } = require('../../src/broadcast/store');
const { sandbox, COLLECTIONS } = require('../storage/helpers');

const broadcast = (over = {}) => ({
  id: 'bc-1', version: 1, target: { scope: 'all' }, text: 'Stop non-M1 work.',
  createdAt: '2026-10-17T12:00:00.000Z', expiresAt: null, revokedAt: null, ...over
});

function setup(t) {
  const box = sandbox(t);
  const privateStore = () => new PrivateStore({ dir: box.dir, repoRoot: box.repoRoot, collections: [...COLLECTIONS, 'broadcasts'] });
  const broadcasts = () => new BroadcastStore(privateStore());
  return { privateStore, broadcasts };
}

test('a store requires a real PrivateStore-shaped object', () => {
  for (const bad of [undefined, null, {}, { get: () => {} }, { get: () => {}, list: () => {} }]) {
    assert.throws(() => new BroadcastStore(bad), TypeError);
  }
});

test('a broadcast is created, read back exactly, and listed; creating the same id twice is refused', (t) => {
  const s = setup(t);
  const created = s.broadcasts().create(broadcast());
  assert.equal(created.ok, true);
  assert.deepEqual(created.broadcast.target, { scope: 'all' });
  const read = s.broadcasts().get('bc-1');
  assert.equal(read.ok, true);
  assert.deepEqual(read.broadcast, created.broadcast);
  assert.deepEqual(s.broadcasts().list().items.map((entry) => entry.id), ['bc-1']);
  assert.deepEqual(s.broadcasts().create(broadcast()), { ok: false, reason: 'duplicate-id' });
});

test('an invalid broadcast is refused before anything is written, with its problems', (t) => {
  const s = setup(t);
  const result = s.broadcasts().create(broadcast({ target: { scope: 'nowhere' } }));
  assert.deepEqual(result, { ok: false, reason: 'invalid-broadcast', problems: ['invalid-target'] });
  assert.deepEqual(s.broadcasts().list().items, []);
});

test('text that fails the publish content scan is refused, and nothing is written', (t) => {
  const s = setup(t);
  const result = s.broadcasts().create(broadcast({ text: 'My key is sk-ant-' + 'a'.repeat(40) }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'content-scan-rejected');
  assert.equal(result.scan.status, 'blocked');
  assert.deepEqual(s.broadcasts().list().items, []);
});

test('revoking sets revokedAt; revoking again, or a not-found id, changes nothing further', (t) => {
  const s = setup(t);
  s.broadcasts().create(broadcast());
  const revoked = s.broadcasts().revoke('bc-1', '2026-10-17T13:00:00.000Z');
  assert.equal(revoked.ok, true);
  assert.equal(revoked.broadcast.revokedAt, '2026-10-17T13:00:00.000Z');
  const again = s.broadcasts().revoke('bc-1', '2026-10-17T14:00:00.000Z');
  assert.equal(again.ok, true);
  assert.equal(again.broadcast.revokedAt, '2026-10-17T13:00:00.000Z', 'the first revocation stands');
  assert.deepEqual(s.broadcasts().revoke('missing', '2026-10-17T13:00:00.000Z'), { ok: false, reason: 'broadcast-not-found' });
});

test('a record that no longer validates on read is an error, never treated as missing or skipped in a list', (t) => {
  const s = setup(t);
  const store = s.privateStore();
  store.put('broadcasts', 'broken', { id: 'broken', version: 1, target: { scope: 'all' } });
  assert.deepEqual(new BroadcastStore(store).get('broken'), { ok: false, reason: 'invalid-broadcast-record' });
  assert.deepEqual(new BroadcastStore(store).list(), { ok: false, reason: 'invalid-broadcast-record' });
});

test('a storage failure (unreadable store) is reported as unavailable, not as empty or not-found', () => {
  const broken = { get: () => ({ ok: false, reason: 'store-unavailable' }), list: () => ({ ok: false, reason: 'store-unavailable' }), transact: () => ({ ok: false, reason: 'store-unavailable' }) };
  const broadcasts = new BroadcastStore(broken);
  assert.deepEqual(broadcasts.list(), { ok: false, reason: 'store-unavailable' });
  assert.deepEqual(broadcasts.get('bc-1'), { ok: false, reason: 'store-unavailable' });
  assert.deepEqual(broadcasts.create({}), { ok: false, reason: 'invalid-broadcast', problems: ['invalid-id', 'invalid-version', 'invalid-target', 'invalid-text', 'invalid-created-at'] });
  assert.deepEqual(broadcasts.create(broadcast()), { ok: false, reason: 'store-unavailable' }, 'a valid broadcast still fails closed when the transaction itself cannot run');
  assert.deepEqual(broadcasts.revoke('bc-1', '2026-10-17T13:00:00.000Z'), { ok: false, reason: 'store-unavailable' });
});
