'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../../src/export/commands.ts'), 'utf8').replace(/\r\n/g, '\n');

test('the command takes no argument and opens the report in an unsaved editor', () => {
  assert.match(source, /registerCommand\(EXPORT_COMMANDS\.projectReport, \(\) => exportProjectReport\(\)\)/);
  assert.match(source, /openTextDocument\(\{ language: 'markdown', content: built\.markdown \}\)/);
});

test('nothing is written to the workspace or the repository by the export', () => {
  assert.doesNotMatch(source, /writeFile|appendFile|fs\.|createWriteStream|workspace\.fs|\.save\(|saveAs|rename|showSaveDialog/);
  assert.doesNotMatch(source, /Uri\.file|Uri\.from|untitled:/, 'the document is not tied to a path');
});

test('an untrusted workspace exports nothing, and a refused report shows why instead of opening anything', () => {
  assert.ok(source.indexOf('isTrusted') < source.indexOf('buildProjectReport(await'), 'trust is checked before anything is built');
  assert.match(source, /if \(!built\.ok\) \{.*showErrorMessage.*return; \}/);
});

test('the command is declared and activates on use', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
  assert.ok(manifest.contributes.commands.some((entry) => entry.command === 'multiagentSystem.export.projectReport' && /Export Project Report \(Markdown\)/.test(entry.title)));
  assert.ok(manifest.activationEvents.includes('onCommand:multiagentSystem.export.projectReport'));
});
