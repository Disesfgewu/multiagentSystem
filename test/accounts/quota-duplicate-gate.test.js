'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { PrivateStore } = require('../../src/storage/private-store');
const { AccountProfileService } = require('../../src/accounts/profile-service');
const { savePolicy, loadPolicy, decideDispatch } = require('../../src/accounts/quota-policy');
const { runningSlots, reserveSlot, releaseSlot, recoverOrphanedSlots } = require('../../src/accounts/quota-reservations');
const { recordVerifiedIdentity, linkedProfiles, resolveGroup, groupReadings, readingsTrust, trustedReadings, coordinatePolicies } = require('../../src/accounts/identity-registry');
const { describeAccounts } = require('../../src/accounts/profile-view');
const { presentAccount } = require('../../src/overview/presentation');
const { observe, CONFIDENCE } = require('../../src/accounts/observation');
const { sandbox, COLLECTIONS } = require('../storage/helpers');

const duplicatesOf = (store, id, profiles) => {
  const found = linkedProfiles(store, id, profiles.map((profile) => profile.id));
  assert.equal(found.ok, true);
  return found.ids;
};
// What the gate shows and the reservation rechecks: the limits coordinated over the whole group.
const coordRead = (store, id, ids) => (ids.length > 0 ? coordinatePolicies([loadPolicy(store, id), ...ids.map((other) => loadPolicy(store, other))]) : loadPolicy(store, id));
const recordIdentityAt = (store, id, identity, at) => assert.equal(recordVerifiedIdentity(store, id, identity, at).ok, true);
const recordIdentity = (store, id, identity) => assert.equal(recordVerifiedIdentity(store, id, identity, NOW).ok, true);

const COLLECTION_NAMES = [...COLLECTIONS, 'quotaReservations'];
const NOW = new Date('2026-10-19T10:00:00.000Z');
const LEASE_A = '11111111-1111-4111-8111-111111111111';
const LEASE_B = '22222222-2222-4222-8222-222222222222';

const crypto = require('node:crypto');
// The opaque subject hash a real check produces (see observation.js subjectKey).
const subjectOf = (email) => crypto.createHash('sha256').update(`claude\0${email}`).digest('hex').slice(0, 32);
const verifiedIdentity = (profileId, email, provider = 'claude') => ({
  profileId,
  provider,
  loggedIn: true,
  authMethod: 'claude.ai',
  anomalies: [],
  configDirMatches: true,
  subject: {
    field: 'subject',
    value: subjectOf(email),
    confidence: CONFIDENCE.ACTUAL,
    observedAt: NOW.toISOString()
  }
});

const unverifiedIdentity = (profileId, provider = 'claude') => ({
  profileId,
  provider,
  loggedIn: false,
  authMethod: 'unknown',
  anomalies: [],
  configDirMatches: null,
  subject: {
    field: 'subject',
    value: null,
    confidence: CONFIDENCE.UNKNOWN,
    reason: 'not-logged-in'
  }
});

const reading = () => observe('quota.window.used_percent', 10, {
  unit: 'percent', scope: 'account', source: 'synthetic',
  observedAt: new Date(NOW.getTime() - 1_000), validForMs: 60_000
});

function setupEnvironment(t) {
  const box = sandbox(t);
  const store = new PrivateStore({ dir: box.dir, repoRoot: box.repoRoot, collections: COLLECTION_NAMES });
  const service = new AccountProfileService({ store, sessions: () => [] });
  return { store, service, box };
}

test('identical labels do not cause duplicate grouping when identity is unverified (no guessing by label)', (t) => {
  const { store, service } = setupEnvironment(t);
  const p1 = service.create({ provider: 'claude', label: 'Team Account', configDir: path.join(store.dir, 'cfg1') }).profile;
  const p2 = service.create({ provider: 'claude', label: 'Team Account 2', configDir: path.join(store.dir, 'cfg2') }).profile;

  // Before identity check: both unverified
  const profiles = [p1, p2];
  assert.deepEqual(duplicatesOf(store, p1.id, profiles), [], 'unverified profiles are never assumed to be duplicate');
  assert.deepEqual(duplicatesOf(store, p2.id, profiles), []);

  // Set limits on p1 only
  assert.equal(savePolicy(store, p1.id, { maxConcurrent: 1, unknownQuota: 'block' }).ok, true);

  // Take a lease on p1 with a fresh observation
  const res1 = reserveSlot({
    store,
    accountKey: p1.id,
    linkedAccountKeys: duplicatesOf(store, p1.id, profiles),
    expectedPolicyRead: coordRead(store, p1.id, duplicatesOf(store, p1.id, profiles)),
    observations: [reading()],
    now: NOW,
    leaseId: LEASE_A
  });
  assert.equal(res1.decision.allowed, true);

  // Launch on p2 is independent and NOT blocked by p1's running agent
  const res2 = reserveSlot({
    store,
    accountKey: p2.id,
    linkedAccountKeys: duplicatesOf(store, p2.id, profiles),
    expectedPolicyRead: coordRead(store, p2.id, duplicatesOf(store, p2.id, profiles)),
    observations: [reading()],
    now: NOW,
    leaseId: LEASE_B
  });
  assert.equal(res2.decision.allowed, true);
});

test('two profiles sharing verified provider identity share concurrency limits under PrivateStore atomic lock', (t) => {
  const { store, service } = setupEnvironment(t);
  const p1 = service.create({ provider: 'claude', label: 'Claude Work', configDir: path.join(store.dir, 'cfg1') }).profile;
  const p2 = service.create({ provider: 'claude', label: 'Claude Work Secondary', configDir: path.join(store.dir, 'cfg2') }).profile;
  const profiles = [p1, p2];

  // Both verified with the same actual provider account
  recordIdentity(store, p1.id, verifiedIdentity(p1.id, 'shared-alice@example.com'));
  recordIdentity(store, p2.id, verifiedIdentity(p2.id, 'shared-alice@example.com'));

  // Discovered as duplicate profiles
  assert.deepEqual(duplicatesOf(store, p1.id, profiles), [p2.id]);
  assert.deepEqual(duplicatesOf(store, p2.id, profiles), [p1.id]);

  // Set maxConcurrent = 1 on p1
  assert.equal(savePolicy(store, p1.id, { maxConcurrent: 1, unknownQuota: 'block' }).ok, true);
  assert.equal(savePolicy(store, p2.id, { maxConcurrent: 1, unknownQuota: 'block' }).ok, true);

  // Reserve slot for p1 with linked duplicate profile p2
  const dupP1 = duplicatesOf(store, p1.id, profiles);
  const res1 = reserveSlot({
    store,
    accountKey: p1.id,
    linkedAccountKeys: dupP1,
    expectedPolicyRead: coordRead(store, p1.id, dupP1),
    observations: [reading()],
    now: NOW,
    leaseId: LEASE_A
  });
  assert.equal(res1.decision.allowed, true);

  // Checking running slots on p2 reflects p1's active lease
  const dupP2 = duplicatesOf(store, p2.id, profiles);
  const slotsP2 = runningSlots(store, p2.id, NOW, { linkedAccountKeys: dupP2 });
  assert.deepEqual(slotsP2, { ok: true, running: 1, orphaned: 0 });

  // Attempt to reserve slot for duplicate profile p2: blocked by shared real account limit!
  const res2 = reserveSlot({
    store,
    accountKey: p2.id,
    linkedAccountKeys: dupP2,
    expectedPolicyRead: coordRead(store, p2.id, dupP2),
    observations: [reading()],
    now: NOW,
    leaseId: LEASE_B
  });
  assert.equal(res2.decision.allowed, false);
  assert.equal(res2.decision.reasons[0].code, 'concurrency-limit');
  assert.equal(res2.decision.reasons[0].running, 1);
  assert.equal(res2.decision.reasons[0].limit, 1);

  // Releasing lease on p1 immediately frees capacity for p2
  assert.deepEqual(releaseSlot(store, res1.decision.reservation, NOW), { ok: true, released: true });

  const retryP2 = reserveSlot({
    store,
    accountKey: p2.id,
    linkedAccountKeys: dupP2,
    expectedPolicyRead: coordRead(store, p2.id, dupP2),
    observations: [reading()],
    now: NOW,
    leaseId: LEASE_B
  });
  assert.equal(retryP2.decision.allowed, true);
});

test('policy enforcement cannot be bypassed by launching through an unconfigured duplicate profile', (t) => {
  const { store, service } = setupEnvironment(t);
  const p1 = service.create({ provider: 'claude', label: 'Primary Configured', configDir: path.join(store.dir, 'cfg1') }).profile;
  const p2 = service.create({ provider: 'claude', label: 'Secondary Unconfigured', configDir: path.join(store.dir, 'cfg2') }).profile;
  const profiles = [p1, p2];

  recordIdentity(store, p1.id, verifiedIdentity(p1.id, 'shared-bob@example.com'));
  recordIdentity(store, p2.id, verifiedIdentity(p2.id, 'shared-bob@example.com'));

  // User configured maxConcurrent: 1 on p1, but left p2 without policy
  assert.equal(savePolicy(store, p1.id, { maxConcurrent: 1, unknownQuota: 'block' }).ok, true);
  assert.equal(loadPolicy(store, p2.id).stored, false);

  // Take a slot on p1
  const dupP1 = duplicatesOf(store, p1.id, profiles);
  const res1 = reserveSlot({
    store,
    accountKey: p1.id,
    linkedAccountKeys: dupP1,
    expectedPolicyRead: coordRead(store, p1.id, dupP1),
    observations: [reading()],
    now: NOW,
    leaseId: LEASE_A
  });
  assert.equal(res1.decision.allowed, true);

  // Attempting to launch p2 (which has no stored policy of its own) coordinates with p1's policy
  // and blocks because the shared real account limit (1) is reached!
  const dupP2 = duplicatesOf(store, p2.id, profiles);
  const res2 = reserveSlot({
    store,
    accountKey: p2.id,
    linkedAccountKeys: dupP2,
    expectedPolicyRead: coordRead(store, p2.id, dupP2),
    observations: [reading()],
    now: NOW,
    leaseId: LEASE_B
  });
  assert.equal(res2.decision.allowed, false, 'cannot bypass limit via unconfigured duplicate profile');
  assert.equal(res2.decision.reasons[0].code, 'concurrency-limit');
});

test('profiles with different verified identities are never mixed or grouped', (t) => {
  const { store, service } = setupEnvironment(t);
  const pAlice = service.create({ provider: 'claude', label: 'Alice Profile', configDir: path.join(store.dir, 'cfg1') }).profile;
  const pBob = service.create({ provider: 'claude', label: 'Bob Profile', configDir: path.join(store.dir, 'cfg2') }).profile;
  const profiles = [pAlice, pBob];

  recordIdentity(store, pAlice.id, verifiedIdentity(pAlice.id, 'alice@company.com'));
  recordIdentity(store, pBob.id, verifiedIdentity(pBob.id, 'bob@company.com'));

  assert.deepEqual(duplicatesOf(store, pAlice.id, profiles), []);
  assert.deepEqual(duplicatesOf(store, pBob.id, profiles), []);

  assert.equal(savePolicy(store, pAlice.id, { maxConcurrent: 1, unknownQuota: 'block' }).ok, true);
  assert.equal(savePolicy(store, pBob.id, { maxConcurrent: 1, unknownQuota: 'block' }).ok, true);

  const resAlice = reserveSlot({
    store,
    accountKey: pAlice.id,
    linkedAccountKeys: duplicatesOf(store, pAlice.id, profiles),
    expectedPolicyRead: coordRead(store, pAlice.id, duplicatesOf(store, pAlice.id, profiles)),
    observations: [reading()],
    now: NOW,
    leaseId: LEASE_A
  });
  assert.equal(resAlice.decision.allowed, true);

  // Bob is completely independent and allowed
  const resBob = reserveSlot({
    store,
    accountKey: pBob.id,
    linkedAccountKeys: duplicatesOf(store, pBob.id, profiles),
    expectedPolicyRead: coordRead(store, pBob.id, duplicatesOf(store, pBob.id, profiles)),
    observations: [reading()],
    now: NOW,
    leaseId: LEASE_B
  });
  assert.equal(resBob.decision.allowed, true);
});

test('describeAccounts and presentAccount reflect duplicate status and shared limits in UI', (t) => {
  const { store, service } = setupEnvironment(t);
  const p1 = service.create({ provider: 'claude', label: 'Work Claude 1', configDir: path.join(store.dir, 'cfg1') }).profile;
  const p2 = service.create({ provider: 'claude', label: 'Work Claude 2', configDir: path.join(store.dir, 'cfg2') }).profile;
  const profiles = [p1, p2];

  const id1 = verifiedIdentity(p1.id, 'team-shared@example.com');
  const id2 = verifiedIdentity(p2.id, 'team-shared@example.com');
  recordIdentity(store, p1.id, id1);
  recordIdentity(store, p2.id, id2);

  const observations = new Map([
    [p1.id, { identity: id1 }],
    [p2.id, { identity: id2 }]
  ]);

  const described = describeAccounts({ profiles, observations, context: { repoRoot: store.repoRoot } });
  assert.equal(described.length, 2);
  assert.deepEqual(described[0].duplicateOf, [p2.id]);
  assert.deepEqual(described[1].duplicateOf, [p1.id]);
  assert.ok(described[0].issues.some((i) => i.code === 'duplicate-account'));
  assert.ok(described[1].issues.some((i) => i.code === 'duplicate-account'));

  // Presentation in Overview
  const presented = presentAccount({
    id: p1.id,
    label: p1.label,
    provider: 'Claude Code',
    policy: 'Limits: at most 1 running at once.',
    usage: ['Usage: unknown.'],
    duplicateOf: [p2.id],
    gate: {
      action: 'block',
      line: 'Right now: a new agent would be held back. 1 agent is already running on this account, and the limit is 1.',
      reason: '1 agent is already running on this account, and the limit is 1.'
    }
  });

  assert.equal(presented.gateAction, 'block');
  assert.equal(presented.contextValue, 'multiagentOverviewAccountBlocked');
  assert.deepEqual(presented.duplicateOf, [p2.id]);
  assert.match(presented.tooltip.join('\n'), /Duplicate account: shares limits with other profiles for this account \(acct-.*?\)/);
});

const reserve = (store, id, ids, leaseId, over = {}) => reserveSlot({
  store, accountKey: id, linkedAccountKeys: ids, expectedPolicyRead: coordRead(store, id, ids),
  observations: [reading()], now: NOW, leaseId, ...over
});

test('a second Extension Host, or a restarted one, still shares the limit: the groups come from the store, not from memory', (t) => {
  const { store, service, box } = setupEnvironment(t);
  const p1 = service.create({ provider: 'claude', label: 'One', configDir: path.join(store.dir, 'cfg1') }).profile;
  const p2 = service.create({ provider: 'claude', label: 'Two', configDir: path.join(store.dir, 'cfg2') }).profile;
  const profiles = [p1, p2];
  recordIdentity(store, p1.id, verifiedIdentity(p1.id, 'shared@example.com'));
  recordIdentity(store, p2.id, verifiedIdentity(p2.id, 'shared@example.com'));
  assert.equal(savePolicy(store, p1.id, { maxConcurrent: 1, unknownQuota: 'block' }).ok, true);
  assert.equal(reserve(store, p1.id, duplicatesOf(store, p1.id, profiles), LEASE_A).decision.allowed, true);

  // Another host: a new PrivateStore over the same folder, with no check of its own in this process.
  const otherHost = new PrivateStore({ dir: box.dir, repoRoot: box.repoRoot, collections: COLLECTION_NAMES });
  const group = duplicatesOf(otherHost, p2.id, profiles);
  assert.deepEqual(group, [p1.id], 'the other host knows the group');
  const blocked = reserve(otherHost, p2.id, group, LEASE_B);
  assert.deepEqual([blocked.decision.allowed, blocked.decision.reasons[0].code], [false, 'concurrency-limit']);
});

test('one failed check of a profile does not let its sibling go past the shared limit', (t) => {
  const { store, service } = setupEnvironment(t);
  const p1 = service.create({ provider: 'claude', label: 'One', configDir: path.join(store.dir, 'cfg1') }).profile;
  const p2 = service.create({ provider: 'claude', label: 'Two', configDir: path.join(store.dir, 'cfg2') }).profile;
  const profiles = [p1, p2];
  recordIdentity(store, p1.id, verifiedIdentity(p1.id, 'shared@example.com'));
  recordIdentity(store, p2.id, verifiedIdentity(p2.id, 'shared@example.com'));
  assert.equal(savePolicy(store, p1.id, { maxConcurrent: 1, unknownQuota: 'block' }).ok, true);
  assert.equal(reserve(store, p1.id, duplicatesOf(store, p1.id, profiles), LEASE_A).decision.allowed, true);
  // p1's next check fails or finds it signed out: the checks record nothing, and nothing is unlinked.
  recordVerifiedIdentity(store, p1.id, unverifiedIdentity(p1.id), NOW);
  recordVerifiedIdentity(store, p1.id, null, NOW);
  const blocked = reserve(store, p2.id, duplicatesOf(store, p2.id, profiles), LEASE_B);
  assert.equal(blocked.decision.allowed, false, 'p1 is still running and still shares the account');
});

test('a profile that now signs in as another account cannot lift the limit of the group it left', (t) => {
  const { store, service } = setupEnvironment(t);
  const p1 = service.create({ provider: 'claude', label: 'One', configDir: path.join(store.dir, 'cfg1') }).profile;
  const p2 = service.create({ provider: 'claude', label: 'Two', configDir: path.join(store.dir, 'cfg2') }).profile;
  const profiles = [p1, p2];
  recordIdentity(store, p1.id, verifiedIdentity(p1.id, 'alice@example.com'));
  recordIdentity(store, p2.id, verifiedIdentity(p2.id, 'alice@example.com'));
  assert.equal(savePolicy(store, p1.id, { maxConcurrent: 1, unknownQuota: 'block' }).ok, true);
  assert.equal(reserve(store, p1.id, duplicatesOf(store, p1.id, profiles), LEASE_A).decision.allowed, true);
  recordIdentity(store, p2.id, verifiedIdentity(p2.id, 'bob@example.com'));
  assert.deepEqual(duplicatesOf(store, p2.id, profiles), [p1.id], 'still counted with the account it was verified as before');
  assert.equal(reserve(store, p2.id, duplicatesOf(store, p2.id, profiles), LEASE_B).decision.allowed, false);
});

test('a linked profile\'s limits changing before the lease is taken is caught inside the same transaction', (t) => {
  const { store, service } = setupEnvironment(t);
  const p1 = service.create({ provider: 'claude', label: 'One', configDir: path.join(store.dir, 'cfg1') }).profile;
  const p2 = service.create({ provider: 'claude', label: 'Two', configDir: path.join(store.dir, 'cfg2') }).profile;
  const profiles = [p1, p2];
  recordIdentity(store, p1.id, verifiedIdentity(p1.id, 'shared@example.com'));
  recordIdentity(store, p2.id, verifiedIdentity(p2.id, 'shared@example.com'));
  assert.equal(savePolicy(store, p1.id, { maxConcurrent: 2, unknownQuota: 'block' }).ok, true);
  const ids = duplicatesOf(store, p1.id, profiles);
  const shown = coordRead(store, p1.id, ids);
  // The sibling's limit is tightened after the person was shown the limits, before the lease is taken.
  assert.equal(savePolicy(store, p2.id, { maxConcurrent: 1, unknownQuota: 'block' }).ok, true);
  const refused = reserveSlot({ store, accountKey: p1.id, linkedAccountKeys: ids, expectedPolicyRead: shown, observations: [reading()], now: NOW, leaseId: LEASE_A });
  assert.deepEqual([refused.ok, refused.reason], [false, 'policy-changed']);
  assert.equal(runningSlots(store, p1.id, NOW, { linkedAccountKeys: ids }).running, 0, 'no lease was taken');
  assert.equal(reserve(store, p1.id, ids, LEASE_A).decision.allowed, true, 'with the current limits shown, it goes through');
});

test('when the profile list cannot be read after links and leases exist, the group is unknown and nothing is reserved on a guess', (t) => {
  const { store, service } = setupEnvironment(t);
  const p1 = service.create({ provider: 'claude', label: 'One', configDir: path.join(store.dir, 'cfg1') }).profile;
  const p2 = service.create({ provider: 'claude', label: 'Two', configDir: path.join(store.dir, 'cfg2') }).profile;
  recordIdentity(store, p1.id, verifiedIdentity(p1.id, 'shared@example.com'));
  recordIdentity(store, p2.id, verifiedIdentity(p2.id, 'shared@example.com'));
  assert.equal(savePolicy(store, p1.id, { maxConcurrent: 1, unknownQuota: 'block' }).ok, true);
  assert.equal(reserve(store, p1.id, [p2.id], LEASE_A).decision.allowed, true);
  assert.deepEqual(resolveGroup(store, () => service.list(), p2.id).ids, [p1.id], 'with a readable list the sibling is known');
  const realList = service.list.bind(service);
  service.list = () => ({ ok: false, reason: 'store-unavailable' });
  const unknown = resolveGroup(store, () => service.list(), p2.id);
  assert.deepEqual(unknown, { ok: false, reason: 'profiles-unavailable' }, 'not an empty group');
  assert.equal(runningSlots(store, p1.id, NOW, { linkedAccountKeys: [p2.id] }).running, 1, 'p1\'s lease is still there to be counted once the list is readable');
  service.list = realList;
  assert.deepEqual(resolveGroup(store, () => service.list(), p2.id).ids, [p1.id], 'back to normal');
});

const percent = (value, ageMs, confidence = 'actual') => observe('quota.window.used_percent', value, {
  unit: 'percent', scope: 'account', source: 'synthetic', confidence, observedAt: new Date(NOW.getTime() - ageMs), validForMs: 600_000
});

// The decision the gate takes for `id`: the group from the store, the readings that describe its account, the coordinated limits.
function gateDecision(store, service, id, readingsOf) {
  const group = resolveGroup(store, () => service.list(), id);
  assert.equal(group.ok, true);
  // Exactly what the gate does: each profile's readings are filtered by that profile's own trust first.
  const readings = new Map(group.current.map((other) => [other, trustedReadings(readingsOf[other], readingsTrust(store, other))]));
  const observations = groupReadings(trustedReadings(readingsOf[id], readingsTrust(store, id)), group.current, readings, NOW);
  const policy = group.ids.length > 0 ? coordinatePolicies([loadPolicy(store, id), ...group.ids.map((other) => loadPolicy(store, other))]) : loadPolicy(store, id);
  const decision = decideDispatch({ policy: policy.policy, observations, now: NOW, running: 0, approval: undefined });
  return { group, decision };
}

test('a profile that moved to another account never lifts the usage block of the account it left', (t) => {
  const { store, service } = setupEnvironment(t);
  const p1 = service.create({ provider: 'claude', label: 'One', configDir: path.join(store.dir, 'cfg1') }).profile;
  const p2 = service.create({ provider: 'claude', label: 'Two', configDir: path.join(store.dir, 'cfg2') }).profile;
  recordIdentity(store, p1.id, verifiedIdentity(p1.id, 'alice@example.com'));
  recordIdentity(store, p2.id, verifiedIdentity(p2.id, 'alice@example.com'));
  assert.equal(savePolicy(store, p2.id, { blockAtPercent: 90, unknownQuota: 'block' }).ok, true);
  // Account A (p2's) is at 95%, read a minute ago. p1 then signs in as account B, which is at 10%, read just now.
  recordIdentity(store, p1.id, verifiedIdentity(p1.id, 'bob@example.com'));
  const readingsOf = { [p2.id]: [percent(95, 60_000)], [p1.id]: [percent(10, 1_000)] };
  const { group, decision } = gateDecision(store, service, p2.id, readingsOf);
  assert.deepEqual(group.ids, [p1.id], 'p1 is still counted for leases and limits');
  assert.deepEqual(group.current, [], 'but it is not signed in as p2\'s account, so its readings are not p2\'s');
  assert.equal(decision.allowed, false, 'p2 stays blocked by its own 95%');
  assert.ok(decision.reasons.some((reason) => /usage|percent|block/i.test(JSON.stringify(reason))), JSON.stringify(decision.reasons));
});

test('profiles that are the same account now do share readings, and the highest valid actual percentage decides', (t) => {
  const { store, service } = setupEnvironment(t);
  const p1 = service.create({ provider: 'claude', label: 'One', configDir: path.join(store.dir, 'cfg1') }).profile;
  const p2 = service.create({ provider: 'claude', label: 'Two', configDir: path.join(store.dir, 'cfg2') }).profile;
  recordIdentity(store, p1.id, verifiedIdentity(p1.id, 'alice@example.com'));
  recordIdentity(store, p2.id, verifiedIdentity(p2.id, 'alice@example.com'));
  assert.equal(savePolicy(store, p2.id, { blockAtPercent: 90, unknownQuota: 'block' }).ok, true);
  const readingsOf = { [p2.id]: [percent(95, 60_000)], [p1.id]: [percent(10, 1_000)] };
  const { group, decision } = gateDecision(store, service, p2.id, readingsOf);
  assert.deepEqual([group.ids, group.current], [[p1.id], [p1.id]]);
  assert.equal(decision.allowed, false, 'the sibling\'s newer, lower figure may belong to a link that is out of date: the higher figure holds');
  const expiredHigh = { [p2.id]: [percent(95, 700_000)], [p1.id]: [percent(10, 1_000)] };
  assert.equal(gateDecision(store, service, p2.id, expiredHigh).decision.allowed, true, 'once the higher reading has expired only the valid one counts');
});

test('B to A: readings left from before a profile took on this account never lift the block, and nor do its own old ones', (t) => {
  const { store, service } = setupEnvironment(t);
  const p1 = service.create({ provider: 'claude', label: 'One', configDir: path.join(store.dir, 'cfg1') }).profile;
  const p2 = service.create({ provider: 'claude', label: 'Two', configDir: path.join(store.dir, 'cfg2') }).profile;
  recordIdentity(store, p1.id, verifiedIdentity(p1.id, 'bob@example.com'));
  recordIdentity(store, p2.id, verifiedIdentity(p2.id, 'alice@example.com'));
  assert.equal(savePolicy(store, p1.id, { blockAtPercent: 90, unknownQuota: 'block' }).ok, true);
  assert.equal(savePolicy(store, p2.id, { blockAtPercent: 90, unknownQuota: 'block' }).ok, true);
  // p2's account A is at 95%; p1's file still holds account B's 10%, written a second ago.
  const readingsOf = { [p2.id]: [percent(95, 60_000)], [p1.id]: [percent(10, 40_000)] };
  // p1 is verified as A thirty seconds ago, after that reading was written. No new reading was written since.
  recordIdentityAt(store, p1.id, verifiedIdentity(p1.id, 'alice@example.com'), new Date(NOW.getTime() - 30_000));
  const { group, decision } = gateDecision(store, service, p2.id, readingsOf);
  assert.deepEqual(group.current, [p1.id], 'p1 is the same account now');
  assert.equal(decision.allowed, false, 'the old 10% is not A\'s, so A\'s 95% still blocks');
  // p1's own gate has no reading it can trust yet: unknown, which this policy holds back.
  const own = gateDecision(store, service, p1.id, readingsOf);
  assert.equal(own.decision.allowed, false, 'its own old reading does not count as a reading of the new account');
  // A reading written after the change is trusted again.
  const fresh = { [p2.id]: [percent(95, 700_000)], [p1.id]: [percent(20, 1_000)] };
  assert.equal(gateDecision(store, service, p1.id, fresh).decision.allowed, true, 'a reading after the change is its account\'s reading (the sibling\'s old one has expired)');
});

test('a session that was already running when the profile changed account: its readings stay untrusted while it runs and after it ends, until a later reading follows', (t) => {
  const { store, service, box } = setupEnvironment(t);
  const p1 = service.create({ provider: 'claude', label: 'One', configDir: path.join(store.dir, 'cfg1') }).profile;
  recordIdentity(store, p1.id, verifiedIdentity(p1.id, 'bob@example.com'));
  assert.equal(savePolicy(store, p1.id, { blockAtPercent: 90, unknownQuota: 'block' }).ok, true);
  const at = (secondsAgo) => new Date(NOW.getTime() - secondsAgo * 1000);
  const taken = reserveSlot({ store, accountKey: p1.id, linkedAccountKeys: [], expectedPolicyRead: loadPolicy(store, p1.id), observations: [percent(10, 61_000)], now: at(60), leaseId: LEASE_A });
  assert.equal(taken.decision.allowed, true);
  // The profile is verified as A at T-30s while the B session keeps running; at T-20s that B session writes 20%.
  recordIdentityAt(store, p1.id, verifiedIdentity(p1.id, 'alice@example.com'), at(30));
  const fromOldSession = { [p1.id]: [percent(20, 20_000)] };
  assert.deepEqual(readingsTrust(store, p1.id).trusted, false, 'the old session is still running and may still be reporting B');
  assert.equal(gateDecision(store, service, p1.id, fromOldSession).decision.allowed, false, 'its reading is not used while it runs');
  // The B session ends at T-10s. The file was not written again, but ending does not make its 20% account A's.
  assert.equal(releaseSlot(store, taken.decision.reservation, at(10)).ok, true);
  assert.equal(readingsTrust(store, p1.id).trusted, true, 'nothing from before the change is still running');
  assert.equal(gateDecision(store, service, p1.id, fromOldSession).decision.allowed, false, 'the reading the old session left behind is still not trusted');
  // A reading written after it ended, by a session that started under account A, is account A's.
  assert.equal(gateDecision(store, service, p1.id, { [p1.id]: [percent(20, 1_000)] }).decision.allowed, true, 'a later reading is trusted');
  // The barrier is kept in the store: another host, or this one after a restart, does not bring the old file back.
  const restarted = new PrivateStore({ dir: box.dir, repoRoot: box.repoRoot, collections: COLLECTION_NAMES });
  assert.equal(gateDecision(restarted, service, p1.id, fromOldSession).decision.allowed, false);
  assert.equal(gateDecision(restarted, service, p1.id, { [p1.id]: [percent(20, 1_000)] }).decision.allowed, true);
});

test('a session that was recovered instead of ended moves the barrier the same way', (t) => {
  const { store, service } = setupEnvironment(t);
  const p1 = service.create({ provider: 'claude', label: 'One', configDir: path.join(store.dir, 'cfg1') }).profile;
  recordIdentity(store, p1.id, verifiedIdentity(p1.id, 'bob@example.com'));
  assert.equal(savePolicy(store, p1.id, { blockAtPercent: 90, unknownQuota: 'block' }).ok, true);
  const at = (secondsAgo) => new Date(NOW.getTime() - secondsAgo * 1000);
  const taken = reserveSlot({ store, accountKey: p1.id, linkedAccountKeys: [], expectedPolicyRead: loadPolicy(store, p1.id), observations: [percent(10, 61_000)], now: at(60), leaseId: LEASE_B, ownerPid: 4242, ownerHost: 'host-a', isOwnerAlive: () => true });
  assert.equal(taken.decision.allowed, true);
  recordIdentityAt(store, p1.id, verifiedIdentity(p1.id, 'alice@example.com'), at(30));
  const left = { [p1.id]: [percent(20, 20_000)] };
  assert.equal(readingsTrust(store, p1.id).trusted, false);
  assert.deepEqual(recoverOrphanedSlots(store, p1.id, at(10), { ownerHost: 'host-a', isOwnerAlive: () => false }), { ok: true, recovered: 1 });
  assert.equal(readingsTrust(store, p1.id).trusted, true);
  assert.equal(gateDecision(store, service, p1.id, left).decision.allowed, false, 'a recovered session\'s leftovers are not trusted either');
  assert.equal(gateDecision(store, service, p1.id, { [p1.id]: [percent(20, 1_000)] }).decision.allowed, true);
});

test('a profile that never changed account keeps all its readings, old or new', (t) => {
  const { store, service } = setupEnvironment(t);
  const p1 = service.create({ provider: 'claude', label: 'One', configDir: path.join(store.dir, 'cfg1') }).profile;
  recordIdentity(store, p1.id, verifiedIdentity(p1.id, 'alice@example.com'));
  recordIdentity(store, p1.id, verifiedIdentity(p1.id, 'alice@example.com'));
  assert.deepEqual(readingsTrust(store, p1.id), { ok: true, trusted: true, since: null });
  assert.equal(trustedReadings([percent(10, 3_600_000)], readingsTrust(store, p1.id)).length, 1);
  assert.deepEqual(trustedReadings([percent(10, 1)], { ok: false, trusted: false, since: null }), [], 'unreadable trust uses nothing');
  assert.deepEqual(readingsTrust(store, 'never-verified'), { ok: true, trusted: true, since: null }, 'a profile without a link has no change to account for');
});

test('a profile with a running lease cannot be removed, so its siblings keep counting it; once nothing runs, removal also drops its account link', async (t) => {
  const { store, service } = setupEnvironment(t);
  const p1 = service.create({ provider: 'claude', label: 'One', configDir: path.join(store.dir, 'cfg1') }).profile;
  const p2 = service.create({ provider: 'claude', label: 'Two', configDir: path.join(store.dir, 'cfg2') }).profile;
  recordIdentity(store, p1.id, verifiedIdentity(p1.id, 'alice@example.com'));
  recordIdentity(store, p2.id, verifiedIdentity(p2.id, 'alice@example.com'));
  assert.equal(savePolicy(store, p1.id, { maxConcurrent: 1, unknownQuota: 'block' }).ok, true);
  const taken = reserve(store, p1.id, [p2.id], LEASE_A);
  assert.equal(taken.decision.allowed, true);
  // Another window's agent runs on p1: this window's own session list does not show it.
  const refused = await service.remove(p1.id);
  assert.deepEqual([refused.ok, refused.code ?? refused.reason], [false, 'profile-in-use']);
  assert.deepEqual(linkedProfiles(store, p2.id, [p1.id, p2.id]).ids, [p1.id], 'p2 still counts p1');
  assert.equal(runningSlots(store, p2.id, NOW, { linkedAccountKeys: [p1.id] }).running, 1);
  assert.equal(reserve(store, p2.id, [p1.id], LEASE_B).decision.allowed, false, 'and is still held back by it');
  assert.equal(releaseSlot(store, taken.decision.reservation, NOW).ok, true);
  const removed = await service.remove(p1.id);
  assert.equal(removed.ok, true);
  assert.equal(store.get('quotaReservations', `identity-${p1.id}`).found, false, 'its account link went with it');
  assert.deepEqual(linkedProfiles(store, p2.id, [p2.id]).ids, []);
});

test('a sibling\'s newer, lower reading never lifts a limit, even when its link is out of date', (t) => {
  const { store, service } = setupEnvironment(t);
  const s = service.create({ provider: 'claude', label: 'S', configDir: path.join(store.dir, 'cfgS') }).profile;
  const p = service.create({ provider: 'claude', label: 'P', configDir: path.join(store.dir, 'cfgP') }).profile;
  recordIdentity(store, s.id, verifiedIdentity(s.id, 'alice@example.com'));
  recordIdentity(store, p.id, verifiedIdentity(p.id, 'alice@example.com'));
  assert.equal(savePolicy(store, s.id, { blockAtPercent: 90, unknownQuota: 'block' }).ok, true);
  // P still says it is account A, but in the CLI it has since signed in as B: its folder now reports B's 10%.
  const { decision } = gateDecision(store, service, s.id, { [s.id]: [percent(95, 60_000)], [p.id]: [percent(10, 5_000)] });
  assert.equal(decision.allowed, false);
});
