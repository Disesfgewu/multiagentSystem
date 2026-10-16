'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { accountProviderChoices } = require('../../src/accounts/provider-choices');
const { builtIn } = require('../../src/providers/registry');

test('account creation picker includes every registered provider with honest evidence states', () => {
  const choices = accountProviderChoices();
  assert.deepEqual(choices.map((choice) => choice.id), builtIn.ids());
  assert.equal(choices.length, 3);
  const agy = choices.find((choice) => choice.id === 'agy');
  assert.equal(agy.canCreateProfile, false);
  assert.match(agy.description, /unavailable/);
  assert.match(agy.detail, /Account isolation: unknown; identity verification: unknown; quota\/usage: unknown/);
  assert.match(agy.detail, /no separate account will be created/);
  for (const id of ['claude', 'codex']) {
    const choice = choices.find((entry) => entry.id === id);
    assert.equal(choice.canCreateProfile, true);
    assert.match(choice.detail, /Account isolation: unverified; identity verification: unverified/);
    assert.match(choice.detail, new RegExp(`quota/usage: ${builtIn.capability(id, 'usageObservation')}`));
  }
});
