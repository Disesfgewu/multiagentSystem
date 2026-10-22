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

test('replies are never written for an agent: only the clipboard text the person read and then confirmed with Record Reply is recorded', () => {
  assert.match(source, /if \(decision === 'Record Reply' \|\| decision === 'Record It Anyway'\) \{ entry\.reply = clip;/);
  assert.equal([...source.matchAll(/\.reply = /g)].length, 1, 'there is one place a reply is set');
  assert.match(source, /reply: null \}\)\)/, 'every participant starts with no reply');
  assert.match(source, /The extension cannot read their answers/);
});

test('the clipboard is read only after the person pressed the button, never before the first question of an agent, and Escape skips one agent only', () => {
  const loop = source.slice(source.indexOf('for (const entry of askers)'), source.indexOf('const minutes = buildMinutes('));
  assert.ok(loop.indexOf("showInformationMessage(`Copy ${entry.name}'s answer") < loop.indexOf('await readClipboard()'), 'the question comes before the read');
  assert.match(loop, /if \(ready !== 'Read Clipboard'\) continue;/);
  assert.doesNotMatch(loop, /\bbreak\b/, 'nothing ends the loop for the agents after this one');
  assert.match(loop, /const twin = used\.get\(clip\.trim\(\)\);/);
  assert.match(loop, /'Record It Anyway' : 'Record Reply'/);
  assert.match(loop, /if \(clip\.trim\(\) === ''\)/);
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

test('no wording in the code or the documents names a button that no longer exists', () => {
  const docs = fs.readFileSync(path.join(__dirname, '../../docs/MEETING.md'), 'utf8');
  assert.equal(/Use Clipboard/.test(source) || /Use Clipboard/.test(docs), false);
  for (const label of ['Enter Replies', 'Make Minutes Now', 'Read Clipboard', 'No Reply', 'Record Reply', 'Record It Anyway']) assert.ok(source.includes(`'${label}'`) || source.includes(label), label);
  for (const label of ['Read Clipboard', 'Record Reply']) assert.ok(docs.includes(label), `${label} is in the document`);
});
