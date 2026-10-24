'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { orderAccountChoices } = require('../../src/accounts/account-order');

const profiles = [{ id: 'a', label: 'Work A' }, { id: 'b', label: 'Work B' }, { id: 'c', label: 'Home' }];

test("the role group's default account is offered first, marked, and each account says which real account it is (#352)", () => {
  const choices = orderAccountChoices(profiles, { defaultId: 'b', emails: { a: 'owner-a@example.test', b: 'owner-b@example.test' }, plans: { b: 'Max' } });
  assert.deepEqual(choices.map((choice) => choice.id), ['b', 'a', 'c']);
  assert.deepEqual(choices[0], { id: 'b', label: 'Work B', description: "this role group's default account · owner-b@example.test · Max plan", isDefault: true });
  assert.equal(choices[1].description, 'owner-a@example.test');
  assert.equal(choices[2].description, 'sign-in not checked in this window');
});

test('without a default the order is kept; a default that is gone changes nothing; the account in use can be left out (#352)', () => {
  assert.deepEqual(orderAccountChoices(profiles).map((choice) => choice.id), ['a', 'b', 'c']);
  assert.deepEqual(orderAccountChoices(profiles, { defaultId: 'gone' }).map((choice) => [choice.id, choice.isDefault]), [['a', false], ['b', false], ['c', false]]);
  assert.deepEqual(orderAccountChoices(profiles, { defaultId: 'a', exclude: 'a' }).map((choice) => choice.id), ['b', 'c'], 'switching away from the default');
  assert.deepEqual(orderAccountChoices(null), []);
  assert.equal(orderAccountChoices(profiles, { emails: Object.create({ a: 'x@example.test' }) })[0].description, 'sign-in not checked in this window', 'inherited keys are not read');
});
