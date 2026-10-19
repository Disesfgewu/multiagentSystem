'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { zipSync } = require('fflate');
const { createCandidate } = require('../../scripts/release-candidate');

const lock = { packages: { '': { version: '0.0.3' }, 'node_modules/fflate': { version: '0.8.3', license: 'MIT' } } };
const files = {
  '[Content_Types].xml': '<Types/>',
  'extension.vsixmanifest': '<PackageManifest/>',
  'extension/package.json': JSON.stringify({ name: 'multiagentsystem', version: '0.0.3', main: './out/src/extension.js', license: 'MIT', dependencies: { fflate: '0.8.3' } }),
  'extension/readme.md': 'Multiagent extension',
  'extension/LICENSE.txt': 'MIT License',
  'extension/THIRD_PARTY_NOTICES.md': 'fflate 0.8.3\nMIT License',
  'extension/media/multiagent.svg': '<svg/>',
  'extension/out/src/extension.js': 'module.exports = {};',
  'extension/out/packages/github-read-adapter/src/index.js': 'module.exports = {};',
  'extension/node_modules/fflate/LICENSE': 'MIT License',
  'extension/node_modules/fflate/lib/node.cjs': 'module.exports = {};'
};

test('candidate binds verified package version, full source commit and VSIX SHA-256', () => {
  const archive = Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, Buffer.from(value)]))));
  const candidate = createCandidate({ archive, archiveName: 'multiagentsystem.vsix', lock, sourceCommit: 'a'.repeat(40) });
  assert.deepEqual([candidate.release, candidate.version, candidate.prerelease], ['v0.0.3-beta', '0.0.3', true]);
  assert.equal(candidate.sourceCommit, 'a'.repeat(40));
  assert.match(candidate.artifact.sha256, /^[0-9a-f]{64}$/);
  assert.equal(candidate.artifact.bytes, archive.length);
  assert.equal(candidate.artifact.verifiedFileCount, Object.keys(files).length);
  assert.deepEqual(candidate.runtimeDependencies, ['fflate 0.8.3 (MIT)']);
});

test('candidate refuses ambiguous commits, paths and packages that fail VSIX verification', () => {
  const archive = Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, Buffer.from(value)]))));
  const input = { archive, archiveName: 'multiagentsystem.vsix', lock, sourceCommit: 'a'.repeat(40) };
  assert.throws(() => createCandidate({ ...input, sourceCommit: 'abc1234' }), /full lowercase Git commit/);
  assert.throws(() => createCandidate({ ...input, archiveName: '../candidate.vsix' }), /base name/);
  assert.throws(() => createCandidate({ ...input, lock: { packages: {} } }), /dependency license\/version/);
});
