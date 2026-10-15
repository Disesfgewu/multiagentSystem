'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { PrivateStore, CONFIRM_CLEAR } = require('../../src/storage/private-store');
const { DirectoryLock } = require('../../src/shared/lock');
const { sandbox, COLLECTIONS, failure, watchRawPathIo } = require('./helpers');

const open = (s, extra) => new PrivateStore({ dir: s.dir, repoRoot: s.repoRoot, collections: COLLECTIONS, ...extra });
const profile = (extra) => ({ provider: 'claude', label: 'Synthetic work account', ...extra });
const listing = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

test('rejects a data directory inside, containing or unrelated-but-unresolvable to the repository', (t) => {
  const s = sandbox(t);
  const reject = (dir) => assert.throws(
    () => new PrivateStore({ dir, repoRoot: s.repoRoot, collections: COLLECTIONS }),
    (error) => Array.isArray(error.problems)
  );
  reject(path.join(s.repoRoot, '.private'));
  reject(s.root);
  reject('relative/dir');
  assert.doesNotThrow(() => open(s));
  // The data directory is not created by constructing the store.
  assert.equal(fs.existsSync(s.dir), false);
});

test('a link below the data directory path that leads into the repository is refused', (t) => {
  const s = sandbox(t);
  const outer = path.join(s.root, 'outer');
  fs.mkdirSync(outer);
  try {
    fs.symlinkSync(s.repoRoot, path.join(outer, 'link'), 'junction');
  } catch (error) {
    t.skip(`cannot create a directory link here: ${error.code}`);
    return;
  }
  assert.throws(
    () => new PrivateStore({ dir: path.join(outer, 'link', 'data'), repoRoot: s.repoRoot, collections: COLLECTIONS }),
    (error) => error.problems.includes('private-root-inside-repo')
  );
});

test('a data directory that cannot be resolved is rejected, not treated as missing', (t) => {
  const s = sandbox(t);
  const realpath = (value) => {
    if (value === s.dir) throw failure('EACCES');
    if (value === s.repoRoot) return value;
    throw failure('ENOENT');
  };
  assert.throws(
    () => new PrivateStore({ dir: s.dir, repoRoot: s.repoRoot, collections: COLLECTIONS, context: { realpath } }),
    (error) => error.problems.includes('private-root-unresolvable')
  );
});

test('stores, reads, lists and deletes records, creating owner-only files', (t) => {
  const s = sandbox(t);
  const store = open(s);
  assert.deepEqual(store.list('profiles'), { ok: true, items: [] });
  assert.equal(store.put('profiles', 'p1', profile()).ok, true);
  assert.equal(store.put('profiles', 'p2', profile({ label: 'Second' })).ok, true);
  assert.deepEqual(store.get('profiles', 'p1'), { ok: true, found: true, value: profile() });
  assert.deepEqual(store.get('profiles', 'missing'), { ok: true, found: false, value: null });
  assert.deepEqual(store.list('profiles').items.map((item) => item.id), ['p1', 'p2']);
  assert.deepEqual(store.delete('profiles', 'p1'), { ok: true, deleted: true });
  assert.deepEqual(store.delete('profiles', 'p1'), { ok: true, deleted: false });
  assert.equal(store.get('nope', 'x').reason, 'unknown-collection');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(s.dir, 'store.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(s.dir).mode & 0o777, 0o700);
  }
  assert.deepEqual(listing(s.dir), ['store.json']);
  assert.equal(new PrivateStore({ dir: s.dir, repoRoot: s.repoRoot, collections: COLLECTIONS })
    .get('profiles', 'p2').value.label, 'Second');
});

test('returned values are copies, so callers cannot mutate stored data', (t) => {
  const s = sandbox(t);
  const store = open(s);
  const input = profile();
  store.put('profiles', 'p1', input);
  input.label = 'changed after put';
  const out = store.get('profiles', 'p1').value;
  out.label = 'changed after get';
  assert.equal(store.get('profiles', 'p1').value.label, 'Synthetic work account');
});

test('identifiers and records are validated', (t) => {
  const s = sandbox(t);
  const store = open(s);
  for (const id of ['', '../x', 'a/b', '.hidden', 'constructor', '__proto__', 'x'.repeat(129), 'é', 42, null]) {
    assert.equal(store.put('profiles', id, profile()).reason, 'invalid-id', String(id));
  }
  for (const value of [null, [], 'text', 7, () => 1]) {
    assert.equal(store.put('profiles', 'ok', value).reason, 'invalid-record');
  }
  const circular = {};
  circular.self = circular;
  assert.equal(store.put('profiles', 'ok', circular).reason, 'invalid-record');
  assert.equal(store.put('profiles', 'big', { blob: 'x'.repeat(70 * 1024) }).reason, 'record-too-large');
  assert.deepEqual(store.list('profiles').items, []);
});

test('credentials are refused by field name and by value shape; secretRef is allowed', (t) => {
  const s = sandbox(t);
  const store = open(s);
  const refused = [
    { apiKey: 'anything' },
    { nested: { accessToken: 'anything' } },
    { password: 'x' },
    { Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz' },
    { note: 'key sk-ant-synthetic12345' },
    { note: 'ghp_syntheticsyntheticsynthetic1234' },
    { list: ['-----BEGIN RSA PRIVATE KEY-----'] }
  ];
  for (const value of refused) {
    const result = store.put('profiles', 'p1', value);
    assert.equal(result.reason, 'secret-detected');
    assert.equal(JSON.stringify(result).includes('synthetic'), false, 'no value in the report');
    assert.equal(JSON.stringify(result).includes('anything'), false);
  }
  assert.equal(store.put('profiles', 'p1', { provider: 'claude', secretRef: 'secret:acct/p1' }).ok, true);
  assert.equal(fs.existsSync(path.join(s.dir, 'store.json')), true);
  assert.equal(fs.readFileSync(path.join(s.dir, 'store.json'), 'utf8').includes('sk-ant'), false);
});

test('a transaction is all-or-nothing', (t) => {
  const s = sandbox(t);
  const store = open(s);
  store.put('profiles', 'keep', profile());
  const before = fs.readFileSync(path.join(s.dir, 'store.json'), 'utf8');

  const failed = store.transact((tx) => {
    tx.put('profiles', 'new', profile());
    tx.delete('profiles', 'keep');
    tx.put('sessions', 'bad', { apiKey: 'x' });
  });
  assert.equal(failed.reason, 'secret-detected');
  assert.equal(fs.readFileSync(path.join(s.dir, 'store.json'), 'utf8'), before);

  const ok = store.transact((tx) => {
    tx.put('sessions', 's1', { provider: 'codex' });
    tx.put('sessions', 's2', { provider: 'claude' });
    return tx.list('sessions').length;
  });
  assert.deepEqual(ok, { ok: true, value: 2, changed: true });

  assert.throws(() => store.transact((tx) => { tx.put('sessions', 's3', {}); throw new RangeError('caller bug'); }), RangeError);
  assert.equal(store.get('sessions', 's3').found, false);
  assert.equal(fs.existsSync(path.join(s.dir, 'store.lock')), false, 'lock is released after an exception');

  assert.equal(store.transact(async () => undefined).reason, 'async-transaction');
  assert.equal(store.transact(() => 'read only').changed, false);
});

test('a write that fails midway leaves the previous data intact and removes its temp file', (t) => {
  const s = sandbox(t);
  const good = open(s);
  good.put('profiles', 'p1', profile());
  const before = fs.readFileSync(path.join(s.dir, 'store.json'), 'utf8');

  const failWhileWriting = open(s, {
    io: { writeFile(file) { fs.writeFileSync(file, '{"partial":'); throw failure('ENOSPC'); } }
  });
  assert.deepEqual(failWhileWriting.put('profiles', 'p2', profile()),
    { ok: false, reason: 'write-failed', detail: 'ENOSPC' });

  const failOnRename = open(s, { io: { rename() { throw failure('EIO'); } } });
  assert.deepEqual(failOnRename.put('profiles', 'p2', profile()),
    { ok: false, reason: 'write-failed', detail: 'EIO' });

  assert.equal(fs.readFileSync(path.join(s.dir, 'store.json'), 'utf8'), before);
  assert.deepEqual(listing(s.dir), ['store.json'], 'no temp or lock files remain');
  assert.equal(good.get('profiles', 'p2').found, false);
});

test('a rename that is briefly refused is retried', (t) => {
  const s = sandbox(t);
  let refusals = 2;
  const store = open(s, {
    io: {
      rename(from, to) {
        if (refusals > 0) { refusals -= 1; throw failure('EPERM'); }
        fs.renameSync(from, to);
      }
    }
  });
  assert.equal(store.put('profiles', 'p1', profile()).ok, true);
  assert.equal(refusals, 0);
});

test('stale temp files from a crashed writer are swept, fresh ones are left', (t) => {
  const s = sandbox(t);
  const store = open(s, { lock: { staleMs: 1000 } });
  store.put('profiles', 'p1', profile());
  const stale = path.join(s.dir, '.store.123.deadbeef.tmp');
  const fresh = path.join(s.dir, '.store.456.cafebabe.tmp');
  fs.writeFileSync(stale, 'x');
  fs.writeFileSync(fresh, 'x');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(stale, old, old);
  store.put('profiles', 'p2', profile());
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(fresh), true);
});

test('a corrupt, truncated or foreign file is preserved, reported and never overwritten', (t) => {
  const cases = {
    'invalid-json': '{ not json',
    'empty': '',
    'invalid-envelope': JSON.stringify([1, 2]),
    'foreign-format': JSON.stringify({ format: 'other', schemaVersion: 1, collections: {} }),
    'unknown-collection': JSON.stringify({ format: 'multiagent-private-store', schemaVersion: 1, collections: { bogus: {} } }),
    'invalid-id': JSON.stringify({ format: 'multiagent-private-store', schemaVersion: 1, collections: { profiles: { '../x': {} } } }),
    'invalid-record': JSON.stringify({ format: 'multiagent-private-store', schemaVersion: 1, collections: { profiles: { a: 'text' } } })
  };
  for (const [detail, bytes] of Object.entries(cases)) {
    const s = sandbox(t);
    fs.mkdirSync(s.dir);
    const file = path.join(s.dir, 'store.json');
    fs.writeFileSync(file, bytes);
    const store = open(s);

    const status = store.status();
    assert.equal(status.ok, false, detail);
    assert.equal(status.reason, 'corrupt', detail);
    assert.equal(store.put('profiles', 'p1', profile()).reason, 'store-unavailable', detail);
    assert.equal(store.delete('profiles', 'p1').reason, 'store-unavailable', detail);
    assert.equal(store.get('profiles', 'p1').reason, 'store-unavailable', detail);
    assert.equal(store.list('profiles').ok, false);
    assert.equal(store.exportMasked().ok, false);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes, `${detail}: byte-for-byte unchanged`);
    assert.deepEqual(listing(s.dir), ['store.json'], `${detail}: no lock or temp left`);
  }
});

test('a newer schema version is refused without downgrading or touching the file', (t) => {
  const s = sandbox(t);
  fs.mkdirSync(s.dir);
  const file = path.join(s.dir, 'store.json');
  const bytes = JSON.stringify({ format: 'multiagent-private-store', schemaVersion: 9, collections: { profiles: {} } });
  fs.writeFileSync(file, bytes);
  const store = open(s);
  assert.deepEqual([store.status().reason, store.status().onDiskVersion], ['unsupported-schema', 9]);
  assert.equal(store.put('profiles', 'p1', profile()).reason, 'store-unavailable');
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
});

test('a store file that is a link or not a regular file is not followed', (t) => {
  const s = sandbox(t);
  fs.mkdirSync(s.dir);
  const target = path.join(s.repoRoot, 'planted.json');
  fs.writeFileSync(target, JSON.stringify({ format: 'multiagent-private-store', schemaVersion: 1, collections: {} }));
  try {
    fs.symlinkSync(target, path.join(s.dir, 'store.json'), 'file');
  } catch (error) {
    t.skip(`cannot create a file link here: ${error.code}`);
    return;
  }
  const store = open(s);
  assert.equal(store.status().reason, 'unsafe-path');
  assert.equal(store.put('profiles', 'p1', profile()).reason, 'store-unavailable');
  assert.equal(fs.readFileSync(target, 'utf8').includes('p1'), false, 'nothing written through the link');

  fs.rmSync(path.join(s.dir, 'store.json'));
  fs.mkdirSync(path.join(s.dir, 'store.json'));
  assert.equal(open(s).status().reason, 'unsafe-path');
});

test('concurrent processes all land their writes', async (t) => {
  const s = sandbox(t);
  const worker = path.join(__dirname, 'fixtures', 'put-worker.js');
  const reasons = [];
  const run = (tag) => new Promise((resolve) => {
    const child = spawn(process.execPath, [worker, s.dir, s.repoRoot, tag, '5'], { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', (chunk) => reasons.push(String(chunk).trim()));
    child.on('exit', (code) => resolve(code));
  });
  const codes = await Promise.all(['a', 'b', 'c', 'd'].map(run));
  assert.deepEqual(codes, [0, 0, 0, 0], reasons.join('; '));
  const items = open(s).list('sessions').items;
  assert.equal(items.length, 20);
  assert.deepEqual(listing(s.dir), ['store.json']);
});

test('two instances that each loaded before the other wrote do not lose updates', (t) => {
  const s = sandbox(t);
  const first = open(s);
  const second = open(s);
  first.put('profiles', 'a', profile());
  second.put('profiles', 'b', profile());
  assert.deepEqual(first.list('profiles').items.map((item) => item.id), ['a', 'b']);
});

const keepMigration = { from: 1, to: 2, up: (data) => data };
const openV2 = (s) => new PrivateStore({
  dir: s.dir, repoRoot: s.repoRoot, collections: COLLECTIONS, schemaVersion: 2, migrations: [keepMigration]
});
// A store that has a real backup: written by v1, then migrated by v2.
function withBackup(s) {
  open(s).put('profiles', 'p1', profile());
  const v2 = openV2(s);
  assert.equal(v2.migrate().ok, true);
  return v2;
}

test('clear requires confirmation, removes only owned files, and recovers a corrupt store', (t) => {
  const s = sandbox(t);
  const store = withBackup(s);
  fs.writeFileSync(path.join(s.dir, 'backups', 'notes.txt'), 'not ours');
  fs.writeFileSync(path.join(s.dir, 'unrelated.txt'), 'not ours');

  assert.equal(store.clear().reason, 'confirmation-required');
  assert.equal(store.clear({ confirm: 'yes' }).reason, 'confirmation-required');
  assert.equal(store.get('profiles', 'p1').found, true);

  assert.deepEqual(store.clear({ confirm: CONFIRM_CLEAR }),
    { ok: true, removed: { store: true, backups: 1, temps: 0, kept: { unrecognized: 1 } } });
  assert.deepEqual(listing(s.dir), ['backups', 'unrelated.txt']);
  assert.deepEqual(listing(path.join(s.dir, 'backups')), ['notes.txt'], 'the manifest and our backup are gone, the stranger stays');
  assert.deepEqual(store.list('profiles'), { ok: true, items: [] });

  fs.writeFileSync(path.join(s.dir, 'store.json'), 'garbage');
  assert.equal(store.status().ok, false);
  assert.equal(store.clear({ confirm: CONFIRM_CLEAR }).ok, true);
  assert.equal(store.status().ok, true);
});

test('keeps backups when asked to', (t) => {
  const s = sandbox(t);
  const store = withBackup(s);
  const before = listing(path.join(s.dir, 'backups'));
  const outcome = store.clear({ confirm: CONFIRM_CLEAR, includeBackups: false });
  assert.deepEqual([outcome.ok, outcome.removed.store, outcome.removed.backups], [true, true, 0]);
  assert.deepEqual(listing(path.join(s.dir, 'backups')), before);
});

test('private files never show up in git status of the repository', (t) => {
  const s = sandbox(t);
  const git = (...args) => spawnSync('git', args, { cwd: s.repoRoot, encoding: 'utf8' });
  if (git('init', '-q').status !== 0) { t.skip('git is not available'); return; }
  fs.writeFileSync(path.join(s.repoRoot, 'tracked.txt'), 'x');
  git('add', '.');
  git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', 'commit', '-q', '-m', 'init');

  const store = open(s);
  store.put('profiles', 'p1', profile());
  store.put('sessions', 's1', { provider: 'codex', worktree: 'synthetic/path' });
  assert.equal(git('status', '--porcelain', '--ignored').stdout.trim(), '');
  assert.equal(git('ls-files').stdout.trim(), 'tracked.txt');
});

test('a data directory owned by someone else, or that is not a directory, is refused', (t) => {
  const s = sandbox(t);
  const store = open(s);
  store.put('profiles', 'p1', profile());
  const before = fs.readFileSync(path.join(s.dir, 'store.json'), 'utf8');

  if (typeof process.getuid === 'function') {
    t.mock.method(process, 'getuid', () => process.getuid.mock.calls.length * 0 + 424242);
    assert.deepEqual(store.put('profiles', 'p2', profile()), { ok: false, reason: 'directory-rejected', detail: 'not-owned' });
    assert.deepEqual(store.clear({ confirm: CONFIRM_CLEAR }), { ok: false, reason: 'directory-rejected', detail: 'not-owned' });
    t.mock.restoreAll();
  }
  assert.equal(fs.readFileSync(path.join(s.dir, 'store.json'), 'utf8'), before);

  const other = sandbox(t);
  fs.writeFileSync(other.dir, 'a file where the directory should be');
  const result = open(other).put('profiles', 'p1', profile());
  assert.equal(result.reason, 'directory-rejected');
});

test('I/O errors while locking come back as results, not exceptions', (t) => {
  if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) {
    t.skip('needs a POSIX directory that the current user cannot write to');
    return;
  }
  const s = sandbox(t);
  const store = open(s);
  store.put('profiles', 'p1', profile());
  fs.chmodSync(s.dir, 0o500);
  try {
    assert.deepEqual(store.put('profiles', 'p2', profile()), { ok: false, reason: 'lock-failed', detail: 'EACCES' });
    assert.deepEqual(store.clear({ confirm: CONFIRM_CLEAR }), { ok: false, reason: 'lock-failed', detail: 'EACCES' });
    assert.equal(store.get('profiles', 'p1').found, true, 'reads still work');
  } finally {
    fs.chmodSync(s.dir, 0o700);
  }
});

test('a link swapped in above a directory that did not exist yet creates nothing in the repository', (t) => {
  const s = sandbox(t);
  const outer = path.join(s.root, 'outer');
  fs.mkdirSync(outer);
  const store = new PrivateStore({ dir: path.join(outer, 'link', 'data'), repoRoot: s.repoRoot, collections: COLLECTIONS });
  try {
    fs.symlinkSync(s.repoRoot, path.join(outer, 'link'), 'junction');
  } catch (error) {
    t.skip(`cannot create a directory link here: ${error.code}`);
    return;
  }
  const result = store.put('profiles', 'p1', profile());
  assert.deepEqual([result.ok, result.reason], [false, 'directory-rejected']);
  assert.deepEqual(fs.readdirSync(s.repoRoot), [], 'the check runs before any directory is created');
  assert.equal(store.clear({ confirm: CONFIRM_CLEAR }).reason, 'directory-rejected');
  assert.deepEqual(fs.readdirSync(s.repoRoot), []);
});

// ---- the data directory is checked on reads as well as writes -----------------

// After the store is open and has data, the data directory is moved aside and a
// link to the repository takes its place. The repository holds a well-formed store
// file and a lock file left by a process that no longer exists.
function swapInLinkToRepository(t, s) {
  const planted = JSON.parse(fs.readFileSync(path.join(s.dir, 'store.json'), 'utf8'));
  planted.collections.profiles.evil = { provider: 'claude', label: 'planted in the repository' };
  fs.writeFileSync(path.join(s.repoRoot, 'store.json'), JSON.stringify(planted));
  const gone = spawnSync(process.execPath, ['-e', '0']).pid;
  fs.writeFileSync(path.join(s.repoRoot, 'store.lock'), JSON.stringify({
    token: 'planted', pid: gone, host: require('node:os').hostname(), createdAt: new Date().toISOString()
  }));
  fs.renameSync(s.dir, `${s.dir}.moved`);
  try {
    fs.symlinkSync(s.repoRoot, s.dir, 'junction');
  } catch (error) {
    t.skip(`cannot create a directory link here: ${error.code}`);
    return false;
  }
  return true;
}

// A link that points at the repository itself is both "inside" and "containing" it.
function assertIntoRepo(result) {
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'directory-rejected');
  assert.match(result.detail, /private-root-inside-repo/);
}

test('every read refuses a data directory that was swapped for a link into the repository', (t) => {
  const s = sandbox(t);
  const store = open(s);
  store.put('profiles', 'p1', profile());
  assert.equal(store.list('profiles').items.length, 1, 'before the swap the data is readable');
  if (!swapInLinkToRepository(t, s)) return;

  assertIntoRepo(store.get('profiles', 'evil'));
  const listed = store.list('profiles');
  assertIntoRepo(listed);
  assert.deepEqual(listed.items, []);
  assertIntoRepo(store.exportMasked());
  const status = store.status();
  assertIntoRepo({ ok: status.ok, reason: status.reason, detail: status.detail });
  assert.equal('looseFileMode' in status, false, 'the file behind the link is not even inspected');
  assert.equal(JSON.stringify([store.get('profiles', 'evil'), store.list('profiles'), store.exportMasked()]).includes('evil'), false);

  // The same instance's writes were already refused; they still are.
  assert.equal(store.put('profiles', 'p2', profile()).reason, 'directory-rejected');
  assert.equal(store.migrate().reason, 'directory-rejected');
  assert.equal(store.clear({ confirm: CONFIRM_CLEAR }).reason, 'directory-rejected');
  assert.equal(fs.existsSync(path.join(s.repoRoot, 'store.json')), true, 'nothing in the repository was removed');
});

test('every storage I/O entry rejects a raw link/.. directory before touching it', (t) => {
  const s = sandbox(t);
  const store = open(s);
  assert.equal(store.put('profiles', 'p1', profile()).ok, true);
  const sub = path.join(s.repoRoot, 'sub');
  fs.mkdirSync(sub);
  const link = path.join(s.root, 'repo-sub-link');
  if (process.platform !== 'win32') {
    try { fs.symlinkSync(sub, link, 'dir'); } catch (error) { t.skip(`cannot create a directory link here: ${error.code}`); return; }
  }
  const raw = `${link}${path.sep}..${path.sep}private-data`;
  // The POSIX symlink makes the OS target repo/private-data; the Win32 case still checks that
  // textual dot-dot paths are rejected before an operation sees them.
  store.dir = raw;
  store.file = `${raw}${path.sep}store.json`;
  store.backupDir = `${raw}${path.sep}backups`;
  store.lock = new DirectoryLock(`${raw}${path.sep}store.lock`);
  const rawIo = watchRawPathIo(t, fs);

  for (const result of [
    store.get('profiles', 'p1'), store.list('profiles'), store.status(), store.exportMasked(),
    store.inspectLock(), store.recoverLock({ confirm: 'recover-stale-lock' }),
    store.transact((tx) => tx.put('profiles', 'p2', profile())), store.put('profiles', 'p2', profile()),
    store.delete('profiles', 'p1'), store.migrate(), store.clear({ confirm: CONFIRM_CLEAR })
  ]) {
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.reason, 'directory-rejected');
  }
  assert.deepEqual(rawIo, [], 'no filesystem operation receives the raw path');
  assert.equal(fs.existsSync(`${s.repoRoot}${path.sep}private-data`), false, 'the repository remains untouched');
});

test('lock inspection and recovery do not follow a link into the repository', (t) => {
  const s = sandbox(t);
  const store = open(s);
  store.put('profiles', 'p1', profile());
  if (!swapInLinkToRepository(t, s)) return;

  assertIntoRepo(store.inspectLock());
  assertIntoRepo(store.recoverLock({ confirm: 'recover-stale-lock' }));
  assert.equal(fs.existsSync(path.join(s.repoRoot, 'store.lock')), true, 'the lock file in the repository was not deleted');
});

test('a data directory that is a link with no target is refused before opening', (t) => {
  const s = sandbox(t);
  try {
    fs.symlinkSync(path.join(s.repoRoot, 'not-there'), s.dir, 'junction');
  } catch (error) {
    t.skip(`cannot create a directory link here: ${error.code}`);
    return;
  }
  assert.throws(() => open(s), (error) => error.problems?.includes('private-root-unresolvable'));
  assert.deepEqual(fs.readdirSync(s.repoRoot), [], 'nothing was created in the repository');
});

test('a data directory that does not exist yet reads as an empty store and is not created by reading', (t) => {
  const s = sandbox(t);
  const store = open(s);
  assert.deepEqual(store.list('profiles'), { ok: true, items: [] });
  assert.deepEqual(store.get('profiles', 'p1'), { ok: true, found: false, value: null });
  assert.equal(store.status().ok, true);
  assert.equal(store.exportMasked().ok, true);
  assert.deepEqual(store.inspectLock(), { ok: true, held: false });
  assert.deepEqual(store.recoverLock({ confirm: 'recover-stale-lock' }), { ok: true, recovered: false });
  assert.equal(fs.existsSync(s.dir), false);
});

test('reads refuse a data directory owned by someone else or replaced by a file', (t) => {
  const s = sandbox(t);
  const store = open(s);
  store.put('profiles', 'p1', profile());

  if (typeof process.getuid === 'function') {
    t.mock.method(process, 'getuid', () => 424242);
    const foreign = { ok: false, reason: 'directory-rejected', detail: 'not-owned' };
    assert.deepEqual(store.get('profiles', 'p1'), foreign);
    assert.deepEqual(store.list('profiles'), { ...foreign, items: [] });
    assert.deepEqual(store.exportMasked(), foreign);
    assert.equal(store.status().reason, 'directory-rejected');
    assert.deepEqual(store.inspectLock(), foreign);
    t.mock.restoreAll();
  }

  const other = sandbox(t);
  fs.writeFileSync(other.dir, 'a file where the directory should be');
  const blocked = open(other);
  assert.deepEqual(blocked.list('profiles'), { ok: false, reason: 'directory-rejected', detail: 'not-a-directory', items: [] });
  assert.equal(blocked.get('profiles', 'p1').reason, 'directory-rejected');
  assert.equal(blocked.status().reason, 'directory-rejected');
});
