'use strict';

const { validateRoleGroup } = require('./role-group');
const { previewEffectiveRules } = require('./preview');

const COLLECTION = 'roleGroups';
const fail = (reason) => ({ ok: false, reason });
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const revisionOf = (record) => record.revision === undefined ? 1 : record.revision;

function validRecord(record, id) {
  if (!plain(record) || !plain(record.group) || !plain(record.layers)) return false;
  if (id !== undefined && record.group.id !== id) return false;
  if (!Number.isSafeInteger(revisionOf(record)) || revisionOf(record) < 1) return false;
  if (!validateRoleGroup(record.group).ok) return false;
  return previewEffectiveRules({ roleGroup: record.group, layers: record.layers }).ok;
}

class RoleStore {
  constructor(store) {
    if (!store || typeof store.get !== 'function' || typeof store.list !== 'function' || typeof store.transact !== 'function') {
      throw new TypeError('private-store-required');
    }
    this.store = store;
  }

  get(id) {
    const loaded = this.store.get(COLLECTION, id);
    if (!loaded.ok) return fail(loaded.reason || 'storage-unavailable');
    if (!loaded.found) return fail('role-not-found');
    if (!validRecord(loaded.value, id)) return fail('invalid-role-record');
    return { ok: true, record: { ...loaded.value, revision: revisionOf(loaded.value) } };
  }

  list() {
    const listed = this.store.list(COLLECTION);
    if (!listed.ok) return fail(listed.reason || 'storage-unavailable');
    if (!Array.isArray(listed.items) || listed.items.some((item) => !validRecord(item.value, item.id))) {
      return fail('invalid-role-record');
    }
    return { ok: true, items: listed.items.map((item) => ({ id: item.id, record: { ...item.value, revision: revisionOf(item.value) } })) };
  }

  /** Every edit must pass the revision read before showing its dialog. */
  save(record, { expectedRevision } = {}) {
    if (!validRecord(record)) return fail('invalid-role-record');
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) return fail('invalid-revision');
    const id = record.group.id;
    const result = this.store.transact((tx) => {
      const current = tx.get(COLLECTION, id);
      if (current !== null) {
        if (!validRecord(current, id)) return { rejected: fail('invalid-role-record') };
        if (expectedRevision === undefined) return { rejected: fail('revision-required') };
        if (expectedRevision !== revisionOf(current)) return { rejected: fail('stale-revision') };
      } else if (expectedRevision !== undefined) {
        return { rejected: fail('stale-revision') };
      }
      const revision = current === null ? 1 : revisionOf(current) + 1;
      if (!Number.isSafeInteger(revision)) return { rejected: fail('invalid-revision') };
      const next = structuredClone({ ...record, revision });
      tx.put(COLLECTION, id, next);
      return { saved: next };
    });
    if (!result.ok) return fail(result.reason || 'storage-unavailable');
    if (result.value.rejected) return result.value.rejected;
    return { ok: true, record: result.value.saved };
  }
}

module.exports = { RoleStore, validRecord };
