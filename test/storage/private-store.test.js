'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { PrivateStore, CONFIRM_CLEAR } = require('../../src/storage/private-store');
const { sandbox, COLLECTIONS, failure } = require('./helpers');

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
  const run = (tag) => new Promise((resolve) => {
    const child = spawn(process.execPath, [worker, s.dir, s.repoRoot, tag, '5'], { stdio: 'ignore' });
    child.on('exit', (code) => resolve(code));
  });
  const codes = await Promise.all(['a', 'b', 'c', 'd'].map(run));
  assert.deepEqual(codes, [0, 0, 0, 0]);
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

test('a held lock fails the write with a reason; a stale lock is recovered; a foreign lock is not deleted', (t) => {
  const s = sandbox(t);
  fs.mkdirSync(s.dir);
  const lock = path.join(s.dir, 'store.lock');
  const quick = { retries: 2, waitMs: 1, staleMs: 60000 };

  fs.writeFileSync(lock, 'someone else\n');
  assert.deepEqual(open(s, { lock: quick }).put('profiles', 'p1', profile()), { ok: false, reason: 'locked' });
  assert.equal(fs.existsSync(lock), true);

  const old = new Date(Date.now() - 120000);
  fs.utimesSync(lock, old, old);
  assert.equal(open(s, { lock: quick }).put('profiles', 'p1', profile()).ok, true);
  assert.equal(fs.existsSync(lock), false);
});

test('clear requires confirmation, removes only owned files, and recovers a corrupt store', (t) => {
  const s = sandbox(t);
  const store = open(s);
  store.put('profiles', 'p1', profile());
  fs.mkdirSync(path.join(s.dir, 'backups'));
  fs.writeFileSync(path.join(s.dir, 'backups', 'store.v1.20260101T000000000Z.json'), '{}');
  fs.writeFileSync(path.join(s.dir, 'backups', 'notes.txt'), 'not ours');
  fs.writeFileSync(path.join(s.dir, 'unrelated.txt'), 'not ours');

  assert.equal(store.clear().reason, 'confirmation-required');
  assert.equal(store.clear({ confirm: 'yes' }).reason, 'confirmation-required');
  assert.equal(store.get('profiles', 'p1').found, true);

  assert.deepEqual(store.clear({ confirm: CONFIRM_CLEAR }), { ok: true, removed: { store: true, backups: 1, temps: 0 } });
  assert.deepEqual(listing(s.dir), ['backups', 'unrelated.txt']);
  assert.deepEqual(listing(path.join(s.dir, 'backups')), ['notes.txt']);
  assert.deepEqual(store.list('profiles'), { ok: true, items: [] });

  fs.writeFileSync(path.join(s.dir, 'store.json'), 'garbage');
  assert.equal(store.status().ok, false);
  assert.equal(store.clear({ confirm: CONFIRM_CLEAR }).ok, true);
  assert.equal(store.status().ok, true);
});

test('keeps backups when asked to', (t) => {
  const s = sandbox(t);
  const store = open(s);
  store.put('profiles', 'p1', profile());
  fs.mkdirSync(path.join(s.dir, 'backups'));
  fs.writeFileSync(path.join(s.dir, 'backups', 'store.v1.x.json'), '{}');
  assert.equal(store.clear({ confirm: CONFIRM_CLEAR, includeBackups: false }).removed.backups, 0);
  assert.deepEqual(listing(path.join(s.dir, 'backups')), ['store.v1.x.json']);
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
