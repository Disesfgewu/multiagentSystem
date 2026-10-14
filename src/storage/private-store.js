'use strict';

const fs = require('node:fs');
const nodePath = require('node:path');
const crypto = require('node:crypto');
const { checkPrivateRoot } = require('./paths');
const { findSecrets } = require('./sensitive');

const FORMAT = 'multiagent-private-store';
const STORE_FILE = 'store.json';
const LOCK_FILE = 'store.lock';
const BACKUP_DIR = 'backups';
const CONFIRM_CLEAR = 'delete-private-data';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const RESERVED_IDS = new Set(['constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']);
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_STORE_BYTES = 8 * 1024 * 1024;
const DEFAULT_LOCK = Object.freeze({ retries: 100, waitMs: 20, staleMs: 30000 });
const DEFAULT_PUBLIC_FIELDS = Object.freeze(['provider', 'role', 'kind', 'status', 'layer', 'type', 'method']);
const SAFE_ENUM = /^[a-z][a-z0-9_.-]{0,40}$/;
const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;

// An expected, recoverable failure inside a transaction. The transaction is
// abandoned and nothing is written.
class StoreError extends Error {
  constructor(reason, detail) {
    super(reason);
    this.reason = reason;
    this.detail = detail ?? null;
  }
}

const defaultIo = Object.freeze({
  writeFile(file, text) {
    const descriptor = fs.openSync(file, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, text);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  },
  rename: (from, to) => fs.renameSync(from, to),
  unlink: (target) => fs.unlinkSync(target),
  syncDir(dir) {
    try {
      const descriptor = fs.openSync(dir, 'r');
      try {
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
    } catch {
      // Directories cannot be opened for sync on every platform.
    }
  }
});

const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const clone = (value) => structuredClone(value);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const lstatOrNull = (target) => {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

function validIdentifier(id) {
  return typeof id === 'string' && ID_PATTERN.test(id) && !RESERVED_IDS.has(id);
}

// Structural validation shared by files read from disk and migration output.
// Returns a problem code or null; never includes any value.
function validateEnvelope(data, names, { checkSecrets }) {
  if (!isPlainObject(data) || data.format !== FORMAT) return 'invalid-envelope';
  if (!Number.isInteger(data.schemaVersion) || data.schemaVersion < 1) return 'invalid-version';
  if (!isPlainObject(data.collections)) return 'invalid-collections';
  for (const [name, records] of Object.entries(data.collections)) {
    if (!names.includes(name)) return 'unknown-collection';
    if (!isPlainObject(records)) return 'invalid-collection';
    for (const [id, record] of Object.entries(records)) {
      if (!validIdentifier(id)) return 'invalid-id';
      if (!isPlainObject(record)) return 'invalid-record';
      if (Buffer.byteLength(JSON.stringify(record)) > MAX_RECORD_BYTES) return 'record-too-large';
    }
  }
  if (checkSecrets && findSecrets(data.collections).length > 0) return 'secret-in-data';
  return null;
}

class PrivateStore {
  constructor({ dir, repoRoot, collections, schemaVersion = 1, migrations = [], publicFields = {},
    now = () => Date.now(), context, lock, io } = {}) {
    if (!Array.isArray(collections) || collections.length === 0 || !collections.every(validIdentifier)) {
      throw new TypeError('collections must be a non-empty list of identifiers');
    }
    if (!Number.isInteger(schemaVersion) || schemaVersion < 1) throw new TypeError('invalid schemaVersion');

    const byFrom = new Map();
    for (const step of migrations) {
      const ok = step && Number.isInteger(step.from) && step.to === step.from + 1 && typeof step.up === 'function';
      if (!ok || byFrom.has(step.from)) throw new TypeError('migrations must be unique steps from n to n+1');
      byFrom.set(step.from, step);
    }
    for (let version = 1; version < schemaVersion; version += 1) {
      if (!byFrom.has(version)) throw new TypeError(`missing migration from version ${version}`);
    }

    const check = checkPrivateRoot(dir, repoRoot, context);
    if (!check.ok) {
      const error = new Error(`storage directory rejected: ${check.problems.join(', ')}`);
      error.problems = check.problems;
      throw error;
    }

    this.dir = dir;
    this.repoRoot = repoRoot;
    this.context = context;
    this.names = [...collections];
    this.schemaVersion = schemaVersion;
    this.migrations = byFrom;
    this.publicFields = publicFields;
    this.now = now;
    this.lockOptions = { ...DEFAULT_LOCK, ...lock };
    this.io = { ...defaultIo, ...io };
    this.file = nodePath.join(dir, STORE_FILE);
    this.lockFile = nodePath.join(dir, LOCK_FILE);
    this.backupDir = nodePath.join(dir, BACKUP_DIR);
  }

  // ---- reading --------------------------------------------------------------

  #empty() {
    return {
      format: FORMAT,
      schemaVersion: this.schemaVersion,
      updatedAt: null,
      collections: Object.fromEntries(this.names.map((name) => [name, {}]))
    };
  }

  #normalize(data) {
    for (const name of this.names) if (!data.collections[name]) data.collections[name] = {};
    return data;
  }

  #runMigrations(data) {
    let current = data;
    for (let version = data.schemaVersion; version < this.schemaVersion; version += 1) {
      const step = this.migrations.get(version);
      let next;
      try {
        next = step.up(clone(current));
      } catch {
        throw new StoreError('migration-failed', `step ${step.from}->${step.to}: threw`);
      }
      if (isPlainObject(next)) next.schemaVersion = step.to;
      const problem = validateEnvelope(next, this.names, { checkSecrets: true });
      if (problem) throw new StoreError('migration-failed', `step ${step.from}->${step.to}: ${problem}`);
      current = next;
    }
    return current;
  }

  // Returns the parsed data, or a state that says why it is not usable. A file
  // that cannot be used is never treated as empty and never overwritten.
  // `persist` additionally writes a pending migration (after a backup).
  #load(persist) {
    let stat;
    try {
      stat = lstatOrNull(this.file);
    } catch {
      return { state: 'unreadable' };
    }
    if (!stat) return { state: 'ok', data: this.#empty(), onDiskVersion: null };
    if (stat.isSymbolicLink() || !stat.isFile()) return { state: 'unsafe-path' };

    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return { state: 'unreadable' };
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { state: 'corrupt', detail: 'invalid-json' };
    }
    if (isPlainObject(data) && Number.isInteger(data.schemaVersion) && data.schemaVersion > this.schemaVersion) {
      return { state: 'unsupported-schema', detail: 'newer-version', onDiskVersion: data.schemaVersion };
    }
    const problem = validateEnvelope(data, this.names, { checkSecrets: false });
    if (problem) return { state: 'corrupt', detail: problem };

    const onDiskVersion = data.schemaVersion;
    if (onDiskVersion === this.schemaVersion) return { state: 'ok', data: this.#normalize(data), onDiskVersion };

    let migrated;
    try {
      migrated = this.#normalize(this.#runMigrations(data));
    } catch (error) {
      if (error instanceof StoreError) return { state: 'migration-failed', detail: error.detail, onDiskVersion };
      throw error;
    }
    if (!persist) return { state: 'ok', data: migrated, onDiskVersion, pendingMigration: true };

    try {
      this.#backup(text, onDiskVersion);
    } catch {
      return { state: 'backup-failed', onDiskVersion };
    }
    try {
      this.#write(migrated);
    } catch {
      return { state: 'write-failed', onDiskVersion };
    }
    return { state: 'ok', data: migrated, onDiskVersion, migrated: true };
  }

  #backup(text, version) {
    fs.mkdirSync(this.backupDir, { recursive: true, mode: 0o700 });
    const stamp = new Date(this.now()).toISOString().replace(/[-:.]/g, '');
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const name = `store.v${version}.${stamp}${attempt === 0 ? '' : `-${attempt}`}.json`;
      try {
        this.io.writeFile(nodePath.join(this.backupDir, name), text);
        return name;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    throw new Error('backup-name-exhausted');
  }

  status() {
    const loaded = this.#load(false);
    const result = {
      ok: loaded.state === 'ok',
      reason: loaded.state === 'ok' ? null : loaded.state,
      detail: loaded.detail ?? null,
      schemaVersion: this.schemaVersion,
      onDiskVersion: loaded.onDiskVersion ?? null,
      pendingMigration: Boolean(loaded.pendingMigration)
    };
    if (process.platform !== 'win32') {
      try {
        result.looseFileMode = (fs.statSync(this.file).mode & 0o077) !== 0;
      } catch {
        result.looseFileMode = false;
      }
    }
    return result;
  }

  get(collection, id) {
    if (!this.names.includes(collection)) return { ok: false, reason: 'unknown-collection' };
    const loaded = this.#load(false);
    if (loaded.state !== 'ok') return { ok: false, reason: 'store-unavailable', detail: loaded.state };
    const records = loaded.data.collections[collection];
    if (!validIdentifier(id) || !Object.hasOwn(records, id)) return { ok: true, found: false, value: null };
    return { ok: true, found: true, value: clone(records[id]) };
  }

  list(collection) {
    if (!this.names.includes(collection)) return { ok: false, reason: 'unknown-collection', items: [] };
    const loaded = this.#load(false);
    if (loaded.state !== 'ok') return { ok: false, reason: 'store-unavailable', detail: loaded.state, items: [] };
    const records = loaded.data.collections[collection];
    const items = Object.keys(records).sort().map((id) => ({ id, value: clone(records[id]) }));
    return { ok: true, items };
  }

  // ---- locking and writing --------------------------------------------------

  // The lock is advisory and per directory. It does not protect against a
  // process that ignores it or against network file systems, and recovery of a
  // stale lock is best effort: a holder that stalls past `staleMs` can lose it.
  #acquire() {
    const { retries, waitMs, staleMs } = this.lockOptions;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.#assertDirectory();
    const token = crypto.randomBytes(8).toString('hex');
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const descriptor = fs.openSync(this.lockFile, 'wx', 0o600);
        fs.writeSync(descriptor, `${token}\n`);
        fs.closeSync(descriptor);
        return token;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const stat = fs.statSync(this.lockFile);
          if (Date.now() - stat.mtimeMs > staleMs) {
            const again = fs.statSync(this.lockFile);
            if (again.mtimeMs === stat.mtimeMs && again.ino === stat.ino) fs.unlinkSync(this.lockFile);
            continue;
          }
        } catch {
          continue;
        }
        sleep(waitMs);
      }
    }
    return null;
  }

  #release(token) {
    try {
      if (fs.readFileSync(this.lockFile, 'utf8').trim() === token) fs.unlinkSync(this.lockFile);
    } catch {
      // Already removed or taken over as stale; never delete someone else's lock.
    }
  }

  // The directory may have been replaced by a link since construction.
  #assertDirectory() {
    const check = checkPrivateRoot(this.dir, this.repoRoot, this.context);
    if (!check.ok) throw new StoreError('directory-rejected', check.problems.join(','));
    const stat = lstatOrNull(this.dir);
    if (stat && !stat.isDirectory() && !stat.isSymbolicLink()) throw new StoreError('directory-rejected', 'not-a-directory');
  }

  #write(data) {
    const next = { ...data, updatedAt: new Date(this.now()).toISOString() };
    const text = JSON.stringify(next, null, 2);
    if (Buffer.byteLength(text) > MAX_STORE_BYTES) throw new StoreError('store-too-large');
    const temp = nodePath.join(this.dir, `.store.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    let wrote = false;
    try {
      this.io.writeFile(temp, text);
      wrote = true;
      let lastError;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          this.io.rename(temp, this.file);
          lastError = null;
          break;
        } catch (error) {
          // Windows can briefly refuse a rename while a reader has the file open.
          if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
          lastError = error;
          sleep(20);
        }
      }
      if (lastError) throw lastError;
      this.io.syncDir(this.dir);
    } catch (error) {
      if (wrote || lstatOrNull(temp)) {
        try {
          this.io.unlink(temp);
        } catch {
          // Best effort; stale temp files are swept on the next write.
        }
      }
      throw error;
    }
  }

  #sweepTemps() {
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      if (!/^\.store\.\d+\.[0-9a-f]{8}\.tmp$/.test(name)) continue;
      const target = nodePath.join(this.dir, name);
      try {
        if (Date.now() - fs.statSync(target).mtimeMs > this.lockOptions.staleMs) {
          fs.unlinkSync(target);
          removed += 1;
        }
      } catch {
        // Gone already.
      }
    }
    return removed;
  }

  // All-or-nothing. `work` receives a synchronous view; any StoreError thrown by
  // it (or by `tx.put`) abandons the transaction and nothing is written. Other
  // errors are the caller's own and propagate after the lock is released.
  transact(work) {
    if (typeof work !== 'function') throw new TypeError('transact requires a function');
    let token;
    try {
      token = this.#acquire();
    } catch (error) {
      if (error instanceof StoreError) return { ok: false, reason: error.reason, detail: error.detail };
      throw error;
    }
    if (!token) return { ok: false, reason: 'locked' };
    try {
      this.#sweepTemps();
      const loaded = this.#load(true);
      if (loaded.state !== 'ok') {
        return { ok: false, reason: 'store-unavailable', detail: loaded.state, migration: loaded.detail ?? null };
      }
      const working = clone(loaded.data);
      let changed = false;
      const records = (collection) => {
        if (!this.names.includes(collection)) throw new StoreError('unknown-collection');
        return working.collections[collection];
      };
      const tx = {
        get: (collection, id) => {
          const all = records(collection);
          return validIdentifier(id) && Object.hasOwn(all, id) ? clone(all[id]) : null;
        },
        list: (collection) => {
          const all = records(collection);
          return Object.keys(all).sort().map((id) => ({ id, value: clone(all[id]) }));
        },
        put: (collection, id, value) => {
          const all = records(collection);
          if (!validIdentifier(id)) throw new StoreError('invalid-id');
          if (!isPlainObject(value)) throw new StoreError('invalid-record');
          let size;
          try {
            size = Buffer.byteLength(JSON.stringify(value));
          } catch {
            throw new StoreError('invalid-record', 'not-serializable');
          }
          if (size > MAX_RECORD_BYTES) throw new StoreError('record-too-large');
          const secrets = findSecrets(value);
          if (secrets.length > 0) {
            throw new StoreError('secret-detected', secrets.map((entry) => `${entry.code}@${entry.path || '(value)'}`).join(','));
          }
          all[id] = clone(value);
          changed = true;
        },
        delete: (collection, id) => {
          const all = records(collection);
          if (!validIdentifier(id) || !Object.hasOwn(all, id)) return false;
          delete all[id];
          changed = true;
          return true;
        }
      };

      let value;
      try {
        value = work(tx);
      } catch (error) {
        if (error instanceof StoreError) return { ok: false, reason: error.reason, detail: error.detail };
        throw error;
      }
      if (value && typeof value.then === 'function') return { ok: false, reason: 'async-transaction' };
      if (!changed) return { ok: true, value, changed: false };

      try {
        this.#write(working);
      } catch (error) {
        if (error instanceof StoreError) return { ok: false, reason: error.reason, detail: error.detail };
        return { ok: false, reason: 'write-failed', detail: error.code || 'unknown' };
      }
      return { ok: true, value, changed: true };
    } finally {
      this.#release(token);
    }
  }

  put(collection, id, value) {
    return this.transact((tx) => tx.put(collection, id, value));
  }

  delete(collection, id) {
    const outcome = this.transact((tx) => tx.delete(collection, id));
    return outcome.ok ? { ok: true, deleted: outcome.value } : outcome;
  }

  // Applies a pending migration now (after a backup) instead of on first write.
  migrate() {
    const outcome = this.transact(() => undefined);
    if (!outcome.ok) return outcome;
    return { ok: true, onDiskVersion: this.status().onDiskVersion };
  }

  // ---- clearing and export --------------------------------------------------

  // Removes only files this store owns. It works on a corrupt or unsupported
  // store, which is the recovery path when the data cannot be used.
  clear({ confirm, includeBackups = true } = {}) {
    if (confirm !== CONFIRM_CLEAR) return { ok: false, reason: 'confirmation-required' };
    let token;
    try {
      token = this.#acquire();
    } catch (error) {
      if (error instanceof StoreError) return { ok: false, reason: error.reason, detail: error.detail };
      throw error;
    }
    if (!token) return { ok: false, reason: 'locked' };
    try {
      const removed = { store: false, backups: 0, temps: 0 };
      if (lstatOrNull(this.file)) {
        fs.unlinkSync(this.file);
        removed.store = true;
      }
      for (const name of fs.readdirSync(this.dir)) {
        if (/^\.store\.\d+\.[0-9a-f]{8}\.tmp$/.test(name)) {
          fs.unlinkSync(nodePath.join(this.dir, name));
          removed.temps += 1;
        }
      }
      if (includeBackups && lstatOrNull(this.backupDir)) {
        for (const name of fs.readdirSync(this.backupDir)) {
          if (!/^store\.v\d+\..+\.json$/.test(name)) continue;
          fs.unlinkSync(nodePath.join(this.backupDir, name));
          removed.backups += 1;
        }
        try {
          fs.rmdirSync(this.backupDir);
        } catch {
          // Not empty: it holds something this store does not own.
        }
      }
      return { ok: true, removed };
    } finally {
      this.#release(token);
    }
  }

  // Structure only: ids become aliases, nested values are summarised, and every
  // value is replaced by a type placeholder unless its field is on the public
  // allow-list and the value is a short lower-case enumeration.
  exportMasked() {
    const loaded = this.#load(false);
    if (loaded.state !== 'ok') return { ok: false, reason: 'store-unavailable', detail: loaded.state };
    const out = {};
    for (const name of this.names) {
      const allow = new Set(this.publicFields[name] || DEFAULT_PUBLIC_FIELDS);
      const ids = Object.keys(loaded.data.collections[name]).sort();
      out[name] = {
        count: ids.length,
        records: ids.map((id, index) => ({
          alias: `${name}#${index + 1}`,
          fields: maskRecord(loaded.data.collections[name][id], allow)
        }))
      };
    }
    return {
      ok: true,
      export: {
        format: `${FORMAT}-masked`,
        schemaVersion: this.schemaVersion,
        exportedAt: new Date(this.now()).toISOString(),
        note: 'Identifiers, values and nested keys are masked. This export is for diagnostics, not backup.',
        collections: out
      }
    };
  }
}

function maskRecord(record, allow) {
  const fields = {};
  let unnamed = 0;
  for (const [key, value] of Object.entries(record)) {
    const name = SAFE_KEY.test(key) ? key : `field#${(unnamed += 1)}`;
    if (allow.has(key) && typeof value === 'string' && SAFE_ENUM.test(value) && findSecrets(value).length === 0) {
      fields[name] = value;
    } else if (Array.isArray(value)) {
      fields[name] = `<array:${value.length}>`;
    } else if (value === null) {
      fields[name] = null;
    } else if (typeof value === 'object') {
      fields[name] = `<object:${Object.keys(value).length}>`;
    } else {
      fields[name] = `<${typeof value}>`;
    }
  }
  return fields;
}

module.exports = {
  PrivateStore,
  StoreError,
  FORMAT,
  STORE_FILE,
  CONFIRM_CLEAR,
  MAX_RECORD_BYTES,
  MAX_STORE_BYTES,
  DEFAULT_PUBLIC_FIELDS
};
