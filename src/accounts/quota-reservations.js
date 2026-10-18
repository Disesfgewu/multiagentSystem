'use strict';

const { randomUUID } = require('node:crypto');
const { decideDispatch, validatePolicy, DEFAULT_POLICY } = require('./quota-policy');

const COLLECTION = 'quotaReservations';
const SCHEMA_VERSION = 1;
const LEASE_MS = 5 * 60_000;
const RENEW_MS = 60_000;
const MAX_LEASES = 64;
const ACCOUNT_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/;
const LEASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RECORD_KEYS = new Set(['schemaVersion', 'leases']);
const LEASE_KEYS = new Set(['id', 'expiresAt']);

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const onlyKeys = (value, allowed) => isPlain(value) && Object.keys(value).every((key) => allowed.has(key));
const recordId = (accountKey) => `slots-${accountKey}`;
const timeOf = (value) => value instanceof Date ? value.getTime() : Date.parse(value);

function checkedAccount(accountKey) {
  return typeof accountKey === 'string' && ACCOUNT_KEY.test(accountKey);
}

function parseRecord(value) {
  if (value === null) return { ok: true, leases: [] };
  if (!onlyKeys(value, RECORD_KEYS) || value.schemaVersion !== SCHEMA_VERSION || !Array.isArray(value.leases) || value.leases.length > MAX_LEASES) {
    return { ok: false, reason: 'reservation-record-invalid' };
  }
  const ids = new Set();
  const leases = [];
  for (const lease of value.leases) {
    if (!onlyKeys(lease, LEASE_KEYS) || typeof lease.id !== 'string' || !LEASE_ID.test(lease.id) || ids.has(lease.id) ||
        typeof lease.expiresAt !== 'string' || !Number.isFinite(Date.parse(lease.expiresAt)) ||
        new Date(Date.parse(lease.expiresAt)).toISOString() !== lease.expiresAt) {
      return { ok: false, reason: 'reservation-record-invalid' };
    }
    ids.add(lease.id);
    leases.push({ id: lease.id, expiresAt: lease.expiresAt });
  }
  return { ok: true, leases };
}

function readPolicy(tx, accountKey) {
  const value = tx.get('policies', `quota-${accountKey}`);
  if (value === null) return { ok: true, stored: false, policy: DEFAULT_POLICY };
  const checked = validatePolicy(value);
  return checked.ok
    ? { ok: true, stored: true, policy: checked.policy }
    : { ok: false, reason: 'stored-policy-invalid' };
}

function samePolicy(a, b) {
  return Boolean(a && b && a.ok === true && b.ok === true && a.stored === b.stored &&
    JSON.stringify(a.policy) === JSON.stringify(b.policy));
}

function activeRecord(tx, accountKey, nowMs) {
  const parsed = parseRecord(tx.get(COLLECTION, recordId(accountKey)));
  if (!parsed.ok) return parsed;
  const active = parsed.leases.filter((lease) => Date.parse(lease.expiresAt) > nowMs);
  return { ok: true, leases: active, changed: active.length !== parsed.leases.length };
}

function writeRecord(tx, accountKey, leases) {
  if (leases.length === 0) tx.delete(COLLECTION, recordId(accountKey));
  else tx.put(COLLECTION, recordId(accountKey), { schemaVersion: SCHEMA_VERSION, leases });
}

/** Reads and removes expired leases under the PrivateStore's cross-process lock. */
function runningSlots(store, accountKey, now = new Date()) {
  const nowMs = timeOf(now);
  if (!store || typeof store.transact !== 'function' || !checkedAccount(accountKey) || !Number.isFinite(nowMs)) {
    return { ok: false, reason: 'reservation-input-invalid' };
  }
  const outcome = store.transact((tx) => {
    const record = activeRecord(tx, accountKey, nowMs);
    if (!record.ok) return record;
    if (record.changed) writeRecord(tx, accountKey, record.leases);
    return { ok: true, running: record.leases.length };
  });
  return outcome.ok ? outcome.value : { ok: false, reason: outcome.reason || 'store-unavailable' };
}

/**
 * Rechecks the policy and takes a lease in the same PrivateStore transaction. Two Extension Hosts
 * therefore cannot both take the last slot. A malformed record is an error, never an empty list.
 */
function reserveSlot({ store, accountKey, expectedPolicyRead, observations = [], now = new Date(), approval, leaseMs = LEASE_MS, leaseId = randomUUID() } = {}) {
  const nowMs = timeOf(now);
  if (!store || typeof store.transact !== 'function' || !checkedAccount(accountKey) || !Number.isFinite(nowMs) ||
      !Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 24 * 60 * 60_000 || !LEASE_ID.test(leaseId)) {
    return { ok: false, reason: 'reservation-input-invalid' };
  }
  const outcome = store.transact((tx) => {
    const policyRead = readPolicy(tx, accountKey);
    if (!policyRead.ok) return policyRead;
    if (!samePolicy(policyRead, expectedPolicyRead)) return { ok: false, reason: 'policy-changed' };
    const record = activeRecord(tx, accountKey, nowMs);
    if (!record.ok) return record;
    const constrained = policyRead.stored === true;
    const decision = decideDispatch({
      policy: constrained ? policyRead.policy : DEFAULT_POLICY,
      observations: constrained ? observations : [],
      now: new Date(nowMs),
      running: record.leases.length,
      approval: constrained ? approval : 'override'
    });
    if (!decision.allowed) {
      if (record.changed) writeRecord(tx, accountKey, record.leases);
      return { ok: true, decision };
    }
    if (record.leases.length >= MAX_LEASES) return { ok: false, reason: 'reservation-capacity' };
    const reservation = { accountKey, id: leaseId };
    writeRecord(tx, accountKey, [...record.leases, { id: leaseId, expiresAt: new Date(nowMs + leaseMs).toISOString() }]);
    return { ok: true, decision: { ...decision, reservation } };
  });
  return outcome.ok ? outcome.value : { ok: false, reason: outcome.reason || 'store-unavailable' };
}

function renewSlot(store, reservation, now = new Date(), leaseMs = LEASE_MS) {
  const nowMs = timeOf(now);
  if (!store || typeof store.transact !== 'function' || !isPlain(reservation) || !checkedAccount(reservation.accountKey) ||
      typeof reservation.id !== 'string' || !LEASE_ID.test(reservation.id) || !Number.isFinite(nowMs) ||
      !Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 24 * 60 * 60_000) {
    return { ok: false, reason: 'reservation-input-invalid' };
  }
  const outcome = store.transact((tx) => {
    const record = activeRecord(tx, reservation.accountKey, nowMs);
    if (!record.ok) return record;
    const found = record.leases.find((lease) => lease.id === reservation.id);
    if (!found) {
      if (record.changed) writeRecord(tx, reservation.accountKey, record.leases);
      return { ok: true, renewed: false };
    }
    found.expiresAt = new Date(nowMs + leaseMs).toISOString();
    writeRecord(tx, reservation.accountKey, record.leases);
    return { ok: true, renewed: true };
  });
  return outcome.ok ? outcome.value : { ok: false, reason: outcome.reason || 'store-unavailable' };
}

function releaseSlot(store, reservation, now = new Date()) {
  const nowMs = timeOf(now);
  if (!store || typeof store.transact !== 'function' || !isPlain(reservation) || !checkedAccount(reservation.accountKey) ||
      typeof reservation.id !== 'string' || !LEASE_ID.test(reservation.id) || !Number.isFinite(nowMs)) {
    return { ok: false, reason: 'reservation-input-invalid' };
  }
  const outcome = store.transact((tx) => {
    const record = activeRecord(tx, reservation.accountKey, nowMs);
    if (!record.ok) return record;
    const remaining = record.leases.filter((lease) => lease.id !== reservation.id);
    const released = remaining.length !== record.leases.length;
    if (released || record.changed) writeRecord(tx, reservation.accountKey, remaining);
    return { ok: true, released };
  });
  return outcome.ok ? outcome.value : { ok: false, reason: outcome.reason || 'store-unavailable' };
}

module.exports = {
  COLLECTION,
  LEASE_MS,
  RENEW_MS,
  runningSlots,
  reserveSlot,
  renewSlot,
  releaseSlot
};
