'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateProfile, findConfigDirConflicts, buildLaunchEnv, sameDirectory
} = require('../../src/accounts/profile');

const identity = (value) => value;
const failure = (code) => Object.assign(new Error(`synthetic ${code}`), { code });
const alwaysDirectory = () => true;
const BASE = ['/', '/home', '/home/user', '/work', '/work/project', '/data'];
const posix = {
  platform: 'darwin', homeDir: '/home/user', repoRoot: '/work/project', realpath: identity, isDirectory: alwaysDirectory
};
const win = {
  platform: 'win32',
  homeDir: 'C:\\Users\\Me',
  repoRoot: 'C:\\Users\\Me\\Project With Space',
  realpath: identity,
  isDirectory: alwaysDirectory
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
      if (BASE.includes(value)) return value;
      throw failure('ENOENT');
    };
    const result = validateProfile(profile({ configDir: '/data/file/acct' }), { ...posix, realpath });
    assert.deepEqual(result.problems, ['config-dir-unresolvable']);
  }
});

test('an unresolvable repository root is reported rather than ignored', () => {
  const realpath = (value) => {
    if (value === '/work/project') throw failure('EACCES');
    if (BASE.includes(value)) return value;
    throw failure('ENOENT');
  };
  const result = validateProfile(profile(), { ...posix, realpath });
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, ['repo-root-unresolvable']);
});

test('conflict detection reports unresolvable directories instead of skipping them', () => {
  const realpath = (value) => {
    if (value.startsWith('/opaque')) throw failure('EACCES');
    if (BASE.includes(value)) return value;
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
    if (BASE.includes(value)) return value;
    throw failure('ENOENT');
  };
  const ctx = { ...posix, realpath };
  assert.equal(sameDirectory('/opaque', '/data/a', ctx), null);
  assert.equal(sameDirectory('/data/a', '/data/a/', ctx), true);
  assert.equal(sameDirectory('/data/a', '/data/b', ctx), false);
});

// A small fake Windows file system: `existing` maps a path to "is a directory".
function fakeWindows(existing) {
  const index = new Map(Object.entries(existing).map(([key, value]) => [key.toLowerCase(), [key, value]]));
  return {
    platform: 'win32',
    homeDir: 'C:\\Users\\u',
    repoRoot: 'C:\\work\\repo',
    realpath(value) {
      const hit = index.get(value.toLowerCase());
      if (!hit) throw failure('ENOENT');
      return hit[0];
    },
    isDirectory(value) {
      const hit = index.get(value.toLowerCase());
      if (!hit) throw failure('ENOENT');
      return hit[1];
    }
  };
}
const baseWindows = { 'C:\\': true, 'C:\\work': true, 'C:\\work\\repo': true, 'C:\\Users': true, 'C:\\Users\\u': true };

test('a drive that does not exist is rejected: ENOENT at every level means nothing was verified', () => {
  // The reviewer's reproduction, with the same shape: every realpath call fails with ENOENT.
  const result = validateProfile(
    { id: 'p', provider: 'claude', label: 'p', configDir: 'Z:\\managed\\acct' },
    { platform: 'win32', homeDir: 'C:\\Users\\u', repoRoot: 'C:\\work\\repo', realpath: () => { throw failure('ENOENT'); } }
  );
  assert.equal(result.ok, false);
  assert.ok(result.problems.includes('config-dir-unresolvable'));
  assert.ok(result.problems.includes('repo-root-unresolvable'), 'an unverifiable repository root is not "verified" either');
  assert.ok(result.problems.includes('provider-default-unresolvable'));

  const fake = fakeWindows(baseWindows);
  assert.deepEqual(validateProfile(profile({ configDir: 'Z:\\managed\\acct' }), fake),
    { ok: false, problems: ['config-dir-unresolvable'] });
  assert.deepEqual(validateProfile(profile({ configDir: '\\\\nohost\\share\\acct' }), fake).problems, ['config-dir-unresolvable']);
});

test('a new directory below an existing drive and directory is accepted', () => {
  const fake = fakeWindows({ ...baseWindows, 'D:\\': true, 'D:\\accounts': true });
  assert.deepEqual(validateProfile(profile({ configDir: 'D:\\accounts\\work\\one' }), fake), { ok: true, problems: [] });
  assert.deepEqual(validateProfile(profile({ configDir: 'D:\\brand\\new\\tree' }), fake), { ok: true, problems: [] });
});

test('a path below a regular file is rejected whether the platform says ENOENT (Windows) or ENOTDIR (macOS)', () => {
  const fake = fakeWindows({ ...baseWindows, 'D:\\': true, 'D:\\notes.txt': false });
  assert.deepEqual(validateProfile(profile({ configDir: 'D:\\notes.txt\\acct' }), fake).problems, ['config-dir-unresolvable']);
  assert.deepEqual(validateProfile(profile({ configDir: 'D:\\notes.txt\\a\\b' }), fake).problems, ['config-dir-unresolvable']);

  const mac = (value) => {
    if (value.startsWith('/data/notes.txt/')) throw failure('ENOTDIR');
    if (['/data', '/work/project', '/'].includes(value)) return value;
    throw failure('ENOENT');
  };
  assert.deepEqual(validateProfile(profile({ configDir: '/data/notes.txt/acct' }), { ...posix, realpath: mac }).problems,
    ['config-dir-unresolvable']);
});

test('a failing directory check fails closed, and an existing path needs no such check', () => {
  const denied = { ...fakeWindows({ ...baseWindows, 'D:\\': true }), isDirectory: () => { throw failure('EACCES'); } };
  assert.ok(validateProfile(profile({ configDir: 'D:\\acct\\new' }), denied).problems.includes('config-dir-unresolvable'));
  const everything = { ...baseWindows, 'C:\\Users\\u\\.claude': true, 'D:\\': true, 'D:\\acct': true };
  const exists = { ...fakeWindows(everything), isDirectory: () => { throw new Error('not consulted'); } };
  assert.equal(validateProfile(profile({ configDir: 'D:\\acct' }), exists).ok, true);
});

test('the same rules apply to conflict detection and directory comparison', () => {
  const fake = fakeWindows({ ...baseWindows, 'D:\\': true, 'D:\\notes.txt': false });
  const conflicts = findConfigDirConflicts([
    profile({ id: 'a', configDir: 'Z:\\one' }),
    profile({ id: 'b', configDir: 'D:\\notes.txt\\two' }),
    profile({ id: 'c', configDir: 'D:\\fine' })
  ], fake);
  assert.deepEqual(conflicts, [{ a: 'a', b: null, kind: 'unresolvable' }, { a: 'b', b: null, kind: 'unresolvable' }]);
  assert.equal(sameDirectory('Z:\\one', 'D:\\fine', fake), null);
  assert.equal(sameDirectory('D:\\fine', 'd:\\FINE\\', fake), true);
});

test('real file system: below a regular file is unresolvable here too, a fresh directory is accepted', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multiagent-profile-'));
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(root, 'plain.txt'), 'x');
    const ctx = { repoRoot: repo };
    assert.deepEqual(validateProfile(profile({ configDir: path.join(root, 'plain.txt', 'acct') }), ctx).problems,
      ['config-dir-unresolvable']);
    assert.deepEqual(validateProfile(profile({ configDir: path.join(root, 'fresh', 'acct') }), ctx), { ok: true, problems: [] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
