'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkRoleForLaunch, roleChoices, REASONS, UNASSIGNED } = require('../../src/roles/launch-role');

const group = (over = {}) => ({ id: 'role-a', name: 'Alpha', role: 'worker', provider: 'claude', version: 3, defaultAccountProfileId: null, allowedScope: { repositories: [], paths: [] }, toolPermissions: {}, memoryScope: { mode: 'off' }, rules: [], ...over });
const record = (over) => ({ group: group(over), layers: {} });

test('a valid role group for the same provider may be assigned', () => {
  const checked = checkRoleForLaunch({ id: 'role-a', provider: 'claude', record: record() });
  assert.equal(checked.ok, true);
  assert.deepEqual([checked.group.id, checked.group.name, checked.group.version], ['role-a', 'Alpha', 3]);
});

test('a role for a provider without account isolation cannot silently ignore its default account', () => {
  const agy = record({ provider: 'agy', defaultAccountProfileId: 'profile-a' });
  const checked = checkRoleForLaunch({ id: 'role-a', provider: 'agy', record: agy });
  assert.deepEqual([checked.ok, checked.code], [false, 'role-group-account-isolation-unknown']);
  assert.equal(checked.message, REASONS['role-group-account-isolation-unknown']);
  assert.deepEqual(roleChoices([{ id: 'role-a', value: agy }], 'agy'), { choices: [], skipped: 1 });
  assert.equal(checkRoleForLaunch({ id: 'role-a', provider: 'agy', record: record({ provider: 'agy' }) }).ok, true);
  assert.equal(checkRoleForLaunch({ id: 'role-a', provider: 'claude', record: record({ defaultAccountProfileId: 'profile-a' }) }).ok, true);
});

test('every refusal has a code and a plain message', () => {
  const cases = [
    [{ id: 'role-a', provider: 'codex', record: record() }, 'role-group-provider-mismatch'],
    [{ id: 'role-a', provider: 'claude', record: null }, 'role-group-not-found'],
    [{ id: 'role-a', provider: 'claude', record: undefined }, 'role-group-not-found'],
    [{ id: 'role-a', provider: 'claude', record: record({ id: 'role-b' }) }, 'role-group-unreadable'],
    [{ id: 'role-a', provider: 'claude', record: record({ provider: 'nonsense' }) }, 'role-group-unreadable'],
    [{ id: 'role-a', provider: 'claude', record: { layers: {} } }, 'role-group-unreadable'],
    [{ id: 'role-a', provider: 'claude', record: 'text' }, 'role-group-unreadable'],
    [{ id: 'role-a', provider: 'claude', record: {} }, 'role-group-unreadable'],
    [{ id: 'role-a', provider: 'claude', record: { group: { ...group(), extra: 1 } } }, 'role-group-unreadable'],
    [{ id: 'role-a', provider: 'claude', record: { group: group(), layers: { task: [{ id: 'bad', type: 'instruction', text: '' }] } } }, 'role-group-unreadable'],
    [{ id: 'role-a', provider: 'claude', record: { group: group(), layers: 'invalid' } }, 'role-group-unreadable'],
    [{ id: 'role-a', provider: 'claude', record: { group: group(), layers: {}, revision: 0 } }, 'role-group-unreadable'],
    ...['', '../x', 'a b', UNASSIGNED, 'x'.repeat(65), undefined, null, 5, {}, '__proto__x/'].map((id) => [{ id, provider: 'claude', record: record() }, 'invalid-role-group'])
  ];
  for (const [input, code] of cases) {
    const checked = checkRoleForLaunch(input);
    assert.deepEqual([checked.ok, checked.code], [false, code], JSON.stringify(input.id));
    assert.equal(checked.message, REASONS[code]);
    assert.equal(checked.group, undefined);
    assert.ok(checked.message.length > 20);
  }
});

test('the id that was asked for must be the id of the stored group', () => {
  assert.equal(checkRoleForLaunch({ id: 'role-a', provider: 'claude', record: record({ id: 'role-A' }) }).code, 'role-group-unreadable');
});

test('role choices: only readable groups for this provider, sorted, with the unreadable counted', () => {
  const items = [
    { id: 'role-b', value: record({ id: 'role-b', name: 'Beta' }) },
    { id: 'role-c', value: record({ id: 'role-c', name: 'Alpha' }) },
    { id: 'role-a', value: record({ id: 'role-a', name: 'Alpha' }) },
    { id: 'role-x', value: record({ id: 'role-x', provider: 'codex' }) },
    { id: 'role-bad', value: { group: { id: 'role-bad' } } },
    { id: 'role-other', value: record({ id: 'role-mismatch' }) },
    null,
    { value: record() },
    { id: 5, value: record() }
  ];
  const { choices, skipped } = roleChoices(items, 'claude');
  assert.deepEqual(choices.map((choice) => choice.id), ['role-a', 'role-c', 'role-b']);
  assert.equal(skipped, 5, 'unreadable ones are counted, other providers\' groups are not');
  assert.deepEqual(roleChoices(items, 'codex').choices.map((choice) => choice.id), ['role-x']);
  for (const bad of [undefined, null, 'x', {}, 5]) assert.deepEqual(roleChoices(bad, 'claude'), { choices: [], skipped: 0 });
  assert.deepEqual(roleChoices([], 'claude'), { choices: [], skipped: 0 });
  assert.deepEqual(Object.keys(choices[0]).sort(), ['defaultAccountProfileId', 'id', 'name', 'role', 'version'], 'a choice carries no rules');
});
