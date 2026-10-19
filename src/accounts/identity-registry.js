'use strict';

const { CONFIDENCE, isFresh } = require('./observation');

// In-memory registry of observed identities for account profiles.
// Holds verified identity (fingerprint, auth method, anomalies) and tracks verified fingerprints
// to detect identity changes.
// It never holds credentials or raw PII (emails/tokens).
const identities = new Map();
const lastVerifiedFingerprints = new Map();

function registerProfileIdentity(profileId, identity) {
  if (typeof profileId !== 'string' || !profileId) return;
  if (!identity) {
    identities.delete(profileId);
    return;
  }
  identities.set(profileId, identity);
  if (identity.subject && identity.subject.confidence === CONFIDENCE.ACTUAL && typeof identity.subject.value === 'string') {
    lastVerifiedFingerprints.set(profileId, identity.subject.value);
  }
}

function getProfileIdentity(profileId) {
  return identities.get(profileId) || null;
}

function clearProfileIdentities() {
  identities.clear();
  lastVerifiedFingerprints.clear();
}

/**
 * Checks whether an account profile's verified identity changed compared to what was previously verified.
 * Returns true if it had a verified identity and now has a DIFFERENT verified identity or has become unverified/logged out.
 */
function detectIdentityChange(profileId, currentIdentity) {
  const previousFingerprint = lastVerifiedFingerprints.get(profileId);
  if (!previousFingerprint) return false;
  if (!currentIdentity || !currentIdentity.loggedIn) return true;
  if (!currentIdentity.subject || currentIdentity.subject.confidence !== CONFIDENCE.ACTUAL) return true;
  return currentIdentity.subject.value !== previousFingerprint;
}

/**
 * Finds all other profile IDs that represent the same verified provider account.
 * Only profiles with CONFIDENCE.ACTUAL matching provider and subject value are grouped.
 * Profiles with unknown, estimated, or unverified identity return an empty array (no guessing from labels).
 */
function findDuplicateProfiles(profileId, profiles = [], identitiesMap = identities) {
  if (!profileId || !Array.isArray(profiles)) return [];
  const currentIdentity = identitiesMap instanceof Map ? identitiesMap.get(profileId) : identitiesMap[profileId];
  if (!currentIdentity || !currentIdentity.subject || currentIdentity.subject.confidence !== CONFIDENCE.ACTUAL || !currentIdentity.subject.value) {
    return [];
  }
  const currentKey = `${currentIdentity.provider}:${currentIdentity.subject.value}`;
  const duplicates = [];
  for (const profile of profiles) {
    if (!profile || profile.id === profileId) continue;
    const otherIdentity = identitiesMap instanceof Map ? identitiesMap.get(profile.id) : identitiesMap[profile.id];
    if (!otherIdentity || !otherIdentity.subject || otherIdentity.subject.confidence !== CONFIDENCE.ACTUAL) {
      continue;
    }
    const otherKey = `${otherIdentity.provider}:${otherIdentity.subject.value}`;
    if (otherKey === currentKey) {
      duplicates.push(profile.id);
    }
  }
  return duplicates;
}

/**
 * Deduplicates quota observations across multiple profiles sharing the same real account.
 * For each window, preserves the freshest (most recent valid) reading. Never sums percentages.
 */
function deduplicateQuotaObservations(observationLists) {
  const byWindow = new Map();
  for (const list of observationLists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item.field !== 'string') continue;
      const existing = byWindow.get(item.field);
      if (!existing) {
        byWindow.set(item.field, item);
      } else {
        const existingTime = Date.parse(existing.observedAt);
        const itemTime = Date.parse(item.observedAt);
        if (Number.isFinite(itemTime) && (!Number.isFinite(existingTime) || itemTime > existingTime)) {
          byWindow.set(item.field, item);
        }
      }
    }
  }
  return [...byWindow.values()];
}

/**
 * Resolves the effective policy across duplicate profiles of the same real account.
 * Enforces the most protective constraint (minimum running limit, minimum thresholds, strictest unknown policy).
 */
function coordinatePolicies(policyReads = []) {
  const storedPolicies = policyReads.filter((read) => read && read.ok && read.stored && read.policy).map((read) => read.policy);
  if (storedPolicies.length === 0) {
    return policyReads[0] || { ok: true, stored: false, policy: { unknownQuota: 'require-confirmation' } };
  }
  const coordinated = { unknownQuota: 'require-confirmation' };
  let hasMaxConcurrent = false;
  let minMaxConcurrent = Infinity;
  let hasWarn = false;
  let minWarn = Infinity;
  let hasBlock = false;
  let minBlock = Infinity;
  let strictUnknown = false;

  for (const p of storedPolicies) {
    if (p.maxConcurrent !== undefined) {
      hasMaxConcurrent = true;
      minMaxConcurrent = Math.min(minMaxConcurrent, p.maxConcurrent);
    }
    if (p.warnAtPercent !== undefined) {
      hasWarn = true;
      minWarn = Math.min(minWarn, p.warnAtPercent);
    }
    if (p.blockAtPercent !== undefined) {
      hasBlock = true;
      minBlock = Math.min(minBlock, p.blockAtPercent);
    }
    if (p.unknownQuota === 'block') {
      strictUnknown = true;
    }
  }

  if (hasMaxConcurrent) coordinated.maxConcurrent = minMaxConcurrent;
  if (hasWarn) coordinated.warnAtPercent = minWarn;
  if (hasBlock) coordinated.blockAtPercent = minBlock;
  coordinated.unknownQuota = strictUnknown ? 'block' : 'require-confirmation';

  return { ok: true, stored: true, policy: Object.freeze(coordinated) };
}

module.exports = {
  registerProfileIdentity,
  getProfileIdentity,
  clearProfileIdentities,
  detectIdentityChange,
  findDuplicateProfiles,
  deduplicateQuotaObservations,
  coordinatePolicies
};
