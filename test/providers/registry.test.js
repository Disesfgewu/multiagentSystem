'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRegistry, describeProvider, builtIn, ProviderError, CAPABILITIES, STATUSES } = require('../../src/providers/registry');

const valid = (over = {}) => ({ id: 'tool', label: 'Tool', executable: 'tool', support: 'terminal-only', ...over });
const codeOf = (fn) => { try { fn(); } catch (error) { return error instanceof ProviderError ? error.code : `other:${error.message}`; } return null; };
const cp = (...codes) => String.fromCodePoint(...codes);

test('the built-in registry has exactly claude, codex and agy, in a fixed order', () => {
  assert.deepEqual(builtIn.ids(), ['agy', 'claude', 'codex']);
  assert.deepEqual(builtIn.list().map((p) => p.label).sort(), ['Claude Code', 'Codex CLI', 'agy']);
  assert.deepEqual(builtIn.list().map((p) => p.executable), ['agy', 'claude', 'codex']);
  for (const provider of builtIn.list()) assert.deepEqual(provider.args, []);
});

test('every provider states every capability; unstated ones are unknown; nothing is verified yet', () => {
  for (const provider of builtIn.list()) {
    assert.deepEqual(Object.keys(provider.capabilities), [...CAPABILITIES]);
    for (const status of Object.values(provider.capabilities)) assert.ok(STATUSES.includes(status));
    assert.equal(provider.capabilities.webSearch, 'unknown');
    assert.equal(provider.capabilities.mcp, 'unknown');
    assert.equal(Object.values(provider.capabilities).includes('verified'), false, provider.id);
  }
});

test('agy has a terminal launch and nothing else', () => {
  const agy = builtIn.get('agy');
  assert.equal(agy.support, 'terminal-only');
  for (const name of CAPABILITIES) assert.equal(agy.capabilities[name], name === 'terminalLaunch' ? 'unverified' : 'unknown', name);
  assert.deepEqual(agy.args, []);
});

test('claude and codex keep dedicated support', () => {
  assert.equal(builtIn.get('claude').support, 'dedicated');
  assert.equal(builtIn.get('codex').support, 'dedicated');
  assert.equal(builtIn.capability('claude', 'accountIsolation'), 'unverified');
  assert.equal(builtIn.capability('codex', 'resume'), 'unknown');
});

test('lookups never guess: unknown ids and capabilities give null or unknown', () => {
  for (const id of ['opencode', '', 'CLAUDE', 'claude ', null, undefined, 7, {}, 'constructor', '__proto__', 'toString']) {
    assert.equal(builtIn.get(id), null, String(id));
    assert.equal(builtIn.has(id), false);
    assert.equal(builtIn.capability(id, 'terminalLaunch'), 'unknown');
  }
  assert.equal(builtIn.capability('claude', 'nonsense'), 'unknown');
  assert.equal(builtIn.capability('claude', '__proto__'), 'unknown');
});

test('descriptions are frozen', () => {
  const provider = builtIn.get('claude');
  assert.ok(Object.isFrozen(provider) && Object.isFrozen(provider.capabilities) && Object.isFrozen(provider.args) && Object.isFrozen(builtIn.list()));
  assert.throws(() => { 'use strict'; provider.executable = 'sh'; }, TypeError);
});

test('a valid description is accepted and gets unknown for what it does not state', () => {
  const provider = describeProvider(valid({ args: ['--flag=a/b', 'x'], capabilities: { mcp: 'unsupported' } }));
  assert.equal(provider.capabilities.mcp, 'unsupported');
  assert.equal(provider.capabilities.resume, 'unknown');
  assert.deepEqual(provider.args, ['--flag=a/b', 'x']);
});

test('unknown fields, non-objects and bad support are rejected with a code that holds no value', () => {
  assert.equal(codeOf(() => describeProvider(valid({ shell: 'sh -c x' }))), 'provider-unknown-field');
  assert.equal(codeOf(() => describeProvider(valid({ env: {} }))), 'provider-unknown-field');
  for (const input of [null, undefined, 'claude', 7, [], () => 0]) assert.equal(codeOf(() => describeProvider(input)), 'provider-not-object');
  for (const support of [undefined, 'full', '']) assert.equal(codeOf(() => describeProvider(valid({ support }))), 'provider-invalid-support');
});

test('ids: lower case, short, and nothing that looks like an account, address or path', () => {
  for (const id of ['', 'Claude', '1tool', 'a b', 'a/b', 'a@b', 'a.b', 'a_b', '-x', 'x'.repeat(33), 'tool\n', `to${cp(0x200b)}ol`, `to${cp(0x202e)}ol`, 'tool;x', '$(x)', undefined, 5]) {
    assert.equal(codeOf(() => describeProvider(valid({ id }))), 'provider-invalid-id', JSON.stringify(id));
  }
  assert.equal(codeOf(() => describeProvider(valid({ id: 'x'.repeat(32) }))), null);
});

test('executables are bare names: no path, shell character, whitespace or control character', () => {
  for (const executable of ['', '/bin/sh', './x', '../x', 'a/b', 'a\\b', 'C:\\x', 'a b', 'a;b', 'a&&b', 'a|b', 'a`b`', '$(x)', '$HOME', 'a>b', 'a\nb', 'a\0b', '-rf', '.hidden', '~', 'x'.repeat(65), `a${cp(0x202e)}b`, undefined, 3]) {
    assert.equal(codeOf(() => describeProvider(valid({ executable }))), 'provider-invalid-executable', JSON.stringify(executable));
  }
  assert.equal(codeOf(() => describeProvider(valid({ executable: 'tool.exe' }))), null);
});

test('arguments are a dense short list of plain data tokens', () => {
  for (const args of ['x', {}, null, [1], [''], ['a b'], ['a;b'], ['a\nb'], ['$(x)'], ['`x`'], ['a|b'], ["a'b"], ['a"b'], ['a\\b'], ['a\0'], [`a${cp(0x202e)}`], ['x'.repeat(257)], new Array(1), new Array(33).fill('x')]) {
    assert.equal(codeOf(() => describeProvider(valid({ args }))), 'provider-invalid-args', JSON.stringify(args));
  }
  assert.equal(codeOf(() => describeProvider(valid({ args: new Array(32).fill('x') }))), null);
  const accessor = [];
  Object.defineProperty(accessor, '0', { enumerable: true, get() { throw new Error('must not execute'); } });
  accessor.length = 1;
  assert.equal(codeOf(() => describeProvider(valid({ args: accessor }))), 'provider-invalid-args');
});

test('labels are printable, bounded text', () => {
  for (const label of ['', '   ', 'x'.repeat(65), 'a\nb', 'a\0b', `a${cp(0x202e)}b`, `a${cp(0x200b)}b`, `a${cp(0x2028)}b`, `a${cp(0x1b)}[0m`, undefined, 7]) {
    assert.equal(codeOf(() => describeProvider(valid({ label }))), 'provider-invalid-label', JSON.stringify(label));
  }
  assert.equal(describeProvider(valid({ label: '  Tool  ' })).label, 'Tool');
});

test('capabilities: unknown names and statuses are rejected', () => {
  assert.equal(codeOf(() => describeProvider(valid({ capabilities: { telepathy: 'verified' } }))), 'provider-unknown-capability');
  assert.equal(codeOf(() => describeProvider(valid({ capabilities: { mcp: 'yes' } }))), 'provider-invalid-capability-status');
  assert.equal(codeOf(() => describeProvider(valid({ capabilities: { mcp: true } }))), 'provider-invalid-capability-status');
  assert.equal(codeOf(() => describeProvider(valid({ capabilities: [] }))), 'provider-invalid-capabilities');
  assert.equal(codeOf(() => describeProvider(valid({ capabilities: null }))), 'provider-invalid-capabilities');
});

test('capabilities validate every own key and copy only checked data properties', () => {
  const hiddenStatus = {};
  Object.defineProperty(hiddenStatus, 'resume', { value: 'invalid', enumerable: false });
  assert.equal(codeOf(() => describeProvider(valid({ capabilities: hiddenStatus }))), 'provider-invalid-capability-status');

  const hiddenUnknown = {};
  Object.defineProperty(hiddenUnknown, 'secret', { value: 'verified', enumerable: false });
  assert.equal(codeOf(() => describeProvider(valid({ capabilities: hiddenUnknown }))), 'provider-unknown-capability');

  const symbolKey = { [Symbol('hidden')]: 'verified' };
  assert.equal(codeOf(() => describeProvider(valid({ capabilities: symbolKey }))), 'provider-unknown-capability');

  const accessor = {};
  Object.defineProperty(accessor, 'resume', { enumerable: true, get() { throw new Error('must not execute'); } });
  assert.equal(codeOf(() => describeProvider(valid({ capabilities: accessor }))), 'provider-invalid-capability-status');
});

test('a registry rejects duplicates and non-lists, and orders by id without locale', () => {
  assert.equal(codeOf(() => createRegistry([valid(), valid()])), 'registry-duplicate-id');
  assert.equal(codeOf(() => createRegistry({})), 'registry-not-list');
  assert.equal(codeOf(() => createRegistry([valid({ id: 'b-tool' }), valid({ id: 'a-tool' }), valid({ id: 'a2' })])), null);
  assert.deepEqual(createRegistry([valid({ id: 'b-tool' }), valid({ id: 'a-tool' }), valid({ id: 'a2' })]).ids(), ['a-tool', 'a2', 'b-tool']);
  assert.equal(createRegistry([]).list().length, 0);
});

test('errors never carry the rejected value', () => {
  const secret = 'ghp_syntheticsecretvalue';
  for (const make of [() => describeProvider(valid({ executable: `${secret} x` })), () => describeProvider(valid({ id: secret })), () => describeProvider(valid({ args: [`${secret};`] }))]) {
    try { make(); assert.fail('should throw'); } catch (error) { assert.equal(JSON.stringify([error.message, error.code, error.stack.split('\n')[0]]).includes(secret), false); }
  }
});
