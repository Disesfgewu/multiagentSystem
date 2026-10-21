'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPrompt, promptIsSafe, planDelivery, describePlan, validateDelivery, summarizeDeliveries, MAX_PROMPT_CHARS } = require('../../src/broadcast/deliver');
const { validateBroadcast } = require('../../src/broadcast/model');

const NOW = new Date('2026-10-21T10:00:00.000Z');
const make = (over = {}) => validateBroadcast({ id: 'bc-1', version: 1, target: { scope: 'all' }, text: 'Stop and run the tests first.', createdAt: '2026-10-21T09:00:00.000Z', expiresAt: null, revokedAt: null, ...over }).broadcast;
const waiting = { status: { confidence: 'actual', value: 'waiting', source: 'hook' } };
const session = (over = {}) => ({ id: 'session-1', name: 'Worker 1', provider: 'claude', roleGroupId: 'g1', terminalOpen: true, state: 'cli-observed', providerObservation: waiting, ...over });
const plan = (sessions, broadcast = make(), roleOf = () => 'worker') => planDelivery({ broadcast, sessions, roleOf, now: NOW });

test('the prompt is one clean line that starts with [ and carries the whole broadcast', () => {
  const prompt = buildPrompt(make());
  assert.equal(prompt, '[Administrator broadcast, created 2026-10-21T09:00:00.000Z] Stop and run the tests first.');
  assert.equal(prompt.startsWith('['), true);
  assert.equal(promptIsSafe(prompt), true);
});

test('text that a terminal must not receive is refused: line ends, escape sequences, hidden characters, over-long text', () => {
  for (const text of ['one\ntwo', 'a\rb', 'a\u001b[31mred', 'a\u0007b', 'a‮b', 'a​b', 'a b', 'x'.repeat(MAX_PROMPT_CHARS)]) {
    assert.throws(() => buildPrompt({ text, createdAt: '2026-10-21T09:00:00.000Z' }), /prompt-invalid/, JSON.stringify(text).slice(0, 30));
    assert.equal(promptIsSafe(text), false);
  }
  for (const value of ['', '/clear', '!ls', '#note', 'plain', 5, null, undefined]) assert.equal(promptIsSafe(value), false, String(value));
  for (const bad of [null, {}, { text: 5, createdAt: 'x' }, { text: 'a' }]) assert.throws(() => buildPrompt(bad), /prompt-invalid/);
});

test('only sessions waiting for input, with an open terminal and a CLI recorded as running, are sent to', () => {
  const result = plan([
    session({ id: 'ready' }),
    session({ id: 'busy', providerObservation: { status: { confidence: 'actual', value: 'working' } } }),
    session({ id: 'done', providerObservation: { status: { confidence: 'actual', value: 'completed' } } }),
    session({ id: 'ended', providerObservation: { status: { confidence: 'actual', value: 'ended' } } }),
    session({ id: 'nodata', providerObservation: undefined }),
    session({ id: 'unknown', providerObservation: { status: { confidence: 'unknown', value: null } } }),
    session({ id: 'estimated', providerObservation: { status: { confidence: 'estimated', value: 'waiting' } } }),
    session({ id: 'closed', terminalOpen: false }),
    session({ id: 'shell', state: 'terminal-open' }),
    session({ id: 'exited', state: 'cli-exited' }),
    session({ id: 'requested', state: 'launch-requested' })
  ]);
  assert.equal(result.ok, true);
  const by = Object.fromEntries(result.recipients.map((entry) => [entry.id, `${entry.decision}:${entry.reason}`]));
  assert.deepEqual(by, {
    ready: 'send:waiting-for-input', busy: 'skip:cli-busy', done: 'skip:cli-not-waiting', ended: 'skip:cli-not-waiting', nodata: 'skip:state-unknown', unknown: 'skip:state-unknown',
    estimated: 'skip:state-unknown', closed: 'skip:terminal-not-open', shell: 'skip:cli-not-running', exited: 'skip:cli-not-running', requested: 'send:waiting-for-input'
  });
});

test('the target decides who is considered: all, a role, a provider, one session', () => {
  const sessions = [session({ id: 'a', provider: 'claude' }), session({ id: 'b', provider: 'codex' }), session({ id: 'c', provider: 'claude' })];
  const roles = { a: 'worker', b: 'pm', c: 'pm' };
  const ids = (target) => plan(sessions, make({ target }), (entry) => roles[entry.id]).recipients.map((entry) => entry.id);
  assert.deepEqual(ids({ scope: 'all' }), ['a', 'b', 'c']);
  assert.deepEqual(ids({ scope: 'roleGroup', role: 'pm' }), ['b', 'c']);
  assert.deepEqual(ids({ scope: 'provider', provider: 'claude' }), ['a', 'c']);
  assert.deepEqual(ids({ scope: 'agent', agentId: 'c' }), ['c']);
  assert.deepEqual(ids({ scope: 'agent', agentId: 'someone-else' }), []);
  assert.deepEqual(ids({ scope: 'roleGroup', role: 'ghost' }), []);
});

test('an expired or revoked broadcast, or one with unsafe text, is not planned at all', () => {
  assert.deepEqual(plan([session()], make({ expiresAt: '2026-10-21T09:30:00.000Z' })), { ok: false, reason: 'broadcast-not-live' });
  assert.deepEqual(plan([session()], make({ revokedAt: '2026-10-21T09:30:00.000Z' })), { ok: false, reason: 'broadcast-not-live' });
  assert.deepEqual(planDelivery({ broadcast: null, sessions: [], now: NOW }), { ok: false, reason: 'broadcast-not-live' });
  assert.deepEqual(plan([session()], { ...make(), text: 'a\nb' }), { ok: false, reason: 'prompt-invalid' });
});

test('the confirmation lists who gets it, who does not and why, the complete prompt, and that typed is not read', () => {
  const lines = describePlan(plan([session({ id: 'a', name: 'Ready One' }), session({ id: 'b', name: 'Busy One', providerObservation: { status: { confidence: 'actual', value: 'working' } } }), session({ id: 'c', name: 'Unknown One', providerObservation: undefined })])).join('\n');
  assert.match(lines, /Will be typed into 1 session:/);
  assert.match(lines, /Ready One \(claude\)/);
  assert.match(lines, /Will NOT be sent to 2:/);
  assert.match(lines, /Busy One \(claude\): the CLI is busy working/);
  assert.match(lines, /Unknown One \(claude\): not sent: state unknown/);
  assert.match(lines, /\[Administrator broadcast, created 2026-10-21T09:00:00\.000Z\] Stop and run the tests first\./);
  assert.match(lines, /not proof that the CLI read it/);
  assert.match(describePlan(plan([session({ providerObservation: undefined })])).join('\n'), /No session can receive it now\./);
});

test('a delivery record keeps only ids, outcomes and reasons, and anything else is refused', () => {
  const good = { id: 'dl-1', broadcastId: 'bc-1', version: 1, at: '2026-10-21T10:00:00.000Z', results: [{ sessionId: 'session-1', provider: 'claude', outcome: 'sent', reason: 'waiting-for-input' }, { sessionId: 'session-2', provider: 'codex', outcome: 'skipped', reason: 'cli-busy' }] };
  const checked = validateDelivery({ ...good, results: good.results.map((entry) => ({ ...entry, name: 'Worker', path: '/x' })) });
  assert.equal(checked.ok, true);
  assert.deepEqual(Object.keys(checked.record.results[0]).sort(), ['outcome', 'provider', 'reason', 'sessionId'], 'names and paths are dropped');
  for (const bad of [null, { ...good, id: 'BAD ID' }, { ...good, broadcastId: '' }, { ...good, version: 0 }, { ...good, at: 'nope' }, { ...good, results: 'x' }, { ...good, results: [{ ...good.results[0], outcome: 'delivered' }] }, { ...good, results: [{ ...good.results[0], reason: 'because' }] }, { ...good, results: [{ ...good.results[0], sessionId: 'a b' }] }, { ...good, results: Array(201).fill(good.results[0]) }]) {
    assert.equal(validateDelivery(bad).ok, false, JSON.stringify(bad).slice(0, 60));
  }
  assert.equal(summarizeDeliveries([checked.record], 'bc-1'), 'typed into 1 session, not sent to 1');
  assert.equal(summarizeDeliveries([checked.record], 'other'), 'unknown (not sent to any CLI)');
  assert.equal(summarizeDeliveries(undefined, 'bc-1'), 'unknown (not sent to any CLI)');
});
