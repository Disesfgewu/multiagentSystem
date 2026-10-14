'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PrivateStore } = require('../../src/storage/private-store');
const { findSecrets } = require('../../src/storage/sensitive');
const { sandbox, COLLECTIONS } = require('./helpers');

const open = (s, extra) => new PrivateStore({ dir: s.dir, repoRoot: s.repoRoot, collections: COLLECTIONS, ...extra });

function seed(store) {
  store.put('profiles', 'work-account', {
    provider: 'claude',
    label: 'Alice personal laptop',
    configDir: '/Users/alice/.claude-work',
    privacyDomain: 'acme-internal',
    authMethod: 'claude.ai',
    secretRef: 'secret:acct/work-account',
    nested: { email: 'alice@example.test', deeper: { orgName: 'Acme' } },
    flags: ['a', 'b', 'c'],
    count: 7,
    enabled: true,
    gone: null,
    'weird key with spaces and alice@example.test': 'value'
  });
  store.put('sessions', 'session-0001', {
    provider: 'codex', status: 'running', terminalId: 'T-4471', worktree: 'C:\\Users\\alice\\work trees\\feat'
  });
}

test('the masked export keeps structure and public enumerations only', (t) => {
  const s = sandbox(t);
  const store = open(s, { now: () => Date.parse('2026-01-01T00:00:00Z') });
  seed(store);
  const result = store.exportMasked();
  assert.equal(result.ok, true);
  const exported = result.export;

  assert.equal(exported.format, 'multiagent-private-store-masked');
  assert.equal(exported.exportedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(exported.collections.profiles.count, 1);
  assert.equal(exported.collections.roleGroups.count, 0);

  const profile = exported.collections.profiles.records[0];
  assert.equal(profile.alias, 'profiles#1');
  assert.equal(profile.fields.provider, 'claude', 'allow-listed enumeration is kept');
  assert.equal(profile.fields.label, '<string>');
  assert.equal(profile.fields.configDir, '<string>');
  assert.equal(profile.fields.authMethod, '<string>', 'not on the allow-list');
  assert.equal(profile.fields.secretRef, '<string>');
  assert.equal(profile.fields.nested, '<object:2>');
  assert.equal(profile.fields.flags, '<array:3>');
  assert.equal(profile.fields.count, '<number>');
  assert.equal(profile.fields.enabled, '<boolean>');
  assert.equal(profile.fields.gone, null);
  assert.ok(Object.keys(profile.fields).includes('field#1'), 'an unsafe field name is replaced');

  const session = exported.collections.sessions.records[0];
  assert.deepEqual(session.fields, {
    provider: 'codex', status: 'running', terminalId: '<string>', worktree: '<string>'
  });
});

test('nothing identifying appears anywhere in the export', (t) => {
  const s = sandbox(t);
  const store = open(s);
  seed(store);
  const text = JSON.stringify(store.exportMasked());
  for (const leaked of ['alice', 'Alice', 'acme', 'Acme', 'work-account', 'session-0001', 'T-4471',
    '.claude-work', 'work trees', 'secret:acct', 's.dir', s.dir, s.repoRoot, 'example.test']) {
    assert.equal(text.includes(leaked), false, `leaked: ${leaked}`);
  }
  assert.deepEqual(findSecrets(JSON.parse(text)), []);
});

test('the allow-list is per collection and values must be short lower-case enumerations', (t) => {
  const s = sandbox(t);
  const store = open(s, { publicFields: { profiles: ['authMethod', 'label'] } });
  store.put('profiles', 'p1', { provider: 'claude', authMethod: 'claude.ai', label: 'Has Capitals And Spaces' });
  const fields = store.exportMasked().export.collections.profiles.records[0].fields;
  assert.equal(fields.provider, '<string>', 'not on this collection\'s list');
  assert.equal(fields.authMethod, 'claude.ai');
  assert.equal(fields.label, '<string>', 'allow-listed but not an enumeration-shaped value');
});

test('aliases are stable for the same data and do not reveal insertion order or ids', (t) => {
  const s = sandbox(t);
  const store = open(s);
  store.put('profiles', 'zzz', { provider: 'codex' });
  store.put('profiles', 'aaa', { provider: 'claude' });
  const first = store.exportMasked().export.collections.profiles.records;
  const second = store.exportMasked().export.collections.profiles.records;
  assert.deepEqual(first, second);
  assert.deepEqual(first.map((record) => record.alias), ['profiles#1', 'profiles#2']);
});

test('an unusable store cannot be exported', (t) => {
  const s = sandbox(t);
  const store = open(s);
  seed(store);
  require('node:fs').writeFileSync(require('node:path').join(s.dir, 'store.json'), 'garbage');
  assert.deepEqual(store.exportMasked(), { ok: false, reason: 'store-unavailable', detail: 'corrupt' });
});
