'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PrivateStore } = require('../../src/storage/private-store');
const { RoleStore } = require('../../src/roles/role-store');
const { buildFromTemplate } = require('../../src/roles/templates');
const { roleGroupsUsingProfile, describeGroups, clearRoleDefaults } = require('../../src/roles/profile-usage');
const { sandbox, COLLECTIONS } = require('../storage/helpers');

function setup(t) {
  const box = sandbox(t);
  const privateStore = () => new PrivateStore({ dir: box.dir, repoRoot: box.repoRoot, collections: COLLECTIONS });
  const roles = new RoleStore(privateStore());
  const add = (id, name, defaultAccountProfileId = null, templateId = 'worker') => {
    const built = buildFromTemplate({ templateId, provider: 'claude', name, newId: id }).record;
    built.group.defaultAccountProfileId = defaultAccountProfileId;
    assert.equal(roles.save(built).ok, true, id);
  };
  return { roles, add, privateStore };
}

test('only the role groups that name this profile as their default are found, with what a dialog needs', (t) => {
  const { roles, add } = setup(t);
  add('role-a', 'Developer A', 'profile-1');
  add('role-b', 'Developer B', 'profile-2');
  add('role-c', 'Reviewer', 'profile-1', 'pm');
  add('role-d', 'No default', null);
  const found = roleGroupsUsingProfile(roles, 'profile-1');
  assert.equal(found.ok, true);
  assert.deepEqual(found.groups.map((group) => [group.id, group.name, group.revision]), [['role-a', 'Developer A', 1], ['role-c', 'Reviewer', 1]]);
  assert.deepEqual(roleGroupsUsingProfile(roles, 'profile-9'), { ok: true, groups: [] });
});

test('unreadable role groups are an unknown, never "none"; bad input and a throwing store are refused', (t) => {
  const { roles, add, privateStore } = setup(t);
  add('role-a', 'Developer A', 'profile-1');
  const failing = { list: () => ({ ok: false, reason: 'invalid-role-record' }) };
  assert.deepEqual(roleGroupsUsingProfile(failing, 'profile-1'), { ok: false, reason: 'invalid-role-record' });
  assert.deepEqual(roleGroupsUsingProfile({ list: () => { throw new Error('boom'); } }, 'profile-1'), { ok: false, reason: 'storage-unavailable' });
  assert.deepEqual(roleGroupsUsingProfile({ list: () => ({ ok: true, items: 'x' }) }, 'profile-1'), { ok: false, reason: 'storage-unavailable' });
  for (const bad of [undefined, null, '', 5]) assert.equal(roleGroupsUsingProfile(roles, bad).ok, false, String(bad));
  for (const store of [undefined, null, {}]) assert.equal(roleGroupsUsingProfile(store, 'profile-1').ok, false);
  // A damaged stored record makes the whole listing unreadable.
  assert.equal(privateStore().put('roleGroups', 'role-broken', { group: { id: 'role-broken' } }).ok, true);
  assert.equal(roleGroupsUsingProfile(roles, 'profile-1').ok, false);
});

test('clearing the defaults goes through the edit path: the default is gone, the version moves, nothing else changes', (t) => {
  const { roles, add } = setup(t);
  add('role-a', 'Developer A', 'profile-1');
  add('role-b', 'Developer B', 'profile-2');
  const before = roles.get('role-a').record;
  const found = roleGroupsUsingProfile(roles, 'profile-1');
  const result = clearRoleDefaults(roles, found.groups, 'profile-1');
  assert.deepEqual(result, { cleared: ['role-a'], failed: [] });
  const after = roles.get('role-a').record;
  assert.equal(after.group.defaultAccountProfileId, null);
  assert.equal(after.group.version, before.group.version + 1);
  assert.equal(after.revision, before.revision + 1);
  assert.deepEqual({ ...after.group, defaultAccountProfileId: undefined, version: 0 }, { ...before.group, defaultAccountProfileId: undefined, version: 0 }, 'name, scope, permissions and rules are unchanged');
  assert.equal(roles.get('role-b').record.group.defaultAccountProfileId, 'profile-2', 'a group of another profile is not touched');
  assert.deepEqual(roleGroupsUsingProfile(roles, 'profile-1'), { ok: true, groups: [] });
});

test('a group edited since it was read is re-read and cleared at its new version, keeping the other edit; one that no longer names the profile is left alone and counts as done', (t) => {
  const { roles, add } = setup(t);
  add('role-a', 'Developer A', 'profile-1');
  add('role-b', 'Developer B', 'profile-1');
  const found = roleGroupsUsingProfile(roles, 'profile-1');
  // Someone else edits role-a (renames it) and someone points role-b at another profile.
  const a = roles.get('role-a').record; a.group.name = 'Renamed meanwhile'; a.group.version += 1;
  assert.equal(roles.save(a, { expectedRevision: a.revision }).ok, true);
  const b = roles.get('role-b').record; b.group.defaultAccountProfileId = 'profile-7'; b.group.version += 1;
  assert.equal(roles.save(b, { expectedRevision: b.revision }).ok, true);
  const result = clearRoleDefaults(roles, found.groups, 'profile-1');
  // role-a still names profile-1 at a newer revision: it is re-read and cleared at that revision, keeping the rename.
  assert.deepEqual(result, { cleared: ['role-a', 'role-b'], failed: [] });
  assert.equal(roles.get('role-a').record.group.name, 'Renamed meanwhile', 'the other edit is kept');
  assert.equal(roles.get('role-a').record.group.defaultAccountProfileId, null);
  assert.equal(roles.get('role-b').record.group.defaultAccountProfileId, 'profile-7', 'role-b was not touched');
});

test('a store that fails while clearing leaves the group as it is and says so; nothing throws', (t) => {
  const { roles, add } = setup(t);
  add('role-a', 'Developer A', 'profile-1');
  const found = roleGroupsUsingProfile(roles, 'profile-1');
  const broken = (over) => ({ get: (id) => roles.get(id), save: () => ({ ok: false, reason: 'stale-revision' }), ...over });
  assert.deepEqual(clearRoleDefaults(broken(), found.groups, 'profile-1'), { cleared: [], failed: [{ id: 'role-a', reason: 'stale-revision' }] });
  assert.deepEqual(clearRoleDefaults(broken({ get: () => ({ ok: false, reason: 'role-not-found' }) }), found.groups, 'profile-1'), { cleared: [], failed: [{ id: 'role-a', reason: 'role-not-found' }] });
  assert.deepEqual(clearRoleDefaults(broken({ save: () => { throw new Error('boom'); } }), found.groups, 'profile-1'), { cleared: [], failed: [{ id: 'role-a', reason: 'storage-unavailable' }] });
  assert.equal(roles.get('role-a').record.group.defaultAccountProfileId, 'profile-1', 'unchanged');
  assert.deepEqual(clearRoleDefaults(roles, undefined, 'profile-1'), { cleared: [], failed: [] });
});

test('the names shown are cut short and counted: at most five, each at most forty characters', () => {
  const group = (name) => ({ name });
  assert.equal(describeGroups([group('Developer')]), '“Developer”');
  assert.equal(describeGroups(['a', 'b', 'c'].map(group)), '“a”, “b”, “c”');
  const many = describeGroups(Array.from({ length: 8 }, (_, index) => group(`Role ${index}`)));
  assert.equal(many, '“Role 0”, “Role 1”, “Role 2”, “Role 3”, “Role 4” and 3 more');
  assert.equal(describeGroups([group('x'.repeat(100))]), `“${'x'.repeat(40)}”`);
});
