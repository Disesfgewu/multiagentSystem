'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PrivateStore } = require('../../src/storage/private-store');
const { observe, CONFIDENCE } = require('../../src/accounts/observation');
const {
  recordVerifiedIdentity,
  linkedProfiles,
  assessLaunchIdentity,
  readLinks,
  deduplicateQuotaObservations,
  coordinatePolicies
} = require('../../src/accounts/identity-registry');
const { sandbox, COLLECTIONS } = require('../storage/helpers');

const NOW = new Date('2026-10-19T10:00:00.000Z');
const NAMES = [...COLLECTIONS, 'quotaReservations'];
const subjectOf = (who) => who.padEnd(32, '0').slice(0, 32).replace(/[^a-f0-9]/g, 'a');
const A = subjectOf('a1');
const B = subjectOf('b2');
const C = subjectOf('c3');

const identity = (subject, over = {}) => ({
  provider: 'claude',
  loggedIn: true,
  subject: { field: 'subject', value: subject, confidence: CONFIDENCE.ACTUAL, observedAt: NOW.toISOString() },
  ...over
});
const loggedOut = () => ({ provider: 'claude', loggedIn: false, subject: { field: 'subject', value: null, confidence: CONFIDENCE.UNKNOWN } });
const answer = (id) => ({ ok: true, identity: id });

function open(t) {
  const box = sandbox(t);
  const make = () => new PrivateStore({ dir: box.dir, repoRoot: box.repoRoot, collections: NAMES });
  return { store: make(), another: make };
}

test('profiles verified as the same actual account are linked, different accounts and unverified ones are not, and labels never matter', (t) => {
  const { store } = open(t);
  const all = ['p1', 'p2', 'p3', 'p4'];
  assert.deepEqual(recordVerifiedIdentity(store, 'p1', identity(A), NOW), { ok: true, recorded: true, changed: false });
  recordVerifiedIdentity(store, 'p2', identity(A), NOW);
  recordVerifiedIdentity(store, 'p3', identity(B), NOW);
  assert.deepEqual(recordVerifiedIdentity(store, 'p4', loggedOut(), NOW), { ok: true, recorded: false, changed: false });
  assert.deepEqual(recordVerifiedIdentity(store, 'p4', identity(A, { subject: { ...identity(A).subject, confidence: CONFIDENCE.ESTIMATED } }), NOW), { ok: true, recorded: false, changed: false }, 'an estimate is not a verification');
  assert.deepEqual(linkedProfiles(store, 'p1', all), { ok: true, ids: ['p2'], known: true });
  assert.deepEqual(linkedProfiles(store, 'p2', all), { ok: true, ids: ['p1'], known: true });
  assert.deepEqual(linkedProfiles(store, 'p3', all), { ok: true, ids: [], known: true }, 'a different account stays alone');
  assert.deepEqual(linkedProfiles(store, 'p4', all), { ok: true, ids: [], known: false }, 'never verified: nothing is guessed');
  assert.deepEqual(linkedProfiles(store, 'p1', ['p1']), { ok: true, ids: [], known: true }, 'a profile that no longer exists is not a member');
  const codex = recordVerifiedIdentity(store, 'p5', identity(A, { provider: 'codex' }), NOW);
  assert.equal(codex.ok, true);
  assert.deepEqual(linkedProfiles(store, 'p5', ['p1', 'p5']).ids, [], 'the same hash under another provider is another account');
});

test('the groups live in the shared store: another Extension Host, or a restarted one, sees them without any check of its own', (t) => {
  const { store, another } = open(t);
  recordVerifiedIdentity(store, 'p1', identity(A), NOW);
  recordVerifiedIdentity(store, 'p2', identity(A), NOW);
  const otherHost = another();
  assert.deepEqual(linkedProfiles(otherHost, 'p2', ['p1', 'p2']), { ok: true, ids: ['p1'], known: true });
  assert.equal(JSON.stringify(readLinks(otherHost).links.get('p1')).includes('@'), false, 'only an opaque hash, never an address');
});

test('a failed or signed-out check never removes a link, so one bad check cannot lift a shared limit', (t) => {
  const { store } = open(t);
  recordVerifiedIdentity(store, 'p1', identity(A), NOW);
  recordVerifiedIdentity(store, 'p2', identity(A), NOW);
  recordVerifiedIdentity(store, 'p1', loggedOut(), NOW);
  recordVerifiedIdentity(store, 'p1', null, NOW);
  assert.deepEqual(linkedProfiles(store, 'p2', ['p1', 'p2']).ids, ['p1']);
  assert.deepEqual(linkedProfiles(store, 'p1', ['p1', 'p2']).ids, ['p2']);
});

test('a profile that is verified as another account keeps counting toward the groups it was in', (t) => {
  const { store } = open(t);
  const all = ['p1', 'p2', 'p3'];
  recordVerifiedIdentity(store, 'p1', identity(A), NOW);
  recordVerifiedIdentity(store, 'p2', identity(A), NOW);
  recordVerifiedIdentity(store, 'p3', identity(B), NOW);
  assert.deepEqual(recordVerifiedIdentity(store, 'p2', identity(B), NOW), { ok: true, recorded: true, changed: true });
  assert.deepEqual(linkedProfiles(store, 'p1', all).ids, ['p2'], 'p1 still shares its limit with the profile that moved away');
  assert.deepEqual(linkedProfiles(store, 'p3', all).ids, ['p2'], 'and the new account counts it as well');
  assert.deepEqual(linkedProfiles(store, 'p2', all).ids, ['p1', 'p3']);
  recordVerifiedIdentity(store, 'p2', identity(C), NOW);
  recordVerifiedIdentity(store, 'p2', identity(A), NOW);
  assert.deepEqual(linkedProfiles(store, 'p3', all).ids, ['p2'], 'the history is bounded but never forgets the latest previous accounts');
});

test('at launch the account the CLI reports now is compared with the one that was verified', (t) => {
  const { store } = open(t);
  recordVerifiedIdentity(store, 'p1', identity(A), NOW);
  assert.deepEqual(assessLaunchIdentity(store, 'p1', answer(identity(A)), NOW), { ok: true }, 'same account');
  assert.deepEqual(assessLaunchIdentity(store, 'nobody', answer(identity(B)), NOW), { ok: true }, 'a profile that was never verified has nothing to compare');
  assert.deepEqual(assessLaunchIdentity(store, 'p1', answer(loggedOut()), NOW), { ok: false, code: 'identity-changed' }, 'signed out');
  assert.deepEqual(assessLaunchIdentity(store, 'p1', answer(identity(B)), NOW), { ok: false, code: 'identity-changed' }, 'a different account');
  assert.deepEqual(linkedProfiles(store, 'p1', ['p1']).known, true);
  assert.deepEqual(readLinks(store).links.get('p1').subject, B, 'the change is recorded for the next check');
  assert.deepEqual(readLinks(store).links.get('p1').previous, [A]);
});

test('an answer that cannot tell neither blocks a launch nor releases anything', (t) => {
  const { store } = open(t);
  recordVerifiedIdentity(store, 'p1', identity(A), NOW);
  for (const unknown of [null, undefined, { ok: false }, { ok: true, identity: null }, answer(identity(A, { subject: { value: A, confidence: CONFIDENCE.UNKNOWN } }))]) {
    assert.deepEqual(assessLaunchIdentity(store, 'p1', unknown, NOW), { ok: true, unverified: true }, JSON.stringify(unknown));
  }
  assert.deepEqual(readLinks(store).links.get('p1').subject, A, 'nothing was rewritten');
});

test('an unreadable identity record is an unknown group, never an empty one', (t) => {
  const { store } = open(t);
  recordVerifiedIdentity(store, 'p1', identity(A), NOW);
  assert.equal(store.put('quotaReservations', 'identity-p2', { schemaVersion: 1, provider: 'claude', subject: 'not-a-hash', previous: [], verifiedAt: NOW.toISOString() }).ok, true);
  assert.deepEqual(linkedProfiles(store, 'p1', ['p1', 'p2']), { ok: false, reason: 'identity-record-invalid' });
  assert.deepEqual(assessLaunchIdentity(store, 'p1', answer(identity(A)), NOW), { ok: false, code: 'identity-unavailable' });
  assert.deepEqual(recordVerifiedIdentity(store, 'p2', identity(B), NOW), { ok: false, reason: 'identity-record-invalid' }, 'a damaged record is not overwritten');
});

const reading = (field, value, ageMs, validForMs, confidence = 'actual') => observe(field, value, {
  unit: 'percent', scope: 'account', source: 'claude status line', confidence,
  observedAt: new Date(NOW.getTime() - ageMs), validForMs
});

test('deduplicated usage keeps the freshest reading per window and never sums', () => {
  const field = 'quota.five_hour.used_percent';
  const merged = deduplicateQuotaObservations([[reading(field, 60, 100_000, 600_000)], [reading(field, 75, 10_000, 600_000), reading('quota.seven_day.used_percent', 40, 10_000, 600_000)]], NOW);
  assert.equal(merged.find((o) => o.field === field).value, 75);
  assert.equal(merged.find((o) => o.field === 'quota.seven_day.used_percent').value, 40);
  assert.equal(merged.length, 2);
});

test('a newer weaker reading never hides a valid actual one', () => {
  const field = 'quota.five_hour.used_percent';
  const actual = reading(field, 90, 60_000, 600_000);
  const newerEstimate = reading(field, 10, 1_000, 600_000, 'estimated');
  const newerButExpired = reading(field, 5, 2_000, 1_000);
  const unknownNewer = observe(field, null, { unit: 'percent', scope: 'account', source: 'claude status line', observedAt: new Date(NOW.getTime() - 500), reason: 'not-reported' });
  for (const weaker of [newerEstimate, newerButExpired, unknownNewer]) {
    assert.equal(deduplicateQuotaObservations([[actual], [weaker]], NOW)[0].value, 90, weaker.confidence);
    assert.equal(deduplicateQuotaObservations([[weaker], [actual]], NOW)[0].value, 90, 'whatever the order');
  }
  const olderActual = reading(field, 80, 120_000, 600_000);
  assert.equal(deduplicateQuotaObservations([[olderActual], [actual]], NOW)[0].value, 90, 'among valid actual readings the newest wins');
  assert.equal(deduplicateQuotaObservations([[newerEstimate], [reading(field, 7, 50_000, 1_000, 'estimated')]], NOW)[0].value, 10, 'with nothing valid the newest is shown');
});

test('coordinatePolicies enforces strictest limits across duplicate profiles of the same real account', () => {
  const policyA = { ok: true, stored: true, policy: { maxConcurrent: 2, warnAtPercent: 80, blockAtPercent: 90, unknownQuota: 'require-confirmation' } };
  const policyB = { ok: true, stored: true, policy: { maxConcurrent: 1, warnAtPercent: 70, blockAtPercent: 85, unknownQuota: 'block' } };
  const coordinated = coordinatePolicies([policyA, policyB]);
  assert.equal(coordinated.ok, true);
  assert.equal(coordinated.stored, true);
  assert.equal(coordinated.policy.maxConcurrent, 1);
  assert.equal(coordinated.policy.warnAtPercent, 70);
  assert.equal(coordinated.policy.blockAtPercent, 85);
  assert.equal(coordinated.policy.unknownQuota, 'block');
});
