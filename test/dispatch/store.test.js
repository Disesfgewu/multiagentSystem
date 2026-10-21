'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DispatchStore } = require('../../src/dispatch/store');

const memory = (initial = []) => {
  const map = new Map(initial.map((value) => [value.id, value]));
  return {
    list: () => ({ ok: true, items: [...map.values()].map((value) => ({ value })) }),
    transact: (work) => ({ ok: true, value: work({ get: (_c, id) => map.get(id) ?? null, put: (_c, id, value) => map.set(id, value) }) })
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
