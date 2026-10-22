'use strict';

const { validateTeamRules, emptyTeamRules } = require('./model');

// One document in the private store. A missing document is "nobody has written team rules"; one that exists but does not validate
// is an error, never an empty list, so a damaged file cannot silently turn the rules off.
const COLLECTION = 'teamRules';
const ID = 'team';
const fail = (reason) => ({ ok: false, reason });

class TeamRulesStore {
  constructor(store) {
    if (!store || typeof store.get !== 'function' || typeof store.transact !== 'function') throw new TypeError('private-store-required');
    this.store = store;
  }

  get() {
    const loaded = this.store.get(COLLECTION, ID);
    if (!loaded.ok) return fail(loaded.reason || 'storage-unavailable');
    if (!loaded.found) return { ok: true, doc: emptyTeamRules() };
    const checked = validateTeamRules(loaded.value);
    return checked.ok ? { ok: true, doc: checked.doc } : fail('invalid-team-rules-record');
  }

  /** Saves `next` only if the stored version is still `expectedVersion`: two windows cannot overwrite each other. */
  save(next, expectedVersion) {
    const checked = validateTeamRules(next);
    if (!checked.ok) return fail('invalid-team-rules');
    if (checked.doc.version !== expectedVersion + 1) return fail('invalid-version');
    const result = this.store.transact((tx) => {
      const current = tx.get(COLLECTION, ID);
      const currentVersion = current === null ? 0 : (validateTeamRules(current).ok ? current.version : -1);
      if (currentVersion < 0) return { rejected: fail('invalid-team-rules-record') };
      if (currentVersion !== expectedVersion) return { rejected: fail('stale-version') };
      tx.put(COLLECTION, ID, checked.doc);
      return { saved: checked.doc };
    });
    if (!result.ok) return fail(result.reason || 'storage-unavailable');
    if (result.value.rejected) return result.value.rejected;
    return { ok: true, doc: result.value.saved };
  }
}

module.exports = { TeamRulesStore, COLLECTION, ID };
