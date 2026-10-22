'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../../src/memoryPanel/commands.ts'), 'utf8').replace(/\r\n/g, '\n');

test('no command takes an argument: the role group, the text, the choice of note and the confirmation come from the windows', () => {
  const registrations = [...source.matchAll(/registerCommand\(MEMORY_COMMANDS\.(\w+), ([^\n]*)\),?\n/g)];
  assert.deepEqual(registrations.map((entry) => entry[1]).sort(), ['add', 'edit', 'refresh', 'remove', 'review', 'suggest', 'toggle']);
  for (const entry of registrations) assert.match(entry[2], /^\(\) => /, `${entry[1]} ignores arguments`);
});

test('every change to a note is confirmed in a modal, and nothing is adopted without a named approver', () => {
  for (const title of ['Add this shared note?', 'Replace this shared note?', 'Delete this shared note?', 'Review this suggested note']) assert.match(source, new RegExp(`showWarningMessage\\(\\s*'${title.replace('?', '[?]')}'[^\\n]*modal: true`), title);
  assert.equal([...source.matchAll(/memory\.adopt\(/g)].length, 3, 'add, edit and review are the only places a note is adopted');
  for (const guard of ["confirmed !== 'Add'", "confirmed !== 'Replace'", "confirmed !== 'Delete'", "decision !== 'Adopt' && decision !== 'Reject'"]) assert.ok(source.includes(guard), guard);
  assert.ok(source.indexOf("confirmed !== 'Add'") >= 0 && source.indexOf("confirmed !== 'Add'") < source.indexOf('memory.propose({ repoId: handle.repoId, roleGroupId, privacyDomain, content: text'));
  assert.match(source, /const APPROVER = \{ kind: 'human', id: 'local-user' \}/);
});

test('an agent suggestion is only a candidate: it is proposed and never adopted by the command that records it', () => {
  const body = source.slice(source.indexOf('async function suggest('), source.indexOf('/** Reviews one suggestion'));
  assert.match(body, /kind: 'agent-suggestion'/);
  assert.doesNotMatch(body, /adopt\(/);
});

test('editing keeps the old note until the new one is saved', () => {
  const body = source.slice(source.indexOf('async function edit('), source.indexOf('async function toggle('));
  assert.ok(body.indexOf('memory.propose(') < body.indexOf('memory.remove(note.id)'));
  assert.match(body, /The old note was kept/);
});

test('the view and its commands are declared and activate on use', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
  assert.ok(manifest.contributes.views.multiagentSystem.some((view) => view.id === 'multiagentSystem.memoryView' && view.name === 'Shared Memory'));
  for (const name of ['refresh', 'add', 'edit', 'toggle', 'remove', 'suggest', 'review']) {
    assert.ok(manifest.contributes.commands.some((entry) => entry.command === `multiagentSystem.memory.${name}`), name);
    assert.ok(manifest.activationEvents.includes(`onCommand:multiagentSystem.memory.${name}`), name);
  }
});
