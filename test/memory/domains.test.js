'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDomainPolicy, defaultDomainFor, validDomain, MAX_GRANTS } = require('../../src/memory/domains');

const refuses = (config, field) => {
  assert.throws(() => createDomainPolicy(config), (error) => {
    assert.ok(error instanceof TypeError, JSON.stringify(config));
    assert.equal(error.message.includes('SYNTHETIC-VALUE'), false, 'the message does not repeat the value');
    return true;
  }, field || JSON.stringify(config));
};

test('by default every account has a domain of its own, so two accounts never share memory', () => {
  assert.equal(defaultDomainFor('acct-0123456789ab'), 'account:acct-0123456789ab');
  assert.equal(defaultDomainFor('Work_Account-1'), 'account:work_account-1', 'one spelling per account');
  assert.notEqual(defaultDomainFor('acct-a'), defaultDomainFor('acct-b'));
  for (const bad of ['', ' ', 'a b', 'a/b', 'a@b.test', '../x', 'x'.repeat(65), '-leading', null, undefined, 7, {}]) {
    assert.throws(() => defaultDomainFor(bad), TypeError, JSON.stringify(bad));
  }
  const policy = createDomainPolicy();
  assert.equal(policy.domainFor('acct-a'), 'account:acct-a');
  assert.deepEqual(policy.readableDomains('account:acct-a'), ['account:acct-a']);
  assert.deepEqual(policy.describe(), { accountAssignments: 0, grants: 0 });
});

test('accounts inside one trust boundary can be placed in the same domain, by an explicit assignment', () => {
  const policy = createDomainPolicy({ accountDomains: { 'acct-a': 'team', 'acct-b': 'team', 'ACCT-C': 'other' } });
  assert.equal(policy.domainFor('acct-a'), 'team');
  assert.equal(policy.domainFor('acct-b'), 'team');
  assert.equal(policy.domainFor('acct-c'), 'other', 'account ids compare without case');
  assert.equal(policy.domainFor('acct-d'), 'account:acct-d', 'an account that was not assigned keeps its own domain');
  assert.deepEqual(policy.describe(), { accountAssignments: 3, grants: 0 });
});

test('sharing is a grant, written down, directional and not transitive; without one there is none', () => {
  const policy = createDomainPolicy({ grants: [{ reader: 'b', source: 'a' }, { reader: 'c', source: 'b' }] });
  assert.deepEqual(policy.readableDomains('a'), ['a'], 'a has nothing granted to it');
  assert.deepEqual(policy.readableDomains('b'), ['b', 'a']);
  assert.deepEqual(policy.readableDomains('c'), ['c', 'b'], 'c reads b, and not a through b');
  assert.deepEqual(policy.readableDomains('z'), ['z'], 'a domain that was never mentioned reads only itself');
  assert.deepEqual(policy.describe(), { accountAssignments: 0, grants: 2 });
});

test('the domains a reader may read come back in a fixed order, its own first', () => {
  const grants = ['q', 'B', 'a', 'z', 'm'].map((source) => ({ reader: 'me', source: source.toLowerCase() === 'b' ? 'b2' : source }));
  const policy = createDomainPolicy({ grants });
  const first = policy.readableDomains('me');
  assert.deepEqual(first, ['me', 'a', 'b2', 'm', 'q', 'z']);
  const reversed = createDomainPolicy({ grants: [...grants].reverse() });
  assert.deepEqual(reversed.readableDomains('me'), first, 'not dependent on the order the grants were written');
  first.push('stolen');
  assert.deepEqual(policy.readableDomains('me'), ['me', 'a', 'b2', 'm', 'q', 'z'], 'the answer is a copy');
});

test('a configuration that cannot be understood gives no policy at all, and never a wider one', () => {
  const bad = [
    null, 'grants', 7, [], { extra: 1 }, { accountDomains: [] }, { accountDomains: 'x' }, { grants: {} }, { grants: 'a' },
    { accountDomains: { 'a b': 'x' } }, { accountDomains: { 'acct-a': 'Upper' } }, { accountDomains: { 'acct-a': 'a@b.test' } },
    { accountDomains: { 'acct-a': 'a/b' } }, { accountDomains: { 'acct-a': '' } }, { accountDomains: { 'acct-a': 5 } },
    { accountDomains: { 'acct-a': 'x', 'ACCT-A': 'y' } },
    { grants: [null] }, { grants: ['a'] }, { grants: [{ reader: 'a' }] }, { grants: [{ source: 'a' }] },
    { grants: [{ reader: 'a', source: 'a' }] }, { grants: [{ reader: 'A', source: 'b' }] }, { grants: [{ reader: 'a', source: 'a@b.test' }] },
    { grants: [{ reader: 'a', source: '/etc' }] }, { grants: [{ reader: 'a', source: 'b', all: true }] },
    { grants: [{ reader: 'a', source: 'b' }, { reader: 'a', source: 'b' }] },
    { grants: [{ reader: 'a', source: '*' }] }, { grants: [{ reader: '*', source: 'b' }] }
  ];
  for (const config of bad) refuses(config);
  refuses({ grants: Array.from({ length: MAX_GRANTS + 1 }, (_, i) => ({ reader: `r${i}`, source: 's' })) });
  refuses({ accountDomains: Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`acct-${i}`, 'x'])) });
  refuses({ accountDomains: { 'acct-a': 'SYNTHETIC-VALUE' } });
  refuses({ grants: [{ reader: 'a', source: 'SYNTHETIC-VALUE' }] });
});

test('domain names are plain lower-case labels: not an address, a path, a wildcard or an account name', () => {
  for (const good of ['team', 'account:acct-1', 'a.b_c-d', 'x1', 'a'.repeat(64)]) assert.equal(validDomain(good), true, good);
  for (const bad of ['', 'Team', 'a@b', 'a/b', 'a\\b', 'a b', '*', '-x', '.x', 'a'.repeat(65), 'tab\tx', 'new\nline', null, undefined, 3]) {
    assert.equal(validDomain(bad), false, JSON.stringify(bad));
  }
});

test('the policy is fixed once built: changing the configuration afterwards changes nothing', () => {
  const config = { accountDomains: { 'acct-a': 'team' }, grants: [{ reader: 'b', source: 'a' }] };
  const policy = createDomainPolicy(config);
  config.grants.push({ reader: 'b', source: 'secret' });
  config.grants[0].source = 'other';
  config.accountDomains['acct-a'] = 'changed';
  assert.deepEqual(policy.readableDomains('b'), ['b', 'a']);
  assert.equal(policy.domainFor('acct-a'), 'team');
  assert.equal(Object.isFrozen(policy), true);
  assert.throws(() => { 'use strict'; policy.readableDomains = () => ['x']; }, TypeError);
  assert.throws(() => policy.readableDomains('Not Valid'), TypeError);
});
