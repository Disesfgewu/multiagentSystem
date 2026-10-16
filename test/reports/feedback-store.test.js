'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFeedback, saveFeedback, idFor } = require('../../src/reports/feedback-store');
const target = { repository: 'owner/repo', kind: 'pullRequest', number: 7 };
const head = 'a'.repeat(40);

function store() {
  const records = new Map();
  return {
    records,
    get: (_collection, id) => ({ ok: true, found: records.has(id), value: records.get(id) }),
    transact(work) {
      const tx = { get: (_collection, id) => records.get(id) ?? null, put: (_collection, id, value) => records.set(id, value) };
      return { ok: true, value: work(tx) };
    }
  };
}

test('local feedback survives a fresh reader, is head tagged and rejects a concurrent stale edit', () => {
  const privateStore = store();
  assert.deepEqual(readFeedback(privateStore, target), { state: 'missing' });
  const first = saveFeedback(privateStore, target, { note: 'Ask about the missing test', headSha: head }, null, new Date('2026-10-16T00:00:00Z'));
  assert.equal(first.ok, true);
  assert.equal(first.record.revision, 1);
  assert.equal(readFeedback(privateStore, target).record.note, 'Ask about the missing test');
  assert.equal(saveFeedback(privateStore, target, { note: 'Old editor', headSha: head }, null).reason, 'stale-feedback');
  assert.equal(saveFeedback(privateStore, target, { note: 'New editor', headSha: head }, 1).record.revision, 2);
  assert.equal(readFeedback(privateStore, target).record.note, 'New editor');
  assert.equal(JSON.stringify(privateStore.records).includes('token'), false);
});

test('read failure and damaged feedback are unknown, never an empty note or overwritten', () => {
  assert.equal(readFeedback({ get: () => ({ ok: false }) }, target).state, 'unknown');
  const privateStore = store();
  privateStore.records.set(idFor(target), { note: 'bad' });
  assert.equal(readFeedback(privateStore, target).state, 'unknown');
  assert.equal(saveFeedback(privateStore, target, { note: 'replace', headSha: null }, null).reason, 'invalid-saved-feedback');
  assert.deepEqual(privateStore.records.get(idFor(target)), { note: 'bad' });
});

test('feedback only accepts a bounded local note and head; private fields cannot enter the record', () => {
  const privateStore = store();
  for (const bad of [
    { note: 'x', headSha: head, accountLabel: 'private' },
    { note: 'x', headSha: head, localPath: 'private' },
    { note: 'x', headSha: head, token: 'private' },
    { note: 'x\u202E', headSha: head }, { note: 'x'.repeat(2001), headSha: head },
    { note: 'x', headSha: 'short' }, { note: '', headSha: null }
  ]) assert.equal(saveFeedback(privateStore, target, bad, null).ok, false);
  assert.equal(privateStore.records.size, 0);
});
