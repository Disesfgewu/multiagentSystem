'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { executableAvailable } = require('../../src/providers/executable');

test('a synthetic agy binary on an absolute PATH is detected; absent and non-executable files are not', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-preflight-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fake = path.join(directory, 'agy');
  fs.writeFileSync(fake, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  assert.equal(executableAvailable('agy', { env: { PATH: directory }, platform: 'darwin' }), true);
  assert.equal(executableAvailable('missing', { env: { PATH: directory }, platform: 'darwin' }), false);
  assert.equal(executableAvailable('agy', { env: { PATH: directory }, platform: 'darwin',
    access: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } }), false);
  if (process.platform !== 'win32') {
    fs.chmodSync(fake, 0o600);
    assert.equal(executableAvailable('agy', { env: { PATH: directory }, platform: 'darwin' }), false);
  }
});

test('the preflight ignores relative PATH entries and rejects command text', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-relative-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.equal(executableAvailable('agy', { env: { PATH: `.${path.delimiter}${directory}` }, platform: 'darwin',
    stat: (target) => target === path.join('.', 'agy') ? { isFile: () => true } : fs.statSync(target), access: () => {} }), false);
  for (const name of ['agy --skip', '../agy', 'agy/other', 'agy\n', '']) {
    assert.equal(executableAvailable(name, { env: { PATH: directory } }), false);
  }
});

test('Windows lookup accepts PATHEXT executable names and a case-insensitive PATH key', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-win-preflight-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'agy.EXE'), 'synthetic executable');
  assert.equal(executableAvailable('agy', { env: { Path: directory, PATHEXT: '.EXE;.CMD' }, platform: 'win32' }), true);
});
