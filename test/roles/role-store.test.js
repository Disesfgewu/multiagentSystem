'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PrivateStore } = require('../../src/storage/private-store');
const { RoleStore } = require('../../src/roles/role-store');
const { buildFromTemplate } = require('../../src/roles/templates');
const { sandbox, COLLECTIONS } = require('../storage/helpers');

function setup(t) {
  const box = sandbox(t);
  const privateStore = () => new PrivateStore({ dir: box.dir, repoRoot: box.repoRoot, collections: COLLECTIONS });
  const roles = () => new RoleStore(privateStore());
  const record = buildFromTemplate({ templateId: 'worker', provider: 'claude', name: 'Developer', newId: 'role-test' }).record;
  return { privateStore, roles, record };
}

test('two editors cannot overwrite each other; revision survives a new PrivateStore instance', (t) => {
  const s = setup(t);
  assert.equal(s.roles().save(s.record).record.revision, 1);
  const first = s.roles().get('role-test');
  const second = s.roles().get('role-test');
  assert.equal(first.ok && second.ok, true);

  first.record.group.name = 'First edit';
  const saved = s.roles().save(first.record, { expectedRevision: first.record.revision });
  assert.equal(saved.ok, true);
  assert.equal(saved.record.revision, 2);
  second.record.group.name = 'Second edit';
  assert.deepEqual(s.roles().save(second.record, { expectedRevision: second.record.revision }), { ok: false, reason: 'stale-revision' });
  assert.equal(s.roles().get('role-test').record.group.name, 'First edit');
  assert.equal(s.roles().get('role-test').record.revision, 2);
});

test('failed reads, invalid records and missing revisions never become an empty or successful edit', (t) => {
  const s = setup(t);
  assert.equal(s.roles().save(s.record).ok, true);
  const current = s.roles().get('role-test').record;
  assert.deepEqual(s.roles().save(current), { ok: false, reason: 'revision-required' });
  assert.deepEqual(s.roles().save(current, { expectedRevision: 0 }), { ok: false, reason: 'invalid-revision' });
  assert.deepEqual(s.roles().save(current, { expectedRevision: 9 }), { ok: false, reason: 'stale-revision' });
  assert.deepEqual(s.roles().get('missing'), { ok: false, reason: 'role-not-found' });

  const unreadable = new RoleStore({
    get: () => ({ ok: false, reason: 'store-unavailable' }),
    list: () => ({ ok: false, reason: 'store-unavailable' }),
    transact: () => { throw new Error('must not write'); }
  });
  assert.deepEqual(unreadable.get('role-test'), { ok: false, reason: 'store-unavailable' });
  assert.deepEqual(unreadable.list(), { ok: false, reason: 'store-unavailable' });
});

test('legacy role without revision is read as revision 1 and upgraded on the first guarded edit', (t) => {
  const s = setup(t);
  assert.equal(s.privateStore().put('roleGroups', 'role-test', s.record).ok, true);
  const read = s.roles().get('role-test');
  assert.equal(read.record.revision, 1);
  read.record.group.name = 'Updated';
  assert.equal(s.roles().save(read.record, { expectedRevision: 1 }).record.revision, 2);
  assert.equal(s.roles().get('role-test').record.group.name, 'Updated');
});

test('malformed stored role refuses the whole list and is never silently overwritten', (t) => {
  const s = setup(t);
  assert.equal(s.privateStore().put('roleGroups', 'role-test', { group: { id: 'role-test' }, layers: {} }).ok, true);
  assert.deepEqual(s.roles().list(), { ok: false, reason: 'invalid-role-record' });
  assert.deepEqual(s.roles().get('role-test'), { ok: false, reason: 'invalid-role-record' });
  assert.deepEqual(s.roles().save(s.record, { expectedRevision: 1 }), { ok: false, reason: 'invalid-role-record' });
});
