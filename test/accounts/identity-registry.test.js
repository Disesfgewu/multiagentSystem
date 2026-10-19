'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PrivateStore } = require('../../src/storage/private-store');
const { observe, CONFIDENCE } = require('../../src/accounts/observation');
const {
  recordVerifiedIdentity,
  linkedProfiles,
  resolveGroup,
  assessLaunchIdentity,
  readLinks,
  groupReadings,
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
const recordIdentity = (store, id, subject) => assert.equal(recordVerifiedIdentity(store, id, identity(subject), NOW).ok, true);
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
  assert.deepEqual(linkedProfiles(store, 'p1', all), { ok: true, ids: ['p2'], current: ['p2'], known: true });
  assert.deepEqual(linkedProfiles(store, 'p2', all), { ok: true, ids: ['p1'], current: ['p1'], known: true });
  assert.deepEqual(linkedProfiles(store, 'p3', all), { ok: true, ids: [], current: [], known: true }, 'a different account stays alone');
  assert.deepEqual(linkedProfiles(store, 'p4', all), { ok: true, ids: [], current: [], known: false }, 'never verified: nothing is guessed');
  assert.deepEqual(linkedProfiles(store, 'p1', ['p1']), { ok: true, ids: [], current: [], known: true }, 'a profile that no longer exists is not a member');
  const codex = recordVerifiedIdentity(store, 'p5', identity(A, { provider: 'codex' }), NOW);
  assert.equal(codex.ok, true);
  assert.deepEqual(linkedProfiles(store, 'p5', ['p1', 'p5']).ids, [], 'the same hash under another provider is another account');
});

test('the groups live in the shared store: another Extension Host, or a restarted one, sees them without any check of its own', (t) => {
  const { store, another } = open(t);
  recordVerifiedIdentity(store, 'p1', identity(A), NOW);
  recordVerifiedIdentity(store, 'p2', identity(A), NOW);
  const otherHost = another();
  assert.deepEqual(linkedProfiles(otherHost, 'p2', ['p1', 'p2']), { ok: true, ids: ['p1'], current: ['p1'], known: true });
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
  assert.deepEqual(linkedProfiles(store, 'p3', all).ids, ['p2'], 'moving back and forth keeps the earlier accounts');
});

test('linked profiles and profiles that are the same account now are told apart', (t) => {
  const { store } = open(t);
  const all = ['p1', 'p2', 'p3'];
  recordIdentity(store, 'p1', A);
  recordIdentity(store, 'p2', A);
  recordIdentity(store, 'p3', A);
  recordVerifiedIdentity(store, 'p1', identity(B), NOW);
  assert.deepEqual(linkedProfiles(store, 'p2', all), { ok: true, ids: ['p1', 'p3'], current: ['p3'], known: true }, 'p1 still counts toward limits but is not p2\'s account now');
  assert.deepEqual(linkedProfiles(store, 'p1', all), { ok: true, ids: ['p2', 'p3'], current: [], known: true });
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

test('a sibling\'s reading may only make the decision stricter: it never fills, replaces or lowers the profile\'s own', () => {
  const field = 'quota.five_hour.used_percent';
  const other = 'quota.seven_day.used_percent';
  const own = [reading(field, 50, 60_000, 600_000)];
  const sibling = (value, ageMs = 1_000, validFor = 600_000, confidence = 'actual', name = field) => new Map([['s', [reading(name, value, ageMs, validFor, confidence)]]]);
  assert.equal(groupReadings(own, ['s'], sibling(95), NOW)[0].value, 95, 'a higher valid actual figure tightens');
  assert.equal(groupReadings(own, ['s'], sibling(10), NOW)[0].value, 50, 'a lower, newer figure never lowers it');
  assert.equal(groupReadings(own, ['s'], sibling(95, 1_000, 600_000, 'estimated'), NOW)[0].value, 50, 'an estimate is not a reading to tighten with');
  assert.equal(groupReadings(own, ['s'], sibling(95, 700_000, 600_000), NOW)[0].value, 50, 'an expired figure is not used');
  assert.equal(groupReadings(own, ['s'], sibling(95, 1_000, 600_000, 'actual', other), NOW)[0].value, 50, 'another window is another window');
  assert.equal(groupReadings(own, [], sibling(95), NOW), own, 'no current sibling, nothing changes');
  assert.equal(groupReadings(own, ['missing'], sibling(95), NOW)[0].value, 50);
});

test('what is missing, unknown or expired in a profile\'s own readings stays so: a sibling cannot fill it in', () => {
  const field = 'quota.five_hour.used_percent';
  const siblings = new Map([['s', [reading(field, 10, 1_000, 600_000)]]]);
  assert.deepEqual(groupReadings([], ['s'], siblings, NOW), [], 'no own reading at all: still none');
  const expired = [reading(field, 95, 700_000, 600_000)];
  assert.deepEqual(groupReadings(expired, ['s'], siblings, NOW), expired, 'own reading expired: left as it is');
  const unknown = [observe(field, null, { unit: 'percent', scope: 'account', source: 'claude status line', observedAt: new Date(NOW.getTime() - 500), reason: 'not-reported' })];
  assert.deepEqual(groupReadings(unknown, ['s'], siblings, NOW), unknown, 'own reading unknown: left unknown');
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

test('switching accounts many times never forgets an older group: at capacity the new account is refused instead', (t) => {
  const { store } = open(t);
  const all = ['p1', 'p2'];
  recordVerifiedIdentity(store, 'p1', identity(A), NOW);
  recordVerifiedIdentity(store, 'p2', identity(A), NOW);
  const switches = Array.from({ length: 16 }, (_, index) => subjectOf(`d${index.toString(16)}`));
  for (const subject of switches) assert.equal(recordVerifiedIdentity(store, 'p1', identity(subject), NOW).ok, true, 'within capacity');
  assert.deepEqual(linkedProfiles(store, 'p1', all).ids, ['p2'], 'sixteen switches later p2 still shares the first account with p1');
  const refused = recordVerifiedIdentity(store, 'p1', identity(subjectOf('eee')), NOW);
  assert.deepEqual(refused, { ok: false, reason: 'identity-history-full' });
  assert.deepEqual(linkedProfiles(store, 'p1', all).ids, ['p2'], 'nothing was forgotten');
  assert.equal(readLinks(store).links.get('p1').subject, switches[15], 'and the record is unchanged');
  const launch = assessLaunchIdentity(store, 'p1', answer(identity(subjectOf('eee'))), NOW);
  assert.deepEqual(launch, { ok: false, code: 'identity-unavailable' }, 'a launch is stopped while the history is full');
});

test('a profile listing that cannot be read is an unknown group, never an empty one', (t) => {
  const { store } = open(t);
  recordVerifiedIdentity(store, 'p1', identity(A), NOW);
  recordVerifiedIdentity(store, 'p2', identity(A), NOW);
  const profiles = [{ id: 'p1' }, { id: 'p2' }];
  assert.deepEqual(resolveGroup(store, () => ({ ok: true, profiles }), 'p1'), { ok: true, ids: ['p2'], current: ['p2'], known: true, profiles });
  for (const broken of [() => ({ ok: false }), () => ({ ok: true }), () => ({ ok: true, profiles: 'x' }), () => null, () => { throw new Error('storage'); }]) {
    assert.deepEqual(resolveGroup(store, broken, 'p1'), { ok: false, reason: 'profiles-unavailable' });
  }
  assert.equal(resolveGroup(store, () => ({ ok: true, profiles }), 'p1').ids.length, 1, 'after the failure the group is intact');
});
