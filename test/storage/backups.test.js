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
  const [name] = fs.readdirSync(dir).filter((entry) => entry.startsWith('store.v'));
  assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), original);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o600);
  }
});

const crypto = require('node:crypto');
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const backupsDir = (s) => path.join(s.dir, 'backups');
const manifestOf = (s) => JSON.parse(fs.readFileSync(path.join(backupsDir(s), 'manifest.json'), 'utf8'));
const names = (s) => fs.readdirSync(backupsDir(s)).sort();

// A store with one real backup (written by v1, migrated by v2); returns the file name.
function migrated(s) {
  const original = seed(s);
  const store = open(s, 2);
  assert.equal(store.migrate().ok, true);
  const [entry] = manifestOf(s).entries;
  return { store, original, entry };
}

test('the manifest is written with the backup, and names the file exactly as created', (t) => {
  const s = sandbox(t);
  const { original, entry } = migrated(s);
  assert.match(entry.name, /^store\.v1\.\d{8}T\d{9}Z\.json$/);
  assert.deepEqual([entry.sha256, entry.bytes, entry.fromVersion], [sha(original), Buffer.byteLength(original), 1]);
  assert.deepEqual(names(s), [entry.name, 'manifest.json'].sort());
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(backupsDir(s), 'manifest.json')).mode & 0o777, 0o600);
  }
});

test('an unrelated file whose name looks like a backup is not deleted by clear', (t) => {
  const s = sandbox(t);
  const { store, entry } = migrated(s);
  const dir = backupsDir(s);
  fs.writeFileSync(path.join(dir, 'store.v1.user-document.json'), 'unrelated user document');
  // Even the exact shape of a generated name proves nothing without a manifest entry.
  fs.writeFileSync(path.join(dir, 'store.v1.20260101T000000000Z.json'), 'another unrelated document');

  const outcome = store.clear({ confirm: CONFIRM_CLEAR });
  assert.deepEqual(outcome, { ok: true, removed: { store: true, backups: 1, temps: 0, kept: { unrecognized: 2 } } });
  assert.deepEqual(names(s), ['store.v1.20260101T000000000Z.json', 'store.v1.user-document.json']);
  assert.equal(fs.readFileSync(path.join(dir, 'store.v1.user-document.json'), 'utf8'), 'unrelated user document');
  assert.equal(fs.readFileSync(path.join(dir, 'store.v1.20260101T000000000Z.json'), 'utf8'), 'another unrelated document');
  assert.equal(fs.existsSync(path.join(dir, entry.name)), false, 'ours is gone');
});

test('a backup whose content changed, or that was replaced by a link, is kept and reported', (t) => {
  const s = sandbox(t);
  const { store, entry } = migrated(s);
  const dir = backupsDir(s);
  const file = path.join(dir, entry.name);

  fs.appendFileSync(file, ' edited');
  assert.deepEqual(store.clear({ confirm: CONFIRM_CLEAR }).removed.kept, { modified: 1 });
  assert.equal(fs.existsSync(file), true);
  assert.deepEqual(manifestOf(s).entries.map((e) => e.name), [entry.name], 'still listed, so a later clear can decide again');

  // Same size, different bytes.
  const original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, original.replace('Synthetic', 'Tampered!!'.slice(0, 9)));
  assert.equal(store.clear({ confirm: CONFIRM_CLEAR }).removed.kept.modified, 1);

  // Replaced by a link to a file outside the backups directory.
  const precious = path.join(s.repoRoot, 'precious.txt');
  fs.writeFileSync(precious, 'precious');
  fs.rmSync(file);
  try {
    fs.symlinkSync(precious, file, 'file');
  } catch (error) {
    t.skip(`cannot create a file link here: ${error.code}`);
    return;
  }
  assert.equal(store.clear({ confirm: CONFIRM_CLEAR }).removed.kept['not-regular'], 1);
  assert.equal(fs.readFileSync(precious, 'utf8'), 'precious');
});

test('a manifest entry whose file never appeared (crash between the two steps) is harmless', (t) => {
  const s = sandbox(t);
  const { store, entry } = migrated(s);
  const dir = backupsDir(s);
  const manifest = manifestOf(s);
  manifest.entries.push({ ...entry, name: 'store.v1.20260102T000000000Z.json' });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  assert.deepEqual(store.clear({ confirm: CONFIRM_CLEAR }),
    { ok: true, removed: { store: true, backups: 1, temps: 0, kept: {} } });
  assert.equal(fs.existsSync(dir), false, 'nothing left, so the directory is removed too');
});

test('an unusable manifest means nothing in the directory can be proven: all kept and reported', (t) => {
  for (const [label, bytes] of [
    ['not json', '{ nope'],
    ['wrong format', JSON.stringify({ format: 'other', entries: [] })],
    ['path traversal', JSON.stringify({ format: 'multiagent-private-store-backups',
      entries: [{ name: '../../outside.json', sha256: 'a'.repeat(64), bytes: 1 }] })],
    ['duplicate names', null]
  ]) {
    const s = sandbox(t);
    const { store, entry } = migrated(s);
    const dir = backupsDir(s);
    fs.writeFileSync(path.join(dir, 'manifest.json'),
      bytes === null ? JSON.stringify({ format: 'multiagent-private-store-backups', entries: [entry, entry] }) : bytes);
    const before = names(s);

    const outcome = store.clear({ confirm: CONFIRM_CLEAR });
    assert.equal(outcome.ok, true, label);
    assert.equal(outcome.removed.backups, 0, label);
    assert.equal(outcome.removed.store, true, label);
    assert.ok(outcome.removed.kept['manifest-unverified'] >= 1, label);
    assert.deepEqual(names(s), before, `${label}: nothing in the backups directory was touched`);
  }
});

test('a later backup sets an unusable manifest aside instead of overwriting it', (t) => {
  const s = sandbox(t);
  const { entry } = migrated(s);
  const dir = backupsDir(s);
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{ nope');

  // Another migration step: v2 -> v3 produces a second backup.
  const step3 = { from: 2, to: 3, up: (data) => data };
  const store = new PrivateStore({
    dir: s.dir, repoRoot: s.repoRoot, collections: COLLECTIONS, schemaVersion: 3, migrations: [keep, step3]
  });
  assert.equal(store.migrate().ok, true);

  const all = names(s);
  assert.ok(all.some((name) => /^manifest\.invalid\.\d{8}T\d{9}Z\.json$/.test(name)), 'the broken manifest was kept');
  assert.equal(fs.readFileSync(path.join(dir, all.find((name) => name.startsWith('manifest.invalid'))), 'utf8'), '{ nope');
  assert.equal(manifestOf(s).entries.length, 1, 'a fresh manifest lists only the new backup');
  assert.ok(all.includes(entry.name), 'the older backup is still there, now unproven');

  const outcome = store.clear({ confirm: CONFIRM_CLEAR });
  assert.equal(outcome.removed.backups, 1);
  assert.ok(outcome.removed.kept.unrecognized >= 1);
  assert.ok(fs.existsSync(path.join(dir, entry.name)), 'unproven backup kept');
});

test('a backup that fails to be created leaves no manifest entry or file behind', (t) => {
  const s = sandbox(t);
  const original = seed(s);
  let failNext = false;
  const io = {
    writeFile(target, text) {
      if (failNext && path.basename(target).startsWith('store.v')) throw Object.assign(new Error('x'), { code: 'ENOSPC' });
      const descriptor = fs.openSync(target, 'wx', 0o600);
      try { fs.writeFileSync(descriptor, text); } finally { fs.closeSync(descriptor); }
    }
  };
  failNext = true;
  const outcome = open(s, 2, { io }).migrate();
  assert.deepEqual([outcome.ok, outcome.detail], [false, 'backup-failed']);
  assert.deepEqual(names(s).filter((name) => name.startsWith('store.v')), []);
  assert.deepEqual(manifestOf(s).entries, [], 'the intent entry was rolled back');
  assert.equal(fs.readFileSync(path.join(s.dir, 'store.json'), 'utf8'), original);

  failNext = false;
  assert.equal(open(s, 2, { io }).migrate().ok, true, 'a retry works');
  assert.equal(manifestOf(s).entries.length, 1);
});

test('after clear, survivors stay listed and the manifest is dropped only when empty', (t) => {
  const s = sandbox(t);
  const { store, entry } = migrated(s);
  fs.appendFileSync(path.join(backupsDir(s), entry.name), 'x');
  store.clear({ confirm: CONFIRM_CLEAR });
  assert.equal(manifestOf(s).entries.length, 1);
  fs.writeFileSync(path.join(backupsDir(s), entry.name), fs.readFileSync(path.join(backupsDir(s), entry.name), 'utf8').slice(0, -1));
  assert.equal(store.clear({ confirm: CONFIRM_CLEAR }).removed.backups, 1);
  assert.equal(fs.existsSync(backupsDir(s)), false);
});

test('a manifest entry cannot name a path outside the backups directory', (t) => {
  const s = sandbox(t);
  const { store, entry } = migrated(s);
  const dir = backupsDir(s);
  const precious = path.join(s.dir, 'escape.json');
  fs.writeFileSync(precious, 'precious data');
  fs.mkdirSync(path.join(dir, 'store.v1.x'));
  const hostile = [
    'store.v1.x/../../escape.json',
    'store.v1.x\\..\\..\\escape.json',
    'store.v1.user-document.json',
    'store.v1.20260101T000000000Z.json/..'
  ];
  for (const name of hostile) {
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      format: 'multiagent-private-store-backups',
      entries: [{ name, sha256: sha('precious data'), bytes: Buffer.byteLength('precious data') }, entry]
    }));
    const outcome = store.clear({ confirm: CONFIRM_CLEAR });
    assert.equal(outcome.ok, true, name);
    assert.equal(outcome.removed.backups, 0, `${name}: nothing was deleted on the strength of that manifest`);
    assert.equal(fs.readFileSync(precious, 'utf8'), 'precious data', name);
    assert.ok(fs.existsSync(path.join(dir, entry.name)), `${name}: our own backup is kept too, since the manifest is unusable`);
    open(s, 2).put('profiles', 'again', { provider: 'claude' });
  }
});
