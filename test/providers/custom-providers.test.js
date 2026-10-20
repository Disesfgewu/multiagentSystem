'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { customProvidersFrom, MAX_PROVIDERS } = require('../../src/providers/custom-providers');
const { readUserLevel } = require('../../src/settings/user-level');
const { builtIn } = require('../../src/providers/registry');

const good = (over = {}) => ({ id: 'opencode', label: 'OpenCode', executable: 'opencode', args: ['--model', 'x'], ...over });

test('only the user-level value of a setting counts; workspace, folder and language values are ignored and only reported', () => {
  const inspected = { key: 'k', defaultValue: ['from-default'], globalValue: ['mine'], workspaceValue: ['from-repo'], workspaceFolderValue: ['from-folder'], workspaceLanguageValue: ['x'], workspaceFolderLanguageValue: ['y'], globalLanguageValue: ['z'] };
  assert.deepEqual(readUserLevel(inspected), { value: ['mine'], ignoredScopes: ['workspaceValue', 'workspaceFolderValue', 'workspaceLanguageValue', 'workspaceFolderLanguageValue'] });
  assert.equal(JSON.stringify(readUserLevel(inspected)).includes('from-repo'), false, 'an ignored value is never returned');
  assert.deepEqual(readUserLevel({ workspaceValue: [good()] }), { value: undefined, ignoredScopes: ['workspaceValue'] }, 'a workspace value alone yields nothing');
  assert.deepEqual(readUserLevel({ defaultValue: [good()] }), { value: undefined, ignoredScopes: [] }, 'a default is not something the person chose');
  for (const bad of [undefined, null, 5, 'x', [], true]) assert.deepEqual(readUserLevel(bad), { value: undefined, ignoredScopes: [] });
  assert.deepEqual(readUserLevel({ globalValue: ['a'], workspaceValue: undefined }), { value: ['a'], ignoredScopes: [] });
});

test('a valid entry becomes a terminal-only provider whose every capability is unknown', () => {
  const read = customProvidersFrom([good(), good({ id: 'other', label: 'Other', executable: 'other-cli', args: undefined })]);
  assert.deepEqual(read.rejected, []);
  assert.deepEqual(read.providers.map((provider) => [provider.id, provider.support, provider.args]), [['opencode', 'terminal-only', ['--model', 'x']], ['other', 'terminal-only', []]]);
  for (const provider of read.providers) for (const status of Object.values(provider.capabilities)) assert.equal(status, 'unknown');
  assert.equal(Object.isFrozen(read.providers[0]), true);
});

test('nothing, or null, is an empty list; a setting that is not a list or is too long is unusable as a whole', () => {
  assert.deepEqual(customProvidersFrom(undefined), { providers: [], rejected: [], code: null });
  assert.deepEqual(customProvidersFrom(null), { providers: [], rejected: [], code: null });
  for (const raw of ['x', 5, {}, true]) assert.equal(customProvidersFrom(raw).code, 'custom-providers-not-a-list');
  const tooMany = customProvidersFrom(Array.from({ length: MAX_PROVIDERS + 1 }, (_, index) => good({ id: `p${index}` })));
  assert.deepEqual([tooMany.code, tooMany.providers.length], ['custom-providers-too-many', 0]);
});

test('hostile or malformed entries are rejected with a code that never contains the value', () => {
  const secret = 'SECRET-VALUE-9x';
  const cases = [
    [null, 'provider-not-object'], ['x', 'provider-not-object'], [[], 'provider-not-object'],
    [good({ extra: 1 }), 'provider-unknown-field'],
    [good({ support: 'dedicated' }), 'provider-unknown-field'],
    [good({ capabilities: { mcp: 'verified' } }), 'provider-unknown-field'],
    [good({ env: { SOME_NAME: secret } }), 'provider-unknown-field'],
    [good({ id: 'claude' }), 'provider-id-reserved'], [good({ id: 'codex' }), 'provider-id-reserved'],
    [good({ id: 'Bad Id' }), 'provider-invalid-id'], [good({ id: undefined }), 'provider-invalid-id'],
    [good({ label: '' }), 'provider-invalid-label'], [good({ label: `a‮b${secret}` }), 'provider-invalid-label'], [good({ label: 'x'.repeat(65) }), 'provider-invalid-label'],
    [good({ executable: '/bin/sh' }), 'provider-invalid-executable'], [good({ executable: 'sh -c x' }), 'provider-invalid-executable'], [good({ executable: `a;${secret}` }), 'provider-invalid-executable'], [good({ executable: '..\\x' }), 'provider-invalid-executable'], [good({ executable: undefined }), 'provider-invalid-executable'],
    [good({ args: 'x' }), 'provider-invalid-args'], [good({ args: ['a b'] }), 'provider-invalid-args'], [good({ args: ['$(id)'] }), 'provider-invalid-args'], [good({ args: [`x\n${secret}`] }), 'provider-invalid-args'], [good({ args: [5] }), 'provider-invalid-args'], [good({ args: Array.from({ length: 33 }, () => 'a') }), 'provider-invalid-args']
  ];
  for (const [entry, code] of cases) {
    const read = customProvidersFrom([entry]);
    assert.deepEqual([read.providers.length, read.rejected], [0, [{ index: 0, code }]], code);
    assert.equal(JSON.stringify(read).includes(secret), false, 'the rejected value is never in the result');
  }
});

test('a duplicate id and a good entry beside a bad one: the bad one is rejected by position, the good one is kept', () => {
  const read = customProvidersFrom([good(), good(), { nope: 1 }, good({ id: 'second', label: 'Second', executable: 'second' })]);
  assert.deepEqual(read.providers.map((provider) => provider.id), ['opencode', 'second']);
  assert.deepEqual(read.rejected, [{ index: 1, code: 'provider-id-duplicate' }, { index: 2, code: 'provider-unknown-field' }]);
  for (const id of builtIn.ids()) assert.equal(customProvidersFrom([good({ id })]).rejected[0].code, 'provider-id-reserved', id);
});
