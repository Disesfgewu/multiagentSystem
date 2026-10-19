'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const setting = manifest.contributes.configuration.properties['multiagentSystem.skills.autoInstall'];

test('the auto-install switch is application scoped, so a repository cannot turn it back on', () => {
  assert.equal(setting.scope, 'application');
  assert.equal(setting.default, true);
});

test('the code reads only the user-level value, never workspace or folder values', () => {
  const source = fs.readFileSync(path.join(root, 'src/skills/skillCommands.ts'), 'utf8');
  assert.match(source, /inspect<boolean>\('skills\.autoInstall'\)/);
  assert.match(source, /inspected\?\.globalValue \?\? inspected\?\.defaultValue/);
  assert.equal(/workspaceValue|workspaceFolderValue/.test(source), false);
  assert.equal(/getConfiguration\('multiagentSystem',\s*folder/.test(source), false, 'no folder-scoped read of the switch');
});
