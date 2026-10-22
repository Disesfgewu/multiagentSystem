'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../../src/sessions/sessionCommands.ts'), 'utf8').replace(/\r\n/g, '\n');

test('the first auto-mode launch asks once in a modal window, remembers the answer for this user, and declining starts nothing', () => {
  const body = source.slice(source.indexOf('export async function confirmAutoModeOnce'), source.indexOf('export const INSTRUCTION_PREVIEW_SCHEME'));
  assert.match(body, /autoMode\.auto\.state !== 'on'\) return true/);
  assert.match(body, /globalState\.get<boolean>\(AUTO_MODE_ACKNOWLEDGED_KEY\) === true\) return true/);
  assert.match(body, /modal: true/);
  assert.match(body, /if \(answer !== 'I Understand, Continue'\) return false;/);
  assert.ok(body.indexOf('return false;') < body.indexOf('globalState.update'), 'nothing is remembered unless the person agreed');
});

test('both a new session and a reopened one go through it, only when interactive, and before anything is started', () => {
  const uses = [...source.matchAll(/if \(interactive && !\(await confirmAutoModeOnce\(context, autoMode\)\)\)/g)];
  assert.equal(uses.length, 2);
  assert.ok(source.indexOf('confirmAutoModeOnce(context, autoMode)') < source.indexOf('manager.start('));
});

test('the enforced confirmation is given the auto-mode lines for the sandbox case', () => {
  assert.match(source, /extraLines: autoModeFor\(provider, launch, 'enforced'\)\.lines/);
});
