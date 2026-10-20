'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PrivateStore } = require('../../src/storage/private-store');
const { RoleStore } = require('../../src/roles/role-store');
const { buildFromTemplate } = require('../../src/roles/templates');
const { AccountProfileService } = require('../../src/accounts/profile-service');
const { removeProfileFlow, BUTTON_CLEAR, BUTTON_PLAIN } = require('../../src/roles/profile-usage');
const { sandbox, COLLECTIONS } = require('../storage/helpers');

function setup(t) {
  const box = sandbox(t);
  const store = new PrivateStore({ dir: box.dir, repoRoot: box.repoRoot, collections: COLLECTIONS });
  let sessions = [];
  const service = new AccountProfileService({ store, sessions: () => sessions, now: () => new Date('2026-10-15T00:00:00.000Z') });
  const roles = new RoleStore(store);
  const profile = (name) => {
    const dir = path.join(box.root, 'accounts', name);
    fs.mkdirSync(dir, { recursive: true });
    const created = service.create({ provider: 'claude', label: name, configDir: dir });
    assert.equal(created.ok, true);
    return created.profile;
  };
  const role = (id, defaultAccountProfileId) => {
    const built = buildFromTemplate({ templateId: 'worker', provider: 'claude', name: `Role ${id}`, newId: id }).record;
    built.group.defaultAccountProfileId = defaultAccountProfileId;
    assert.equal(roles.save(built).ok, true);
  };
  const dialogs = { asked: [], historical: 0 };
  const ui = (answer = true, historical = true) => ({
    confirmRemove: async (groups, button) => { dialogs.asked.push({ names: groups.map((group) => group.name), button }); return answer; },
    confirmHistorical: async () => { dialogs.historical += 1; return historical; }
  });
  return { service, roles, profile, role, dialogs, ui, setSessions: (next) => { sessions = next; } };
}

test('the dialog lists the groups using the profile; confirming removes the profile and clears exactly those defaults', async (t) => {
  const s = setup(t);
  const a = s.profile('A'); const b = s.profile('B');
  s.role('role-1', a.id); s.role('role-2', b.id);
  const result = await removeProfileFlow({ service: s.service, roleStore: s.roles, profileId: a.id, ui: s.ui() });
  assert.deepEqual(result, { outcome: 'removed', cleared: 1, failed: 0, rolesUnknown: false });
  assert.deepEqual(s.dialogs.asked, [{ names: ['Role role-1'], button: BUTTON_CLEAR }]);
  assert.equal(s.service.get(a.id).code, 'profile-not-found');
  assert.equal(s.service.resolveForLaunch(a.id).code, 'profile-not-found', 'a launch under the removed profile is refused');
  assert.equal(s.roles.get('role-1').record.group.defaultAccountProfileId, null);
  assert.equal(s.roles.get('role-2').record.group.defaultAccountProfileId, b.id);
});

test('with no group using it the plain button is used and no role group is touched', async (t) => {
  const s = setup(t);
  const a = s.profile('A'); const b = s.profile('B');
  s.role('role-2', b.id);
  const result = await removeProfileFlow({ service: s.service, roleStore: s.roles, profileId: a.id, ui: s.ui() });
  assert.deepEqual(result, { outcome: 'removed', cleared: 0, failed: 0, rolesUnknown: false });
  assert.deepEqual(s.dialogs.asked, [{ names: [], button: BUTTON_PLAIN }]);
  assert.equal(s.roles.get('role-2').record.revision, 1);
});

test('cancelling changes nothing: the profile stays and the defaults stay', async (t) => {
  const s = setup(t);
  const a = s.profile('A');
  s.role('role-1', a.id);
  const result = await removeProfileFlow({ service: s.service, roleStore: s.roles, profileId: a.id, ui: s.ui(false) });
  assert.deepEqual(result, { outcome: 'cancelled' });
  assert.equal(s.service.get(a.id).ok, true);
  assert.equal(s.roles.get('role-1').record.group.defaultAccountProfileId, a.id);
  assert.equal(s.roles.get('role-1').record.revision, 1);
});

test('unreadable role groups refuse the removal before any dialog or change', async (t) => {
  const s = setup(t);
  const a = s.profile('A');
  const unreadable = { list: () => ({ ok: false, reason: 'invalid-role-record' }) };
  const result = await removeProfileFlow({ service: s.service, roleStore: unreadable, profileId: a.id, ui: s.ui() });
  assert.deepEqual(result, { outcome: 'roles-unreadable' });
  assert.deepEqual(s.dialogs.asked, []);
  assert.equal(s.service.get(a.id).ok, true, 'the profile is not removed');
});

test('a group that was pointed at the profile in another window after the first read is cleared too', async (t) => {
  const s = setup(t);
  const a = s.profile('A');
  s.role('role-1', a.id);
  const ui = s.ui();
  const confirm = ui.confirmRemove;
  ui.confirmRemove = async (groups, button) => {
    const answer = await confirm(groups, button);
    s.role('role-late', a.id); // another window, after the list was shown
    return answer;
  };
  const result = await removeProfileFlow({ service: s.service, roleStore: s.roles, profileId: a.id, ui });
  assert.deepEqual(result, { outcome: 'removed', cleared: 2, failed: 0, rolesUnknown: false });
  assert.equal(s.roles.get('role-late').record.group.defaultAccountProfileId, null);
});

test('a clear that fails is reported as failed; the group keeps naming a profile that no longer exists, and a launch under it is refused', async (t) => {
  const s = setup(t);
  const a = s.profile('A');
  s.role('role-1', a.id);
  const failingSave = { list: () => s.roles.list(), get: (id) => s.roles.get(id), save: () => ({ ok: false, reason: 'stale-revision' }) };
  const result = await removeProfileFlow({ service: s.service, roleStore: failingSave, profileId: a.id, ui: s.ui() });
  assert.deepEqual(result, { outcome: 'removed', cleared: 0, failed: 1, rolesUnknown: false });
  assert.equal(s.roles.get('role-1').record.group.defaultAccountProfileId, a.id);
  assert.equal(s.service.resolveForLaunch(a.id).ok, false, 'fail closed: the dangling default cannot start anything');
});

test('role groups becoming unreadable after the removal are reported as unknown, not as cleared', async (t) => {
  const s = setup(t);
  const a = s.profile('A');
  s.role('role-1', a.id);
  let calls = 0;
  const flaky = { list: () => (++calls === 1 ? s.roles.list() : { ok: false, reason: 'storage-unavailable' }), get: (id) => s.roles.get(id), save: (...args) => s.roles.save(...args) };
  const result = await removeProfileFlow({ service: s.service, roleStore: flaky, profileId: a.id, ui: s.ui() });
  assert.deepEqual(result, { outcome: 'removed', cleared: 0, failed: 0, rolesUnknown: true });
});

test('a profile with earlier sessions asks a second time; refusing it removes nothing and clears nothing; a profile in use is an error', async (t) => {
  const s = setup(t);
  const a = s.profile('A');
  s.role('role-1', a.id);
  s.setSessions([{ accountProfileId: a.id, terminalOpen: false }]);
  assert.deepEqual(await removeProfileFlow({ service: s.service, roleStore: s.roles, profileId: a.id, ui: s.ui(true, false) }), { outcome: 'cancelled' });
  assert.equal(s.dialogs.historical, 1);
  assert.equal(s.service.get(a.id).ok, true);
  assert.equal(s.roles.get('role-1').record.group.defaultAccountProfileId, a.id);
  assert.equal((await removeProfileFlow({ service: s.service, roleStore: s.roles, profileId: a.id, ui: s.ui(true, true) })).outcome, 'removed');
  assert.equal(s.roles.get('role-1').record.group.defaultAccountProfileId, null);

  const b = s.profile('B');
  s.role('role-2', b.id);
  s.setSessions([{ accountProfileId: b.id, terminalOpen: true }]);
  assert.deepEqual(await removeProfileFlow({ service: s.service, roleStore: s.roles, profileId: b.id, ui: s.ui() }), { outcome: 'error', code: 'profile-in-use' });
  assert.equal(s.roles.get('role-2').record.group.defaultAccountProfileId, b.id, 'nothing cleared when the removal itself failed');
});
