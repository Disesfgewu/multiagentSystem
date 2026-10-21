'use strict';

const { validateDispatch } = require('./task');

// One immutable record per dispatch (what was typed into which session), through the same generic `PrivateStore` as the
// broadcast delivery log. A record that fails to validate on read is an error, never an empty or shorter list.
const COLLECTION = 'taskDispatches';
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
      return { saved: checked.record };
    });
    if (!result.ok) return fail(result.reason || 'storage-unavailable');
    if (result.value.rejected) return result.value.rejected;
    return { ok: true, record: result.value.saved };
  }
}

module.exports = { DispatchStore, COLLECTION };
