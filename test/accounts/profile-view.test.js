'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { describeAccounts, hintFor } = require('../../src/accounts/profile-view');
const { claudeIdentityFromAuthStatus, codexIdentityFromAccountRead } = require('../../src/accounts/observation');

// Synthetic paths and identities; the context keeps the checks off the real filesystem.
const context = { platform: 'darwin', homeDir: '/home/user', repoRoot: '/work/project', realpath: (value) => value, isDirectory: () => true };
const observedAt = '2026-10-15T00:00:00.000Z';
const ok = { ok: true, problems: [] };

const profile = (id, label, dir, extra = {}) => ({ id, provider: 'claude', label, configDir: dir, expectedAuthMethod: null, ...extra });
const status = (email, extra = {}) => ({
  loggedIn: true, authMethod: 'claude.ai', configDirectory: undefined, email, orgId: 'org-synthetic', subscriptionType: 'max', ...extra
});

function observe(p, raw) {
  return {
    validation: ok,
    blockers: [],
    identity: claudeIdentityFromAuthStatus({ ...raw, configDirectory: raw.configDirectory ?? p.configDir }, { profile: p, observedAt, context })
  };
}

const view = (profiles, observations) => describeAccounts({ profiles, observations: new Map(observations), context });

test('without an observation an account is unknown, never ready', () => {
  const [entry] = view([profile('a', 'Personal', '/home/user/acc/a')], []);
  assert.equal(entry.health, 'unknown');
  assert.deepEqual(entry.verifiedIdentity, { state: 'unknown', source: 'unknown', reason: 'not-inspected' });
  assert.deepEqual(entry.loginMethod, { state: 'unknown', source: 'unknown', expected: null });
  assert.deepEqual(entry.label, { value: 'Personal', source: 'user-label' });
  assert.ok(entry.issues.some((issue) => issue.code === 'not-inspected'));
});

test('a verified account shows a fingerprint and the login method, each with its source', () => {
  const p = profile('a', 'Personal', '/home/user/acc/a', { expectedAuthMethod: 'claude.ai' });
  const [entry] = view([p], [['a', observe(p, status('person@example.test'))]]);
  assert.equal(entry.health, 'ready');
  assert.equal(entry.verifiedIdentity.state, 'verified');
  assert.equal(entry.verifiedIdentity.source, 'service');
  assert.match(entry.verifiedIdentity.fingerprint, /^[0-9a-f]{8}$/);
  assert.deepEqual(entry.loginMethod, { state: 'reported', source: 'service', value: 'claude.ai', expected: 'claude.ai' });
  assert.deepEqual(entry.issues, []);
});

test('the account principal is never shown: no email or organisation appears anywhere in the view', () => {
  const p = profile('a', 'Personal', '/home/user/acc/a');
  const entries = view([p], [['a', observe(p, status('person@example.test'))]]);
  const text = JSON.stringify(entries);
  assert.doesNotMatch(text, /person@example|example\.test|org-synthetic/);
});

test('the label is only a label: a label that looks like an account does not become the identity', () => {
  const p = profile('a', 'person@example.test (work)', '/home/user/acc/a');
  const [entry] = view([p], []);
  assert.equal(entry.label.source, 'user-label');
  assert.equal(entry.verifiedIdentity.state, 'unknown');
});

test('two profiles that log in to the same real account are both flagged and name each other', () => {
  const a = profile('a', 'Personal', '/home/user/acc/a');
  const b = profile('b', 'Work', '/home/user/acc/b');
  const same = status('same@example.test');
  const entries = view([a, b], [['a', observe(a, same)], ['b', observe(b, same)]]);
  for (const entry of entries) {
    assert.equal(entry.health, 'attention');
    assert.ok(entry.issues.some((issue) => issue.code === 'duplicate-account'));
  }
  assert.deepEqual(entries[0].duplicateOf, ['b']);
  assert.deepEqual(entries[1].duplicateOf, ['a']);
  assert.equal(entries[0].verifiedIdentity.fingerprint, entries[1].verifiedIdentity.fingerprint);
});

test('different accounts of the same provider are both ready and not duplicates', () => {
  const a = profile('a', 'Personal', '/home/user/acc/a');
  const b = profile('b', 'Work', '/home/user/acc/b');
  const entries = view([a, b], [['a', observe(a, status('one@example.test'))], ['b', observe(b, status('two@example.test'))]]);
  assert.deepEqual(entries.map((entry) => entry.health), ['ready', 'ready']);
  assert.notEqual(entries[0].verifiedIdentity.fingerprint, entries[1].verifiedIdentity.fingerprint);
  assert.deepEqual(entries.map((entry) => entry.duplicateOf), [[], []]);
});

test('a shared or nested configuration folder is flagged on both profiles', () => {
  const a = profile('a', 'A', '/home/user/acc/a');
  const b = profile('b', 'B', '/home/user/acc/a');
  const c = profile('c', 'C', '/home/user/acc/a/inner');
  const entries = view([a, b, c], []);
  assert.ok(entries[0].issues.some((issue) => issue.code === 'config-dir-conflict:same'));
  assert.ok(entries[1].issues.some((issue) => issue.code === 'config-dir-conflict:same'));
  assert.ok(entries[2].issues.some((issue) => issue.code === 'config-dir-conflict:nested'));
});

test('a logged-out account, an unverified login method and a mismatching login are reported with actionable hints', () => {
  const p = profile('a', 'A', '/home/user/acc/a', { expectedAuthMethod: 'claude.ai' });
  const loggedOut = view([p], [['a', observe(p, { loggedIn: false })]])[0];
  assert.equal(loggedOut.health, 'attention');
  assert.equal(loggedOut.verifiedIdentity.state, 'unknown');
  assert.equal(loggedOut.verifiedIdentity.reason, 'not-logged-in');
  assert.match(loggedOut.issues.find((issue) => issue.code === 'not-logged-in').hint, /log in/i);

  const console = view([p], [['a', observe(p, { loggedIn: true, authMethod: 'console', email: 'x@example.test' })]])[0];
  assert.equal(console.verifiedIdentity.state, 'unknown', 'an API-style login does not verify a person');
  assert.equal(console.loginMethod.value, 'console');
  assert.equal(console.loginMethod.expected, 'claude.ai');
  assert.ok(console.issues.some((issue) => issue.code === 'anomaly:auth-method-mismatch'));
});

test('a different configuration folder reported by the CLI and an inherited credential are surfaced', () => {
  const p = profile('a', 'A', '/home/user/acc/a');
  const wrongDir = observe(p, status('x@example.test', { configDirectory: '/home/user/.claude' }));
  assert.ok(view([p], [['a', wrongDir]])[0].issues.some((issue) => issue.code === 'config-dir-mismatch'));

  const inherited = { ...observe(p, status('x@example.test')), blockers: [{ code: 'credential-override-inherited', variable: 'ANTHROPIC_API_KEY' }] };
  const [entry] = view([p], [['a', inherited]]);
  assert.equal(entry.health, 'attention');
  const issue = entry.issues.find((candidate) => candidate.code === 'credential-override:ANTHROPIC_API_KEY');
  assert.ok(issue && /override/i.test(issue.hint));
  assert.doesNotMatch(JSON.stringify(entry), /sk-/);
});

test('an observation without identity from a Codex account read is shown the same way', () => {
  const p = { id: 'c', provider: 'codex', label: 'Codex', configDir: '/home/user/acc/c', expectedAuthMethod: null };
  const identity = codexIdentityFromAccountRead({ account: { type: 'chatgpt', email: 'codex@example.test', planType: 'plus' }, requiresOpenaiAuth: false }, { profile: p, observedAt, codexHome: '/home/user/acc/c', context });
  const [entry] = view([p], [['c', { validation: ok, blockers: [], identity }]]);
  assert.equal(entry.provider, 'codex');
  assert.doesNotMatch(JSON.stringify(entry), /codex@example/);
  assert.ok(['verified', 'unknown'].includes(entry.verifiedIdentity.state));
});

test('every issue code has a hint, including unknown ones', () => {
  for (const code of ['not-inspected', 'not-logged-in', 'duplicate-account', 'config-dir:config-dir-inside-repo', 'credential-override:X', 'something-new']) {
    assert.ok(hintFor(code).length > 5, code);
  }
});
