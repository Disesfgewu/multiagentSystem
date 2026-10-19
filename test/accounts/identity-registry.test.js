'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { observe, CONFIDENCE } = require('../../src/accounts/observation');
const {
  registerProfileIdentity,
  getProfileIdentity,
  clearProfileIdentities,
  detectIdentityChange,
  findDuplicateProfiles,
  deduplicateQuotaObservations,
  coordinatePolicies
} = require('../../src/accounts/identity-registry');

const NOW = new Date('2026-10-19T10:00:00.000Z');

test('findDuplicateProfiles never guesses duplicates from identical labels when identity is unverified', () => {
  clearProfileIdentities();
  const profA = { id: 'prof-a', label: 'Work Claude', provider: 'claude' };
  const profB = { id: 'prof-b', label: 'Work Claude', provider: 'claude' };
  const profiles = [profA, profB];

  // Case 1: No identities inspected
  assert.deepEqual(findDuplicateProfiles('prof-a', profiles), []);
  assert.deepEqual(findDuplicateProfiles('prof-b', profiles), []);

  // Case 2: Identities inspected but unverified (e.g. unknown confidence)
  const unverifiedIdentity = {
    profileId: 'prof-a',
    provider: 'claude',
    loggedIn: false,
    subject: { field: 'subject', confidence: CONFIDENCE.UNKNOWN, reason: 'not-logged-in' }
  };
  registerProfileIdentity('prof-a', unverifiedIdentity);
  registerProfileIdentity('prof-b', { ...unverifiedIdentity, profileId: 'prof-b' });

  assert.deepEqual(findDuplicateProfiles('prof-a', profiles), []);
  assert.deepEqual(findDuplicateProfiles('prof-b', profiles), []);
});

test('findDuplicateProfiles identifies profiles that share verified subject identity and isolates different accounts', () => {
  clearProfileIdentities();
  const prof1 = { id: 'prof-1', label: 'Main', provider: 'claude' };
  const prof2 = { id: 'prof-2', label: 'Backup', provider: 'claude' };
  const prof3 = { id: 'prof-3', label: 'Other Person', provider: 'claude' };
  const prof4 = { id: 'prof-4', label: 'Codex Profile', provider: 'codex' };
  const profiles = [prof1, prof2, prof3, prof4];

  // Verified identities
  const verifiedUserA = (id) => ({
    profileId: id,
    provider: 'claude',
    loggedIn: true,
    subject: { field: 'subject', value: 'sha256-user-a-hash', confidence: CONFIDENCE.ACTUAL, observedAt: NOW.toISOString() }
  });
  const verifiedUserB = (id) => ({
    profileId: id,
    provider: 'claude',
    loggedIn: true,
    subject: { field: 'subject', value: 'sha256-user-b-hash', confidence: CONFIDENCE.ACTUAL, observedAt: NOW.toISOString() }
  });
  const verifiedCodex = (id) => ({
    profileId: id,
    provider: 'codex',
    loggedIn: true,
    subject: { field: 'subject', value: 'sha256-user-a-hash', confidence: CONFIDENCE.ACTUAL, observedAt: NOW.toISOString() }
  });

  registerProfileIdentity('prof-1', verifiedUserA('prof-1'));
  registerProfileIdentity('prof-2', verifiedUserA('prof-2'));
  registerProfileIdentity('prof-3', verifiedUserB('prof-3'));
  registerProfileIdentity('prof-4', verifiedCodex('prof-4'));

  // prof-1 and prof-2 represent the same real provider account
  assert.deepEqual(findDuplicateProfiles('prof-1', profiles), ['prof-2']);
  assert.deepEqual(findDuplicateProfiles('prof-2', profiles), ['prof-1']);

  // prof-3 is a different real account, never mixed
  assert.deepEqual(findDuplicateProfiles('prof-3', profiles), []);

  // prof-4 is a different provider, never mixed even if raw subject string collided
  assert.deepEqual(findDuplicateProfiles('prof-4', profiles), []);
});

test('detectIdentityChange detects changed, expired or logged out verified identities', () => {
  clearProfileIdentities();
  const verifiedFirst = {
    profileId: 'prof-1',
    provider: 'claude',
    loggedIn: true,
    subject: { field: 'subject', value: 'fingerprint-alice', confidence: CONFIDENCE.ACTUAL }
  };
  registerProfileIdentity('prof-1', verifiedFirst);

  // Still same identity
  assert.equal(detectIdentityChange('prof-1', verifiedFirst), false);

  // Changed to Bob: must detect change
  const verifiedSecond = {
    profileId: 'prof-1',
    provider: 'claude',
    loggedIn: true,
    subject: { field: 'subject', value: 'fingerprint-bob', confidence: CONFIDENCE.ACTUAL }
  };
  assert.equal(detectIdentityChange('prof-1', verifiedSecond), true);

  // Logged out: must detect change / invalidation
  const loggedOut = {
    profileId: 'prof-1',
    provider: 'claude',
    loggedIn: false,
    subject: { field: 'subject', confidence: CONFIDENCE.UNKNOWN, reason: 'not-logged-in' }
  };
  assert.equal(detectIdentityChange('prof-1', loggedOut), true);
});

test('deduplicateQuotaObservations preserves freshest reading per window and never sums percentages', () => {
  const obsOlder = observe('quota.five_hour.used_percent', 60, {
    unit: 'percent', scope: 'account', source: 'claude status line',
    observedAt: new Date(NOW.getTime() - 100_000), validForMs: 600_000
  });
  const obsFresher = observe('quota.five_hour.used_percent', 75, {
    unit: 'percent', scope: 'account', source: 'claude status line',
    observedAt: new Date(NOW.getTime() - 10_000), validForMs: 600_000
  });
  const obsOtherWindow = observe('quota.seven_day.used_percent', 40, {
    unit: 'percent', scope: 'account', source: 'claude status line',
    observedAt: new Date(NOW.getTime() - 10_000), validForMs: 600_000
  });

  const deduplicated = deduplicateQuotaObservations([[obsOlder], [obsFresher, obsOtherWindow]]);
  assert.equal(deduplicated.length, 2);

  const fiveHour = deduplicated.find((o) => o.field === 'quota.five_hour.used_percent');
  const sevenDay = deduplicated.find((o) => o.field === 'quota.seven_day.used_percent');

  // Freshest 75% is preserved; not added (never 135%)
  assert.equal(fiveHour.value, 75);
  assert.equal(sevenDay.value, 40);
});

test('coordinatePolicies enforces strictest limits across duplicate profiles of the same real account', () => {
  const policyA = { ok: true, stored: true, policy: { maxConcurrent: 2, warnAtPercent: 80, blockAtPercent: 90, unknownQuota: 'require-confirmation' } };
  const policyB = { ok: true, stored: true, policy: { maxConcurrent: 1, warnAtPercent: 70, blockAtPercent: 85, unknownQuota: 'block' } };

  const coordinated = coordinatePolicies([policyA, policyB]);
  assert.equal(coordinated.ok, true);
  assert.equal(coordinated.stored, true);
  assert.equal(coordinated.policy.maxConcurrent, 1, 'minimum running limit is enforced');
  assert.equal(coordinated.policy.warnAtPercent, 70, 'lowest warning threshold is enforced');
  assert.equal(coordinated.policy.blockAtPercent, 85, 'lowest pause threshold is enforced');
  assert.equal(coordinated.policy.unknownQuota, 'block', 'strictest unknown policy is enforced');
});
