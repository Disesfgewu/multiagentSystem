'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A temporary repository directory next to a private data directory, both real.
function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multiagent-storage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, 'repo with space');
  const dir = path.join(root, '私人 資料');
  fs.mkdirSync(repoRoot);
  return { root, repoRoot, dir };
}

const COLLECTIONS = ['profiles', 'roleGroups', 'sessions', 'policies'];
const failure = (code) => Object.assign(new Error(`synthetic ${code}`), { code });

module.exports = { sandbox, COLLECTIONS, failure };
