'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../../src/meeting/commands.ts'), 'utf8').replace(/\r\n/g, '\n');

test('the command takes no argument: the topic, the agents and every confirmation come from the windows', () => {
  assert.match(source, /registerCommand\(MEETING_COMMANDS\.start, \(\) => meeting\(sessions\)\)/);
});

test('the topic is checked before anything is asked of an agent, and it is typed only through the shared confirmation', () => {
  assert.ok(source.indexOf('buildMeetingPrompt({') < source.indexOf('await confirmAndType('));
  assert.equal([...source.matchAll(/sendPrompt\(/g)].length, 0, 'this command never types by itself');
  assert.match(source, /ids: chosen\.map\(\(entry\) => entry\.id\)/);
  assert.match(source, /chosen\.length < 2/);
});

test('replies are never written for an agent: only the clipboard text the person pressed Use Clipboard for is recorded', () => {
  assert.match(source, /if \(decision === 'Use Clipboard'\) entry\.reply = clip;/);
  assert.equal([...source.matchAll(/\.reply = /g)].length, 1, 'there is one place a reply is set');
  assert.match(source, /reply: null \}\)\)/, 'every participant starts with no reply');
  assert.match(source, /The extension cannot read their answers/);
});

test('the minutes open in an unsaved editor and nothing is written to a file', () => {
  assert.match(source, /openTextDocument\(\{ language: 'markdown', content: minutes\.markdown \}\)/);
  assert.doesNotMatch(source, /writeFile|appendFile|workspace\.fs|showSaveDialog|Uri\.file/);
});

test('the command is declared and activates on use', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
  assert.ok(manifest.contributes.commands.some((entry) => entry.command === 'multiagentSystem.meeting.start' && /Start Meeting/.test(entry.title)));
  assert.ok(manifest.activationEvents.includes('onCommand:multiagentSystem.meeting.start'));
});
