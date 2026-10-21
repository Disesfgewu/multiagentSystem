'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DispatchStore, MAX_RECORDS } = require('../../src/dispatch/store');

const memory = (initial = []) => {
  const map = new Map(initial.map((value) => [value.id, value]));
  return {
    list: () => ({ ok: true, items: [...map.values()].map((value) => ({ value })) }),
    transact: (work) => ({ ok: true, value: work({ get: (_c, id) => map.get(id) ?? null, put: (_c, id, value) => map.set(id, value), list: () => [...map.entries()].map(([id, value]) => ({ id, value })), delete: (_c, id) => map.delete(id) }) }),
    size: () => map.size
  };
};
const record = (over = {}) => ({ id: 'd-1', kind: 'issue', issueNumber: 1, at: '2026-10-21T10:00:00.000Z', results: [], ...over });

test('a dispatch is saved once and never overwritten; a malformed one writes nothing', () => {
  const store = new DispatchStore(memory());
  assert.equal(store.record(record()).ok, true);
  assert.deepEqual(store.record(record()), { ok: false, reason: 'duplicate-id' });
  assert.equal(store.record(record({ id: 'd-2', kind: 'nope' })).reason, 'invalid-dispatch');
  assert.equal(store.list().items.length, 1);
});

test('a stored record that no longer validates is an error, not a shorter list', () => {
  assert.deepEqual(new DispatchStore(memory([record({ kind: 'nope' })])).list(), { ok: false, reason: 'invalid-dispatch-record' });
  assert.throws(() => new DispatchStore(null), /private-store-required/);
  assert.equal(new DispatchStore({ list: () => ({ ok: false, reason: 'storage-unavailable' }), transact: () => ({}) }).list().reason, 'storage-unavailable');
});

test('the log keeps the newest records only, and the one just written is always kept', () => {
  const backing = memory();
  const store = new DispatchStore(backing);
  const at = (index) => new Date(Date.UTC(2026, 9, 21, 0, 0, index)).toISOString();
  for (let index = 0; index < MAX_RECORDS + 5; index += 1) assert.equal(store.record(record({ id: `d-${index}`, at: at(index) })).ok, true);
  assert.equal(backing.size(), MAX_RECORDS);
  const ids = new Set(store.list().items.map((item) => item.id));
  assert.equal(ids.has('d-0'), false);
  assert.equal(ids.has('d-4'), false);
  assert.equal(ids.has('d-5'), true);
  assert.equal(ids.has(`d-${MAX_RECORDS + 4}`), true);
  // A record older than all the others is still kept when it is the one just written.
  assert.equal(store.record(record({ id: 'd-old', at: at(-10) })).ok, true);
  assert.equal(new Set(store.list().items.map((item) => item.id)).has('d-old'), true);
});
