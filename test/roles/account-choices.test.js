'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { selectRoleProfiles } = require('../../src/roles/account-choices');

test('role account choices come from validated account service records and stay provider-scoped', () => {
  const result = selectRoleProfiles([
    { id: 'acct-one', provider: 'claude', label: 'Work', configDir: 'private data' },
    { id: 'acct-two', provider: 'codex', label: 'Personal' }
  ], 'claude');
  assert.deepEqual(result, { ok: true, profiles: [{ id: 'acct-one', label: 'Work' }] });
  assert.equal(JSON.stringify(result).includes('configDir'), false);
});

test('malformed, duplicate and unsafe account data refuses the whole list instead of looking empty', () => {
  const good = { id: 'acct-one', provider: 'claude', label: 'Work' };
  for (const profiles of [undefined, {}, [good, { ...good }], [good, { ...good, id: 'two', label: 'bad\nlabel' }],
    [good, { ...good, id: 'two', label: 'bad\u202Ename' }], [good, { ...good, id: 'two', provider: 'unknown' }],
    [{ ...good, id: '../escape' }], [{ ...good, label: 'x'.repeat(81) }]]) {
    assert.deepEqual(selectRoleProfiles(profiles, 'claude'), { ok: false, reason: 'invalid-account-list' });
  }
  assert.deepEqual(selectRoleProfiles([good], 'unknown'), { ok: false, reason: 'invalid-account-list' });
  assert.deepEqual(selectRoleProfiles([], 'agy'), { ok: true, profiles: [] }, 'a confirmed empty list remains distinct from a failed read');
});
