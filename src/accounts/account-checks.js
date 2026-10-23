'use strict';

/**
 * The last sign-in check of each account, kept in the private store so the account view still shows it after the window reloads
 * (#352), with the time it was made. What is kept is what the view needs and nothing more: whether it worked and why not, when, the
 * command asked, and the reduced identity the check produced (signed in or not, the login method, the plan and the account's opaque
 * fingerprint hash). The e-mail address and organization are NEVER kept: they come back from the next check, which runs on start.
 *
 * A stored record that cannot be read is ignored (the account shows "not checked yet"), never shown as a check.
 */

const COLLECTION = 'accountChecks';
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/;
const REASON = /^[a-z][a-z-]{0,40}$/;
const MAX_IDENTITY_BYTES = 4096;
// Anything that looks like an e-mail address. The identity this module stores has none (its subject is a hash), so finding one
// means the shape changed: such a record is refused rather than written.
const LOOKS_LIKE_EMAIL = /[^\s"@]+@[^\s"@]+\.[^\s"@]+/;

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (reason) => ({ ok: false, reason });

/** The part of a check result that may be stored, or null when it cannot be. */
function storable(result) {
  if (!isPlain(result) || (result.state !== 'checked' && result.state !== 'unknown') || typeof result.reason !== 'string' || !REASON.test(result.reason)) return null;
  if (typeof result.checkedAt !== 'string' || !Number.isFinite(Date.parse(result.checkedAt))) return null;
  if (result.source !== null && !(typeof result.source === 'string' && result.source.length <= 80)) return null;
  let identity = null;
  if (result.identity !== null && result.identity !== undefined) {
    if (!isPlain(result.identity) || typeof result.identity.loggedIn !== 'boolean' || typeof result.identity.provider !== 'string') return null;
    const text = JSON.stringify(result.identity);
    if (Buffer.byteLength(text) > MAX_IDENTITY_BYTES || LOOKS_LIKE_EMAIL.test(text)) return null;
    identity = JSON.parse(text);
  }
  return { schemaVersion: 1, ok: result.ok === true && result.state === 'checked', state: result.state, reason: result.reason, checkedAt: new Date(result.checkedAt).toISOString(), source: result.source ?? null, identity };
}

class AccountCheckStore {
  constructor(store) {
    if (!store || typeof store.get !== 'function' || typeof store.transact !== 'function') throw new TypeError('private-store-required');
    this.store = store;
  }

  /** Saves the last check of one account. The display part (e-mail, organization) is dropped here whatever the caller passes. */
  save(profileId, result) {
    if (typeof profileId !== 'string' || !PROFILE_ID.test(profileId)) return fail('invalid-profile');
    const record = storable(result);
    if (!record) return fail('invalid-result');
    const outcome = this.store.transact((tx) => { tx.put(COLLECTION, profileId, record); return true; });
    return outcome && outcome.ok ? { ok: true } : fail(outcome?.reason || 'storage-unavailable');
  }

  /** The stored checks of the given accounts, as check results marked `restored`; an unreadable record is left out. */
  load(profileIds) {
    const results = new Map();
    for (const id of Array.isArray(profileIds) ? profileIds : []) {
      if (typeof id !== 'string' || !PROFILE_ID.test(id)) continue;
      const found = this.store.get(COLLECTION, id);
      if (!found || !found.ok || !found.found || !isPlain(found.value) || found.value.schemaVersion !== 1) continue;
      const record = storable(found.value);
      if (record) results.set(id, { ok: record.ok, state: record.state, reason: record.reason, checkedAt: record.checkedAt, source: record.source, identity: record.identity, restored: true });
    }
    return results;
  }

  remove(profileId) {
    if (typeof profileId !== 'string' || !PROFILE_ID.test(profileId)) return fail('invalid-profile');
    const outcome = this.store.transact((tx) => { tx.delete(COLLECTION, profileId); return true; });
    return outcome && outcome.ok ? { ok: true } : fail(outcome?.reason || 'storage-unavailable');
  }
}

module.exports = { AccountCheckStore, COLLECTION, storable, LOOKS_LIKE_EMAIL };
