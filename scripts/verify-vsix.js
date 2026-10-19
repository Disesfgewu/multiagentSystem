'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { unzipSync } = require('fflate');
const { scanPublication } = require('../src/publish/scan');

const ROOT_FILES = new Set([
  'extension/package.json', 'extension/readme.md', 'extension/LICENSE.txt',
  'extension/THIRD_PARTY_NOTICES.md', 'extension/media/multiagent.svg'
]);
const META_FILES = new Set(['[Content_Types].xml', 'extension.vsixmanifest']);
const MUST_HAVE = [
  'extension/package.json', 'extension/LICENSE.txt', 'extension/THIRD_PARTY_NOTICES.md',
  'extension/out/src/extension.js', 'extension/out/packages/github-read-adapter/src/index.js',
  'extension/node_modules/fflate/LICENSE', 'extension/node_modules/fflate/lib/node.cjs'
];

function fail(reason) { throw new Error(`VSIX verification failed: ${reason}`); }
function readText(entries, name) { return Buffer.from(entries[name]).toString('utf8'); }

function allowed(name) {
  if (META_FILES.has(name) || ROOT_FILES.has(name)) return true;
  if (/^extension\/out\/(?:src|packages)\/[\w./-]+\.js$/.test(name)) return true;
  if (/^extension\/node_modules\/fflate\/[\w./-]+$/.test(name)) return true;
  if (/^extension\/resources\/agent-skills\/[a-z0-9][a-z0-9-]*\/SKILL\.md$/.test(name)) return true;
  if (name === 'extension/resources/agent-templates/ISSUE_TEMPLATE/standard.md' || name === 'extension/resources/agent-templates/pull_request_template.md') return true;
  return false;
}

function scanCode(name, source) {
  // The publication scanner's diff mode applies its code-literal refinement.
  const lines = source.split('\n');
  const diff = `diff --git a/${name} b/${name}\nnew file mode 100644\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}`;
  return scanPublication([{ kind: 'diff', text: diff }]);
}

function verifyVsix(archive, lock) {
  if (!lock?.packages?.['node_modules/fflate'] || lock.packages['node_modules/fflate'].version !== '0.8.3' || lock.packages['node_modules/fflate'].license !== 'MIT') fail('runtime dependency license/version differs from lockfile');
  let entries;
  try { entries = unzipSync(archive); } catch { fail('invalid ZIP archive'); }
  const names = Object.keys(entries);
  if (names.length > 300) fail('unexpected file count');
  for (const name of names) {
    if (!allowed(name) || name.includes('..') || name.includes('\\') || name.startsWith('/')) fail(`unexpected entry: ${name}`);
  }
  for (const name of MUST_HAVE) if (!entries[name]) fail(`missing entry: ${name}`);

  const manifest = JSON.parse(readText(entries, 'extension/package.json'));
  const expectedVersion = lock?.packages?.['']?.version;
  if (typeof expectedVersion !== 'string' || manifest.name !== 'multiagentsystem' || manifest.version !== expectedVersion) fail('extension identity/version differs from lockfile');
  if (manifest.main !== './out/src/extension.js' || manifest.license !== 'MIT' || JSON.stringify(manifest.dependencies) !== JSON.stringify({ fflate: '0.8.3' })) fail('unexpected runtime manifest');
  const notice = readText(entries, 'extension/THIRD_PARTY_NOTICES.md');
  if (!notice.includes('fflate 0.8.3') || !notice.includes('MIT License')) fail('missing runtime dependency notice');

  for (const name of names) {
    if (name.startsWith('extension/node_modules/')) continue; // npm ci pins these files by lockfile integrity.
    if (name === 'extension/out/src/publish/detectors.js' || name === 'extension/out/src/publish/scan.js') continue; // Scanner implementation contains deliberate detector examples.
    const source = readText(entries, name);
    const result = name.endsWith('.js') ? scanCode(name, source) : scanPublication([{ kind: 'pr-body', text: source }]);
    if (result.status !== 'clear' || result.truncated) fail(`publication scan ${result.status} for ${name}: ${result.findings.map((finding) => finding.code).join(',') || result.reason || 'incomplete'}`);
  }
  return { version: manifest.version, fileCount: names.length, runtimeDependencies: ['fflate 0.8.3 (MIT)'] };
}

if (require.main === module) {
  try {
    const target = process.argv[2];
    if (!target) fail('pass a VSIX file path');
    const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package-lock.json'), 'utf8'));
    const result = verifyVsix(fs.readFileSync(target), lock);
    process.stdout.write(`VSIX verified: ${result.fileCount} files; ${result.runtimeDependencies.join(', ')}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { verifyVsix };
