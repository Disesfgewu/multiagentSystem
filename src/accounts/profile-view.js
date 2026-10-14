'use strict';

const { validateProfile, findConfigDirConflicts } = require('./profile');
const { groupBySubject, CONFIDENCE } = require('./observation');
const { reportEntry, profileReadiness } = require('./readiness');

// What the account list may show, and where each value comes from. Only four kinds of
// information are shown, each with its source named; anything that could not be verified
// is shown as unknown instead of being filled in:
//   user-label  the label the user typed (never evidence of who the account is)
//   service     the provider CLI's own report (verified identity, login method)
//   unknown     there is no verified value, with the reason
// The service-confirmed principal itself (an email, an organisation) is never kept or
// shown: the observation only holds a one-way key, so the view offers a short fingerprint
// that tells "same account" from "different account" and nothing else.

const FINGERPRINT_LENGTH = 8;

const ISSUE_HINTS = Object.freeze({
  'not-inspected': 'The account has not been checked yet. Run the check to verify the login.',
  'not-logged-in': 'Not logged in. Open a terminal for this profile and log in with the CLI.',
  'subject-unverified': 'The service did not confirm who this account is, so it cannot be used for a managed launch.',
  'config-dir-mismatch': 'The CLI reports a different configuration folder than this profile. It may be running under another account.',
  'config-dir-unverified': 'The CLI did not say which configuration folder it uses, so it is unverified.',
  'duplicate-account': 'Another profile logs in to the same real account. Remove one so quota is not counted twice.',
  'config-dir-conflict:same': 'Another profile uses the same configuration folder.',
  'config-dir-conflict:nested': 'Another profile uses a folder inside or around this one.',
  'config-dir-conflict:unresolvable': 'The configuration folder cannot be resolved, so conflicts cannot be ruled out.',
  'anomaly:credential-from-environment': 'A credential from the environment overrides this login. Remove it before launching.',
  'anomaly:auth-method-mismatch': 'The login method differs from the one expected for this profile.'
});

function hintFor(code) {
  if (ISSUE_HINTS[code]) return ISSUE_HINTS[code];
  if (code.startsWith('config-dir:')) return 'The configuration folder cannot be used for this profile.';
  if (code.startsWith('credential-override:')) return 'An inherited environment variable would override this login.';
  return 'Needs attention.';
}

function identityField(identity) {
  if (!identity) return { state: 'unknown', source: 'unknown', reason: 'not-inspected' };
  const subject = identity.subject;
  if (subject && subject.confidence === CONFIDENCE.ACTUAL && typeof subject.value === 'string') {
    return {
      state: 'verified',
      source: 'service',
      fingerprint: subject.value.slice(0, FINGERPRINT_LENGTH),
      observedAt: subject.observedAt
    };
  }
  return { state: 'unknown', source: 'unknown', reason: (subject && subject.reason) || 'not-reported' };
}

function loginMethodField(identity, expected) {
  if (!identity || typeof identity.authMethod !== 'string') {
    return { state: 'unknown', source: 'unknown', expected: expected ?? null };
  }
  return { state: 'reported', source: 'service', value: identity.authMethod, expected: expected ?? null };
}

/**
 * Builds the account list. `observations` maps a profile id to what the caller has inspected:
 * `{ identity, blockers, validation }` (all optional). Nothing here runs a CLI or reads a login
 * file. Without an observation a profile is shown as unknown, never as ready.
 *
 * @param {{ profiles: object[], observations?: Map<string, object>, context?: object }} input
 */
function describeAccounts({ profiles, observations = new Map(), context } = {}) {
  const conflicts = findConfigDirConflicts(profiles, context);
  const identities = profiles.map((profile) => observations.get(profile.id)?.identity).filter(Boolean);
  const grouping = groupBySubject(identities);
  const duplicateIds = new Set(grouping.duplicates.flat());

  return profiles.map((profile) => {
    const observation = observations.get(profile.id) || {};
    const validation = observation.validation || validateProfile(profile, context);
    const entry = reportEntry(profile.id, { validation, blockers: observation.blockers || [], identity: observation.identity || null });
    const readiness = profileReadiness(entry);

    const reasons = [...readiness.reasons];
    if (duplicateIds.has(profile.id)) reasons.push('duplicate-account');
    for (const conflict of conflicts) {
      if (conflict.a === profile.id || conflict.b === profile.id) reasons.push(`config-dir-conflict:${conflict.kind}`);
    }
    const unique = [...new Set(reasons)];

    let health;
    if (!observation.identity) health = 'unknown';
    else health = unique.length === 0 ? 'ready' : 'attention';

    return {
      id: profile.id,
      provider: profile.provider,
      label: { value: profile.label, source: 'user-label' },
      verifiedIdentity: identityField(observation.identity),
      loginMethod: loginMethodField(observation.identity, profile.expectedAuthMethod),
      health,
      issues: unique.map((code) => ({ code, hint: hintFor(code) })),
      duplicateOf: grouping.duplicates.filter((group) => group.includes(profile.id)).flat().filter((other) => other !== profile.id)
    };
  });
}

module.exports = { describeAccounts, hintFor, ISSUE_HINTS };
