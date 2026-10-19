'use strict';

// Regression guard for the acceptance criterion "do not silently switch accounts" (#20).
// A launch held back by a limit must stay held back: the profile given to the launcher never changes,
// no other profile is started or gets a slot, and the message offers no automatic switch.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { PrivateStore } = require('../../src/storage/private-store');
const { AccountProfileService } = require('../../src/accounts/profile-service');
const { savePolicy, loadPolicy, QuotaDispatcher } = require('../../src/accounts/quota-policy');
const { runningSlots, reserveSlot } = require('../../src/accounts/quota-reservations');
const { gateLaunch, commitDispatch, wordsFor, LIMITS_NOTE } = require('../../src/accounts/quota-gate');
const { observe } = require('../../src/accounts/observation');
const { sandbox, COLLECTIONS } = require('../storage/helpers');

const NOW = new Date('2026-10-19T10:00:00.000Z');
const LEASE = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const reading = (value) => observe('quota.five_hour.used_percent', value, {
  unit: 'percent', scope: 'account', source: 'synthetic', observedAt: new Date(NOW.getTime() - 1_000), validForMs: 60_000
});
// Words that would offer to move the work elsewhere on its own.
const OFFERS_SWITCH = /\b(switch|switched|switching|instead|fall ?back|another account|other account|different account|alternative|reroute|moved? to|use (the )?(other|another))\b/i;

function environment(t) {
  const box = sandbox(t);
  const store = new PrivateStore({ dir: box.dir, repoRoot: box.repoRoot, collections: [...COLLECTIONS, 'quotaReservations'] });
  const service = new AccountProfileService({ store, sessions: () => [] });
  const make = (label) => service.create({ provider: 'claude', label, configDir: path.join(store.dir, label) }).profile;
  return { store, held: make('Limited Account'), idle: make('Idle Account') };
}

/**
 * The launch path in miniature, built from the real gate pieces in the order the extension uses them:
 * decide with gateLaunch, then take the slot atomically with reserveSlot, and only then call the launcher
 * with the profile that was asked for. `launcher` records every profile it was given.
 */
function startAgent({ store, profileId, observations, approval, running, launcher, leaseId }) {
  const policyRead = loadPolicy(store, profileId);
  const preview = gateLaunch({ policyRead, observations, now: NOW, running, approval });
  const reserved = reserveSlot({ store, accountKey: profileId, linkedAccountKeys: [], expectedPolicyRead: policyRead, observations, now: NOW, approval, leaseId });
  if (!reserved.ok || !reserved.decision?.allowed) return { launched: false, preview, reserved };
  launcher(profileId);
  return { launched: true, preview, reserved };
}

// Everything the held-back result may say or carry: no other profile, no label, no alternative.
function assertNoSwitch(result, others) {
  const allowedKeys = ['action', 'allowed', 'overridable', 'lines', 'note', 'reasons'];
  assert.deepEqual(Object.keys(result).sort(), allowedKeys.sort(), 'the gate result carries nothing beyond a decision and its reasons');
  const text = JSON.stringify(result);
  for (const other of others) {
    assert.equal(text.includes(other.id), false, 'no other profile id appears in the result');
    assert.equal(text.includes(other.label), false, 'no other account label appears in the result');
  }
  for (const line of [...result.lines, ...result.reasons.map(wordsFor)]) assert.doesNotMatch(line, OFFERS_SWITCH, line);
  if (result.note) assert.equal(result.note, LIMITS_NOTE);
}

test('a launch held at the pause threshold never reaches the launcher, never moves to another profile, and offers no switch', (t) => {
  const { store, held, idle } = environment(t);
  assert.equal(savePolicy(store, held.id, { blockAtPercent: 90, unknownQuota: 'block' }).ok, true);
  // The idle profile is the tempting fallback: no limits at all, nothing running.
  const launched = [];
  const launcher = (id) => launched.push(id);
  const outcome = startAgent({ store, profileId: held.id, observations: [reading(90)], running: 0, launcher, leaseId: LEASE(1) });

  assert.equal(outcome.launched, false);
  assert.deepEqual(launched, [], 'nothing was started, on any profile');
  assert.equal(outcome.preview.action, 'block');
  assert.equal(outcome.preview.reasons[0].code, 'quota-block-threshold');
  assertNoSwitch(outcome.preview, [idle]);
  assert.equal(outcome.reserved.decision.allowed, false);
  assert.deepEqual(outcome.reserved.decision.reasons.map((reason) => reason.code), ['quota-block-threshold']);
  assert.equal(runningSlots(store, idle.id, NOW).running, 0, 'the other profile got no slot');
  assert.equal(runningSlots(store, held.id, NOW).running, 0, 'the held profile took no slot either');

  // Asking again changes nothing: the same profile, the same refusal.
  const again = startAgent({ store, profileId: held.id, observations: [reading(90)], running: 0, launcher, leaseId: LEASE(2) });
  assert.equal(again.launched, false);
  assert.deepEqual(launched, []);

  // Only the user's explicit override starts it, and then on the profile that was asked for.
  const overridden = startAgent({ store, profileId: held.id, observations: [reading(90)], approval: 'override', running: 0, launcher, leaseId: LEASE(3) });
  assert.equal(overridden.launched, true);
  assert.deepEqual(launched, [held.id], 'the launcher got exactly the requested profile');
  assert.equal(runningSlots(store, idle.id, NOW).running, 0);
});

test('a launch held by the running limit (not overridable) stays on its profile: one slot, one launch, no switch', (t) => {
  const { store, held, idle } = environment(t);
  assert.equal(savePolicy(store, held.id, { maxConcurrent: 1, unknownQuota: 'require-confirmation' }).ok, true);
  const launched = [];
  const launcher = (id) => launched.push(id);
  const reads = [reading(10)];

  const first = startAgent({ store, profileId: held.id, observations: reads, running: 0, launcher, leaseId: LEASE(1) });
  assert.equal(first.launched, true);
  assert.deepEqual(launched, [held.id]);

  for (const approval of [undefined, 'confirm', 'override']) {
    const second = startAgent({ store, profileId: held.id, observations: reads, approval, running: 1, launcher, leaseId: LEASE(2) });
    assert.equal(second.launched, false, `approval ${approval} cannot lift the running limit`);
    assert.equal(second.preview.action, 'block');
    assert.equal(second.preview.overridable, false);
    assert.equal(second.preview.reasons[0].code, 'concurrency-limit');
    assertNoSwitch(second.preview, [idle]);
  }
  assert.deepEqual(launched, [held.id], 'the launcher was never called again, and never with another profile');
  assert.equal(runningSlots(store, held.id, NOW).running, 1);
  assert.equal(runningSlots(store, idle.id, NOW).running, 0, 'the free profile was not used as a fallback');
});

test('the in-memory dispatcher refuses at its limit without reserving on another account it knows about', () => {
  const dispatcher = new QuotaDispatcher();
  const policy = { maxConcurrent: 1, unknownQuota: 'block' };
  const policyRead = { ok: true, stored: true, policy };
  const open = commitDispatch({ policyRead, observations: [reading(10)], now: NOW, dispatcher, accountKey: 'limited' });
  assert.equal(open.ok, true);
  // Another account with free capacity is known to the dispatcher: the tempting fallback.
  const other = commitDispatch({ policyRead: { ok: true, stored: true, policy: { maxConcurrent: 5, unknownQuota: 'block' } }, observations: [reading(10)], now: NOW, dispatcher, accountKey: 'spare' });
  assert.equal(other.ok, true);
  const before = [dispatcher.running('limited'), dispatcher.running('spare')];
  assert.deepEqual(before, [1, 1]);

  const held = commitDispatch({ policyRead, observations: [reading(10)], now: NOW, dispatcher, accountKey: 'limited' });
  assert.equal(held.ok, false);
  assert.equal(held.code, 'quota-gate');
  assert.equal(Object.hasOwn(held, 'release'), false, 'a refused launch hands out nothing to run');
  assert.doesNotMatch(held.message, OFFERS_SWITCH);
  assert.equal(held.message.includes('spare'), false, 'the other account is not named');
  assert.deepEqual([dispatcher.running('limited'), dispatcher.running('spare')], before, 'no slot moved to or was taken on another account');
  assert.deepEqual([...dispatcher.slots.keys()].sort(), ['limited', 'spare']);
});
