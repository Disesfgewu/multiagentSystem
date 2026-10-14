'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkPrivateRoot } = require('../../src/memory/paths');

const identity = (value) => value;
const failure = (code) => Object.assign(new Error(`synthetic ${code}`), { code });

test('POSIX: accepts directories outside the repo and rejects inside or containing', () => {
  const ctx = { platform: 'darwin', realpath: identity };
  assert.deepEqual(checkPrivateRoot('/data/private', '/work/repo', ctx), { ok: true, problems: [] });
  assert.deepEqual(checkPrivateRoot('/work/repo/.private', '/work/repo', ctx).problems, ['private-root-inside-repo']);
  assert.deepEqual(checkPrivateRoot('/work', '/work/repo', ctx).problems, ['private-root-contains-repo']);
  assert.deepEqual(checkPrivateRoot('private', '/work/repo', ctx).problems, ['private-root-not-absolute']);
  assert.equal(checkPrivateRoot('/work/repo-private', '/work/repo', ctx).ok, true);
});

test('Windows: drive letters, case, spaces, Unicode, and drive-less paths', () => {
  const ctx = { platform: 'win32', realpath: identity };
  const repo = 'C:\\Users\\Me\\Repo With Space';
  assert.equal(checkPrivateRoot('D:\\private', repo, ctx).ok, true);
  assert.equal(checkPrivateRoot('C:\\Users\\Me\\私人資料', repo, ctx).ok, true);
  assert.deepEqual(
    checkPrivateRoot('c:\\users\\me\\repo with space\\.private', repo, ctx).problems,
    ['private-root-inside-repo']
  );
  assert.deepEqual(checkPrivateRoot('\\private', repo, ctx).problems, ['private-root-not-absolute']);
});

test('follows a link that leads into the repo through a missing directory', () => {
  const realpath = (value) => {
    if (value === '/data/link') return '/work/repo/inner';
    if (['/data', '/work/repo', '/'].includes(value)) return value;
    throw failure('ENOENT');
  };
  const result = checkPrivateRoot('/data/link/new', '/work/repo', { platform: 'darwin', realpath, isDirectory: () => true });
  assert.deepEqual(result.problems, ['private-root-inside-repo']);
});

test('errors other than ENOENT fail closed instead of looking like a missing directory', () => {
  for (const make of [() => failure('EACCES'), () => failure('ELOOP'), () => failure('ENOTDIR'), () => new Error('no code')]) {
    const realpath = (value) => {
      if (value === '/data/opaque') throw make();
      if (['/data', '/work/repo', '/'].includes(value)) return value;
      throw failure('ENOENT');
    };
    const ctx = { platform: 'darwin', realpath, isDirectory: () => true };
    assert.deepEqual(checkPrivateRoot('/data/opaque/new', '/work/repo', ctx),
      { ok: false, problems: ['private-root-unresolvable'] });
  }
  const repoDenied = (value) => {
    if (value === '/work/repo') throw failure('EACCES');
    if (['/', '/data'].includes(value)) return value;
    throw failure('ENOENT');
  };
  assert.deepEqual(checkPrivateRoot('/data/private', '/work/repo', { platform: 'darwin', realpath: repoDenied, isDirectory: () => true }),
    { ok: false, problems: ['repo-root-unresolvable'] });
});

// A small fake Windows file system: `existing` maps a path to "is a directory".
function fakeWindows(existing) {
  const index = new Map(Object.entries(existing).map(([key, value]) => [key.toLowerCase(), [key, value]]));
  return {
    platform: 'win32',
    realpath(value) {
      const hit = index.get(value.toLowerCase());
      if (!hit) throw failure('ENOENT');
      return hit[0];
    },
    isDirectory(value) {
      const hit = index.get(value.toLowerCase());
      if (!hit) throw failure('ENOENT');
      return hit[1];
    }
  };
}
const REPO = 'C:\\work\\repo with space';
const baseWindows = { 'C:\\': true, 'C:\\work': true, [REPO]: true };

test('a drive that does not exist fails closed: ENOENT at every level means nothing was verified', () => {
  const fake = fakeWindows(baseWindows);
  assert.deepEqual(checkPrivateRoot('Z:\\managed\\acct', REPO, fake), { ok: false, problems: ['private-root-unresolvable'] });
  assert.deepEqual(checkPrivateRoot('Z:\\', REPO, fake).problems, ['private-root-unresolvable']);
  assert.deepEqual(checkPrivateRoot('\\\\nohost\\share\\acct', REPO, fake).problems, ['private-root-unresolvable']);
  const none = { platform: 'win32', realpath: () => { throw failure('ENOENT'); } };
  assert.deepEqual(checkPrivateRoot('Z:\\managed\\acct', REPO, none).problems, ['private-root-unresolvable', 'repo-root-unresolvable']);
  assert.deepEqual(checkPrivateRoot('D:\\data', 'Z:\\repo', fakeWindows({ 'D:\\': true })).problems, ['repo-root-unresolvable']);
});

test('a new subdirectory below an existing directory is accepted; below a regular file it is not', () => {
  const fake = fakeWindows({ ...baseWindows, 'D:\\': true, 'D:\\data': true, 'D:\\notes.txt': false });
  assert.deepEqual(checkPrivateRoot('D:\\data\\accounts\\one', REPO, fake), { ok: true, problems: [] });
  assert.deepEqual(checkPrivateRoot('D:\\new\\deeper\\one', REPO, fake), { ok: true, problems: [] });
  assert.deepEqual(checkPrivateRoot('D:\\notes.txt\\acct', REPO, fake).problems, ['private-root-unresolvable']);
  assert.deepEqual(checkPrivateRoot('D:\\notes.txt\\a\\b\\c', REPO, fake).problems, ['private-root-unresolvable']);
});

test('a failing directory check fails closed, and an existing path needs no such check', () => {
  const base = fakeWindows({ ...baseWindows, 'D:\\': true });
  assert.deepEqual(checkPrivateRoot('D:\\acct\\new', REPO, { ...base, isDirectory: () => { throw failure('EACCES'); } }).problems,
    ['private-root-unresolvable']);
  assert.equal(checkPrivateRoot('D:\\', REPO, { ...base, isDirectory: () => { throw new Error('not consulted'); } }).ok, true);
});

test('real file system: below a regular file is unresolvable here too, a fresh directory is accepted', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multiagent-paths-'));
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(root, 'plain.txt'), 'x');
    assert.deepEqual(checkPrivateRoot(path.join(root, 'plain.txt', 'acct'), repo).problems, ['private-root-unresolvable']);
    assert.deepEqual(checkPrivateRoot(path.join(root, 'fresh', 'acct'), repo), { ok: true, problems: [] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
