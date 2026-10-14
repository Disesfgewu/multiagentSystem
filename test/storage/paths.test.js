'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { checkPrivateRoot, canonicalize, pathFor } = require('../../src/storage/paths');
const { sandbox, failure } = require('./helpers');

const win = { platform: 'win32' };
const repo = 'C:\\work\\repo with space';

// A fake file system: `existing` maps a path to whether it is a directory.
function fakeFs(existing) {
  const lower = new Map(Object.entries(existing).map(([key, value]) => [key.toLowerCase(), [key, value]]));
  return {
    realpath(value) {
      const hit = lower.get(value.toLowerCase());
      if (!hit) throw failure('ENOENT');
      return hit[0];
    },
    isDirectory(value) {
      const hit = lower.get(value.toLowerCase());
      if (!hit) throw failure('ENOENT');
      return hit[1];
    }
  };
}

test('a drive that does not exist is not "not created yet": every ancestor is ENOENT, so it fails closed', () => {
  const none = fakeFs({ 'C:\\': true, 'C:\\work': true, [repo]: true });
  const result = checkPrivateRoot('Z:\\managed\\acct', repo, { ...win, ...none });
  assert.deepEqual(result, { ok: false, problems: ['private-root-unresolvable'] });
  assert.deepEqual(checkPrivateRoot('Z:\\', repo, { ...win, ...none }).problems, ['private-root-unresolvable']);
  assert.deepEqual(checkPrivateRoot('\\\\nohost\\share\\acct', repo, { ...win, ...none }).problems,
    ['private-root-unresolvable']);
});

test('a repository on an unresolvable drive is reported as unverified', () => {
  const fake = fakeFs({ 'D:\\': true });
  assert.deepEqual(checkPrivateRoot('D:\\data', 'Z:\\repo', { ...win, ...fake }).problems, ['repo-root-unresolvable']);
});

test('a new subdirectory below an existing directory is accepted', () => {
  const fake = fakeFs({ 'C:\\': true, 'C:\\work': true, [repo]: true, 'D:\\': true, 'D:\\data': true });
  assert.deepEqual(checkPrivateRoot('D:\\data\\accounts\\one', repo, { ...win, ...fake }), { ok: true, problems: [] });
  assert.deepEqual(checkPrivateRoot('D:\\new\\deeper\\one', repo, { ...win, ...fake }), { ok: true, problems: [] });
});

test('Windows reports ENOENT below a regular file: that is not a directory that can be created', () => {
  const fake = fakeFs({ 'C:\\': true, 'C:\\work': true, [repo]: true, 'D:\\': true, 'D:\\notes.txt': false });
  assert.deepEqual(checkPrivateRoot('D:\\notes.txt\\acct', repo, { ...win, ...fake }).problems, ['private-root-unresolvable']);
  assert.deepEqual(checkPrivateRoot('D:\\notes.txt\\a\\b\\c', repo, { ...win, ...fake }).problems, ['private-root-unresolvable']);
});

test('an existing path needs no directory check, and a failing check fails closed', () => {
  const fake = fakeFs({ 'C:\\': true, 'C:\\work': true, [repo]: true, 'D:\\': true });
  assert.equal(checkPrivateRoot('D:\\', repo, { ...win, ...fake, isDirectory: () => { throw new Error('unexpected'); } }).ok, true);
  const denied = { ...fake, isDirectory: () => { throw failure('EACCES'); } };
  assert.deepEqual(checkPrivateRoot('D:\\data\\acct', repo, { ...win, ...denied }).problems, ['private-root-unresolvable']);
});

test('case-insensitive Windows paths still detect the repository', () => {
  const fake = fakeFs({ 'C:\\': true, 'C:\\work': true, [repo]: true });
  assert.deepEqual(checkPrivateRoot('c:\\WORK\\REPO WITH SPACE\\.private', repo, { ...win, ...fake }).problems,
    ['private-root-inside-repo']);
});

test('real file system: below a regular file is unresolvable on this platform too', (t) => {
  const s = sandbox(t);
  fs.mkdirSync(s.dir);
  fs.writeFileSync(path.join(s.dir, 'plain.txt'), 'x');
  assert.deepEqual(checkPrivateRoot(path.join(s.dir, 'plain.txt', 'acct'), s.repoRoot).problems, ['private-root-unresolvable']);
  assert.deepEqual(checkPrivateRoot(path.join(s.dir, 'fresh', 'acct'), s.repoRoot), { ok: true, problems: [] });
});

test('canonicalize on the real file system keeps the missing tail', (t) => {
  const s = sandbox(t);
  const p = pathFor(process.platform);
  const real = canonicalize(path.join(s.root, 'missing', 'leaf'), p, fs.realpathSync.native, (v) => fs.statSync(v).isDirectory());
  assert.equal(real, path.join(fs.realpathSync.native(s.root), 'missing', 'leaf'));
});
