'use strict';

const { validateDispatch } = require('./task');

// One immutable record per dispatch (what was typed into which session), through the same generic `PrivateStore` as the
// broadcast delivery log. A record that fails to validate on read is an error, never an empty or shorter list.
const COLLECTION = 'taskDispatches';
// The log keeps the newest records only, so it cannot grow without bound.
const MAX_RECORDS = 500;
const fail = (reason) => ({ ok: false, reason });

class DispatchStore {
  constructor(store) {
    if (!store || typeof store.list !== 'function' || typeof store.transact !== 'function') throw new TypeError('private-store-required');
    this.store = store;
  }

  list() {
    const listed = this.store.list(COLLECTION);
    if (!listed.ok) return fail(listed.reason || 'storage-unavailable');
    if (!Array.isArray(listed.items)) return fail('invalid-dispatch-record');
    const items = [];
    for (const item of listed.items) {
      const checked = validateDispatch(item.value);
      if (!checked.ok) return fail('invalid-dispatch-record');
      items.push(checked.record);
    }
    return { ok: true, items };
  }

  /** Records one dispatch. Its id must be new: a record is never overwritten. */
  record(raw) {
    const checked = validateDispatch(raw);
    if (!checked.ok) return { ok: false, reason: 'invalid-dispatch', problems: checked.problems };
    const result = this.store.transact((tx) => {
      if (tx.get(COLLECTION, checked.record.id) !== null) return { rejected: fail('duplicate-id') };
      tx.put(COLLECTION, checked.record.id, checked.record);
      const all = tx.list(COLLECTION).map((entry) => entry.value).filter((value) => value && typeof value.at === 'string' && typeof value.id === 'string');
      if (all.length > MAX_RECORDS) {
        const oldest = [...all].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1)).slice(0, all.length - MAX_RECORDS);
        for (const entry of oldest) if (entry.id !== checked.record.id) tx.delete(COLLECTION, entry.id);
      }
      return { saved: checked.record };
    });
    if (!result.ok) return fail(result.reason || 'storage-unavailable');
    if (result.value.rejected) return result.value.rejected;
    return { ok: true, record: result.value.saved };
  }
}

module.exports = { DispatchStore, COLLECTION, MAX_RECORDS };
