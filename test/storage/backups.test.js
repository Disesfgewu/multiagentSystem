'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PrivateStore, CONFIRM_CLEAR } = require('../../src/storage/private-store');
const { sandbox, COLLECTIONS } = require('./helpers');

const keep = { from: 1, to: 2, up: (data) => data };
const open = (s, version = 1, extra) => new PrivateStore({
  dir: s.dir, repoRoot: s.repoRoot, collections: COLLECTIONS, schemaVersion: version,
  migrations: version > 1 ? [keep] : [], ...extra
});

function seed(s) {
  open(s).put('profiles', 'p1', { provider: 'claude', name: 'Synthetic' });
  return fs.readFileSync(path.join(s.dir, 'store.json'), 'utf8');
}

function linkBackupsToRepo(t, s) {
  try {
    fs.symlinkSync(s.repoRoot, path.join(s.dir, 'backups'), 'junction');
    return true;
  } catch (error) {
    t.skip(`cannot create a directory link here: ${error.code}`);
    return false;
  }
}

test('a backups directory that links into the repository is refused: nothing is written to the repo', (t) => {
  const s = sandbox(t);
  const original = seed(s);
  if (!linkBackupsToRepo(t, s)) return;

  // Record every file the store tries to create: none may be attempted through the link.
  const attempted = [];
  const io = {
    writeFile(target, text) {
      attempted.push(target);
      const descriptor = fs.openSync(target, 'wx', 0o600);
      try { fs.writeFileSync(descriptor, text); } finally { fs.closeSync(descriptor); }
    }
  };
  const outcome = open(s, 2, { io }).migrate();
  assert.deepEqual([outcome.ok, outcome.reason, outcome.detail], [false, 'store-unavailable', 'backup-failed']);
  assert.deepEqual(attempted, [], 'the check happens before any write, so nothing even transiently lands in the repository');
  assert.deepEqual(fs.readdirSync(s.repoRoot), [], 'no private data in the repository');
  assert.equal(fs.readFileSync(path.join(s.dir, 'store.json'), 'utf8'), original, 'original untouched');
  const status = open(s, 2).status();
  assert.equal(status.ok, true, 'reads still work');
  assert.equal(open(s, 2).put('profiles', 'p2', { provider: 'codex' }).detail, 'backup-failed');
});

test('clear refuses a backups link before deleting anything, and never touches repository files', (t) => {
  const s = sandbox(t);
  const original = seed(s);
  fs.writeFileSync(path.join(s.repoRoot, 'store.v1.20260101.json'), 'a repository file');
  fs.writeFileSync(path.join(s.repoRoot, 'unrelated.txt'), 'keep');
  if (!linkBackupsToRepo(t, s)) return;

  const outcome = open(s).clear({ confirm: CONFIRM_CLEAR });
  assert.deepEqual([outcome.ok, outcome.reason], [false, 'backup-dir-rejected']);
  assert.deepEqual(fs.readdirSync(s.repoRoot).sort(), ['store.v1.20260101.json', 'unrelated.txt']);
  assert.equal(fs.readFileSync(path.join(s.repoRoot, 'store.v1.20260101.json'), 'utf8'), 'a repository file');
  assert.equal(fs.readFileSync(path.join(s.dir, 'store.json'), 'utf8'), original, 'the store was not removed either');

  // Skipping backups leaves the link alone and still clears the store.
  assert.equal(open(s).clear({ confirm: CONFIRM_CLEAR, includeBackups: false }).ok, true);
  assert.deepEqual(fs.readdirSync(s.repoRoot).sort(), ['store.v1.20260101.json', 'unrelated.txt']);
});

test('a backups entry that is a regular file, or a link to a file, is refused', (t) => {
  const s = sandbox(t);
  const original = seed(s);
  fs.writeFileSync(path.join(s.dir, 'backups'), 'not a directory');
  assert.equal(open(s, 2).migrate().detail, 'backup-failed');
  assert.equal(open(s).clear({ confirm: CONFIRM_CLEAR }).reason, 'backup-dir-rejected');
  assert.equal(fs.readFileSync(path.join(s.dir, 'store.json'), 'utf8'), original);
});

test('clear removes only regular backup files, not links that share a backup name', (t) => {
  const s = sandbox(t);
  seed(s);
  const backups = path.join(s.dir, 'backups');
  fs.mkdirSync(backups);
  fs.writeFileSync(path.join(backups, 'store.v1.real.json'), '{}');
  const outside = path.join(s.repoRoot, 'precious.txt');
  fs.writeFileSync(outside, 'precious');
  try {
    fs.symlinkSync(outside, path.join(backups, 'store.v1.link.json'), 'file');
  } catch (error) {
    t.skip(`cannot create a file link here: ${error.code}`);
    return;
  }
  const outcome = open(s).clear({ confirm: CONFIRM_CLEAR });
  assert.deepEqual(outcome, { ok: true, removed: { store: true, backups: 1, temps: 0 } });
  assert.equal(fs.readFileSync(outside, 'utf8'), 'precious');
  assert.deepEqual(fs.readdirSync(backups), ['store.v1.link.json'], 'the link was not followed and is left for the user');
});

test('a backups directory owned by someone else is refused, with the data directory itself still fine', (t) => {
  if (typeof process.getuid !== 'function') { t.skip('no uid on this platform'); return; }
  const s = sandbox(t);
  const original = seed(s);
  fs.mkdirSync(path.join(s.dir, 'backups'));
  fs.writeFileSync(path.join(s.dir, 'backups', 'store.v1.x.json'), '{}');

  // The data directory check runs first and sees the real user; the backups
  // directory check that follows sees a different owner.
  const realUid = process.getuid();
  let calls = 0;
  t.mock.method(process, 'getuid', () => (calls++ === 0 ? realUid : 424242));
  const result = open(s).clear({ confirm: CONFIRM_CLEAR });
  t.mock.restoreAll();

  assert.deepEqual([result.ok, result.reason, result.detail], [false, 'backup-dir-rejected', 'not-owned']);
  assert.equal(fs.readFileSync(path.join(s.dir, 'store.json'), 'utf8'), original);
  assert.deepEqual(fs.readdirSync(path.join(s.dir, 'backups')), ['store.v1.x.json']);
});

test('the backup directory is created private and holds the backup the migration made', (t) => {
  const s = sandbox(t);
  const original = seed(s);
  assert.equal(open(s, 2).migrate().ok, true);
  const dir = path.join(s.dir, 'backups');
  const [name] = fs.readdirSync(dir);
  assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), original);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o600);
  }
});
