'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkPrivateRoot } = require('../../src/memory/paths');

const identity = (value) => value;

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
    throw new Error('ENOENT');
  };
  const result = checkPrivateRoot('/data/link/new', '/work/repo', { platform: 'darwin', realpath });
  assert.deepEqual(result.problems, ['private-root-inside-repo']);
});
