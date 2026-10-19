'use strict';

const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { coordinatePolicies, settleSwitchLeases, rearmSwitchLease, groupSnapshotInTransaction } = require('./identity-registry');
const { decideDispatch, validatePolicy, DEFAULT_POLICY } = require('./quota-policy');

const COLLECTION = 'quotaReservations';
const SCHEMA_VERSION = 1;
const LEASE_MS = 5 * 60_000;
const RENEW_MS = 60_000;
const MAX_LEASES = 64;
const ACCOUNT_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/;
const LEASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RECORD_KEYS = new Set(['schemaVersion', 'leases']);
const LEASE_KEYS = new Set(['id', 'expiresAt', 'ownerPid', 'ownerHost']);
const HOST = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]{1,255}$/u;

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
    const hasPid = lease.ownerPid !== undefined;
    const hasHost = lease.ownerHost !== undefined;
    if (hasPid !== hasHost || (hasPid && (!Number.isSafeInteger(lease.ownerPid) || lease.ownerPid < 1 || typeof lease.ownerHost !== 'string' || !HOST.test(lease.ownerHost)))) {
      return { ok: false, reason: 'reservation-record-invalid' };
    }
    ids.add(lease.id);
    leases.push(hasPid
      ? { id: lease.id, expiresAt: lease.expiresAt, ownerPid: lease.ownerPid, ownerHost: lease.ownerHost }
      : { id: lease.id, expiresAt: lease.expiresAt });
  }
  return { ok: true, leases };
}

// Whether the process that took a lease is still running. Only a confirmed absence (ESRCH) says no:
// EPERM means it exists, and any other error cannot tell, so the answer stays "running".
function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error && error.code === 'ESRCH');
  }
}

/** Who is asking and how to tell whether a lease's owner is still there (injectable for tests). */
function ownerContext(options = {}) {
  return {
    pid: Number.isSafeInteger(options.ownerPid) && options.ownerPid > 0 ? options.ownerPid : process.pid,
    host: typeof options.ownerHost === 'string' && HOST.test(options.ownerHost) ? options.ownerHost : os.hostname(),
    isAlive: typeof options.isOwnerAlive === 'function' ? options.isOwnerAlive : processExists
  };
}

const ownerFields = (ctx) => (HOST.test(ctx.host) ? { ownerPid: ctx.pid, ownerHost: ctx.host } : {});

/** Whether the Extension Host that took a lease is confirmed gone from this computer. */
function ownerGone(lease, ctx) {
  if (lease.ownerPid === undefined || lease.ownerHost !== ctx.host) return false;
  try { return ctx.isAlive(lease.ownerPid) === false; } catch { return false; }
}

/** A lease nobody can judge from here: an older record without an owner, or one whose host is not this computer's name (another computer, or this one renamed). */
const unjudgeable = (lease, ctx) => lease.ownerPid === undefined || lease.ownerHost !== ctx.host;

/**
 * Every stored lease holds a slot until it is released: time and a vanished or unknown
 * owner say nothing about whether the agent it stands for has stopped. A machine that slept, or an
 * Extension Host that was blocked for longer than the lease, resumes with its agents running; a
 * window that closed or crashed leaves agents running in terminals nobody tracks; a computer that
 * was renamed or a record from before owners were recorded cannot be tied to any process at all.
 * Only a recorded end (releaseSlot) or an explicit, confirmed recovery (recoverOrphanedSlots) frees a
 * slot, and until then it keeps blocking new launches. What a confirmed recovery may remove is below.
 */

/** Whether a confirmed recovery may remove the lease: its owner is confirmed gone, or it cannot be judged here and has also gone unrenewed past its expiry. */
function recoverable(lease, nowMs, ctx) {
  return ownerGone(lease, ctx) || (unjudgeable(lease, ctx) && Date.parse(lease.expiresAt) <= nowMs);
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

function activeRecord(tx, accountKey, nowMs, ctx) {
  const parsed = parseRecord(tx.get(COLLECTION, recordId(accountKey)));
  if (!parsed.ok) return parsed;
  // Nothing is dropped here: see the note above about what may free a slot.
  return { ok: true, leases: parsed.leases, changed: false };
}

function writeRecord(tx, accountKey, leases) {
  if (leases.length === 0) tx.delete(COLLECTION, recordId(accountKey));
  else tx.put(COLLECTION, recordId(accountKey), { schemaVersion: SCHEMA_VERSION, leases });
}

/** Reads and removes expired leases under the PrivateStore's cross-process lock. */
function runningSlots(store, accountKey, now = new Date(), options = {}) {
  const ctx = ownerContext(options);
  const nowMs = timeOf(now);
  const linked = Array.isArray(options.linkedAccountKeys) ? options.linkedAccountKeys : [];
  if (!store || typeof store.transact !== 'function' || !checkedAccount(accountKey) || !linked.every(checkedAccount) || !Number.isFinite(nowMs)) {
    return { ok: false, reason: 'reservation-input-invalid' };
  }
  const allKeys = [...new Set([accountKey, ...linked])];
  const outcome = store.transact((tx) => {
    let running = 0;
    let orphaned = 0;
    for (const key of allKeys) {
      const record = activeRecord(tx, key, nowMs, ctx);
      if (!record.ok) return record;
      if (record.changed) writeRecord(tx, key, record.leases);
      running += record.leases.length;
      orphaned += record.leases.filter((lease) => recoverable(lease, nowMs, ctx)).length;
    }
    return { ok: true, running, orphaned };
  });
  return outcome.ok ? outcome.value : { ok: false, reason: outcome.reason || 'store-unavailable' };
}

/**
 * Removes the leases that are recoverable: owner confirmed gone from this computer, or not judgeable
 * here (no owner recorded, another or renamed host) and unrenewed past its expiry. The caller must have
 * asked the person first: nothing proves the agents behind them have stopped, and this stops counting
 * them. A lease whose owner is still running, or an unjudgeable one that has not expired, is kept.
 */
function recoverOrphanedSlots(store, accountKey, now = new Date(), options = {}) {
  const ctx = ownerContext(options);
  const nowMs = timeOf(now);
  const linked = Array.isArray(options.linkedAccountKeys) ? options.linkedAccountKeys : [];
  if (!store || typeof store.transact !== 'function' || !checkedAccount(accountKey) || !linked.every(checkedAccount) || !Number.isFinite(nowMs)) {
    return { ok: false, reason: 'reservation-input-invalid' };
  }
  const allKeys = [...new Set([accountKey, ...linked])];
  const outcome = store.transact((tx) => {
    let totalRecovered = 0;
    for (const key of allKeys) {
      const record = activeRecord(tx, key, nowMs, ctx);
      if (!record.ok) return record;
      const kept = record.leases.filter((lease) => !recoverable(lease, nowMs, ctx));
      const recovered = record.leases.length - kept.length;
      if (recovered > 0 || record.changed) writeRecord(tx, key, kept);
      if (recovered > 0) settleSwitchLeases(tx, key, record.leases.filter((lease) => !kept.includes(lease)).map((lease) => lease.id), nowMs);
      totalRecovered += recovered;
    }
    return { ok: true, recovered: totalRecovered };
  });
  return outcome.ok ? outcome.value : { ok: false, reason: outcome.reason || 'store-unavailable' };
}

/**
 * Rechecks the policy and takes a lease in the same PrivateStore transaction. Two Extension Hosts
 * therefore cannot both take the last slot. A malformed record is an error, never an empty list.
 */
function reserveSlot({ store, accountKey, linkedAccountKeys = [], expectedGroupFingerprint, expectedPolicyRead, observations = [], now = new Date(), approval, leaseMs = LEASE_MS, leaseId = randomUUID(), ownerPid, ownerHost, isOwnerAlive } = {}) {
  const nowMs = timeOf(now);
  const ctx = ownerContext({ ownerPid, ownerHost, isOwnerAlive });
  const linked = Array.isArray(linkedAccountKeys) ? linkedAccountKeys : [];
  if (!store || typeof store.transact !== 'function' || !checkedAccount(accountKey) || !linked.every(checkedAccount) || !Number.isFinite(nowMs) ||
      !Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 24 * 60 * 60_000 || !LEASE_ID.test(leaseId)) {
    return { ok: false, reason: 'reservation-input-invalid' };
  }
  const allKeys = [...new Set([accountKey, ...linked])];
  const outcome = store.transact((tx) => {
    // The policy that decides is the coordinated one over every profile of the group, read here, inside
    // the same transaction that takes the lease. What the caller showed the person (`expectedPolicyRead`)
    // must be that same coordinated reading, so a linked profile's limits changing meanwhile is caught.
    // The group and the trust of each profile's readings are read again here, at the moment the lease is decided.
    // If another window changed either since the caller looked, the launch is refused instead of decided on a stale picture.
    if (expectedGroupFingerprint !== undefined) {
      const snapshot = groupSnapshotInTransaction(tx, store, accountKey);
      if (!snapshot.ok) return { ok: false, reason: snapshot.reason };
      if (snapshot.fingerprint !== expectedGroupFingerprint || JSON.stringify(snapshot.ids) !== JSON.stringify([...linked].sort())) return { ok: false, reason: 'group-changed' };
    }
    const reads = [];
    for (const key of allKeys) {
      const read = readPolicy(tx, key);
      if (!read.ok) return read;
      reads.push(read);
    }
    const policyRead = reads.length > 1 ? coordinatePolicies(reads) : reads[0];
    if (!samePolicy(policyRead, expectedPolicyRead)) return { ok: false, reason: 'policy-changed' };
    const myRecord = activeRecord(tx, accountKey, nowMs, ctx);
    if (!myRecord.ok) return myRecord;

    let totalRunning = myRecord.leases.length;
    const otherRecords = [];
    for (const otherKey of allKeys) {
      if (otherKey === accountKey) continue;
      const otherRec = activeRecord(tx, otherKey, nowMs, ctx);
      if (!otherRec.ok) return otherRec;
      totalRunning += otherRec.leases.length;
      otherRecords.push({ key: otherKey, record: otherRec });
    }

    const constrained = policyRead.stored === true;
    const effectivePolicy = policyRead.policy;

    const decision = decideDispatch({
      policy: constrained ? effectivePolicy : DEFAULT_POLICY,
      observations: constrained ? observations : [],
      now: new Date(nowMs),
      running: totalRunning,
      approval: constrained ? approval : 'override'
    });
    if (!decision.allowed) {
      if (myRecord.changed) writeRecord(tx, accountKey, myRecord.leases);
      for (const other of otherRecords) {
        if (other.record.changed) writeRecord(tx, other.key, other.record.leases);
      }
      return { ok: true, decision };
    }
    if (myRecord.leases.length >= MAX_LEASES) return { ok: false, reason: 'reservation-capacity' };
    const reservation = { accountKey, id: leaseId };
    writeRecord(tx, accountKey, [...myRecord.leases, { id: leaseId, expiresAt: new Date(nowMs + leaseMs).toISOString(), ...ownerFields(ctx) }]);
    for (const other of otherRecords) {
      if (other.record.changed) writeRecord(tx, other.key, other.record.leases);
    }
    return { ok: true, decision: { ...decision, reservation } };
  });
  return outcome.ok ? outcome.value : { ok: false, reason: outcome.reason || 'store-unavailable' };
}

function renewSlot(store, reservation, now = new Date(), leaseMs = LEASE_MS, options = {}) {
  const nowMs = timeOf(now);
  const ctx = ownerContext(options);
  if (!store || typeof store.transact !== 'function' || !isPlain(reservation) || !checkedAccount(reservation.accountKey) ||
      typeof reservation.id !== 'string' || !LEASE_ID.test(reservation.id) || !Number.isFinite(nowMs) ||
      !Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 24 * 60 * 60_000) {
    return { ok: false, reason: 'reservation-input-invalid' };
  }
  const outcome = store.transact((tx) => {
    const record = activeRecord(tx, reservation.accountKey, nowMs, ctx);
    if (!record.ok) return record;
    const found = record.leases.find((lease) => lease.id === reservation.id);
    const expiresAt = new Date(nowMs + leaseMs).toISOString();
    if (!found) {
      // The record no longer has this lease although its owner is running: it was lost (storage cleared,
      // or an older build reclaimed it). The agent is still running, so the honest state is to count it
      // again, even above the limit; that blocks new launches instead of hiding a running one.
      if (options.reacquire === true) {
        if (record.leases.length >= MAX_LEASES) return { ok: false, reason: 'reservation-capacity' };
        // Its session may predate the profile's last change of account: its readings stay untrusted until it ends.
        if (!rearmSwitchLease(tx, reservation.accountKey, reservation.id)) return { ok: false, reason: 'reservation-capacity' };
        writeRecord(tx, reservation.accountKey, [...record.leases, { id: reservation.id, expiresAt, ...ownerFields(ctx) }]);
        return { ok: true, renewed: true, reacquired: true };
      }
      if (record.changed) writeRecord(tx, reservation.accountKey, record.leases);
      return { ok: true, renewed: false };
    }
    found.expiresAt = expiresAt;
    Object.assign(found, ownerFields(ctx));
    writeRecord(tx, reservation.accountKey, record.leases);
    return { ok: true, renewed: true };
  });
  return outcome.ok ? outcome.value : { ok: false, reason: outcome.reason || 'store-unavailable' };
}

function releaseSlot(store, reservation, now = new Date(), options = {}) {
  const nowMs = timeOf(now);
  const ctx = ownerContext(options);
  if (!store || typeof store.transact !== 'function' || !isPlain(reservation) || !checkedAccount(reservation.accountKey) ||
      typeof reservation.id !== 'string' || !LEASE_ID.test(reservation.id) || !Number.isFinite(nowMs)) {
    return { ok: false, reason: 'reservation-input-invalid' };
  }
  const outcome = store.transact((tx) => {
    const record = activeRecord(tx, reservation.accountKey, nowMs, ctx);
    if (!record.ok) return record;
    const remaining = record.leases.filter((lease) => lease.id !== reservation.id);
    const released = remaining.length !== record.leases.length;
    if (released || record.changed) writeRecord(tx, reservation.accountKey, remaining);
    if (released) settleSwitchLeases(tx, reservation.accountKey, [reservation.id], nowMs);
    return { ok: true, released };
  });
  return outcome.ok ? outcome.value : { ok: false, reason: outcome.reason || 'store-unavailable' };
}

module.exports = {
  COLLECTION,
  LEASE_MS,
  RENEW_MS,
  runningSlots,
  recoverOrphanedSlots,
  reserveSlot,
  renewSlot,
  releaseSlot
};
