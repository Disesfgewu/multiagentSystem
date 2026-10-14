'use strict';

const fs = require('node:fs');
const nodePath = require('node:path');
const crypto = require('node:crypto');
const { checkPrivateRoot, isSameOrInside, pathFor, resolvers } = require('./paths');
const { DirectoryLock, LockIoError } = require('./lock');
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
// Values that may be shown in a masked export, by field. A value is kept only if
// it is exactly one of the listed strings; nothing is kept because of its shape.
const DEFAULT_PUBLIC_VALUES = Object.freeze({
  '*': Object.freeze({
    provider: Object.freeze(['claude', 'codex']),
    status: Object.freeze(['preparing', 'running', 'waiting', 'completed', 'failed', 'unknown'])
  })
});
const TEMP_NAME = /^\.store\.\d+\.[0-9a-f]{8}\.tmp$/;
// A backup this store wrote is named exactly like this and is recorded in the
// manifest before the file is created. Matching a name proves nothing: only a
// manifest entry whose file still has the recorded content counts as ours.
const BACKUP_NAME = /^store\.v\d+\.\d{8}T\d{9}Z(?:-\d+)?\.json$/;
const MANIFEST_FILE = 'manifest.json';
const MANIFEST_FORMAT = 'multiagent-private-store-backups';
const SHA256 = /^[0-9a-f]{64}$/;
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
// Windows has no uid; its access control is the user profile's default and is
// not verified here.
const ownedByCurrentUser = (stat) => typeof process.getuid !== 'function' || stat.uid === process.getuid();

function normalizePublicValues(input) {
  const out = {};
  for (const [scope, fields] of Object.entries(input)) {
    if (!isPlainObject(fields)) throw new TypeError('publicValues must map collections to fields');
    out[scope] = {};
    for (const [field, values] of Object.entries(fields)) {
      if (!Array.isArray(values) || !values.every((value) => typeof value === 'string')) {
        throw new TypeError('publicValues fields must list exact string values');
      }
      out[scope][field] = [...values];
    }
  }
  return out;
}
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
  constructor({ dir, repoRoot, collections, schemaVersion = 1, migrations = [], publicValues = DEFAULT_PUBLIC_VALUES,
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
    this.publicValues = normalizePublicValues(publicValues);
    this.now = now;
    this.lock = new DirectoryLock(nodePath.join(dir, LOCK_FILE), lock);
    this.io = { ...defaultIo, ...io };
    this.file = nodePath.join(dir, STORE_FILE);
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
    } catch (error) {
      return {
        state: 'backup-failed',
        detail: error instanceof StoreError ? `${error.reason}:${error.detail}` : error.code || 'unknown',
        onDiskVersion
      };
    }
    try {
      this.#write(migrated);
    } catch {
      return { state: 'write-failed', onDiskVersion };
    }
    return { state: 'ok', data: migrated, onDiskVersion, migrated: true };
  }

  // The backup directory is checked at the level where it is used: it must be a
  // real directory (not a link or junction) owned by the current user, and it must
  // resolve inside the verified data directory and outside the repository. There
  // is an unavoidable window between this check and the file operation that
  // follows; it is re-checked after writing and the data directory is expected to
  // be private to the user.
  #backupDirectory(create) {
    let stat = lstatOrNull(this.backupDir);
    if (!stat) {
      if (!create) return null;
      try {
        fs.mkdirSync(this.backupDir, { mode: 0o700 });
      } catch (error) {
        throw new StoreError('backup-dir-rejected', error.code || 'unknown');
      }
      stat = fs.lstatSync(this.backupDir);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new StoreError('backup-dir-rejected', 'not-a-directory');
    if (!ownedByCurrentUser(stat)) throw new StoreError('backup-dir-rejected', 'not-owned');
    const { platform, realpath } = resolvers(this.context);
    let real;
    let base;
    try {
      real = realpath(this.backupDir);
      base = realpath(this.dir);
    } catch (error) {
      throw new StoreError('backup-dir-rejected', error.code || 'unknown');
    }
    const check = checkPrivateRoot(real, this.repoRoot, this.context);
    if (!check.ok) throw new StoreError('backup-dir-rejected', check.problems.join(','));
    if (!isSameOrInside(pathFor(platform), platform, real, base)) throw new StoreError('backup-dir-rejected', 'outside-data-dir');
    return this.backupDir;
  }

  // The manifest lists the backups this store created, with the content each had
  // when written. It is the only provenance `clear` trusts. An unreadable or
  // malformed manifest is moved aside (never overwritten) and a new one started;
  // the backups it listed then count as unrecognised and are kept.
  #readManifest(dir) {
    const file = nodePath.join(dir, MANIFEST_FILE);
    const stat = lstatOrNull(file);
    if (!stat) return { state: 'none', entries: [] };
    if (stat.isSymbolicLink() || !stat.isFile() || !ownedByCurrentUser(stat)) return { state: 'invalid', entries: [] };
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return { state: 'invalid', entries: [] };
    }
    const valid = isPlainObject(data) && data.format === MANIFEST_FORMAT && Array.isArray(data.entries) &&
      data.entries.every((entry) => isPlainObject(entry) && BACKUP_NAME.test(entry.name || '') &&
        SHA256.test(entry.sha256 || '') && Number.isInteger(entry.bytes) && entry.bytes >= 0) &&
      new Set(data.entries.map((entry) => entry.name)).size === data.entries.length;
    return valid ? { state: 'ok', entries: data.entries } : { state: 'invalid', entries: [] };
  }

  #writeManifest(dir, entries) {
    const temp = nodePath.join(dir, `.manifest.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    try {
      this.io.writeFile(temp, JSON.stringify({ format: MANIFEST_FORMAT, entries }, null, 2));
      this.io.rename(temp, nodePath.join(dir, MANIFEST_FILE));
    } catch (error) {
      try {
        fs.unlinkSync(temp);
      } catch {
        // Nothing was created.
      }
      throw error;
    }
  }

  #setAsideManifest(dir) {
    const file = nodePath.join(dir, MANIFEST_FILE);
    const stamp = new Date(this.now()).toISOString().replace(/[-:.]/g, '');
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const target = nodePath.join(dir, `manifest.invalid.${stamp}${attempt === 0 ? '' : `-${attempt}`}.json`);
      if (lstatOrNull(target)) continue;
      fs.renameSync(file, target);
      return;
    }
    throw new Error('manifest-name-exhausted');
  }

  #backup(text, version) {
    const dir = this.#backupDirectory(true);
    let manifest = this.#readManifest(dir);
    if (manifest.state === 'invalid') {
      this.#setAsideManifest(dir);
      manifest = { state: 'none', entries: [] };
    }
    const sha256 = crypto.createHash('sha256').update(text).digest('hex');
    const bytes = Buffer.byteLength(text);
    const stamp = new Date(this.now()).toISOString().replace(/[-:.]/g, '');
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const name = `store.v${version}.${stamp}${attempt === 0 ? '' : `-${attempt}`}.json`;
      const target = nodePath.join(dir, name);
      if (lstatOrNull(target) || manifest.entries.some((entry) => entry.name === name)) continue;

      // Record the intent first. A crash between the two steps leaves an entry
      // without a file, which is harmless; the other order would leave a backup
      // nobody can prove is ours.
      const entry = { name, sha256, bytes, fromVersion: version, createdAt: new Date(this.now()).toISOString() };
      this.#writeManifest(dir, [...manifest.entries, entry]);
      try {
        this.io.writeFile(target, text);
        this.#backupDirectory(false);
      } catch (error) {
        try {
          if (lstatOrNull(target)) fs.unlinkSync(target);
        } catch {
          // Best effort: the file was created by this call a moment ago.
        }
        try {
          this.#writeManifest(dir, manifest.entries);
        } catch {
          // The stray entry has no file and is ignored by clear.
        }
        if (error.code === 'EEXIST') continue;
        throw error;
      }
      return name;
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

  // The single-writer lock is advisory and per directory (see lock.js). It is
  // never taken from a writer that might still be running: a held lock makes the
  // call return `locked` with who seems to hold it, and a person (or the product,
  // on request) clears a dead holder with `recoverLock`.
  #lock() {
    // Check before creating anything, so a link into the repository cannot cause
    // directories to be created there, then again once the directory exists.
    const before = checkPrivateRoot(this.dir, this.repoRoot, this.context);
    if (!before.ok) throw new StoreError('directory-rejected', before.problems.join(','));
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new StoreError('directory-rejected', error.code || 'unknown');
    }
    this.#assertDirectory();
    let got;
    try {
      got = this.lock.acquire();
    } catch (error) {
      if (error instanceof LockIoError) throw new StoreError('lock-failed', error.code);
      throw error;
    }
    if (!got.ok) throw new StoreError('locked', got.detail);
    return got.token;
  }

  #release(token) {
    this.lock.release(token);
  }

  inspectLock() {
    try {
      const { held, detail, ageMs, stale } = this.lock.inspect();
      return held ? { ok: true, held, detail, ageMs, stale } : { ok: true, held: false };
    } catch (error) {
      if (error instanceof LockIoError) return { ok: false, reason: 'lock-failed', detail: error.code };
      throw error;
    }
  }

  // Clears a lock whose owner is provably gone. `force` is for a stale lock whose
  // owner a program cannot judge (another host, unreadable, or a reused process
  // id); it still requires the lock to be older than the stale age.
  recoverLock(options) {
    try {
      const result = this.lock.recover(options);
      const { text, ...rest } = result;
      return rest;
    } catch (error) {
      if (error instanceof LockIoError) return { ok: false, reason: 'lock-failed', detail: error.code };
      throw error;
    }
  }

  // The directory may have been replaced by a link since construction.
  #assertDirectory() {
    const check = checkPrivateRoot(this.dir, this.repoRoot, this.context);
    if (!check.ok) throw new StoreError('directory-rejected', check.problems.join(','));
    let stat;
    try {
      stat = fs.statSync(this.dir);
    } catch (error) {
      throw new StoreError('directory-rejected', error.code || 'unknown');
    }
    if (!stat.isDirectory()) throw new StoreError('directory-rejected', 'not-a-directory');
    if (!ownedByCurrentUser(stat)) throw new StoreError('directory-rejected', 'not-owned');
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
      if (!TEMP_NAME.test(name)) continue;
      const target = nodePath.join(this.dir, name);
      try {
        const stat = fs.lstatSync(target);
        if (stat.isFile() && ownedByCurrentUser(stat) && Date.now() - stat.mtimeMs > this.lock.options.staleMs) {
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
      token = this.#lock();
    } catch (error) {
      if (error instanceof StoreError) return { ok: false, reason: error.reason, detail: error.detail };
      throw error;
    }
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
      token = this.#lock();
    } catch (error) {
      if (error instanceof StoreError) return { ok: false, reason: error.reason, detail: error.detail };
      throw error;
    }
    try {
      // Verify everything that will be touched before deleting anything.
      const backupDir = includeBackups ? this.#backupDirectory(false) : null;
      const removed = { store: false, backups: 0, temps: 0 };
      const kept = {};
      const keep = (reason) => { kept[reason] = (kept[reason] || 0) + 1; };

      if (lstatOrNull(this.file)) {
        fs.unlinkSync(this.file);
        removed.store = true;
      }
      for (const name of fs.readdirSync(this.dir)) {
        if (!TEMP_NAME.test(name)) continue;
        const target = nodePath.join(this.dir, name);
        const stat = fs.lstatSync(target);
        if (stat.isFile() && ownedByCurrentUser(stat)) {
          fs.unlinkSync(target);
          removed.temps += 1;
        }
      }

      if (backupDir) {
        // Provenance: a backup is deleted only if the manifest lists it, it is a
        // regular file owned by this user, and its content is exactly what was
        // recorded. Everything else in the directory, however it is named, is
        // someone else's or unproven, and is kept and counted by reason.
        const manifest = this.#readManifest(backupDir);
        const listed = new Map(manifest.entries.map((entry) => [entry.name, entry]));
        const survivors = [];
        for (const entry of manifest.entries) {
          const target = nodePath.join(backupDir, entry.name);
          const stat = lstatOrNull(target);
          if (!stat) continue;                                  // intent without a file
          let verdict = null;
          if (stat.isSymbolicLink() || !stat.isFile()) verdict = 'not-regular';
          else if (!ownedByCurrentUser(stat)) verdict = 'not-owned';
          else if (stat.size !== entry.bytes) verdict = 'modified';
          else if (crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') !== entry.sha256) verdict = 'modified';
          if (verdict) {
            keep(verdict);
            survivors.push(entry);
          } else {
            fs.unlinkSync(target);
            removed.backups += 1;
          }
        }
        for (const name of fs.readdirSync(backupDir)) {
          if (name === MANIFEST_FILE || listed.has(name) || /^\.manifest\.\d+\.[0-9a-f]{8}\.tmp$/.test(name)) continue;
          keep(manifest.state === 'invalid' && /^manifest(\.invalid\..+)?\.json$/.test(name) ? 'manifest-unverified' : 'unrecognized');
        }
        if (manifest.state === 'invalid') keep('manifest-unverified');
        if (manifest.state === 'ok') {
          if (survivors.length > 0) this.#writeManifest(backupDir, survivors);
          else fs.unlinkSync(nodePath.join(backupDir, MANIFEST_FILE));
        }
        try {
          fs.rmdirSync(backupDir);
        } catch {
          // Not empty: it holds something this store does not own or cannot prove.
        }
      }
      removed.kept = kept;
      return { ok: true, removed };
    } catch (error) {
      if (error instanceof StoreError) return { ok: false, reason: error.reason, detail: error.detail };
      return { ok: false, reason: 'clear-failed', detail: error.code || 'unknown' };
    } finally {
      this.#release(token);
    }
  }

  // Structure only: ids become aliases, nested values are summarised, and every
  // value is replaced by a type placeholder unless the field has a fixed list of
  // public values and the value is exactly one of them. Matching a pattern is
  // never enough, because an account or agent label can look like an enumeration.
  exportMasked() {
    const loaded = this.#load(false);
    if (loaded.state !== 'ok') return { ok: false, reason: 'store-unavailable', detail: loaded.state };
    const out = {};
    for (const name of this.names) {
      const allow = { ...this.publicValues['*'], ...this.publicValues[name] };
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
    if (typeof value === 'string' && Object.hasOwn(allow, key) && allow[key].includes(value)) {
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
  DEFAULT_PUBLIC_VALUES
};
