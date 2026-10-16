'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { describeProviderCapabilities, NAMES, MEANING } = require('../../src/providers/capability-text');
const { CAPABILITIES, builtIn, createRegistry } = require('../../src/providers/registry');

test('every capability of every built-in provider is described in words, and the model is unknown', () => {
  assert.deepEqual(Object.keys(NAMES).sort(), [...CAPABILITIES].sort());
  for (const id of builtIn.ids()) {
    const lines = describeProviderCapabilities(id);
    assert.equal(lines.length, CAPABILITIES.length + 2, id);
    for (const name of CAPABILITIES) assert.ok(lines.some((line) => line.startsWith(`  - ${NAMES[name]}: `)), `${id} ${name}`);
    assert.equal(lines.at(-1), 'Model in use: unknown (no source reports which model a session uses).');
    assert.equal(/undefined|null|\[object/.test(lines.join('\n')), false);
  }
});

test('nothing is called verified unless the registry says so, and agy is terminal start only with the rest unknown', () => {
  for (const id of builtIn.ids()) assert.equal(describeProviderCapabilities(id).some((line) => line.includes(MEANING.verified)), false, id);
  const agy = describeProviderCapabilities('agy');
  assert.match(agy[0], /terminal start only/);
  assert.equal(agy.filter((line) => line.endsWith(': unknown')).length, CAPABILITIES.length - 1);
  assert.match(agy.find((line) => line.includes('Start in a native terminal')), /not yet checked on a real machine/);
  assert.match(describeProviderCapabilities('claude')[0], /dedicated support/);
});

test('the words follow the registry status, whatever it is', () => {
  const registry = createRegistry([{ id: 'tool', label: 'Tool', executable: 'tool', support: 'dedicated', capabilities: { mcp: 'verified', webSearch: 'unsupported', resume: 'unverified' } }]);
  const lines = describeProviderCapabilities('tool', registry);
  assert.ok(lines.includes('  - Use MCP servers: verified on a real machine'));
  assert.ok(lines.includes('  - Search the web: not supported'));
  assert.ok(lines.includes('  - Resume a session: the extension has code for it, not yet checked on a real machine'));
  assert.ok(lines.includes('  - Start in a native terminal: unknown'));
});

test('an unknown or odd provider id gets one honest line', () => {
  for (const id of ['opencode', '', undefined, null, 5, '__proto__', 'constructor']) {
    assert.deepEqual(describeProviderCapabilities(id), ['Provider abilities: unknown provider.', 'Model in use: unknown (no source reports it).'], String(id));
  }
});
