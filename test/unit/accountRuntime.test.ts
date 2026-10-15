import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { terminalAccountEnvironment } from '../../src/accounts/accountRuntime';

test('a managed launch receives only its validated config folder and removes credential overrides', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multiagent-account-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, 'repo');
  const accountDir = path.join(root, 'accounts', 'work');
  fs.mkdirSync(repoRoot);
  fs.mkdirSync(accountDir, { recursive: true });
  const profile = { id: 'acct-work', provider: 'claude', label: 'Work', configDir: accountDir };
  const result = terminalAccountEnvironment('claude', { PATH: '/synthetic', CLAUDE_CONFIG_DIR: '/stale' }, repoRoot, profile);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.env.CLAUDE_CONFIG_DIR, fs.realpathSync.native(accountDir));
  assert.deepEqual(Object.keys(result.env), ['CLAUDE_CONFIG_DIR']);
  assert.equal(Object.hasOwn(result.env, 'PATH'), false, 'the terminal inherits PATH without copying the whole environment');
});

test('a credential inherited from the extension blocks a profile launch without exposing its value', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multiagent-account-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, 'repo');
  const accountDir = path.join(root, 'accounts', 'work');
  fs.mkdirSync(repoRoot);
  fs.mkdirSync(accountDir, { recursive: true });
  const result = terminalAccountEnvironment('claude', { ANTHROPIC_API_KEY: 'synthetic-private-value' }, repoRoot, {
    id: 'acct-work', provider: 'claude', label: 'Work', configDir: accountDir
  });
  assert.deepEqual(result, {
    ok: false,
    code: 'credential-override',
    message: 'An inherited credential or provider setting would override this account. Remove it from the environment before launching.'
  });
  assert.equal(JSON.stringify(result).includes('synthetic-private-value'), false);
});

test('unsupported account isolation and unsafe repository paths cannot produce terminal overrides', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multiagent-account-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, 'repo');
  const accountDir = path.join(root, 'accounts', 'work');
  fs.mkdirSync(repoRoot);
  fs.mkdirSync(accountDir, { recursive: true });
  const agy = terminalAccountEnvironment('agy', {}, repoRoot, {});
  assert.equal(agy.ok, false);
  if (!agy.ok) assert.equal(agy.code, 'provider-unsupported');
  const inside = terminalAccountEnvironment('claude', {}, repoRoot, {
    id: 'acct-work', provider: 'claude', label: 'Work', configDir: path.join(repoRoot, '.account')
  });
  assert.equal(inside.ok, false);
  if (!inside.ok) assert.equal(inside.code, 'account-config-rejected');
});
