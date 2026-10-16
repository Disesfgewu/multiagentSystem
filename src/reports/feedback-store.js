'use strict';

const { createHash } = require('node:crypto');

const COLLECTION = 'reportFeedback';
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA = /^[a-f0-9]{40}$/i;
const safeTarget = (value) => value && typeof value === 'object' && REPOSITORY.test(value.repository) &&
  ['issue', 'pullRequest'].includes(value.kind) && Number.isSafeInteger(value.number) && value.number > 0;
const idFor = (target) => `report-${createHash('sha256').update(target.repository.toLowerCase()).digest('hex').slice(0, 20)}-${target.kind}-${target.number}`;
const plain = (value) => value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const valid = (record, target) => plain(record) && record.repository === target.repository && record.kind === target.kind && record.number === target.number &&
  typeof record.note === 'string' && record.note.trim() !== '' && Array.from(record.note).length <= 2000 &&
  !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(record.note) &&
  (record.headSha === null || (typeof record.headSha === 'string' && SHA.test(record.headSha))) &&
  typeof record.updatedAt === 'string' && Number.isFinite(Date.parse(record.updatedAt)) &&
  Number.isSafeInteger(record.revision) && record.revision > 0 &&
  Object.keys(record).every((key) => ['repository', 'kind', 'number', 'note', 'headSha', 'updatedAt', 'revision'].includes(key));

function readFeedback(store, target) {
  if (!safeTarget(target) || !store || typeof store.get !== 'function') return { state: 'unknown', reason: 'invalid-target-or-store' };
  const found = store.get(COLLECTION, idFor(target));
  if (!found?.ok) return { state: 'unknown', reason: 'private-storage-unavailable' };
  if (!found.found) return { state: 'missing' };
  if (!valid(found.value, target)) return { state: 'unknown', reason: 'invalid-saved-feedback' };
  return { state: 'saved', record: found.value };
}

/** Compare-and-swap a local note. The record never contains an account, a path or a credential. */
function saveFeedback(store, target, input, expectedRevision, now = new Date()) {
  if (!safeTarget(target) || !plain(input) || Object.keys(input).some((key) => !['note', 'headSha'].includes(key)) ||
      typeof input.note !== 'string' || input.note.trim() === '' || Array.from(input.note).length > 2000 ||
      /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input.note) ||
      !(input.headSha === null || (typeof input.headSha === 'string' && SHA.test(input.headSha))) ||
      !(expectedRevision === null || (Number.isSafeInteger(expectedRevision) && expectedRevision > 0)) ||
      !Number.isFinite(now.getTime()) || !store || typeof store.transact !== 'function') return { ok: false, reason: 'invalid-feedback' };
  const result = store.transact((tx) => {
    const old = tx.get(COLLECTION, idFor(target));
    if (old && !valid(old, target)) return { rejected: 'invalid-saved-feedback' };
    if ((old?.revision ?? null) !== expectedRevision) return { rejected: 'stale-feedback' };
    const record = { repository: target.repository, kind: target.kind, number: target.number, note: input.note, headSha: input.headSha, updatedAt: now.toISOString(), revision: (old?.revision ?? 0) + 1 };
    tx.put(COLLECTION, idFor(target), record);
    return { record };
  });
  if (!result?.ok) return { ok: false, reason: result?.reason ?? 'private-storage-unavailable' };
  if (result.value.rejected) return { ok: false, reason: result.value.rejected };
  return { ok: true, record: result.value.record };
}

module.exports = { readFeedback, saveFeedback, idFor, COLLECTION };
