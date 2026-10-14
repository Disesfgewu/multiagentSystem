'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateProfile, findConfigDirConflicts, buildLaunchEnv, sameDirectory
} = require('../../src/accounts/profile');

const identity = (value) => value;
const failure = (code) => Object.assign(new Error(`synthetic ${code}`), { code });
const posix = { platform: 'darwin', homeDir: '/home/user', repoRoot: '/work/project', realpath: identity };
const win = {
  platform: 'win32',
  homeDir: 'C:\\Users\\Me',
  repoRoot: 'C:\\Users\\Me\\Project With Space',
  realpath: identity
};

function profile(overrides) {
  return { id: 'p1', provider: 'claude', label: 'Test account', configDir: '/home/user/accounts/a', ...overrides };
}

test('accepts a dedicated directory outside the repository', () => {
  assert.deepEqual(validateProfile(profile(), posix), { ok: true, problems: [] });
});

test('rejects a relative config directory', () => {
  const result = validateProfile(profile({ configDir: 'accounts/a' }), posix);
  assert.deepEqual(result.problems, ['config-dir-not-absolute']);
});

test('rejects unsupported providers and missing fields', () => {
  assert.deepEqual(validateProfile(profile({ provider: 'other' }), posix).problems, ['provider-unsupported']);
  const result = validateProfile(profile({ id: ' ', label: '' }), posix);
  assert.deepEqual(result.problems, ['profile-id-missing', 'label-missing']);
});

test('rejects a config directory inside the repository or containing it', () => {
  assert.deepEqual(
    validateProfile(profile({ configDir: '/work/project/.acct' }), posix).problems,
    ['config-dir-inside-repo']
  );
  assert.deepEqual(
    validateProfile(profile({ configDir: '/work' }), posix).problems,
    ['config-dir-contains-repo']
  );
});

test('rejects the provider default directory used by unmanaged terminals', () => {
  assert.deepEqual(
    validateProfile(profile({ configDir: '/home/user/.claude' }), posix).problems,
    ['config-dir-is-provider-default']
  );
  assert.deepEqual(
    validateProfile(profile({ provider: 'codex', configDir: '/home/user/.codex' }), posix).problems,
    ['config-dir-is-provider-default']
  );
  // .claude is the default for Claude only, not for Codex.
  assert.equal(validateProfile(profile({ provider: 'codex', configDir: '/home/user/.claude' }), posix).ok, true);
});

test('follows symlinks, including through a directory that does not exist yet', () => {
  const realpath = (value) => {
    if (value === '/exists/link') return '/work/project/inner';
    if (value === '/exists' || value === '/work/project' || value === '/') return value;
    throw failure('ENOENT');
  };
  const result = validateProfile(
    profile({ configDir: '/exists/link/new-account' }),
    { ...posix, realpath }
  );
  assert.deepEqual(result.problems, ['config-dir-inside-repo']);
});

test('does not treat a sibling with a shared name prefix as inside the repository', () => {
  assert.equal(validateProfile(profile({ configDir: '/work/project-accounts/a' }), posix).ok, true);
});

test('Windows paths: drive letters, case, spaces and Unicode', () => {
  assert.equal(validateProfile(profile({ configDir: 'D:\\accounts\\a' }), win).ok, true);
  assert.equal(validateProfile(profile({ configDir: 'C:\\Users\\Me\\帳號 一\\a' }), win).ok, true);
  assert.deepEqual(
    validateProfile(profile({ configDir: 'c:\\users\\me\\project with space\\.acct' }), win).problems,
    ['config-dir-inside-repo']
  );
  assert.deepEqual(
    validateProfile(profile({ configDir: 'c:\\USERS\\me\\.CLAUDE' }), win).problems,
    ['config-dir-is-provider-default']
  );
  assert.deepEqual(
    validateProfile(profile({ configDir: '\\relative\\only' }), win).problems,
    ['config-dir-not-absolute']
  );
});

test('detects profiles that share or nest configuration trees', () => {
  const profiles = [
    profile({ id: 'a', configDir: '/home/user/accounts/a' }),
    profile({ id: 'b', configDir: '/home/user/accounts/a/' }),
    profile({ id: 'c', configDir: '/home/user/accounts/a/child' }),
    profile({ id: 'd', configDir: '/home/user/accounts/d' })
  ];
  assert.deepEqual(findConfigDirConflicts(profiles, posix), [
    { a: 'a', b: 'b', kind: 'same' },
    { a: 'a', b: 'c', kind: 'nested' },
    { a: 'b', b: 'c', kind: 'nested' }
  ]);
});

test('Windows config directory conflicts ignore case', () => {
  const profiles = [
    profile({ id: 'a', configDir: 'D:\\Accounts\\A' }),
    profile({ id: 'b', configDir: 'd:\\accounts\\a' })
  ];
  assert.deepEqual(findConfigDirConflicts(profiles, win), [{ a: 'a', b: 'b', kind: 'same' }]);
});

test('launch env points each provider at its own variable and leaves base env untouched', () => {
  const base = { PATH: '/usr/bin', HOME: '/home/user' };
  const claude = buildLaunchEnv(profile(), base, posix);
  assert.equal(claude.env.CLAUDE_CONFIG_DIR, '/home/user/accounts/a');
  assert.equal(claude.env.CODEX_HOME, undefined);
  assert.deepEqual(claude.blockers, []);

  const codex = buildLaunchEnv(profile({ provider: 'codex', configDir: '/home/user/accounts/x' }), base, posix);
  assert.equal(codex.env.CODEX_HOME, '/home/user/accounts/x');
  assert.deepEqual(base, { PATH: '/usr/bin', HOME: '/home/user' });
});

test('replaces an inherited config directory and reports credential overrides by name only', () => {
  const base = {
    CLAUDE_CONFIG_DIR: '/somewhere/else',
    ANTHROPIC_API_KEY: 'synthetic-secret-value',
    CLAUDE_CODE_USE_BEDROCK: '1',
    ANTHROPIC_AUTH_TOKEN: ''
  };
  const { env, blockers } = buildLaunchEnv(profile(), base, posix);
  assert.equal(env.CLAUDE_CONFIG_DIR, '/home/user/accounts/a');
  assert.deepEqual(blockers, [
    { code: 'credential-override-inherited', variable: 'ANTHROPIC_API_KEY' },
    { code: 'credential-override-inherited', variable: 'CLAUDE_CODE_USE_BEDROCK' }
  ]);
  assert.equal(JSON.stringify(blockers).includes('synthetic-secret-value'), false);
});

test('Windows environment names are matched case-insensitively', () => {
  const base = { Claude_Config_Dir: 'C:\\old', anthropic_api_key: 'x' };
  const { env, blockers } = buildLaunchEnv(profile({ configDir: 'D:\\accounts\\a' }), base, win);
  assert.equal(Object.keys(env).filter((key) => key.toUpperCase() === 'CLAUDE_CONFIG_DIR').length, 1);
  assert.equal(env.CLAUDE_CONFIG_DIR, 'D:\\accounts\\a');
  assert.deepEqual(blockers.map((entry) => entry.variable), ['ANTHROPIC_API_KEY']);
});

test('Codex credential overrides are blocked too', () => {
  const { blockers } = buildLaunchEnv(
    profile({ provider: 'codex', configDir: '/home/user/accounts/x' }),
    { OPENAI_API_KEY: 'x', CODEX_API_KEY: 'y' },
    posix
  );
  assert.deepEqual(blockers.map((entry) => entry.variable), ['OPENAI_API_KEY', 'CODEX_API_KEY']);
});

test('permission and resolution errors fail closed instead of looking like a missing directory', () => {
  const realpath = (value) => {
    if (value === '/opaque/link') throw failure('EACCES');
    if (['/opaque', '/work/project', '/'].includes(value)) return value;
    throw failure('ENOENT');
  };
  const ctx = { ...posix, realpath };
  assert.deepEqual(validateProfile(profile({ configDir: '/opaque/link' }), ctx),
    { ok: false, problems: ['config-dir-unresolvable'] });
  assert.deepEqual(validateProfile(profile({ configDir: '/opaque/link/new' }), ctx).problems,
    ['config-dir-unresolvable']);
  // An ordinary not-yet-created subdirectory of an existing parent is accepted.
  assert.deepEqual(validateProfile(profile({ configDir: '/opaque/fresh/new' }), ctx), { ok: true, problems: [] });
});

test('ENOTDIR, ELOOP and errors without a code are all unresolvable', () => {
  for (const make of [() => failure('ENOTDIR'), () => failure('ELOOP'), () => new Error('no code')]) {
    const realpath = (value) => {
      if (value === '/data/file/acct') throw make();
      if (value === '/work/project') return value;
      throw failure('ENOENT');
    };
    const result = validateProfile(profile({ configDir: '/data/file/acct' }), { ...posix, realpath });
    assert.deepEqual(result.problems, ['config-dir-unresolvable']);
  }
});

test('an unresolvable repository root is reported rather than ignored', () => {
  const realpath = (value) => {
    if (value === '/work/project') throw failure('EACCES');
    throw failure('ENOENT');
  };
  const result = validateProfile(profile(), { ...posix, realpath });
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, ['repo-root-unresolvable']);
});

test('conflict detection reports unresolvable directories instead of skipping them', () => {
  const realpath = (value) => {
    if (value.startsWith('/opaque')) throw failure('EACCES');
    throw failure('ENOENT');
  };
  const profiles = [
    profile({ id: 'a', configDir: '/opaque/a' }),
    profile({ id: 'b', configDir: '/home/user/accounts/b' })
  ];
  assert.deepEqual(findConfigDirConflicts(profiles, { ...posix, realpath }),
    [{ a: 'a', b: null, kind: 'unresolvable' }]);
});

test('sameDirectory is unknown (null) when either side cannot be resolved', () => {
  const realpath = (value) => {
    if (value === '/opaque') throw failure('EACCES');
    throw failure('ENOENT');
  };
  const ctx = { ...posix, realpath };
  assert.equal(sameDirectory('/opaque', '/data/a', ctx), null);
  assert.equal(sameDirectory('/data/a', '/data/a/', ctx), true);
  assert.equal(sameDirectory('/data/a', '/data/b', ctx), false);
});
