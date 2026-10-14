'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionRegistry, STATES } = require('../../src/sessions/registry');

const input = (extra = {}) => ({
  id: 'session-a', repoId: 'repo-1', roleGroupId: 'worker', provider: 'claude',
  accountProfileId: 'account-a', worktree: '/private/worktree-a', ...extra
});

test('a session keeps its provider and account binding across terminal reopens', () => {
  const registry = new SessionRegistry();
  assert.equal(registry.create(input()).state, STATES.UNKNOWN);
  assert.equal(registry.attachTerminal('session-a', 'terminal-1').state, STATES.TERMINAL_OPEN);
  assert.equal(registry.launchRequested('session-a', 'terminal-1').state, STATES.LAUNCH_REQUESTED);
  assert.equal(registry.observeCli('session-a', 'terminal-1', {
    provider: 'claude', accountProfileId: 'account-a', source: 'provider-event',
    observedAt: '2026-01-01T00:00:00Z'
  }).state, STATES.CLI_OBSERVED);
  assert.equal(registry.terminalClosed('session-a', 'terminal-1').state, STATES.TERMINAL_CLOSED);
  assert.equal(registry.attachTerminal('session-a', 'terminal-2').state, STATES.TERMINAL_OPEN);
  assert.deepEqual(
    { provider: registry.get('session-a').provider, accountProfileId: registry.get('session-a').accountProfileId },
    { provider: 'claude', accountProfileId: 'account-a' }
  );
  assert.throws(() => registry.launchRequested('session-a', 'terminal-1'), { code: 'stale-terminal-event' });
  assert.throws(() => registry.attachTerminal('session-a', 'terminal-1'), { code: 'terminal-token-reused' });
});

test('sending a CLI command never by itself reports an active CLI', () => {
  const registry = new SessionRegistry();
  registry.create(input());
  registry.attachTerminal('session-a', 'terminal-1');
  registry.launchRequested('session-a', 'terminal-1');
  assert.equal(registry.get('session-a').state, STATES.LAUNCH_REQUESTED);
  assert.throws(() => registry.observeCli('session-a', 'terminal-1', {
    provider: 'claude', accountProfileId: 'account-a', source: 'shell-open'
  }), { code: 'observation-unverified' });
  assert.throws(() => registry.observeCli('session-a', 'terminal-1', {
    provider: 'claude', accountProfileId: 'account-b', source: 'provider-event'
  }), { code: 'account-binding-mismatch' });
  assert.equal(registry.get('session-a').state, STATES.LAUNCH_REQUESTED);
});

test('extension restart discards runtime status and terminal binding', () => {
  const registry = new SessionRegistry();
  registry.create(input());
  registry.attachTerminal('session-a', 'terminal-1');
  registry.launchRequested('session-a', 'terminal-1');
  registry.observeCli('session-a', 'terminal-1', {
    provider: 'claude', accountProfileId: 'account-a', source: 'provider-event',
    observedAt: '2026-01-01T00:00:00Z'
  });
  const saved = registry.snapshot();
  assert.equal(JSON.stringify(saved).includes('terminal-1'), false);
  assert.equal(JSON.stringify(saved).includes('cli-observed'), false);
  const restored = SessionRegistry.restore(saved);
  assert.equal(restored.get('session-a').state, STATES.UNKNOWN);
  assert.equal(restored.get('session-a').accountProfileId, 'account-a');
  assert.throws(() => restored.terminalClosed('session-a', 'terminal-1'), { code: 'stale-terminal-event' });
});

test('two sessions cannot silently share a native terminal binding', () => {
  const registry = new SessionRegistry();
  registry.create(input());
  registry.create(input({ id: 'session-b', accountProfileId: 'account-b' }));
  registry.attachTerminal('session-a', 'terminal-1');
  assert.throws(() => registry.attachTerminal('session-b', 'terminal-1'), { code: 'terminal-already-bound' });
  assert.equal(registry.get('session-b').state, STATES.UNKNOWN);
});

test('replacing a terminal binding retires the old token even without a close event', () => {
  const registry = new SessionRegistry();
  registry.create(input());
  registry.attachTerminal('session-a', 'terminal-1');
  registry.attachTerminal('session-a', 'terminal-2');
  assert.throws(() => registry.terminalClosed('session-a', 'terminal-1'), { code: 'stale-terminal-event' });
  assert.throws(() => registry.attachTerminal('session-a', 'terminal-1'), { code: 'terminal-token-reused' });
  assert.equal(registry.get('session-a').state, STATES.TERMINAL_OPEN);
});

test('a future provider timestamp cannot claim that a CLI is active', () => {
  const registry = new SessionRegistry({ now: () => '2026-01-01T00:00:00Z' });
  registry.create(input());
  registry.attachTerminal('session-a', 'terminal-1');
  registry.launchRequested('session-a', 'terminal-1');
  assert.throws(() => registry.observeCli('session-a', 'terminal-1', {
    provider: 'claude', accountProfileId: 'account-a', source: 'provider-event',
    observedAt: '2026-01-01T00:00:01Z'
  }), { code: 'future-observation' });
  assert.equal(registry.get('session-a').state, STATES.LAUNCH_REQUESTED);
});

test('CLI exit is distinct from terminal close and permits a fresh launch', () => {
  const registry = new SessionRegistry();
  registry.create(input());
  registry.attachTerminal('session-a', 'terminal-1');
  registry.launchRequested('session-a', 'terminal-1');
  assert.equal(registry.cliExited('session-a', 'terminal-1').state, STATES.CLI_EXITED);
  assert.equal(registry.launchRequested('session-a', 'terminal-1').state, STATES.LAUNCH_REQUESTED);
  assert.equal(registry.terminalClosed('session-a', 'terminal-1').state, STATES.TERMINAL_CLOSED);
});

test('duplicate ids and malformed restored records are rejected', () => {
  const registry = new SessionRegistry();
  registry.create(input());
  assert.throws(() => registry.create(input()), { code: 'session-exists' });
  assert.throws(() => SessionRegistry.restore([input({ accountProfileId: '' })]), {
    code: 'invalid-account-profile-id'
  });
  assert.throws(() => SessionRegistry.restore([input(), input()]), { code: 'session-exists' });
});
