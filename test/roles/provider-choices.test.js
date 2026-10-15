'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { builtIn } = require('../../src/providers/registry');
const { roleProviderChoices } = require('../../src/roles/provider-choices');

test('role provider choices come from the registry and show agy unknown capabilities honestly', () => {
  const choices = roleProviderChoices();
  assert.deepEqual(choices.map((choice) => choice.id), builtIn.ids());
  const agy = choices.find((choice) => choice.id === 'agy');
  assert.ok(agy);
  assert.match(agy.detail, /帳號隔離：未知/);
  assert.match(agy.detail, /身份核實：未知/);
  assert.match(agy.detail, /額度：未知/);
  assert.match(agy.detail, /規則注入：不支援／需手動/);
  assert.doesNotMatch(agy.detail, /已驗證|已送入 CLI/);
  for (const choice of choices) assert.ok(choice.detail.length < 160);
});
