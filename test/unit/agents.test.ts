import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { GROUP_NAMES, PROVIDERS, errorMessage, terminalTitle, validateTerminalName } from '../../src/agents';

test('terminal titles carry a fixed prefix and trim the name', () => {
  assert.equal(terminalTitle('  Worker 1 '), 'Multiagent: Worker 1');
});

test('terminal name validation rejects blank input', () => {
  assert.equal(validateTerminalName('   '), 'Enter a terminal name.');
  assert.equal(validateTerminalName('PM'), undefined);
});

test('the default group has one PM and three workers with unique names', () => {
  assert.deepEqual([...GROUP_NAMES], ['PM', 'Worker 1', 'Worker 2', 'Worker 3']);
  assert.equal(new Set(GROUP_NAMES).size, GROUP_NAMES.length);
});

test('provider executables are plain command names that are safe to type into a shell', () => {
  assert.ok(PROVIDERS.length >= 2);
  for (const provider of PROVIDERS) {
    assert.match(provider.executable, /^[A-Za-z0-9_-]+$/);
    assert.notEqual(provider.label.trim(), '');
  }
});

test('error messages are extracted from Error objects and stringified otherwise', () => {
  assert.equal(errorMessage(new Error('boom')), 'boom');
  assert.equal(errorMessage('plain'), 'plain');
  assert.equal(errorMessage(42), '42');
});
