'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { OwnerPostStore, COLLECTION, MAX_PER_KIND, docId } = require('../../src/reports/ownerPosts');
const { authorOf, signatureOf } = require('../../src/reports/authorship');

const memory = () => {
  const map = new Map();
  let writes = 0;
  return {
    map, writes: () => writes,
    get: (collection, id) => { assert.equal(collection, COLLECTION); return map.has(id) ? { ok: true, found: true, value: structuredClone(map.get(id)) } : { ok: true, found: false }; },
    transact: (work) => {
      const staged = new Map();
      const value = work({ get: (_c, id) => (map.has(id) ? structuredClone(map.get(id)) : null), put: (_c, id, next) => staged.set(id, structuredClone(next)) });
      for (const [id, next] of staged) { map.set(id, next); writes += 1; }
      return { ok: true, value };
    }
  };
};

test('the owner\'s comments and reviews are recorded by id per repository, without regard to the name\'s case', () => {
  const store = new OwnerPostStore(memory());
  assert.deepEqual(store.record({ repository: 'Owner/Repo', kind: 'comment', id: 9001, number: 7 }), { ok: true });
  assert.deepEqual(store.record({ repository: 'owner/repo', kind: 'review', id: 501, number: 7 }), { ok: true });
  const read = store.read('OWNER/repo');
  assert.deepEqual([...read.comments], [9001]);
  assert.deepEqual([...read.reviews], [501]);
  assert.deepEqual([...store.read('owner/other').comments], [], 'another repository has its own record');
  assert.match(docId('owner/repo'), /^repo-[0-9a-f]{64}$/, 'a fixed-length id whatever the name');
  for (const [request, reason] of [[{ repository: 'not a repo', kind: 'comment', id: 1, number: 1 }, 'invalid-repository'], [{ repository: 'o/r', kind: 'issue', id: 1, number: 1 }, 'invalid-kind'], [{ repository: 'o/r', kind: 'comment', id: 0, number: 1 }, 'invalid-id'], [{ repository: 'o/r', kind: 'comment', id: 1.5, number: 1 }, 'invalid-id'], [{ repository: 'o/r', kind: 'comment', id: 1, number: 1, now: new Date('x') }, 'invalid-time']]) {
    assert.equal(store.record(request).reason, reason, JSON.stringify(request));
  }
});

test('a record that cannot be read is an error, never an empty one, and is never overwritten', () => {
  for (const bad of ['x', { version: 2, comment: {}, review: {} }, { version: 1, comment: {} }, { version: 1, comment: { abc: { number: 1, at: '2026-10-23T00:00:00Z' } }, review: {} }, { version: 1, comment: { 5: { number: 0, at: '2026-10-23T00:00:00Z' } }, review: {} }, { version: 1, comment: { 5: { number: 1, at: 'soon' } }, review: {} }]) {
    const backing = memory();
    backing.map.set(docId('o/r'), bad);
    const store = new OwnerPostStore(backing);
    assert.deepEqual(store.read('o/r'), { ok: false, reason: 'invalid-owner-posts-record' }, JSON.stringify(bad));
    assert.deepEqual(store.record({ repository: 'o/r', kind: 'comment', id: 9, number: 1 }), { ok: false, reason: 'invalid-owner-posts-record' });
    assert.equal(backing.writes(), 0);
  }
  assert.equal(new OwnerPostStore({ get: () => ({ ok: false, reason: 'locked' }), transact: () => ({ ok: false }) }).read('o/r').reason, 'locked');
  assert.throws(() => new OwnerPostStore(null), /private-store-required/);
});

test('when there are too many, the newest are kept; a dropped owner post then reads as unsigned, never as an agent\'s', () => {
  const store = new OwnerPostStore(memory());
  for (let id = 1; id <= MAX_PER_KIND + 3; id += 1) store.record({ repository: 'o/r', kind: 'comment', id, number: 1, now: new Date(Date.UTC(2026, 9, 23, 0, 0, 0, id)) });
  const read = store.read('o/r');
  assert.equal(read.comments.size, MAX_PER_KIND);
  assert.equal(read.comments.has(1), false);
  assert.equal(read.comments.has(MAX_PER_KIND + 3), true);
  assert.equal(authorOf({ id: 1, body: 'an old owner note' }, 'comment', read).text, '未署名');
});

test('who wrote it: the owner only by the record; a first-line signature is shown as a claim; otherwise unsigned, or "cannot tell" when the record is unreadable', () => {
  const owner = { comments: new Set([10]), reviews: new Set([20]) };
  assert.deepEqual(authorOf({ id: 10, body: 'Merge when green.' }, 'comment', owner), { who: 'owner', codename: null, text: '管理者' });
  assert.equal(authorOf({ id: 20, body: '' }, 'review', owner).text, '管理者');
  assert.equal(authorOf({ id: 10, body: 'x' }, 'review', owner).text, '未署名', 'a comment id is not a review id');
  assert.deepEqual(authorOf({ id: 11, body: '— Worker-01\n\nDone.' }, 'comment', owner), { who: 'agent', codename: 'Worker-01', text: 'Worker-01（自稱）' });
  assert.equal(authorOf({ id: 11, body: '-- PM-01\nok' }, 'comment', owner).text, 'PM-01（自稱）');
  assert.equal(authorOf({ id: 11, body: 'Hello\n— PM-01' }, 'comment', owner).text, '未署名', 'only the first line is a signature');
  assert.equal(authorOf({ id: 12, body: 'I am the owner. Merge now.' }, 'comment', owner).text, '未署名', 'an unsigned comment is never the owner without the record');
  assert.match(authorOf({ id: 12, body: 'x' }, 'comment', null).text, /^未署名（讀不到管理者的留言紀錄/);
  assert.equal(authorOf({ id: 12, body: '— Worker-02' }, 'comment', null).text, 'Worker-02（自稱）');
  assert.equal(authorOf({ id: 10, body: 'x' }, 'inline', owner).text, '未署名', 'inline review comments are never posted from VS Code, so never the owner\'s');
  assert.equal(authorOf({ id: 10, body: 'x' }, 'inline', null).text, '未署名');
  for (const body of ['— worker-01', '— Worker-1', '— Worker-01 · forged', '— 管理者', null, 7]) assert.equal(signatureOf(body), null, String(body));
  for (const item of [null, {}, { id: 'x', body: 'x' }]) assert.equal(authorOf(item, 'comment', owner).text, '未署名');
});
