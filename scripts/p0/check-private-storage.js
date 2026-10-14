#!/usr/bin/env node
'use strict';

// Reproducible check of the private data store on this machine, using synthetic
// data in a temporary directory that is removed afterwards. No network, no
// credentials, no CLI is started.
//
//   node scripts/p0/check-private-storage.js [--repo <path>]
//
// Exit code 0: every check passed. 1: at least one failed. 2: usage.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PrivateStore, CONFIRM_CLEAR } = require('../../src/storage/private-store');

const results = [];
const record = (name, pass, detail) => results.push({ name, status: pass ? 'pass' : 'fail', detail: detail ?? null });
const skip = (name, detail) => results.push({ name, status: 'skipped', detail });

function parseArgs(argv) {
  const options = { repo: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--repo') options.repo = path.resolve(argv[++i] || '');
    else return null;
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    console.error('usage: check-private-storage.js [--repo <path>]');
    return 2;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multiagent-p0-storage-'));
  try {
    const collections = ['profiles', 'sessions'];
    const dir = path.join(root, 'data with space 資料');
    const migrations = [{
      from: 1, to: 2,
      up(data) {
        for (const item of Object.values(data.collections.profiles)) { item.label = item.name; delete item.name; }
        return data;
      }
    }];
    const make = (version, extra) => new PrivateStore({
      dir, repoRoot: options.repo, collections, schemaVersion: version, migrations: version > 1 ? migrations : [], ...extra
    });

    const gitStatus = () => spawnSync('git', ['-C', options.repo, 'status', '--porcelain', '--ignored'], { encoding: 'utf8' });
    const gitBefore = gitStatus();

    let insideRejected = false;
    try {
      make(1, { dir: path.join(options.repo, '.private-data') });
    } catch (error) {
      insideRejected = Array.isArray(error.problems) && error.problems.includes('private-root-inside-repo');
    }
    record('a data directory inside the repository is rejected', insideRejected);

    const v1 = make(1);
    v1.put('profiles', 'p1', { provider: 'claude', name: 'Synthetic' });
    record('write and read back', v1.get('profiles', 'p1').found === true);
    record('credentials are refused', v1.put('profiles', 'p2', { apiKey: 'synthetic' }).reason === 'secret-detected');

    const original = fs.readFileSync(path.join(dir, 'store.json'), 'utf8');
    const failing = make(2, { io: { rename() { throw Object.assign(new Error('x'), { code: 'EIO' }); } } });
    const failed = failing.put('profiles', 'p3', { provider: 'codex', label: 'x' });
    record('a failed write after a migration leaves the original in place',
      failed.ok === false && fs.readFileSync(path.join(dir, 'store.json'), 'utf8') === original, failed.detail);

    const v2 = make(2);
    const migrated = v2.put('profiles', 'p3', { provider: 'codex', label: 'Two' });
    const backupDir = path.join(dir, 'backups');
    const kept = fs.existsSync(backupDir)
      ? fs.readdirSync(backupDir).filter((name) => fs.readFileSync(path.join(backupDir, name), 'utf8') === original)
      : [];
    record('migration succeeds and a backup of the original version exists', migrated.ok === true && kept.length >= 1);
    record('migrated data is readable', v2.get('profiles', 'p1').value.label === 'Synthetic');

    fs.writeFileSync(path.join(dir, 'store.json'), '{ truncated');
    const before = fs.readFileSync(path.join(dir, 'store.json'), 'utf8');
    const refused = v2.put('profiles', 'p4', { provider: 'claude' });
    record('a corrupt file is preserved and writes are refused',
      refused.reason === 'store-unavailable' && fs.readFileSync(path.join(dir, 'store.json'), 'utf8') === before);
    // An unrelated file whose name looks like a backup must survive `clear`; only a
    // backup the manifest proves we wrote (and whose content is unchanged) is deleted.
    const stranger = path.join(dir, 'backups', 'store.v1.user-document.json');
    fs.writeFileSync(stranger, 'unrelated user document');
    const cleared = v2.clear({ confirm: CONFIRM_CLEAR });
    record('clear recovers a corrupt store', cleared.ok === true && v2.status().ok === true);
    record('clear keeps an unrelated file that is named like a backup',
      fs.existsSync(stranger) && fs.readFileSync(stranger, 'utf8') === 'unrelated user document' &&
      cleared.removed.backups === 1 && cleared.removed.kept && cleared.removed.kept.unrecognized === 1);

    v2.put('profiles', 'p5', { provider: 'claude', label: 'Visible only to the owner' });
    const exported = JSON.stringify(v2.exportMasked());
    record('the masked export contains no stored value',
      !exported.includes('Visible only') && !exported.includes(dir) && !exported.includes('p5'));

    // A backups directory that links into the repository must be refused before
    // anything is written there, and clearing must not touch repository files.
    const linkRoot = path.join(root, 'linked');
    fs.mkdirSync(linkRoot);
    const linkedDir = path.join(linkRoot, 'data');
    const linked = new PrivateStore({ dir: linkedDir, repoRoot: options.repo, collections, schemaVersion: 1 });
    linked.put('profiles', 'p1', { provider: 'claude', name: 'Synthetic' });
    let linkMade = true;
    try {
      fs.symlinkSync(options.repo, path.join(linkedDir, 'backups'), 'junction');
    } catch {
      linkMade = false;
    }
    if (linkMade) {
      const repoBefore = fs.readdirSync(options.repo).sort().join('\n');
      const migrating = new PrivateStore({
        dir: linkedDir, repoRoot: options.repo, collections, schemaVersion: 2, migrations
      });
      const refusedMigration = migrating.migrate();
      const refusedClear = migrating.clear({ confirm: CONFIRM_CLEAR });
      record('a backups link into the repository is refused and the repository is untouched',
        refusedMigration.ok === false && refusedClear.ok === false &&
        fs.readdirSync(options.repo).sort().join('\n') === repoBefore);
      fs.unlinkSync(path.join(linkedDir, 'backups'));
    } else {
      skip('a backups link into the repository is refused and the repository is untouched', 'cannot create a directory link here');
    }

    const gitAfter = gitStatus();
    if (gitBefore.status === 0 && gitAfter.status === 0) {
      record('git status of the repository is unchanged by the stored data', gitBefore.stdout === gitAfter.stdout);
    } else {
      skip('git status of the repository is unchanged by the stored data', 'the repository path is not a git work tree');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const failed = results.filter((entry) => entry.status === 'fail').length;
  console.log(JSON.stringify({
    observedAt: new Date().toISOString(),
    platform: process.platform,
    node: process.version,
    results,
    summary: {
      pass: results.filter((entry) => entry.status === 'pass').length,
      fail: failed,
      skipped: results.filter((entry) => entry.status === 'skipped').length
    }
  }, null, 2));
  return failed === 0 ? 0 : 1;
}

process.exitCode = main();
