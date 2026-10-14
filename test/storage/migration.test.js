'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PrivateStore } = require('../../src/storage/private-store');
const { sandbox, COLLECTIONS, failure } = require('./helpers');

// v1: profiles use `name`. v2: renamed to `label`. v3: sessions gain `status`.
const toV2 = {
  from: 1, to: 2,
  up(data) {
    for (const record of Object.values(data.collections.profiles)) {
      record.label = record.name;
      delete record.name;
    }
    return data;
  }
};
const toV3 = {
  from: 2, to: 3,
  up(data) {
    for (const record of Object.values(data.collections.sessions)) record.status = record.status || 'unknown';
    return data;
  }
};

const open = (s, version, migrations, extra) => new PrivateStore({
  dir: s.dir, repoRoot: s.repoRoot, collections: COLLECTIONS, schemaVersion: version, migrations, ...extra
});
const file = (s) => path.join(s.dir, 'store.json');
const backups = (s) => (fs.existsSync(path.join(s.dir, 'backups')) ? fs.readdirSync(path.join(s.dir, 'backups')).sort() : []);

function seedV1(s) {
  const v1 = open(s, 1, []);
  v1.put('profiles', 'p1', { provider: 'claude', name: 'Synthetic one' });
  v1.put('sessions', 's1', { provider: 'claude' });
  return fs.readFileSync(file(s), 'utf8');
}

test('the migration chain must be complete and made of single steps', (t) => {
  const s = sandbox(t);
  assert.throws(() => open(s, 3, [toV2]), /missing migration from version 2/);
  assert.throws(() => open(s, 2, [{ from: 1, to: 3, up: (d) => d }]), TypeError);
  assert.throws(() => open(s, 3, [toV2, toV2, toV3]), TypeError);
  assert.doesNotThrow(() => open(s, 3, [toV2, toV3]));
});

test('reads see migrated data without writing anything', (t) => {
  const s = sandbox(t);
  const before = seedV1(s);
  const store = open(s, 3, [toV2, toV3]);
  assert.deepEqual(store.status(), {
    ok: true, reason: null, detail: null, schemaVersion: 3, onDiskVersion: 1, pendingMigration: true,
    ...(process.platform === 'win32' ? {} : { looseFileMode: false })
  });
  assert.deepEqual(store.get('profiles', 'p1').value, { provider: 'claude', label: 'Synthetic one' });
  assert.equal(store.get('sessions', 's1').value.status, 'unknown');
  assert.equal(fs.readFileSync(file(s), 'utf8'), before, 'reading never rewrites the file');
  assert.deepEqual(backups(s), []);
});

test('the first write backs up the original, then persists the migration', (t) => {
  const s = sandbox(t);
  const before = seedV1(s);
  const store = open(s, 3, [toV2, toV3]);
  assert.equal(store.put('profiles', 'p2', { provider: 'codex', label: 'Two' }).ok, true);

  const saved = backups(s);
  assert.equal(saved.length, 1);
  assert.match(saved[0], /^store\.v1\./);
  assert.equal(fs.readFileSync(path.join(s.dir, 'backups', saved[0]), 'utf8'), before);
  const disk = JSON.parse(fs.readFileSync(file(s), 'utf8'));
  assert.equal(disk.schemaVersion, 3);
  assert.deepEqual(disk.collections.profiles.p1, { provider: 'claude', label: 'Synthetic one' });
  assert.equal(store.status().pendingMigration, false);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(s.dir, 'backups', saved[0])).mode & 0o777, 0o600);
  }
});

test('explicit migrate() applies a pending migration and is a no-op afterwards', (t) => {
  const s = sandbox(t);
  seedV1(s);
  const store = open(s, 2, [toV2]);
  assert.deepEqual(store.migrate(), { ok: true, onDiskVersion: 2 });
  assert.equal(backups(s).length, 1);
  assert.deepEqual(store.migrate(), { ok: true, onDiskVersion: 2 });
  assert.equal(backups(s).length, 1, 'no second backup when nothing changed');
});

test('a migration that throws leaves the original file untouched and blocks writes', (t) => {
  const s = sandbox(t);
  const before = seedV1(s);
  const broken = { from: 1, to: 2, up() { throw new Error('contains Synthetic one'); } };
  const store = open(s, 2, [broken]);

  assert.equal(store.status().reason, 'migration-failed');
  assert.equal(store.status().detail, 'step 1->2: threw');
  const result = store.put('profiles', 'p2', { provider: 'codex' });
  assert.deepEqual([result.reason, result.detail], ['store-unavailable', 'migration-failed']);
  assert.equal(JSON.stringify(result).includes('Synthetic one'), false, 'the migration error text is not surfaced');
  assert.equal(fs.readFileSync(file(s), 'utf8'), before);
  assert.deepEqual(backups(s), []);
  assert.equal(fs.existsSync(path.join(s.dir, 'store.lock')), false);
});

test('a migration that returns invalid data, drops the envelope or adds a secret is rejected', (t) => {
  const bad = {
    'invalid record': (d) => { d.collections.profiles.p1 = 'not an object'; return d; },
    'unknown collection': (d) => { d.collections.bogus = {}; return d; },
    'bad id': (d) => { d.collections.profiles['../x'] = {}; return d; },
    'not an object': () => null,
    'secret added': (d) => { d.collections.profiles.p1.apiKey = 'x'; return d; },
    'secret value added': (d) => { d.collections.profiles.p1.note = 'ghp_syntheticsyntheticsynthetic1234'; return d; }
  };
  for (const [name, up] of Object.entries(bad)) {
    const s = sandbox(t);
    const before = seedV1(s);
    const store = open(s, 2, [{ from: 1, to: 2, up }]);
    assert.equal(store.put('profiles', 'p2', { provider: 'codex' }).reason, 'store-unavailable', name);
    assert.equal(store.status().reason, 'migration-failed', name);
    assert.equal(fs.readFileSync(file(s), 'utf8'), before, name);
  }
});

test('a migration does not mutate the data it was given on failure', (t) => {
  const s = sandbox(t);
  const before = seedV1(s);
  const half = {
    from: 1, to: 2,
    up(data) {
      data.collections.profiles.p1.label = 'half done';
      throw new Error('fails after changing the copy');
    }
  };
  const store = open(s, 2, [half]);
  store.put('profiles', 'x', {});
  assert.equal(fs.readFileSync(file(s), 'utf8'), before);
});

test('a failed backup or a failed write after the backup keeps the original data', (t) => {
  const s = sandbox(t);
  const before = seedV1(s);

  const noBackup = open(s, 2, [toV2], {
    io: { writeFile(target, text) { if (target.includes('backups')) throw failure('ENOSPC'); fs.writeFileSync(target, text); } }
  });
  const first = noBackup.put('profiles', 'p2', { provider: 'codex' });
  assert.deepEqual([first.reason, first.detail], ['store-unavailable', 'backup-failed']);
  assert.equal(fs.readFileSync(file(s), 'utf8'), before);
  assert.deepEqual(backups(s), []);

  const noWrite = open(s, 2, [toV2], { io: { rename() { throw failure('EIO'); } } });
  const second = noWrite.put('profiles', 'p2', { provider: 'codex' });
  assert.deepEqual([second.reason, second.detail], ['store-unavailable', 'write-failed']);
  assert.equal(fs.readFileSync(file(s), 'utf8'), before, 'original still in place');
  assert.equal(backups(s).length, 1, 'the backup that was made is kept');
  assert.deepEqual(fs.readdirSync(s.dir).filter((name) => name.endsWith('.tmp')), []);

  assert.equal(open(s, 2, [toV2]).put('profiles', 'p2', { provider: 'codex' }).ok, true, 'retry succeeds');
  assert.equal(JSON.parse(fs.readFileSync(file(s), 'utf8')).schemaVersion, 2);
});

test('two backups in the same instant get distinct names and neither is overwritten', (t) => {
  const s = sandbox(t);
  const fixed = Date.parse('2026-01-01T00:00:00.000Z');
  seedV1(s);
  const a = open(s, 2, [toV2], { now: () => fixed });
  a.migrate();
  const original = backups(s)[0];
  // Put a v1 file back and migrate again at the same instant.
  fs.writeFileSync(file(s), JSON.stringify({
    format: 'multiagent-private-store', schemaVersion: 1,
    collections: { profiles: { p9: { provider: 'claude', name: 'Other' } } }
  }));
  open(s, 2, [toV2], { now: () => fixed }).migrate();
  assert.equal(backups(s).length, 2);
  assert.ok(backups(s).includes(original));
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, 'backups', original), 'utf8')).collections.profiles.p1.name,
    'Synthetic one', 'the first backup still holds the first data');
});
