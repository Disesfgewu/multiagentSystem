'use strict';

// Guards the private-data boundary of the read path: the adapter must not reach for the
// machine (environment, files, processes, credential stores) or for write verbs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readdirSync, readFileSync } = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const files = readdirSync(SRC).filter((name) => name.endsWith('.js'));

const strip = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('source files are present', () => {
  assert.ok(files.length >= 10);
});

test('only node:crypto is required from the platform, and no third-party packages', () => {
  for (const file of files) {
    const code = strip(readFileSync(path.join(SRC, file), 'utf8'));
    for (const match of code.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const target = match[1];
      assert.ok(target.startsWith('./') || target === 'node:crypto', `${file} requires ${target}`);
    }
  }
});

test('no access to environment, files, home directory, processes or credential helpers', () => {
  const forbidden = [
    /process\.env/,
    /process\.argv/,
    /\bchild_process\b/,
    /\bos\.homedir\b/,
    /node:(fs|os|child_process|net|http|https|tls|dns|worker_threads)/,
    /\bgh\s+auth\b/,
    /\.claude|\.codex|\.config|keychain|SecretStorage/i,
    /\bXMLHttpRequest\b/,
    /\bimport\s*\(/
  ];
  for (const file of files) {
    const code = strip(readFileSync(path.join(SRC, file), 'utf8'));
    for (const pattern of forbidden) assert.doesNotMatch(code, pattern, `${file} matches ${pattern}`);
  }
});

test('the only global network entry point is the injectable fetch transport', () => {
  const offenders = files.filter((file) => /\bfetch\(/.test(strip(readFileSync(path.join(SRC, file), 'utf8'))));
  assert.deepEqual(offenders, []); // transport.js calls the injected `fetchImpl`, not fetch directly
});

test('no HTTP write verbs are issued except the fixed GraphQL query POST', () => {
  for (const file of files) {
    const code = strip(readFileSync(path.join(SRC, file), 'utf8'));
    assert.doesNotMatch(code, /method:\s*['"](PUT|PATCH|DELETE)['"]/, file);
    const posts = [...code.matchAll(/method:\s*['"]POST['"]/g)];
    if (file !== 'client.js') assert.equal(posts.length, 0, `${file} must not POST`);
  }
  const client = strip(readFileSync(path.join(SRC, 'client.js'), 'utf8'));
  assert.equal([...client.matchAll(/method:\s*['"]POST['"]/g)].length, 1);
});

test('the checked-in GraphQL document is a query without mutations', () => {
  const { REVIEW_THREADS_QUERY } = require('../src/threads');
  assert.match(REVIEW_THREADS_QUERY, /^query\s/);
  assert.doesNotMatch(REVIEW_THREADS_QUERY, /mutation|subscription/);
});
