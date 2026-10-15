'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { canonicalize, checkPrivateRoot, PathResolutionError, pathFor } = require('../../src/shared/paths');
const { PrivateStore } = require('../../src/storage/private-store');
const { MemoryStore } = require('../../src/memory/store');
const { CONFIRM_RECOVER } = require('../../src/shared/lock');
const { AccountProfileService } = require('../../src/accounts/profile-service');
const { sandbox, COLLECTIONS } = require('../storage/helpers');

// `<data>/link -> <repo>/sub`, and a raw path `<data>/link/../x` built by string concatenation,
// because path.join would remove the `..` and test the wrong input. The operating system
// resolves that raw string to `<repo>/x`.
function trap(t) {
  const box = sandbox(t);
  fs.mkdirSync(path.join(box.repoRoot, 'sub'));
  fs.mkdirSync(path.join(box.root, 'data'));
  fs.symlinkSync(path.join(box.repoRoot, 'sub'), path.join(box.root, 'data', 'link'), 'dir');
  const raw = `${box.root}${path.sep}data${path.sep}link${path.sep}..${path.sep}x`;
  return { ...box, raw, leaked: path.join(box.repoRoot, 'x') };
}

test('the trap is real: the operating system puts the raw path inside the repository', (t) => {
  const s = trap(t);
  fs.mkdirSync(s.raw);
  assert.equal(fs.existsSync(s.leaked), true);
});

test('canonicalize refuses a dot-dot segment on both path flavours, but not dots inside names', () => {
  const never = () => { throw new Error('must not resolve'); };
  for (const [platform, value] of [['posix', '/a/link/../x'], ['posix', '/a/..'], ['win32', 'C:\\a\\link\\..\\x'], ['win32', 'C:/a/../x']]) {
    assert.throws(() => canonicalize(value, pathFor(platform), never, never, never), (e) => e instanceof PathResolutionError && e.code === 'EDOTDOT', value);
  }
  const real = (value) => value;
  assert.equal(canonicalize('/a/..b/c.../.d', pathFor('posix'), real, () => true, () => ({ isSymbolicLink: () => false })), '/a/..b/c.../.d');
});

test('checkPrivateRoot rejects the trap path', (t) => {
  const s = trap(t);
  const result = checkPrivateRoot(s.raw, s.repoRoot);
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, ['private-root-unresolvable']);
});

test('storage: put through the trap fails and creates nothing in the repository', (t) => {
  const s = trap(t);
  let outcome;
  try {
    outcome = new PrivateStore({ dir: s.raw, repoRoot: s.repoRoot, collections: COLLECTIONS }).put('profiles', 'a', { label: 'x' });
  } catch (error) {
    outcome = { ok: false, thrown: error.reason || error.message };
  }
  assert.notEqual(outcome && outcome.ok, true);
  assert.equal(fs.existsSync(s.leaked), false);
});

test('memory: a store opened on the trap path is refused and creates nothing in the repository', (t) => {
  const s = trap(t);
  assert.throws(() => new MemoryStore({ dir: s.raw, repoRoot: s.repoRoot }), /private-root-unresolvable/);
  assert.equal(fs.existsSync(s.leaked), false);
});

test('accounts: a config folder written with a dot-dot after a link is refused at create', (t) => {
  const s = trap(t);
  const store = new PrivateStore({ dir: s.dir, repoRoot: s.repoRoot, collections: COLLECTIONS });
  const service = new AccountProfileService({ store });
  const result = service.create({ provider: 'claude', label: 'Trap', configDir: s.raw });
  assert.equal(result.ok, false);
  assert.equal(service.list().profiles.length, 0);
  assert.equal(fs.existsSync(s.leaked), false);
});

test('memory: recoverLock and inspectLock re-check the directory after it is swapped for a link into the repo', (t) => {
  const s = sandbox(t);
  const store = new MemoryStore({ dir: s.dir, repoRoot: s.repoRoot });
  assert.equal(store.propose({ repoId: 'r', roleGroupId: 'g', privacyDomain: 'd', content: 'Release builds use the packaging script.', source: { ref: 'docs/R.md' } }).ok, true);
  fs.rmSync(s.dir, { recursive: true, force: true });
  fs.symlinkSync(s.repoRoot, s.dir, 'dir');
  const lock = path.join(s.repoRoot, 'memory.lock');
  const child = require('node:child_process').spawnSync(process.execPath, ['-e', '0']);
  fs.writeFileSync(lock, JSON.stringify({ token: 't', pid: child.pid, host: os.hostname(), createdAt: 'x' }));
  const recovered = store.recoverLock({ confirm: CONFIRM_RECOVER });
  assert.equal(recovered.ok, false);
  assert.equal(recovered.reason, 'directory-rejected');
  assert.equal(fs.existsSync(lock), true, 'the file in the repository must not be deleted');
  assert.equal(store.inspectLock().reason, 'directory-rejected');
});
