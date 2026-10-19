'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { PrivateStore } = require('../../src/storage/private-store');
const { AccountProfileService } = require('../../src/accounts/profile-service');
const { savePolicy, loadPolicy } = require('../../src/accounts/quota-policy');
const { runningSlots, reserveSlot, releaseSlot } = require('../../src/accounts/quota-reservations');
const { recordVerifiedIdentity, linkedProfiles, resolveGroup, coordinatePolicies } = require('../../src/accounts/identity-registry');
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
