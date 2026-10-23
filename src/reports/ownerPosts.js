'use strict';

/**
 * The owner's own GitHub posts (issue #342). The owner and every agent share one GitHub account, and the repository is public, so
 * neither the GitHub login nor a missing signature says who wrote a comment. What the owner publishes from VS Code (a comment or a
 * formal review, after their confirmation) is recorded here by the id GitHub gave it; only a post whose id is in this record is
 * shown as the owner's.
 *
 * One document per repository in the private store. A document that exists but cannot be read is an error, never an empty record:
 * every unsigned comment would then read "unsigned" instead of "cannot tell".
 */

const { createHash } = require('node:crypto');

const COLLECTION = 'ownerPosts';
const KINDS = Object.freeze(['comment', 'review']);
const MAX_PER_KIND = 5000;
const REPOSITORY = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

const fail = (reason) => ({ ok: false, reason });
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// GitHub compares repository names without case; the id has a fixed length whatever the name.
const docId = (repository) => `repo-${createHash('sha256').update(repository.toLowerCase()).digest('hex')}`;
const emptyDoc = () => ({ version: 1, comment: {}, review: {} });

function validateDoc(raw) {
  if (!isPlain(raw) || Object.keys(raw).sort().join() !== 'comment,review,version' || raw.version !== 1) return fail('invalid-owner-posts-record');
  for (const kind of KINDS) {
    if (!isPlain(raw[kind]) || Object.keys(raw[kind]).length > MAX_PER_KIND) return fail('invalid-owner-posts-record');
    for (const [id, entry] of Object.entries(raw[kind])) {
      if (!/^[1-9][0-9]{0,15}$/.test(id) || !isPlain(entry) || Object.keys(entry).sort().join() !== 'at,number') return fail('invalid-owner-posts-record');
      if (!Number.isSafeInteger(entry.number) || entry.number < 1 || typeof entry.at !== 'string' || !Number.isFinite(Date.parse(entry.at))) return fail('invalid-owner-posts-record');
    }
  }
  return { ok: true, doc: { version: 1, comment: { ...raw.comment }, review: { ...raw.review } } };
}

/** Keeps the newest entries when there are too many. An owner post that falls out of the record is then shown as unsigned, never as an agent's. */
function prune(entries) {
  const list = Object.entries(entries);
  if (list.length <= MAX_PER_KIND) return entries;
  list.sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at));
  return Object.fromEntries(list.slice(0, MAX_PER_KIND));
}

class OwnerPostStore {
  constructor(store) {
    if (!store || typeof store.get !== 'function' || typeof store.transact !== 'function') throw new TypeError('private-store-required');
    this.store = store;
  }

  /** Records one post the owner published from VS Code. `id` is GitHub's id for the comment or review. */
  record({ repository, kind, id, number, now = new Date() } = {}) {
    if (typeof repository !== 'string' || !REPOSITORY.test(repository)) return fail('invalid-repository');
    if (!KINDS.includes(kind)) return fail('invalid-kind');
    if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(number) || number < 1) return fail('invalid-id');
    const at = now instanceof Date && Number.isFinite(now.getTime()) ? now.toISOString() : null;
    if (at === null) return fail('invalid-time');
    const key = docId(repository);
    const result = this.store.transact((tx) => {
      const stored = tx.get(COLLECTION, key);
      const checked = stored === null ? { ok: true, doc: emptyDoc() } : validateDoc(stored);
      if (!checked.ok) return { rejected: checked.reason };
      const doc = checked.doc;
      doc[kind][String(id)] = { number, at };
      doc[kind] = prune(doc[kind]);
      tx.put(COLLECTION, key, doc);
      return { recorded: true };
    });
    if (!result || !result.ok) return fail(result?.reason || 'storage-unavailable');
    if (result.value.rejected) return fail(result.value.rejected);
    return { ok: true };
  }

  /** The ids recorded for a repository, as two sets, or why they cannot be read. */
  read(repository) {
    if (typeof repository !== 'string' || !REPOSITORY.test(repository)) return fail('invalid-repository');
    const loaded = this.store.get(COLLECTION, docId(repository));
    if (!loaded.ok) return fail(loaded.reason || 'storage-unavailable');
    const checked = loaded.found ? validateDoc(loaded.value) : { ok: true, doc: emptyDoc() };
    if (!checked.ok) return checked;
    return { ok: true, comments: new Set(Object.keys(checked.doc.comment).map(Number)), reviews: new Set(Object.keys(checked.doc.review).map(Number)) };
  }
}

module.exports = { OwnerPostStore, COLLECTION, MAX_PER_KIND, validateDoc, docId };
