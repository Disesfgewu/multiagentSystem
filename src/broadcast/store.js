'use strict';

const { validateBroadcast, scanBroadcastText } = require('./model');

// Persists broadcasts through the same generic `PrivateStore` interface role groups and accounts
// already use. A broadcast is created once and never rewritten except to set `revokedAt`: it is an
// audit record of what was sent, not a document someone edits. A record that fails to validate on
// read is an error, never silently treated as missing or as an empty list (the same rule every
// other store in this project already follows).

const COLLECTION = 'broadcasts';
const fail = (reason) => ({ ok: false, reason });

class BroadcastStore {
  constructor(store) {
    if (!store || typeof store.get !== 'function' || typeof store.list !== 'function' || typeof store.transact !== 'function') {
      throw new TypeError('private-store-required');
    }
    this.store = store;
  }

  list() {
    const listed = this.store.list(COLLECTION);
    if (!listed.ok) return fail(listed.reason || 'storage-unavailable');
    if (!Array.isArray(listed.items)) return fail('invalid-broadcast-record');
    const items = [];
    for (const item of listed.items) {
      const checked = validateBroadcast(item.value);
      if (!checked.ok) return fail('invalid-broadcast-record');
      items.push(checked.broadcast);
    }
    return { ok: true, items };
  }

  get(id) {
    const loaded = this.store.get(COLLECTION, id);
    if (!loaded.ok) return fail(loaded.reason || 'storage-unavailable');
    if (!loaded.found) return fail('broadcast-not-found');
    const checked = validateBroadcast(loaded.value);
    if (!checked.ok) return fail('invalid-broadcast-record');
    return { ok: true, broadcast: checked.broadcast };
  }

  /**
   * Creates one broadcast. Its id must not already exist: a broadcast is never overwritten, only
   * revoked. The text is scanned here too, not only by whatever command calls this, so a caller
   * cannot accidentally store an unscanned broadcast by skipping that step.
   */
  create(raw) {
    const checked = validateBroadcast(raw);
    if (!checked.ok) return { ok: false, reason: 'invalid-broadcast', problems: checked.problems };
    const scanned = scanBroadcastText(checked.broadcast.text);
    if (scanned.status !== 'clear') return { ok: false, reason: 'content-scan-rejected', scan: scanned };
    const result = this.store.transact((tx) => {
      const current = tx.get(COLLECTION, checked.broadcast.id);
      if (current !== null) return { rejected: fail('duplicate-id') };
      tx.put(COLLECTION, checked.broadcast.id, checked.broadcast);
      return { saved: checked.broadcast };
    });
    if (!result.ok) return fail(result.reason || 'storage-unavailable');
    if (result.value.rejected) return result.value.rejected;
    return { ok: true, broadcast: result.value.saved };
  }

  /** The first revocation stands: revoking an already-revoked broadcast again changes nothing, whatever time is given. */
  revoke(id, revokedAt) {
    const result = this.store.transact((tx) => {
      const current = tx.get(COLLECTION, id);
      if (current === null) return { rejected: fail('broadcast-not-found') };
      const checked = validateBroadcast(current);
      if (!checked.ok) return { rejected: fail('invalid-broadcast-record') };
      if (checked.broadcast.revokedAt !== null) return { saved: checked.broadcast };
      const revoked = validateBroadcast({ ...checked.broadcast, revokedAt });
      if (!revoked.ok) return { rejected: { ok: false, reason: 'invalid-revoke-time', problems: revoked.problems } };
      tx.put(COLLECTION, id, revoked.broadcast);
      return { saved: revoked.broadcast };
    });
    if (!result.ok) return fail(result.reason || 'storage-unavailable');
    if (result.value.rejected) return result.value.rejected;
    return { ok: true, broadcast: result.value.saved };
  }
}

module.exports = { BroadcastStore };
