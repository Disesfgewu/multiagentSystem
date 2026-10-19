'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { PrivateStore } = require('../../src/storage/private-store');
const { AccountProfileService } = require('../../src/accounts/profile-service');
const { savePolicy, loadPolicy } = require('../../src/accounts/quota-policy');
const { runningSlots, reserveSlot, releaseSlot } = require('../../src/accounts/quota-reservations');
const {
  registerProfileIdentity,
  clearProfileIdentities,
  findDuplicateProfiles,
  detectIdentityChange,
  deduplicateQuotaObservations,
  coordinatePolicies
} = require('../../src/accounts/identity-registry');
const { describeAccounts } = require('../../src/accounts/profile-view');
const { presentAccount } = require('../../src/overview/presentation');
const { observe, CONFIDENCE } = require('../../src/accounts/observation');
const { sandbox, COLLECTIONS } = require('../storage/helpers');

const COLLECTION_NAMES = [...COLLECTIONS, 'quotaReservations'];
const NOW = new Date('2026-10-19T10:00:00.000Z');
const LEASE_A = '11111111-1111-4111-8111-111111111111';
const LEASE_B = '22222222-2222-4222-8222-222222222222';

const verifiedIdentity = (profileId, email, provider = 'claude') => ({
  profileId,
  provider,
  loggedIn: true,
  authMethod: 'claude.ai',
  anomalies: [],
  configDirMatches: true,
  subject: {
    field: 'subject',
    value: `hash-for-${email}`,
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
  clearProfileIdentities();
  return { store, service, box };
}

test('identical labels do not cause duplicate grouping when identity is unverified (no guessing by label)', (t) => {
  const { store, service } = setupEnvironment(t);
  const p1 = service.create({ provider: 'claude', label: 'Team Account', configDir: path.join(store.dir, 'cfg1') }).profile;
  const p2 = service.create({ provider: 'claude', label: 'Team Account 2', configDir: path.join(store.dir, 'cfg2') }).profile;

  // Before identity check: both unverified
  const profiles = [p1, p2];
  assert.deepEqual(findDuplicateProfiles(p1.id, profiles), [], 'unverified profiles are never assumed to be duplicate');
  assert.deepEqual(findDuplicateProfiles(p2.id, profiles), []);

  // Set limits on p1 only
  assert.equal(savePolicy(store, p1.id, { maxConcurrent: 1, unknownQuota: 'block' }).ok, true);

  // Take a lease on p1 with a fresh observation
  const res1 = reserveSlot({
    store,
    accountKey: p1.id,
    linkedAccountKeys: findDuplicateProfiles(p1.id, profiles),
    expectedPolicyRead: loadPolicy(store, p1.id),
    observations: [reading()],
    now: NOW,
    leaseId: LEASE_A
  });
  assert.equal(res1.decision.allowed, true);

  // Launch on p2 is independent and NOT blocked by p1's running agent
  const res2 = reserveSlot({
    store,
    accountKey: p2.id,
    linkedAccountKeys: findDuplicateProfiles(p2.id, profiles),
    expectedPolicyRead: loadPolicy(store, p2.id),
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
  registerProfileIdentity(p1.id, verifiedIdentity(p1.id, 'shared-alice@example.com'));
  registerProfileIdentity(p2.id, verifiedIdentity(p2.id, 'shared-alice@example.com'));

  // Discovered as duplicate profiles
  assert.deepEqual(findDuplicateProfiles(p1.id, profiles), [p2.id]);
  assert.deepEqual(findDuplicateProfiles(p2.id, profiles), [p1.id]);

  // Set maxConcurrent = 1 on p1
  assert.equal(savePolicy(store, p1.id, { maxConcurrent: 1, unknownQuota: 'block' }).ok, true);
  assert.equal(savePolicy(store, p2.id, { maxConcurrent: 1, unknownQuota: 'block' }).ok, true);

  // Reserve slot for p1 with linked duplicate profile p2
  const dupP1 = findDuplicateProfiles(p1.id, profiles);
  const res1 = reserveSlot({
    store,
    accountKey: p1.id,
    linkedAccountKeys: dupP1,
    expectedPolicyRead: loadPolicy(store, p1.id),
    observations: [reading()],
    now: NOW,
    leaseId: LEASE_A
  });
  assert.equal(res1.decision.allowed, true);

  // Checking running slots on p2 reflects p1's active lease
  const dupP2 = findDuplicateProfiles(p2.id, profiles);
  const slotsP2 = runningSlots(store, p2.id, NOW, { linkedAccountKeys: dupP2 });
  assert.deepEqual(slotsP2, { ok: true, running: 1, orphaned: 0 });

  // Attempt to reserve slot for duplicate profile p2: blocked by shared real account limit!
  const res2 = reserveSlot({
    store,
    accountKey: p2.id,
    linkedAccountKeys: dupP2,
    expectedPolicyRead: loadPolicy(store, p2.id),
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
    expectedPolicyRead: loadPolicy(store, p2.id),
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

  registerProfileIdentity(p1.id, verifiedIdentity(p1.id, 'shared-bob@example.com'));
  registerProfileIdentity(p2.id, verifiedIdentity(p2.id, 'shared-bob@example.com'));

  // User configured maxConcurrent: 1 on p1, but left p2 without policy
  assert.equal(savePolicy(store, p1.id, { maxConcurrent: 1, unknownQuota: 'block' }).ok, true);
  assert.equal(loadPolicy(store, p2.id).stored, false);

  // Take a slot on p1
  const dupP1 = findDuplicateProfiles(p1.id, profiles);
  const res1 = reserveSlot({
    store,
    accountKey: p1.id,
    linkedAccountKeys: dupP1,
    expectedPolicyRead: loadPolicy(store, p1.id),
    observations: [reading()],
    now: NOW,
    leaseId: LEASE_A
  });
  assert.equal(res1.decision.allowed, true);

  // Attempting to launch p2 (which has no stored policy of its own) coordinates with p1's policy
  // and blocks because the shared real account limit (1) is reached!
  const dupP2 = findDuplicateProfiles(p2.id, profiles);
  const res2 = reserveSlot({
    store,
    accountKey: p2.id,
    linkedAccountKeys: dupP2,
    expectedPolicyRead: loadPolicy(store, p2.id),
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

  registerProfileIdentity(pAlice.id, verifiedIdentity(pAlice.id, 'alice@company.com'));
  registerProfileIdentity(pBob.id, verifiedIdentity(pBob.id, 'bob@company.com'));

  assert.deepEqual(findDuplicateProfiles(pAlice.id, profiles), []);
  assert.deepEqual(findDuplicateProfiles(pBob.id, profiles), []);

  assert.equal(savePolicy(store, pAlice.id, { maxConcurrent: 1, unknownQuota: 'block' }).ok, true);
  assert.equal(savePolicy(store, pBob.id, { maxConcurrent: 1, unknownQuota: 'block' }).ok, true);

  const resAlice = reserveSlot({
    store,
    accountKey: pAlice.id,
    linkedAccountKeys: findDuplicateProfiles(pAlice.id, profiles),
    expectedPolicyRead: loadPolicy(store, pAlice.id),
    observations: [reading()],
    now: NOW,
    leaseId: LEASE_A
  });
  assert.equal(resAlice.decision.allowed, true);

  // Bob is completely independent and allowed
  const resBob = reserveSlot({
    store,
    accountKey: pBob.id,
    linkedAccountKeys: findDuplicateProfiles(pBob.id, profiles),
    expectedPolicyRead: loadPolicy(store, pBob.id),
    observations: [reading()],
    now: NOW,
    leaseId: LEASE_B
  });
  assert.equal(resBob.decision.allowed, true);
});

test('identity change or invalidation is detected and fails closed', () => {
  clearProfileIdentities();
  const profId = 'prof-identity-check';

  // Initially verified as Alice
  const initialIdentity = verifiedIdentity(profId, 'alice@example.com');
  registerProfileIdentity(profId, initialIdentity);
  assert.equal(detectIdentityChange(profId, initialIdentity), false);

  // Subsequent check reveals Bob logged in
  const changedIdentity = verifiedIdentity(profId, 'bob@example.com');
  assert.equal(detectIdentityChange(profId, changedIdentity), true, 'detects changed principal');

  // Subsequent check reveals logged out
  const loggedOut = unverifiedIdentity(profId);
  assert.equal(detectIdentityChange(profId, loggedOut), true, 'detects invalidation / logout');
});

test('describeAccounts and presentAccount reflect duplicate status and shared limits in UI', (t) => {
  const { store, service } = setupEnvironment(t);
  const p1 = service.create({ provider: 'claude', label: 'Work Claude 1', configDir: path.join(store.dir, 'cfg1') }).profile;
  const p2 = service.create({ provider: 'claude', label: 'Work Claude 2', configDir: path.join(store.dir, 'cfg2') }).profile;
  const profiles = [p1, p2];

  const id1 = verifiedIdentity(p1.id, 'team-shared@example.com');
  const id2 = verifiedIdentity(p2.id, 'team-shared@example.com');
  registerProfileIdentity(p1.id, id1);
  registerProfileIdentity(p2.id, id2);

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
