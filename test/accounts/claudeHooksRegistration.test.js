'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const ID = 'multiagentSystem.accounts.configureHooks';

// An interactive command is only checked for being registered: executing it headlessly would wait for a dialog.
test('the hook bridge command is contributed, titled by what it does, and offered on Claude account profiles', () => {
  const declared = manifest.contributes.commands.find((entry) => entry.command === ID);
  assert.ok(declared, 'declared in package.json');
  assert.match(declared.title, /Hook Bridge/);
  assert.match(declared.title, /CLI hooks/);
  assert.ok(manifest.contributes.menus['view/item/context'].some((entry) => entry.command === ID && /accountsView/.test(entry.when)));
});

test('the command is registered by the account commands and the script ships with the build', () => {
  const source = fs.readFileSync(path.join(root, 'src/accounts/accountCommands.ts'), 'utf8');
  assert.match(source, /configureHooks: 'multiagentSystem\.accounts\.configureHooks'/);
  assert.match(source, /registerCommand\(ACCOUNT_COMMANDS\.configureHooks/);
  // Non-interactive arguments are honoured only in test mode, as for the status line.
  const body = source.slice(source.indexOf('export async function configureHooks'));
  assert.match(body, /const interactive = testMode \?/);
  assert.match(body, /const consent = testMode \?/);
  assert.match(body, /const action = testMode \?/);
  assert.ok(fs.existsSync(path.join(root, 'src/accounts/claudeHookBridge.js')));
});

test('the extension declares no untrusted-workspace capability for this feature', () => {
  assert.equal(manifest.capabilities?.untrustedWorkspaces, undefined);
});
