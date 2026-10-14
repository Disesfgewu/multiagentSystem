'use strict';

// Unlike the other account tests, these use the real host platform and a real
// temporary filesystem, so the CI matrix exercises native path and link rules.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateProfile, findConfigDirConflicts, buildLaunchEnv } = require('../../src/accounts/profile');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multiagent-accounts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, 'repo with space');
  const accounts = path.join(root, '帳號');
  fs.mkdirSync(repoRoot);
  fs.mkdirSync(accounts);
  return { root, repoRoot, accounts };
}

function profile(configDir, overrides) {
  return { id: 'p1', provider: 'claude', label: 'Test account', configDir, ...overrides };
}

test('native: accepts a not-yet-created directory outside the repository', (t) => {
  const { repoRoot, accounts } = fixture(t);
  const result = validateProfile(profile(path.join(accounts, 'new-account')), { repoRoot });
  assert.deepEqual(result, { ok: true, problems: [] });
});

test('native: rejects a directory inside the repository', (t) => {
  const { repoRoot } = fixture(t);
  const result = validateProfile(profile(path.join(repoRoot, '.acct')), { repoRoot });
  assert.deepEqual(result.problems, ['config-dir-inside-repo']);
});

test('native: rejects a link that leads back into the repository', (t) => {
  const { repoRoot, accounts } = fixture(t);
  const link = path.join(accounts, 'link');
  try {
    fs.symlinkSync(repoRoot, link, 'junction');
  } catch (error) {
    t.skip(`cannot create a directory link here: ${error.code}`);
    return;
  }
  const result = validateProfile(profile(path.join(link, 'acct')), { repoRoot });
  assert.deepEqual(result.problems, ['config-dir-inside-repo']);
});

test('native: different spellings of one directory are reported as the same', (t) => {
  const { accounts } = fixture(t);
  const dir = path.join(accounts, 'a');
  fs.mkdirSync(dir);
  const profiles = [
    profile(dir, { id: 'a' }),
    profile(`${dir}${path.sep}`, { id: 'b' }),
    profile(path.join(dir, '..', 'a'), { id: 'c' })
  ];
  const conflicts = findConfigDirConflicts(profiles, {});
  assert.deepEqual(conflicts.map((entry) => `${entry.a}-${entry.b}:${entry.kind}`), [
    'a-b:same', 'a-c:same', 'b-c:same'
  ]);
});

test('native: environment variable names follow the host platform case rules', () => {
  const { env, blockers } = buildLaunchEnv(
    profile(path.join(os.tmpdir(), 'unused')),
    { Anthropic_Api_Key: 'synthetic', claude_config_dir: 'stale' },
    {}
  );
  const configKeys = Object.keys(env).filter((key) => key.toUpperCase() === 'CLAUDE_CONFIG_DIR');
  if (process.platform === 'win32') {
    assert.deepEqual(blockers.map((entry) => entry.variable), ['ANTHROPIC_API_KEY']);
    assert.deepEqual(configKeys, ['CLAUDE_CONFIG_DIR']);
  } else {
    assert.deepEqual(blockers, []);
    assert.deepEqual(configKeys.sort(), ['CLAUDE_CONFIG_DIR', 'claude_config_dir']);
  }
});
