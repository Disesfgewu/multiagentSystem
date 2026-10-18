'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { zipSync } = require('fflate');
const { verifyVsix } = require('../../scripts/verify-vsix');

const lock = { packages: { 'node_modules/fflate': { version: '0.8.3', license: 'MIT' } } };
const base = {
  '[Content_Types].xml': '<Types/>',
  'extension.vsixmanifest': '<PackageManifest/>',
  'extension/package.json': JSON.stringify({ main: './out/src/extension.js', license: 'MIT', dependencies: { fflate: '0.8.3' } }),
  'extension/readme.md': 'Multiagent extension',
  'extension/LICENSE.txt': 'MIT License',
  'extension/THIRD_PARTY_NOTICES.md': 'fflate 0.8.3\nMIT License',
  'extension/media/multiagent.svg': '<svg/>',
  'extension/out/src/extension.js': 'module.exports = {};',
  'extension/out/packages/github-read-adapter/src/index.js': 'module.exports = {};',
  'extension/node_modules/fflate/LICENSE': 'MIT License',
  'extension/node_modules/fflate/lib/node.cjs': 'module.exports = {};'
};

function archive(overrides = {}) {
  return zipSync(Object.fromEntries(Object.entries({ ...base, ...overrides }).map(([name, value]) => [name, Buffer.from(value)])));
}

test('VSIX verifier accepts only the intended runtime files with the locked MIT dependency', () => {
  assert.equal(verifyVsix(archive(), lock).fileCount, Object.keys(base).length);
  assert.throws(() => verifyVsix(archive({ 'extension/test/private.txt': 'secret' }), lock), /unexpected entry/);
  assert.throws(() => verifyVsix(archive({ 'extension/out/test/unit/foo.js': 'module.exports = 1' }), lock), /unexpected entry/);
  assert.throws(() => verifyVsix(archive(), { packages: { 'node_modules/fflate': { version: '0.8.3', license: 'unknown' } } }), /license\/version/);
});

test('VSIX verifier rejects private paths in packaged text and altered runtime metadata', () => {
  assert.throws(() => verifyVsix(archive({ 'extension/readme.md': 'Private file: /Users/alice/private/session.json' }), lock), /publication scan blocked/);
  assert.throws(() => verifyVsix(archive({ 'extension/package.json': JSON.stringify({ main: './out/src/extension.js', license: 'MIT', dependencies: { fflate: '9.9.9' } }) }), lock), /runtime manifest/);
});
