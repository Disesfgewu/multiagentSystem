'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateBroadcast, scanBroadcastText, isLive, appliesTo, broadcastRule, SCOPES } = require('../../src/broadcast/model');
const { resolveRules } = require('../../src/memory/rules');

const cp = (...codes) => String.fromCodePoint(...codes);
const NOW = '2026-10-17T12:00:00.000Z';
const broadcast = (over = {}) => ({
  id: 'bc-1', version: 1, target: { scope: 'all' }, text: 'Stop non-M1 work and pick up an mvp Issue.',
  createdAt: NOW, expiresAt: null, revokedAt: null, ...over
});

test('a well-formed broadcast for every scope is accepted, text is cleaned, and extra target fields are rejected', () => {
  for (const target of [{ scope: 'all' }, { scope: 'roleGroup', role: 'worker' }, { scope: 'agent', agentId: 'session-1' }, { scope: 'provider', provider: 'claude' }]) {
    const result = validateBroadcast(broadcast({ target }));
    assert.equal(result.ok, true, JSON.stringify(target));
    assert.deepEqual(result.broadcast.target, target);
  }
  assert.deepEqual(SCOPES, ['all', 'roleGroup', 'agent', 'provider']);
  const withExtra = validateBroadcast(broadcast({ target: { scope: 'all', extra: 'x' } }));
  assert.deepEqual(withExtra.problems, ['invalid-target']);
  const dirty = validateBroadcast(broadcast({ text: `  hi\tthere${cp(0x202e)}evil${cp(0)}  ` }));
  assert.equal(dirty.ok, true);
  assert.equal(dirty.broadcast.text, 'hi there evil');
});

test('every required field is validated; a bad one names itself, several bad ones are all reported', () => {
  assert.deepEqual(validateBroadcast(null).problems, ['invalid-broadcast']);
  assert.deepEqual(validateBroadcast(broadcast({ id: 'Bad Id!' })).problems, ['invalid-id']);
  assert.deepEqual(validateBroadcast(broadcast({ version: 0 })).problems, ['invalid-version']);
  assert.deepEqual(validateBroadcast(broadcast({ version: 1.5 })).problems, ['invalid-version']);
  assert.deepEqual(validateBroadcast(broadcast({ target: { scope: 'unknown' } })).problems, ['invalid-target']);
  assert.deepEqual(validateBroadcast(broadcast({ target: null })).problems, ['invalid-target']);
  assert.deepEqual(validateBroadcast(broadcast({ target: { scope: 'roleGroup', role: 'Not Valid' } })).problems, ['invalid-target']);
  assert.deepEqual(validateBroadcast(broadcast({ text: '' })).problems, ['invalid-text']);
  assert.deepEqual(validateBroadcast(broadcast({ text: '   ' })).problems, ['invalid-text']);
  assert.deepEqual(validateBroadcast(broadcast({ text: 'x'.repeat(4001) })).problems, ['invalid-text']);
  assert.equal(validateBroadcast(broadcast({ text: 'x'.repeat(4000) })).ok, true);
  assert.deepEqual(validateBroadcast(broadcast({ createdAt: 'not-a-date' })).problems, ['invalid-created-at']);
  assert.deepEqual(validateBroadcast(broadcast({ createdAt: undefined })).problems, ['invalid-created-at']);
  assert.deepEqual(validateBroadcast(broadcast({ expiresAt: 'not-a-date' })).problems, ['invalid-expires-at']);
  assert.deepEqual(validateBroadcast(broadcast({ expiresAt: NOW })).problems, ['expires-before-created'], 'an expiry at or before creation is never valid');
  assert.deepEqual(validateBroadcast(broadcast({ revokedAt: 'not-a-date' })).problems, ['invalid-revoked-at']);
  assert.deepEqual(
    validateBroadcast({ id: '', version: 0, target: {}, text: '', createdAt: null }).problems.sort(),
    ['invalid-created-at', 'invalid-id', 'invalid-target', 'invalid-text', 'invalid-version'].sort(),
    'every problem is reported together, not just the first'
  );
});

test('a sender field, or anything else outside the validated shape, is simply not part of the contract: this module never reads or trusts one', () => {
  const result = validateBroadcast({ ...broadcast(), sender: 'pm', senderRole: 'admin', role: 'admin' });
  assert.equal(result.ok, true);
  for (const key of Object.keys(result.broadcast)) assert.notEqual(key, 'sender');
  assert.deepEqual(Object.keys(result.broadcast).sort(), ['createdAt', 'expiresAt', 'id', 'revokedAt', 'target', 'text', 'version']);
});

test('isLive: a broadcast with no expiry holds until revoked; one with an expiry or a revocation stops applying from that moment on, not before', () => {
  const open = validateBroadcast(broadcast()).broadcast;
  assert.equal(isLive(open, '2030-01-01T00:00:00.000Z'), true, 'no expiresAt means it never expires on its own');
  const expiring = validateBroadcast(broadcast({ expiresAt: '2026-10-17T13:00:00.000Z' })).broadcast;
  assert.equal(isLive(expiring, '2026-10-17T12:59:59.000Z'), true);
  assert.equal(isLive(expiring, '2026-10-17T13:00:00.000Z'), false);
  assert.equal(isLive(expiring, '2026-10-17T14:00:00.000Z'), false);
  const revoked = validateBroadcast(broadcast({ revokedAt: '2026-10-17T12:30:00.000Z' })).broadcast;
  assert.equal(isLive(revoked, '2026-10-17T12:29:00.000Z'), true, 'live until the moment it is revoked');
  assert.equal(isLive(revoked, '2026-10-17T12:30:00.000Z'), false);
  assert.equal(isLive(revoked, { getTime: () => NaN }), false, 'an invalid clock is never treated as live');
});

test('appliesTo matches exactly the named scope, independent of whether the broadcast is still live', () => {
  const all = validateBroadcast(broadcast({ target: { scope: 'all' } })).broadcast;
  assert.equal(appliesTo(all, { role: 'worker', agentId: 'x', provider: 'claude' }), true);
  assert.equal(appliesTo(all, {}), true, 'an "all" broadcast applies even with no context at all');
  const role = validateBroadcast(broadcast({ target: { scope: 'roleGroup', role: 'worker' } })).broadcast;
  assert.equal(appliesTo(role, { role: 'worker' }), true);
  assert.equal(appliesTo(role, { role: 'pm' }), false);
  assert.equal(appliesTo(role, {}), false);
  const agent = validateBroadcast(broadcast({ target: { scope: 'agent', agentId: 'session-1' } })).broadcast;
  assert.equal(appliesTo(agent, { agentId: 'session-1' }), true);
  assert.equal(appliesTo(agent, { agentId: 'session-2' }), false);
  const provider = validateBroadcast(broadcast({ target: { scope: 'provider', provider: 'claude' } })).broadcast;
  assert.equal(appliesTo(provider, { provider: 'claude' }), true);
  assert.equal(appliesTo(provider, { provider: 'codex' }), false);
});

test('broadcastRule produces a `user`-layer instruction rule that composes correctly with every other layer, without changing the resolver', () => {
  const live = validateBroadcast(broadcast({ id: 'stand-down', text: 'Stop non-M1 work.' })).broadcast;
  const rule = broadcastRule(live);
  assert.deepEqual(rule, { id: 'broadcast:stand-down', layer: 'user', type: 'instruction', text: 'Stop non-M1 work.', version: 1 });
  // Weaker layers can only ADD restrictions, never remove or weaken a user-layer instruction: the
  // existing resolver already guarantees this for any 'user' rule, with no change made here.
  const resolved = resolveRules([
    rule,
    { id: 'platform-rule', layer: 'platform', type: 'instruction', text: 'Follow platform policy.' },
    { id: 'task-rule', layer: 'task', type: 'instruction', text: 'Do the assigned task.' }
  ]);
  assert.deepEqual(resolved.instructions.map((entry) => entry.id).sort(), ['broadcast:stand-down', 'platform-rule', 'task-rule'].sort());
  assert.equal(resolved.conflicts.length, 0);
});

test('scanBroadcastText reuses the publish scanner on the broadcast text as a single "comment" unit', () => {
  const clear = scanBroadcastText('Please slow down on M2 work.');
  assert.equal(clear.status, 'clear');
  const withSecret = scanBroadcastText('My key is sk-ant-api03-' + 'a'.repeat(40));
  assert.equal(withSecret.status, 'blocked');
  const withPath = scanBroadcastText('See /Users/someone/secret-project/notes.txt for context.');
  assert.equal(withPath.status, 'blocked');
});
