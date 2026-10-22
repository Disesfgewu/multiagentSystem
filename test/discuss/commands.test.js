'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../../src/discuss/commands.ts'), 'utf8').replace(/\r\n/g, '\n');

test('the command takes no argument: the selection, the question and the confirmation come from the window', () => {
  assert.match(source, /registerCommand\(DISCUSS_COMMANDS\.withPm, \(\) => discuss\(sessions, vscode\.window\.activeTextEditor\)\)/);
});

test('the code is checked before anything is asked of an agent, the target is the PM role only, and the selected text is re-checked after the confirmation', () => {
  assert.ok(source.indexOf('buildDiscussionPrompt({') < source.indexOf('await confirmAndType('), 'the prompt is built (and scanned) first');
  assert.match(source, /if \(!built\.ok\) \{[\s\S]*?return;\s*\}/);
  assert.match(source, /target: \{ scope: 'role', role: 'pm' \}/);
  assert.match(source, /const again = build\(document\.getText\(range\)\);\s*return again\.ok && again\.prompt === built\.prompt \? again\.prompt : null;/);
  assert.equal([...source.matchAll(/sendPrompt\(/g)].length, 0, 'this command never types by itself: the shared confirmation does');
});

test('only a project file or a pull request patch can be discussed, and the path sent is relative to the project folder', () => {
  assert.match(source, /document\.uri\.scheme === DIFF_SCHEME/);
  assert.match(source, /document\.uri\.scheme !== 'file'/);
  assert.match(source, /relative === '' \|\| relative\.startsWith\('\.\.'\)/);
});

test('the command is in the editor menu for a selection, in the palette only with a selection, and activates on use', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
  assert.ok(manifest.contributes.commands.some((entry) => entry.command === 'multiagentSystem.discuss.withPm' && entry.title === 'Discuss with PM Agent'));
  assert.ok(manifest.activationEvents.includes('onCommand:multiagentSystem.discuss.withPm'));
  const context = manifest.contributes.menus['editor/context'].find((entry) => entry.command === 'multiagentSystem.discuss.withPm');
  assert.match(context.when, /editorHasSelection/);
  assert.match(manifest.contributes.menus.commandPalette.find((entry) => entry.command === 'multiagentSystem.discuss.withPm').when, /editorHasSelection/);
});
