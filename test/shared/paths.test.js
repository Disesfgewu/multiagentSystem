'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const shared = require('../../src/shared/paths');
const memory = require('../../src/memory/paths');
const storage = require('../../src/storage/paths');

test('account memory and storage use one private path boundary', () => {
  assert.equal(memory.checkPrivateRoot, shared.checkPrivateRoot);
  assert.equal(storage.checkPrivateRoot, shared.checkPrivateRoot);
});

test('a dangling private root link fails closed for memory and storage', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multiagent-paths-'));
  try {
    const repo = path.join(root, 'repo');
    const link = path.join(root, 'broken-link');
    fs.mkdirSync(repo);
    try {
      fs.symlinkSync(path.join(root, 'missing-target'), link, 'dir');
    } catch (error) {
      if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('symlink creation unavailable');
      throw error;
    }
    for (const boundary of [memory, storage]) {
      for (const dir of [link, path.join(link, 'child')]) {
        assert.deepEqual(boundary.checkPrivateRoot(dir, repo).problems, ['private-root-unresolvable']);
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a directory created between realpath and lstat is rechecked once', () => {
  const failure = Object.assign(new Error('not present yet'), { code: 'ENOENT' });
  let calls = 0;
  const context = {
    platform: 'win32',
    realpath(value) {
      if (value.toLowerCase() === 'c:\\private') {
        calls += 1;
        if (calls === 1) throw failure;
      }
      return value;
    },
    isDirectory: () => true,
    lstat: () => ({ isSymbolicLink: () => false })
  };
  assert.equal(shared.checkPrivateRoot('C:\\private', 'C:\\repo', context).ok, true);
  assert.equal(calls, 2);

  const unresolved = { ...context, realpath: () => { throw failure; } };
  assert.deepEqual(shared.checkPrivateRoot('C:\\private', 'C:\\repo', unresolved).problems,
    ['private-root-unresolvable', 'repo-root-unresolvable']);
});
