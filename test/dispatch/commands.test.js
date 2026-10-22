'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../../src/dispatch/commands.ts'), 'utf8').replace(/\r\n/g, '\n');

test('both dispatch commands take no argument, so nothing a caller passes can choose the task, the recipients or the confirmation', () => {
  const registrations = [...source.matchAll(/registerCommand\(DISPATCH_COMMANDS\.(\w+), ([^\n]*)\)/g)];
  assert.deepEqual(registrations.map((entry) => entry[1]).sort(), ['assignIssue', 'sendTask']);
  for (const entry of registrations) assert.match(entry[2], /^\(\) => dispatch\(sessions, '(issue|free)'\)/, `${entry[1]} ignores arguments`);
});

test('the confirmation is a modal with explicit buttons, and nothing is typed without one of them', () => {
  assert.match(source, /const title = input\.title \?\? 'Type this task into the running agents\?';/);
  assert.match(source, /showWarningMessage\(\s*title,\s*\{ modal: true/);
  assert.match(source, /if \(confirmed !== sendWaiting && confirmed !== sendUnknown\) return null;/);
  assert.equal([...source.matchAll(/sessions\.sendPrompt\(/g)].length, 1, 'there is one place a task is typed');
  assert.ok(source.indexOf("confirmed !== sendWaiting") < source.indexOf('sessions.sendPrompt('), 'the confirmation comes first');
});

test('the Issue is read again after the confirmation and a changed text types nothing', () => {
  assert.match(source, /rebuilt && rebuilt\.ok && rebuilt\.prompt === task\.prompt \? rebuilt\.prompt : null/);
  assert.match(source, /if \(again === null\) changed = true; else prompt = again;/);
  assert.match(source, /reason: 'task-changed'/);
});

test('the commands are declared in the manifest and activate on use', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
  for (const id of ['multiagentSystem.dispatch.assignIssue', 'multiagentSystem.dispatch.sendTask']) {
    assert.ok(manifest.contributes.commands.some((entry) => entry.command === id), `${id} is contributed`);
    assert.ok(manifest.activationEvents.includes(`onCommand:${id}`), `${id} activates`);
  }
});
