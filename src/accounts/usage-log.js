'use strict';

const crypto = require('node:crypto');

/**
 * The token usage log (issue #294): every reading of a session's token usage that a provider really reports is kept, per
 * account, in the extension's private storage, so usage can be followed over time instead of being overwritten by the next
 * reading. Pure logic: it reads a session snapshot, validates and rotates entries, queries and exports them. Nothing here
 * reads a file, a terminal or the network.
 *
 * What is kept: time, session, provider, model, the token counts and cost the provider reported (cost only when reported),
 * whether the numbers are `actual` or a local `estimated` figure, and which source gave them. Never a prompt, a file path or a
 * credential. A provider with no source (Codex, agy today) produces no entries: its readings are unknown and are not
 * written as zeros or as estimates.
 */

const SCHEMA_VERSION = 1;
const MAX_ENTRIES_PER_ACCOUNT = 150;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RECORD_BYTES = 56 * 1024;

const FIELDS = Object.freeze({
  inputTokens: 'usage.input_tokens',
  outputTokens: 'usage.output_tokens',
  cacheReadTokens: 'usage.cache_read_tokens',
  cacheWriteTokens: 'usage.cache_write_tokens',
  costUsd: 'usage.cost_usd'
});
const TOKEN_KEYS = Object.freeze(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']);
const MEASUREMENTS = new Set(['actual', 'estimated', 'mixed']);
const SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,100}$/;
const PROVIDER = /^[a-z][a-z0-9-]{0,31}$/;
const MODEL = /^[a-z][a-z0-9._:/-]{0,127}$/i;
const SOURCE = /^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$/;

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validTime = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const count = (value) => value === null || (Number.isSafeInteger(value) && value >= 0);
const money = (value) => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 1e6);

/**
 * One log entry from a session observation snapshot (`SessionObservationRuntime.snapshot`), or null when the snapshot holds no
 * usage figure the provider really reported or a local estimate. Unknown readings are not entries.
 */
function entryFromSnapshot(snapshot) {
  if (!isPlain(snapshot) || !Array.isArray(snapshot.usage)) return null;
  const values = {};
  let at = null;
  let source = null;
  const measures = new Set();
  for (const key of Object.keys(FIELDS)) {
    const observation = snapshot.usage.find((entry) => isPlain(entry) && entry.field === FIELDS[key]);
    if (!observation || (observation.confidence !== 'actual' && observation.confidence !== 'estimated') || typeof observation.value !== 'number' || !Number.isFinite(observation.value)) {
      values[key] = null;
      continue;
    }
    values[key] = key === 'costUsd' ? observation.value : Math.round(observation.value);
    measures.add(observation.confidence);
    if (validTime(observation.observedAt) && (at === null || Date.parse(observation.observedAt) > Date.parse(at))) at = new Date(observation.observedAt).toISOString();
    if (source === null && typeof observation.source === 'string') source = observation.source.replace('.local-estimate', '');
  }
  if (measures.size === 0 || at === null) return null;
  const model = isPlain(snapshot.model) && snapshot.model.confidence === 'actual' && typeof snapshot.model.value === 'string' && MODEL.test(snapshot.model.value) ? snapshot.model.value : null;
  const entry = {
    at, sessionId: snapshot.sessionId, provider: snapshot.provider, accountProfileId: snapshot.accountProfileId, model,
    ...values, measurement: measures.size === 1 ? [...measures][0] : 'mixed', source: source && SOURCE.test(source) ? source : 'unknown'
  };
  return validateEntry(entry).ok ? validateEntry(entry).entry : null;
}

function validateEntry(raw) {
  if (!isPlain(raw)) return { ok: false };
  if (!validTime(raw.at) || typeof raw.sessionId !== 'string' || !SESSION_ID.test(raw.sessionId) || typeof raw.accountProfileId !== 'string' || !ACCOUNT_ID.test(raw.accountProfileId)) return { ok: false };
  if (typeof raw.provider !== 'string' || !PROVIDER.test(raw.provider)) return { ok: false };
  if (raw.model !== null && (typeof raw.model !== 'string' || !MODEL.test(raw.model))) return { ok: false };
  if (!TOKEN_KEYS.every((key) => count(raw[key])) || !money(raw.costUsd)) return { ok: false };
  if (!MEASUREMENTS.has(raw.measurement) || typeof raw.source !== 'string' || !(SOURCE.test(raw.source) || raw.source === 'unknown')) return { ok: false };
  if (TOKEN_KEYS.every((key) => raw[key] === null) && raw.costUsd === null) return { ok: false };
  return { ok: true, entry: Object.freeze({ at: new Date(raw.at).toISOString(), sessionId: raw.sessionId, provider: raw.provider, accountProfileId: raw.accountProfileId, model: raw.model, inputTokens: raw.inputTokens, outputTokens: raw.outputTokens, cacheReadTokens: raw.cacheReadTokens, cacheWriteTokens: raw.cacheWriteTokens, costUsd: raw.costUsd, measurement: raw.measurement, source: raw.source }) };
}

const recordId = (accountProfileId) => `u-${crypto.createHash('sha256').update(String(accountProfileId)).digest('hex').slice(0, 40)}`;
const COLLECTION = 'usageLog';
const fail = (reason) => ({ ok: false, reason });

/** Keeps the newest entries within the age and size limits. */
function rotate(entries, now) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  let kept = entries.filter((entry) => !Number.isFinite(nowMs) || nowMs - Date.parse(entry.at) <= MAX_AGE_MS).slice(-MAX_ENTRIES_PER_ACCOUNT);
  while (kept.length > 1 && Buffer.byteLength(JSON.stringify({ schemaVersion: SCHEMA_VERSION, accountProfileId: 'x'.repeat(100), entries: kept })) > MAX_RECORD_BYTES) kept = kept.slice(1);
  return kept;
}

class UsageLog {
  /** @param store a PrivateStore-shaped object (`get`, `list`, `transact`) with a `usageLog` collection */
  constructor(store) {
    if (!store || typeof store.get !== 'function' || typeof store.list !== 'function' || typeof store.transact !== 'function') throw new TypeError('private-store-required');
    this.store = store;
  }

  /**
   * Adds one entry. The same session and time twice is one entry (a reading that has not changed is not a new reading); the
   * oldest entries of the account are dropped by age and count. A failure to store is reported, never hidden.
   * @returns {{ ok: true, appended: boolean } | { ok: false, reason: string }}
   */
  append(raw, now = new Date()) {
    const checked = validateEntry(raw);
    if (!checked.ok) return fail('invalid-entry');
    const entry = checked.entry;
    const result = this.store.transact((tx) => {
      const id = recordId(entry.accountProfileId);
      const current = tx.get(COLLECTION, id);
      let entries = [];
      if (current !== null) {
        const read = readRecord(current);
        if (!read.ok) return { rejected: fail('invalid-usage-record') };
        entries = read.entries;
      }
      if (entries.some((existing) => existing.sessionId === entry.sessionId && existing.at === entry.at)) return { appended: false };
      entries = rotate([...entries, entry].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)), now);
      tx.put(COLLECTION, id, { schemaVersion: SCHEMA_VERSION, accountProfileId: entry.accountProfileId, entries });
      return { appended: true };
    });
    if (!result.ok) return fail(result.reason || 'storage-unavailable');
    if (result.value.rejected) return result.value.rejected;
    return { ok: true, appended: result.value.appended };
  }

  /**
   * Entries, newest first, optionally for one account or one session. A record that cannot be read is an error, not an empty log.
   * @returns {{ ok: true, entries: object[] } | { ok: false, reason: string }}
   */
  query({ accountProfileId, sessionId } = {}) {
    const listed = this.store.list(COLLECTION);
    if (!listed.ok) return fail(listed.reason || 'storage-unavailable');
    if (!Array.isArray(listed.items)) return fail('invalid-usage-record');
    let all = [];
    for (const item of listed.items) {
      const read = readRecord(item.value);
      if (!read.ok) return fail('invalid-usage-record');
      all = all.concat(read.entries);
    }
    if (accountProfileId !== undefined) all = all.filter((entry) => entry.accountProfileId === accountProfileId);
    if (sessionId !== undefined) all = all.filter((entry) => entry.sessionId === sessionId);
    return { ok: true, entries: all.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)) };
  }
}

function readRecord(value) {
  if (!isPlain(value) || value.schemaVersion !== SCHEMA_VERSION || !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES_PER_ACCOUNT) return { ok: false };
  const entries = [];
  for (const raw of value.entries) {
    const checked = validateEntry(raw);
    if (!checked.ok) return { ok: false };
    entries.push(checked.entry);
  }
  return { ok: true, entries };
}

/**
 * Keeps one session snapshot in the log when it holds a reported figure. Best effort, never throws: a snapshot with nothing
 * reported opens no storage at all; a store that cannot be opened or written keeps nothing and says so in the result.
 * @param {{ snapshot: unknown, openStore: () => Promise<unknown> | unknown, now?: Date }} input `openStore` resolves to a PrivateStore, or to something falsy when storage is unavailable
 * @returns {Promise<{ recorded: boolean, reason: string }>}
 */
async function recordReading({ snapshot, openStore, now = new Date() }) {
  try {
    const entry = entryFromSnapshot(snapshot);
    if (!entry) return { recorded: false, reason: 'nothing-reported' };
    const store = await openStore();
    if (!store) return { recorded: false, reason: 'storage-unavailable' };
    const result = new UsageLog(store).append(entry, now);
    return result.ok ? { recorded: result.appended, reason: result.appended ? 'recorded' : 'unchanged' } : { recorded: false, reason: result.reason };
  } catch {
    return { recorded: false, reason: 'failed' };
  }
}

const number = (value) => (value === null ? '—' : value.toLocaleString('en-US'));

/** Plain lines for the read-only log document, newest first. The unit of every figure is stated, and a missing figure is "—", never 0. */
function describeLog(entries, { labelFor = () => 'Account', providerLabel = (provider) => provider } = {}) {
  const lines = ['PRIVATE — local token usage log. Do not publish this document.', '', 'Figures are what the provider reported ("actual") or a local estimate, as marked. A dash means that figure was not reported.', ''];
  if (entries.length === 0) lines.push('No usage has been recorded yet. Only providers with a real reading source are logged; Codex and agy have none connected, so nothing is shown for them (unknown, not zero).');
  for (const entry of entries) {
    const mark = entry.measurement === 'actual' ? 'actual' : entry.measurement === 'estimated' ? 'ESTIMATE' : 'actual + estimate';
    lines.push(`${entry.at} · ${labelFor(entry.accountProfileId)} · ${providerLabel(entry.provider)} · ${entry.model ?? 'model unknown'} · input ${number(entry.inputTokens)} · output ${number(entry.outputTokens)} · cache read ${number(entry.cacheReadTokens)} · cache write ${number(entry.cacheWriteTokens)} · cost ${entry.costUsd === null ? '—' : `$${entry.costUsd.toFixed(4)}`} · ${mark} · source ${entry.source}`);
  }
  return lines;
}

const CSV_COLUMNS = ['time', 'account', 'session', 'provider', 'model', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cost_usd', 'measurement', 'source'];
const shortHash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 6);

/**
 * Masked rows for an export: accounts become `account-1`, `account-2`… in order of first appearance and sessions a short hash,
 * so neither a label, an id nor a path leaves with the file.
 */
function exportRows(entries) {
  const accounts = new Map();
  return entries.map((entry) => {
    if (!accounts.has(entry.accountProfileId)) accounts.set(entry.accountProfileId, `account-${accounts.size + 1}`);
    return {
      time: entry.at, account: accounts.get(entry.accountProfileId), session: `s-${shortHash(entry.sessionId)}`, provider: entry.provider, model: entry.model,
      input_tokens: entry.inputTokens, output_tokens: entry.outputTokens, cache_read_tokens: entry.cacheReadTokens, cache_write_tokens: entry.cacheWriteTokens,
      cost_usd: entry.costUsd, measurement: entry.measurement, source: entry.source
    };
  });
}

// A cell a spreadsheet would read as a formula is prefixed so it stays text.
const cell = (value) => {
  if (value === null || value === undefined) return '';
  const text = String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const toCsv = (rows) => [CSV_COLUMNS.join(','), ...rows.map((row) => CSV_COLUMNS.map((column) => cell(row[column])).join(','))].join('\n') + '\n';
const toJson = (rows) => `${JSON.stringify({ masked: true, rows }, null, 2)}\n`;

module.exports = { recordReading, entryFromSnapshot, validateEntry, UsageLog, rotate, describeLog, exportRows, toCsv, toJson, COLLECTION, MAX_ENTRIES_PER_ACCOUNT, MAX_AGE_MS, CSV_COLUMNS };
