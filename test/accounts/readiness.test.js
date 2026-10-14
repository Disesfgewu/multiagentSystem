'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reportEntry, profileReadiness, fleetReadiness } = require('../../src/accounts/readiness');
const { claudeIdentityFromAuthStatus, codexIdentityFromAccountRead } = require('../../src/accounts/observation');

const identity = (value) => value;
const context = { platform: 'darwin', homeDir: '/home/user', repoRoot: '/work/project', realpath: identity };
const profile = { id: 'p1', provider: 'claude', label: 'Test account', configDir: '/home/user/accounts/a' };
const observedAt = '2026-01-01T00:00:00.000Z';
const ok = { ok: true, problems: [] };

const subscription = {
  loggedIn: true, authMethod: 'claude.ai', configDirectory: '/home/user/accounts/a',
  email: 'person@example.test', orgId: 'org-synthetic', subscriptionType: 'max'
};

function entryFor(status) {
  return reportEntry('p1', {
    validation: ok,
    blockers: [],
    identity: claudeIdentityFromAuthStatus(status, { profile, observedAt, context })
  });
}

test('a fully verified profile is ready', () => {
  assert.deepEqual(profileReadiness(entryFor(subscription)), { ready: true, reasons: [] });
});

test('a CLI that does not report its config directory is not ready', () => {
  const { configDirectory, ...withoutDirectory } = subscription;
  const entry = entryFor(withoutDirectory);
  assert.equal(entry.configDirMatches, null);
  assert.deepEqual(profileReadiness(entry), { ready: false, reasons: ['config-dir-unverified'] });
});

test('a mismatching config directory is reported as a mismatch, once', () => {
  const entry = entryFor({ ...subscription, configDirectory: '/home/user/.claude' });
  assert.deepEqual(profileReadiness(entry).reasons, ['config-dir-mismatch']);
});

test('a directory that cannot be resolved is unknown, not matching', () => {
  const realpath = (value) => {
    if (value === '/opaque') throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return value;
  };
  const entry = reportEntry('p1', {
    validation: ok,
    blockers: [],
    identity: claudeIdentityFromAuthStatus(
      { ...subscription, configDirectory: '/opaque' },
      { profile, observedAt, context: { ...context, realpath } }
    )
  });
  assert.equal(entry.configDirMatches, null);
  assert.deepEqual(profileReadiness(entry).reasons, ['config-dir-unverified']);
});

test('Codex without an echoed home directory is not ready either', () => {
  const entry = reportEntry('c1', {
    validation: ok,
    blockers: [],
    identity: codexIdentityFromAccountRead(
      { account: { type: 'chatgpt', email: 'person@example.test', planType: 'plus' } },
      { profile: { ...profile, id: 'c1', provider: 'codex' }, observedAt }
    )
  });
  assert.deepEqual(profileReadiness(entry).reasons, ['config-dir-unverified']);
});

test('every other unknown or abnormal state is a reason, not a pass', () => {
  const apiKey = reportEntry('p1', {
    validation: { ok: false, problems: ['config-dir-inside-repo'] },
    blockers: [{ variable: 'ANTHROPIC_API_KEY' }],
    identity: claudeIdentityFromAuthStatus(
      { loggedIn: true, authMethod: 'api_key', apiKeySource: 'ANTHROPIC_API_KEY', configDirectory: '/home/user/accounts/a' },
      { profile, observedAt, context }
    )
  });
  assert.deepEqual(profileReadiness(apiKey).reasons, [
    'config-dir:config-dir-inside-repo',
    'credential-override:ANTHROPIC_API_KEY',
    'subject-unverified',
    'anomaly:credential-from-environment'
  ]);
  const notInspected = reportEntry('p1', { validation: ok, blockers: [], identity: null });
  assert.deepEqual(profileReadiness(notInspected).reasons,
    ['not-inspected', 'subject-unverified', 'config-dir-unverified']);
});

test('the fleet is not ready with conflicts, duplicates or any unready profile', () => {
  const good = entryFor(subscription);
  assert.deepEqual(fleetReadiness([good]), { ready: true, reasons: [] });
  assert.deepEqual(fleetReadiness([good], { conflicts: [{ kind: 'unresolvable' }] }),
    { ready: false, reasons: ['config-dir-conflict:unresolvable'] });
  assert.deepEqual(fleetReadiness([good], { duplicates: [['a', 'b']] }),
    { ready: false, reasons: ['duplicate-account'] });
  const { configDirectory, ...missing } = subscription;
  assert.equal(fleetReadiness([good, entryFor(missing)]).ready, false);
});
