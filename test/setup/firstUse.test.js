'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { skipsFirstUseDownload, PRODUCTION, DEVELOPMENT, TEST } = require('../../src/setup/firstUse');

test('the first-use download is left out only in tests and the end-to-end run, never in an installed extension (#361)', () => {
  assert.equal(skipsFirstUseDownload(TEST, {}), true);
  assert.equal(skipsFirstUseDownload(DEVELOPMENT, { MULTIAGENT_E2E_NO_DOWNLOAD: '1' }), true);
  assert.equal(skipsFirstUseDownload(DEVELOPMENT, {}), false, 'a person developing the extension still gets the download');
  for (const value of ['1', 'true', 'yes', '']) assert.equal(skipsFirstUseDownload(PRODUCTION, { MULTIAGENT_E2E_NO_DOWNLOAD: value }), false, `installed, ${JSON.stringify(value)}`);
  for (const value of ['true', '0', ' 1', 'yes']) assert.equal(skipsFirstUseDownload(DEVELOPMENT, { MULTIAGENT_E2E_NO_DOWNLOAD: value }), false, JSON.stringify(value));
  assert.equal(skipsFirstUseDownload(DEVELOPMENT, undefined), false);
  assert.equal(skipsFirstUseDownload(undefined, { MULTIAGENT_E2E_NO_DOWNLOAD: '1' }), false);
  // The numbers are VS Code's ExtensionMode.
  const vscodeTypes = fs.readFileSync(path.join(__dirname, '../../node_modules/@types/vscode/index.d.ts'), 'utf8');
  for (const [name, value] of [['Production', PRODUCTION], ['Development', DEVELOPMENT], ['Test', TEST]]) assert.match(vscodeTypes, new RegExp(`${name} = ${value},?`), name);
});

test('the setup view asks it before the automatic download, and nothing else reads the variable (#361)', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/setup/setupView.ts'), 'utf8');
  assert.match(source, /if \(!skipsFirstUseDownload\(context\.extensionMode, process\.env\)\) void controller\.autoPrepare\(\);/);
  const files = fs.readdirSync(path.join(__dirname, '../../src'), { recursive: true }).filter((name) => /\.(js|ts)$/.test(name));
  const readers = files.filter((name) => fs.readFileSync(path.join(__dirname, '../../src', name), 'utf8').includes('MULTIAGENT_E2E_NO_DOWNLOAD'));
  assert.deepEqual(readers.map((name) => name.replace(/\\/g, '/')), ['setup/firstUse.js']);
});
