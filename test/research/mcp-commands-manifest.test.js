'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const source = fs.readFileSync(path.join(root, 'src', 'research', 'mcpCommands.ts'), 'utf8');
const IDS = ['enable', 'stop', 'revoke', 'status', 'setSecret'].map((n) => `multiagentSystem.research.mcp.${n}`);

test('MCP commands are declared in contributes and activationEvents and registered in source', () => {
  const declared = new Set(manifest.contributes.commands.map((c) => c.command));
  for (const id of IDS) {
    assert.ok(declared.has(id), id);
    assert.ok(manifest.activationEvents.includes(`onCommand:${id}`), id);
    assert.ok(source.includes(`'${id}'`), id);
  }
  assert.ok(fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8').includes('registerMcpCommands(context)'));
});

test('starting a server has no interactive bypass; the extension claims no untrusted-workspace support', () => {
  const enableBody = source.slice(source.indexOf('const enable = async'), source.indexOf('const stop = async'));
  assert.ok(enableBody.includes('modal: true'));
  assert.ok(!/interactive/.test(enableBody));
  assert.ok(!/allowNonInteractive|isExtensionTestMode/.test(source));
  assert.ok(source.includes('requireInteractive'));
  assert.equal(manifest.capabilities && manifest.capabilities.untrustedWorkspaces, undefined);
});
