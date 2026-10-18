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

test('VSIX verifier accepts the bundled agent skill and template resources but still rejects .claude and other resources', () => {
  const resources = {
    'extension/resources/agent-skills/fetch-prs/SKILL.md': '---\nname: fetch-prs\ndescription: snapshot\n---\n',
    'extension/resources/agent-skills/raise-issue/SKILL.md': '---\nname: raise-issue\ndescription: issue\n---\n',
    'extension/resources/agent-templates/ISSUE_TEMPLATE/standard.md': '## Background',
    'extension/resources/agent-templates/pull_request_template.md': '### Changes'
  };
  assert.equal(verifyVsix(archive(resources), lock).fileCount, Object.keys(base).length + Object.keys(resources).length);
  assert.throws(() => verifyVsix(archive({ 'extension/.claude/skills/fetch-prs/SKILL.md': 'x' }), lock), /unexpected entry/);
  assert.throws(() => verifyVsix(archive({ 'extension/.claude/settings.local.json': '{}' }), lock), /unexpected entry/);
  assert.throws(() => verifyVsix(archive({ 'extension/resources/agent-skills/fetch-prs/run.sh': 'x' }), lock), /unexpected entry/);
  assert.throws(() => verifyVsix(archive({ 'extension/resources/agent-skills/../x/SKILL.md': 'x' }), lock), /unexpected entry/);
  assert.throws(() => verifyVsix(archive({ 'extension/resources/agent-skills/Fetch_PRs/SKILL.md': 'x' }), lock), /unexpected entry/);
  assert.throws(() => verifyVsix(archive({ 'extension/resources/other/file.md': 'x' }), lock), /unexpected entry/);
  assert.throws(() => verifyVsix(archive({ 'extension/resources/agent-skills/fetch-prs/SKILL.md': 'see /Users/alice/private/notes.md' }), lock), /publication scan blocked/);
});
