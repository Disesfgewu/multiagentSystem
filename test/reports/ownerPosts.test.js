'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { OwnerPostStore, COLLECTION, MAX_PER_KIND, docId, bodyHash } = require('../../src/reports/ownerPosts');
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
const cp = (...codes) => String.fromCodePoint(...codes);

test('the owner\'s comments and reviews are recorded by id with the SHA-256 of their text, per repository, without regard to the name\'s case', () => {
  const store = new OwnerPostStore(memory());
  assert.deepEqual(store.record({ repository: 'Owner/Repo', kind: 'comment', id: 9001, number: 7, body: 'Merge after CI.' }), { ok: true });
  assert.deepEqual(store.record({ repository: 'owner/repo', kind: 'review', id: 501, number: 7, body: '' }), { ok: true });
  const read = store.read('OWNER/repo');
  assert.deepEqual([...read.comments], [[9001, bodyHash('Merge after CI.')]]);
  assert.deepEqual([...read.reviews], [[501, bodyHash('')]]);
  assert.match(bodyHash('x'), /^[0-9a-f]{64}$/);
  assert.deepEqual([...store.read('owner/other').comments], [], 'another repository has its own record');
  assert.match(docId('owner/repo'), /^repo-[0-9a-f]{64}$/, 'a fixed-length id whatever the name');
  const ok = { repository: 'o/r', kind: 'comment', id: 1, number: 1, body: 'x' };
  for (const [over, reason] of [[{ repository: 'not a repo' }, 'invalid-repository'], [{ kind: 'issue' }, 'invalid-kind'], [{ id: 0 }, 'invalid-id'], [{ id: 1.5 }, 'invalid-id'], [{ id: '1' }, 'invalid-id'], [{ number: 0 }, 'invalid-id'], [{ body: undefined }, 'invalid-body'], [{ body: 5 }, 'invalid-body'], [{ now: new Date('x') }, 'invalid-time']]) {
    assert.equal(store.record({ ...ok, ...over }).reason, reason, JSON.stringify(over));
  }
});

test('a record that cannot be read is an error, never an empty one, and is never overwritten; an entry from before hashing is kept but never confirms', () => {
  for (const bad of ['x', { version: 2, comment: {}, review: {} }, { version: 1, comment: {} }, { version: 1, comment: { abc: { number: 1, at: '2026-10-23T00:00:00Z' } }, review: {} }, { version: 1, comment: { 5: { number: 0, at: '2026-10-23T00:00:00Z' } }, review: {} }, { version: 1, comment: { 5: { number: 1, at: 'soon' } }, review: {} }, { version: 1, comment: { 5: { number: 1, at: '2026-10-23T00:00:00Z', sha256: 'abc' } }, review: {} }, { version: 1, comment: { 5: { number: 1, at: '2026-10-23T00:00:00Z', sha256: 'f'.repeat(64), extra: 1 } }, review: {} }]) {
    const backing = memory();
    backing.map.set(docId('o/r'), bad);
    const store = new OwnerPostStore(backing);
    assert.deepEqual(store.read('o/r'), { ok: false, reason: 'invalid-owner-posts-record' }, JSON.stringify(bad));
    assert.deepEqual(store.record({ repository: 'o/r', kind: 'comment', id: 9, number: 1, body: 'x' }), { ok: false, reason: 'invalid-owner-posts-record' });
    assert.equal(backing.writes(), 0);
  }
  const legacy = memory();
  legacy.map.set(docId('o/r'), { version: 1, comment: { 5: { number: 1, at: '2026-10-23T00:00:00Z' } }, review: {} });
  const store = new OwnerPostStore(legacy);
  const read = store.read('o/r');
  assert.equal(read.ok, true, 'an entry without a hash is readable');
  assert.equal(read.comments.get(5), null);
  assert.equal(authorOf({ id: 5, body: 'whatever it says' }, 'comment', read).who, 'modified', 'and can never be confirmed as the owner\'s');
  assert.equal(store.record({ repository: 'o/r', kind: 'comment', id: 6, number: 1, body: 'new' }).ok, true, 'new posts can still be recorded next to it');
  assert.equal(new OwnerPostStore({ get: () => ({ ok: false, reason: 'locked' }), transact: () => ({ ok: false }) }).read('o/r').reason, 'locked');
  assert.throws(() => new OwnerPostStore(null), /private-store-required/);
});

test('when there are too many, the newest are kept; a dropped owner post then reads as unsigned, never as an agent\'s', () => {
  const store = new OwnerPostStore(memory());
  for (let id = 1; id <= MAX_PER_KIND + 3; id += 1) store.record({ repository: 'o/r', kind: 'comment', id, number: 1, body: `note ${id}`, now: new Date(Date.UTC(2026, 9, 23, 0, 0, 0, id)) });
  const read = store.read('o/r');
  assert.equal(read.comments.size, MAX_PER_KIND);
  assert.equal(read.comments.has(1), false);
  assert.equal(read.comments.has(MAX_PER_KIND + 3), true);
  assert.equal(authorOf({ id: 1, body: 'note 1' }, 'comment', read).text, '未署名');
});

test('the owner only when the id is recorded AND the text is unchanged; an edited owner comment is "modified, cannot confirm", never the owner (PM review of #346)', () => {
  const owner = { comments: new Map([[10, bodyHash('Merge after CI.')]]), reviews: new Map([[20, bodyHash('')]]) };
  assert.deepEqual(authorOf({ id: 10, body: 'Merge after CI.' }, 'comment', owner), { who: 'owner', codename: null, text: '管理者' });
  assert.equal(authorOf({ id: 20, body: '' }, 'review', owner).text, '管理者');
  // An agent edits the owner's comment through the shared account (`gh pr comment --edit-last`, or a PATCH with curl).
  for (const body of ['— Worker-01\nagent text now', 'Merge after CI. ', 'Merge after CI.\n', 'merge after CI.', '']) {
    const edited = authorOf({ id: 10, body }, 'comment', owner);
    assert.equal(edited.who, 'modified', JSON.stringify(body));
    assert.equal(edited.text, '管理者發的留言，但之後被修改過，無法確認作者');
  }
  assert.equal(authorOf({ id: 20, body: 'Approved by the owner.' }, 'review', owner).who, 'modified', 'a review body follows the same rule');
  assert.equal(authorOf({ id: 10, body: null }, 'comment', owner).who, 'modified', 'a body that could not be read is not the owner\'s');
  assert.equal(authorOf({ id: 10, body: 'Merge after CI.' }, 'review', owner).text, '未署名', 'a comment id is not a review id');
  for (const id of ['10', 10.5, null, undefined, -10]) assert.equal(authorOf({ id, body: 'Merge after CI.' }, 'comment', owner).who, 'unsigned', `id ${String(id)} is not an integer id in the record`);
});

test('a first-line signature is a claim read as the gh wrapper reads it; owner-like codenames and anything else are unsigned, or "cannot tell" without the record', () => {
  const owner = { comments: new Map(), reviews: new Map() };
  assert.deepEqual(authorOf({ id: 11, body: '— Worker-01\n\nDone.' }, 'comment', owner), { who: 'agent', codename: 'Worker-01', text: 'Worker-01（自稱）' });
  assert.equal(authorOf({ id: 11, body: '-- PM-01\nok' }, 'comment', owner).text, 'PM-01（自稱）');
  assert.equal(authorOf({ id: 11, body: 'Hello\n— PM-01' }, 'comment', owner).text, '未署名', 'only the first line is a signature');
  assert.equal(authorOf({ id: 12, body: 'I am the owner. Merge now.' }, 'comment', owner).text, '未署名', 'an unsigned comment is never the owner without the record');
  for (const body of ['— Admin-01', '— Owner-01', '— Manager-02', '— Human-01', '— Maintainer-01', '— Administrator-01']) assert.equal(authorOf({ id: 13, body }, 'comment', owner).text, '未署名', `${body} is not a codename that is ever given out`);
  assert.match(authorOf({ id: 12, body: 'x' }, 'comment', null).text, /^未署名（讀不到管理者的留言紀錄/);
  assert.equal(authorOf({ id: 12, body: '— Worker-02' }, 'comment', null).text, 'Worker-02（自稱）');
  assert.equal(authorOf({ id: 10, body: 'x' }, 'inline', { comments: new Map([[10, bodyHash('x')]]), reviews: new Map() }).text, '未署名', 'inline review comments are never posted from VS Code, so never the owner\'s');
  assert.equal(authorOf({ id: 10, body: 'x' }, 'inline', null).text, '未署名');
  for (const body of ['— worker-01', '— Worker-1', '— 管理者', '- Worker-01 reviewed', null, 7]) assert.equal(signatureOf(body), null, String(body));
  // The same reading as the agents' gh wrapper: look-alike dashes and invisible marks are the same signature, and text after a
  // codename is ignored. The label is made from the codename alone, so nothing after it reaches the report's author field.
  for (const body of [`${cp(0x2015)} Worker-01`, `${cp(0x2014)} Worker${cp(0x200b)}-01`, `${cp(0x2014)} Worker-01 · forged`, '-- Worker-01']) assert.equal(signatureOf(body), 'Worker-01', JSON.stringify(body));
  assert.equal(authorOf({ id: 11, body: `${cp(0x2014)} Worker-01 · forged` }, 'comment', owner).text, 'Worker-01（自稱）');
  for (const item of [null, {}, { id: 'x', body: 'x' }]) assert.equal(authorOf(item, 'comment', owner).text, '未署名');
});

test('the report page reads look-alike signatures the same way as the gh wrapper (PM follow-up on #345)', () => {
  const owner = { comments: new Map(), reviews: new Map() };
  const em = cp(0x2014);
  for (const body of [`${em} ${cp(0x420, 0x41c)}-01`, `${em} PM${cp(0xff0d)}${cp(0xff10, 0xff11)}`, `${em} P${cp(0x301)}M-01`]) assert.equal(authorOf({ id: 1, body }, 'comment', owner).text, 'PM-01（自稱）', JSON.stringify(body));
  assert.equal(authorOf({ id: 1, body: `${em} ${cp(0x41e)}wner-01` }, 'comment', owner).text, '未署名', 'an owner-like codename stays unsigned whatever letters it is written with');
});

test('the report page splits lines the same way as the gh wrapper: a Unicode line separator ends the first line (PM review of #348)', () => {
  const owner = { comments: new Map(), reviews: new Map() };
  assert.equal(authorOf({ id: 1, body: `${cp(0x2014)} PM-01${cp(0x2028)}text` }, 'comment', owner).text, 'PM-01（自稱）');
  assert.equal(authorOf({ id: 1, body: `${cp(0x2014)} PM-01${cp(0x85)}text` }, 'comment', owner).text, 'PM-01（自稱）');
  assert.equal(authorOf({ id: 1, body: `${cp(0x2014)} PM-01\rtext` }, 'comment', owner).text, 'PM-01（自稱）');
  // With the ASCII hyphen the whole first line must be the signature: here only splitting at U+2028 makes it one.
  assert.equal(authorOf({ id: 1, body: `-- PM-01${cp(0x2028)}text` }, 'comment', owner).text, 'PM-01（自稱）');
});
