'use strict';

const { CONFIDENCE, isFresh } = require('./observation');

const COLLECTION = 'quotaReservations';
const PREFIX = 'identity-';
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/;
const SUBJECT = /^[a-f0-9]{32}$/;
const PROVIDER = /^[a-z][a-z0-9-]{0,40}$/;
const MAX_PREVIOUS = 3;

// Which real provider account each profile was last verified as, kept in the PrivateStore so that every
// Extension Host (another window, or the same one after a restart) sees the same groups. It holds the
// provider name and an opaque subject hash (see observation.js subjectKey), never an e-mail, token or
// credential. A failed or logged-out check never removes a link: not being able to tell is not evidence
// that the profile left its group. A profile that is later verified as another account keeps counting
// toward the groups it was in before (`previous`), so switching accounts cannot lift a shared limit.
const linkId = (profileId) => `${PREFIX}${profileId}`;

function validLink(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && value.schemaVersion === 1 &&
    typeof value.provider === 'string' && PROVIDER.test(value.provider) &&
    typeof value.subject === 'string' && SUBJECT.test(value.subject) &&
    Array.isArray(value.previous) && value.previous.length <= MAX_PREVIOUS && value.previous.every((key) => typeof key === 'string' && SUBJECT.test(key)) &&
    typeof value.verifiedAt === 'string' && Number.isFinite(Date.parse(value.verifiedAt));
}

/** The verified subject of an identity read, or null when it is not an actual, logged-in one. */
function verifiedSubject(identity) {
  if (!identity || typeof identity !== 'object' || identity.loggedIn !== true) return null;
  const subject = identity.subject;
  if (!subject || subject.confidence !== CONFIDENCE.ACTUAL || typeof subject.value !== 'string' || !SUBJECT.test(subject.value)) return null;
  if (typeof identity.provider !== 'string' || !PROVIDER.test(identity.provider)) return null;
  return { provider: identity.provider, subject: subject.value };
}

const subjectsOf = (link) => [link.subject, ...link.previous];

/**
 * Records what a successful check verified. Anything that is not an actual, logged-in identity changes
 * nothing. Returns `changed: true` when the profile was verified before as a different account.
 */
function recordVerifiedIdentity(store, profileId, identity, now = new Date()) {
  const verified = verifiedSubject(identity);
  if (!store || typeof store.transact !== 'function' || typeof profileId !== 'string' || !PROFILE_ID.test(profileId)) {
    return { ok: false, reason: 'identity-input-invalid' };
  }
  if (!verified) return { ok: true, recorded: false, changed: false };
  const at = new Date(now).toISOString();
  const outcome = store.transact((tx) => {
    const found = tx.get(COLLECTION, linkId(profileId));
    if (found !== null && !validLink(found)) return { ok: false, reason: 'identity-record-invalid' };
    let previous = [];
    let changed = false;
    if (found !== null) {
      previous = found.previous;
      if (found.provider !== verified.provider || found.subject !== verified.subject) {
        changed = true;
        previous = [found.subject, ...found.previous].filter((key, index, all) => key !== verified.subject && all.indexOf(key) === index).slice(0, MAX_PREVIOUS);
      }
    }
    tx.put(COLLECTION, linkId(profileId), { schemaVersion: 1, provider: verified.provider, subject: verified.subject, previous, verifiedAt: at });
    return { ok: true, recorded: true, changed };
  });
  return outcome.ok ? outcome.value : { ok: false, reason: outcome.reason || 'store-unavailable' };
}

function readLinks(store) {
  const listed = store && typeof store.list === 'function' ? store.list(COLLECTION) : { ok: false, items: [] };
  if (!listed.ok) return { ok: false, reason: 'store-unavailable' };
  const links = new Map();
  for (const item of listed.items) {
    if (!item.id.startsWith(PREFIX)) continue;
    // An unreadable record is an unknown group, not an empty one: the caller must not proceed on it.
    if (!validLink(item.value)) return { ok: false, reason: 'identity-record-invalid' };
    links.set(item.id.slice(PREFIX.length), item.value);
  }
  return { ok: true, links };
}

/**
 * The other profiles that share a verified provider account with this one, now or through an account
 * either of them was verified as before, in a stable order. Only profiles that still exist count.
 * `ok: false` means the groups could not be established: the caller must not start anything on it.
 */
function linkedProfiles(store, profileId, existingIds) {
  const read = readLinks(store);
  if (!read.ok) return read;
  const own = read.links.get(profileId);
  if (!own) return { ok: true, ids: [], known: false };
  const existing = new Set(existingIds);
  const mine = new Set(subjectsOf(own));
  const ids = [];
  for (const [id, link] of read.links) {
    if (id === profileId || !existing.has(id) || link.provider !== own.provider) continue;
    if (subjectsOf(link).some((key) => mine.has(key))) ids.push(id);
  }
  return { ok: true, ids: ids.sort(), known: true };
}

/**
 * Compares what the CLI says right now with what the profile was verified as. A different actual account,
 * or a CLI that says it is signed out, stops the launch (the link is updated, so the next check and the
 * limits start from the new state). A check that could not tell (no answer, not verifiable) neither
 * blocks nor releases anything: the saved groups keep applying.
 */
function assessLaunchIdentity(store, profileId, outcome, now = new Date()) {
  const read = readLinks(store);
  if (!read.ok) return { ok: false, code: 'identity-unavailable' };
  const link = read.links.get(profileId);
  if (!link) return { ok: true };
  if (!outcome || outcome.ok !== true || !outcome.identity) return { ok: true, unverified: true };
  const identity = outcome.identity;
  if (identity.loggedIn === false) return { ok: false, code: 'identity-changed' };
  const verified = verifiedSubject(identity);
  if (!verified) return { ok: true, unverified: true };
  if (verified.provider === link.provider && verified.subject === link.subject) return { ok: true };
  const recorded = recordVerifiedIdentity(store, profileId, identity, now);
  return recorded.ok ? { ok: false, code: 'identity-changed' } : { ok: false, code: 'identity-unavailable' };
}

/**
 * Deduplicates quota observations across profiles that share the same real account. For each window a
 * still-valid actual reading always wins over anything else (a newer estimate or an unknown one never
 * hides it); among equals the most recent wins. Percentages are never summed.
 */
function deduplicateQuotaObservations(observationLists, now = new Date()) {
  const byWindow = new Map();
  const usable = (item) => item.confidence === CONFIDENCE.ACTUAL && isFresh(item, now);
  const time = (item) => { const t = Date.parse(item.observedAt); return Number.isFinite(t) ? t : -Infinity; };
  for (const list of observationLists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item.field !== 'string') continue;
      const existing = byWindow.get(item.field);
      if (!existing) { byWindow.set(item.field, item); continue; }
      const itemRank = usable(item) ? 1 : 0;
      const existingRank = usable(existing) ? 1 : 0;
      if (itemRank > existingRank || (itemRank === existingRank && time(item) > time(existing))) byWindow.set(item.field, item);
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
  linkId,
  recordVerifiedIdentity,
  readLinks,
  linkedProfiles,
  assessLaunchIdentity,
  deduplicateQuotaObservations,
  coordinatePolicies
};
