'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function watchRawPathIo(t, fs) {
  const calls = [];
  const methods = ['accessSync', 'appendFileSync', 'copyFileSync', 'lstatSync', 'mkdirSync', 'openSync', 'readFileSync', 'readdirSync', 'renameSync', 'rmSync', 'rmdirSync', 'statSync', 'unlinkSync', 'writeFileSync'];
  for (const name of methods) {
    if (typeof fs[name] !== 'function') continue;
    const original = fs[name];
    t.mock.method(fs, name, function watched(target, ...args) {
      if (typeof target === 'string' && target.split(/[\\/]/).includes('..')) calls.push({ operation: name, target });
      return original.call(this, target, ...args);
    });
  }
  const realpath = fs.realpathSync.native;
  t.mock.method(fs.realpathSync, 'native', function watched(target, ...args) {
    if (typeof target === 'string' && target.split(/[\\/]/).includes('..')) calls.push({ operation: 'realpathSync.native', target });
    return realpath.call(this, target, ...args);
  });
  return calls;
}

// A temporary repository directory next to a private data directory, both real.
function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multiagent-storage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, 'repo with space');
  const dir = path.join(root, '私人 資料');
  fs.mkdirSync(repoRoot);
  return { root, repoRoot, dir };
}

const COLLECTIONS = ['profiles', 'roleGroups', 'sessions', 'policies', 'teamRules', 'taskDispatches', 'usageLog'];
const failure = (code) => Object.assign(new Error(`synthetic ${code}`), { code });

module.exports = { sandbox, COLLECTIONS, failure, watchRawPathIo };
