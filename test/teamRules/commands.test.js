'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../../src/teamRules/commands.ts'), 'utf8').replace(/\r\n/g, '\n');

test('the command takes no argument, so nothing a caller passes can write a rule every agent will be told', () => {
  assert.match(source, /registerCommand\(TEAM_RULES_COMMANDS\.edit, \(\) => edit\(\)\)/);
  assert.match(source, /async function edit\(\): Promise<void>/);
});

test('a change is saved only after a modal confirmation, once, on top of the version that was shown', () => {
  assert.match(source, /showWarningMessage\(\s*'Change the rules every agent is given\?', \{ modal: true/);
  assert.match(source, /if \(confirmed !== 'Save'\) return;/);
  assert.equal([...source.matchAll(/store\.save\(/g)].length, 1);
  assert.ok(source.indexOf("confirmed !== 'Save'") < source.indexOf('store.save('), 'the confirmation comes first');
  assert.match(source, /store\.save\(next\.doc, doc\.version\)/);
});

test('the command is declared and activates on use', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
  assert.ok(manifest.contributes.commands.some((entry) => entry.command === 'multiagentSystem.teamRules.edit' && /Edit Team Rules/.test(entry.title)));
  assert.ok(manifest.activationEvents.includes('onCommand:multiagentSystem.teamRules.edit'));
});
