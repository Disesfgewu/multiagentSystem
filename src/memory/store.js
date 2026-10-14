'use strict';

const fs = require('node:fs');
const nodePath = require('node:path');
const crypto = require('node:crypto');
const { checkPrivateRoot } = require('./paths');
const { DirectoryLock, LockIoError } = require('../shared/lock');
const { scanSensitive } = require('./sensitive');
const { flatten, MIN_MATCHABLE_CHARS } = require('./text');

const SCHEMA_VERSION = 1;
const MAX_CONTENT_CHARS = 2000;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const normalize = (text) => text.toLowerCase().replace(/\s+/g, ' ').trim();

// Latin words as words; CJK runs as character bigrams so Chinese task text can
// still be matched without a tokenizer dependency.
function tokens(text) {
  const out = new Set();
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue;
    if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u.test(word)) {
      if (word.length === 1) out.add(word);
      for (let i = 0; i < word.length - 1; i += 1) out.add(word.slice(i, i + 2));
    } else {
      out.add(word);
    }
  }
  return out;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Windows has no uid; its access control is the user profile's default and is
// not verified here.
const ownedByCurrentUser = (stat) => typeof process.getuid !== 'function' || stat.uid === process.getuid();

class MemoryStore {
  constructor({ dir, repoRoot, now = () => Date.now(), context, lock } = {}) {
    const check = checkPrivateRoot(dir, repoRoot, context);
    if (!check.ok) {
      const error = new Error(`memory directory rejected: ${check.problems.join(', ')}`);
      error.problems = check.problems;
      throw error;
    }
    this.dir = dir;
    this.repoRoot = repoRoot;
    this.context = context;
    this.file = nodePath.join(dir, 'memory.json');
    this.now = now;
    this.lock = new DirectoryLock(nodePath.join(dir, 'memory.lock'), lock);
  }

  // The directory was checked when the store was built, but it can be replaced
  // later (for example by a link into the repository). It is checked again on
  // every read and write, and the file itself must be a regular file, not a link.
  // There is an unavoidable window between this check and the operation that
  // follows; the directory is expected to be private to the user.
  #directoryProblem() {
    const check = checkPrivateRoot(this.dir, this.repoRoot, this.context);
    if (!check.ok) return check.problems.join(',');
    let stat;
    try {
      stat = fs.statSync(this.dir);
    } catch (error) {
      return error.code === 'ENOENT' ? null : error.code || 'unknown';
    }
    if (!stat.isDirectory()) return 'not-a-directory';
    if (!ownedByCurrentUser(stat)) return 'not-owned';
    return null;
  }

  // The file on disk is the only source of truth and is read fresh on every
  // call, so a second instance or process never works from a stale copy. A file
  // that cannot be parsed or has another schema version is reported, never
  // treated as empty, and is never overwritten.
  #read() {
    const problem = this.#directoryProblem();
    if (problem) return { state: 'unsafe-path', detail: problem, items: [] };
    let text;
    try {
      const stat = fs.lstatSync(this.file);
      if (stat.isSymbolicLink() || !stat.isFile()) return { state: 'unsafe-path', detail: 'not-a-regular-file', items: [] };
      text = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { state: 'ok', items: [] };
      return { state: 'unreadable', items: [] };
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { state: 'corrupt', items: [] };
    }
    if (!data || data.schemaVersion !== SCHEMA_VERSION || !Array.isArray(data.items)) {
      return { state: 'unsupported-schema', items: [] };
    }
    return { state: 'ok', items: data.items };
  }

  status() {
    const { state } = this.#read();
    return { ok: state === 'ok', reason: state === 'ok' ? null : state };
  }

  // The single-writer lock is advisory and per directory (see src/shared/lock.js). It is
  // never taken from a writer that might still be running: a held lock makes the
  // call return `locked` with who seems to hold it, and a dead holder is cleared
  // only by an explicit `recoverLock`.
  #lock() {
    // Check before creating anything, so a link into the repository cannot cause
    // directories to be created there, then again once the directory exists.
    const before = checkPrivateRoot(this.dir, this.repoRoot, this.context);
    if (!before.ok) return { ok: false, reason: 'directory-rejected', detail: before.problems.join(',') };
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    } catch (error) {
      return { ok: false, reason: 'directory-rejected', detail: error.code || 'unknown' };
    }
    const problem = this.#directoryProblem();
    if (problem) return { ok: false, reason: 'directory-rejected', detail: problem };
    let got;
    try {
      got = this.lock.acquire();
    } catch (error) {
      if (error instanceof LockIoError) return { ok: false, reason: 'lock-failed', detail: error.code };
      throw error;
    }
    return got.ok ? { ok: true, token: got.token } : { ok: false, reason: 'locked', detail: got.detail };
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
      const { text, ...rest } = this.lock.recover(options);
      return rest;
    } catch (error) {
      if (error instanceof LockIoError) return { ok: false, reason: 'lock-failed', detail: error.code };
      throw error;
    }
  }

  // One writer at a time, always re-reading inside the lock, then a temp file
  // plus rename so a crash never leaves a half-written memory file.
  #mutate(apply) {
    const lock = this.#lock();
    if (!lock.ok) return lock;
    try {
      const current = this.#read();
      if (current.state !== 'ok') return { ok: false, reason: 'store-unavailable', detail: current.state };
      const outcome = apply(current.items);
      if (outcome.changed) this.#write(current.items);
      return outcome.result;
    } finally {
      this.lock.release(lock.token);
    }
  }

  #write(items) {
    const temp = nodePath.join(this.dir, `.memory.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    fs.writeFileSync(temp, JSON.stringify({ schemaVersion: SCHEMA_VERSION, items }, null, 2), { mode: 0o600 });
    let lastError;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        fs.renameSync(temp, this.file);
        return;
      } catch (error) {
        // Windows can briefly refuse a rename while a reader has the file open.
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
        lastError = error;
        sleep(20);
      }
    }
    fs.rmSync(temp, { force: true });
    throw lastError;
  }

  list() {
    return this.#read().items.map((item) => ({ ...item }));
  }

  // New items always start as unreviewed candidates. Anything matching a secret
  // pattern is refused outright and nothing about its content is stored. Items
  // too short to be matched reliably in outgoing text are refused as well.
  propose(input) {
    const content = typeof input.content === 'string' ? input.content.trim() : '';
    const missing = ['repoId', 'roleGroupId', 'privacyDomain'].filter((key) => !input[key]);
    if (missing.length > 0 || !input.source || !input.source.ref) {
      return { ok: false, reason: 'missing-fields', fields: [...missing, ...(input.source && input.source.ref ? [] : ['source.ref'])] };
    }
    if (content === '' || content.length > MAX_CONTENT_CHARS) return { ok: false, reason: 'invalid-length' };
    if (flatten(content).length < MIN_MATCHABLE_CHARS) return { ok: false, reason: 'too-short' };

    const findings = scanSensitive(content);
    if (findings.length > 0) return { ok: false, reason: 'sensitive-content', findings };

    return this.#mutate((items) => {
      const same = (item) => item.repoId === input.repoId && item.roleGroupId === input.roleGroupId &&
        item.privacyDomain === input.privacyDomain && item.status !== 'rejected' &&
        normalize(item.content) === normalize(content);
      const duplicate = items.find(same);
      if (duplicate) return { changed: false, result: { ok: false, reason: 'duplicate', duplicateOf: duplicate.id } };

      const item = {
        id: `mem_${crypto.randomBytes(6).toString('hex')}`,
        repoId: input.repoId,
        roleGroupId: input.roleGroupId,
        privacyDomain: input.privacyDomain,
        content,
        source: { kind: input.source.kind || 'task', ref: input.source.ref, digest: input.source.digest || null },
        createdAt: new Date(this.now()).toISOString(),
        verifiedAt: null,
        ttlMs: Number.isFinite(input.ttlMs) ? input.ttlMs : DEFAULT_TTL_MS,
        sensitivity: 'normal',
        status: 'candidate',
        approvedBy: null,
        version: 1
      };
      items.push(item);
      return { changed: true, result: { ok: true, id: item.id } };
    });
  }

  // Adoption is the only path into retrieval and requires a named approver
  // (a person or a rule id); a bare boolean is not accepted.
  adopt(id, approvedBy) {
    if (!approvedBy || !['human', 'rule'].includes(approvedBy.kind) || !approvedBy.id) {
      return { ok: false, reason: 'approver-required' };
    }
    return this.#mutate((items) => {
      const item = items.find((entry) => entry.id === id);
      if (!item || item.status !== 'candidate') {
        return { changed: false, result: { ok: false, reason: 'not-a-candidate' } };
      }
      item.status = 'adopted';
      item.approvedBy = { kind: approvedBy.kind, id: approvedBy.id };
      item.verifiedAt = new Date(this.now()).toISOString();
      item.version += 1;
      return { changed: true, result: { ok: true } };
    });
  }

  reject(id) {
    return this.#mutate((items) => {
      const item = items.find((entry) => entry.id === id);
      if (!item || item.status === 'rejected') {
        return { changed: false, result: { ok: false, reason: 'not-found' } };
      }
      item.status = 'rejected';
      item.version += 1;
      return { changed: true, result: { ok: true } };
    });
  }

  remove(id) {
    return this.#mutate((items) => {
      const index = items.findIndex((entry) => entry.id === id);
      if (index === -1) return { changed: false, result: { ok: false } };
      items.splice(index, 1);
      return { changed: true, result: { ok: true } };
    });
  }

  // `digests` maps a source ref to its current digest. An adopted item whose
  // source changed (or disappeared) is no longer retrievable until re-verified.
  revalidate(digests) {
    const outcome = this.#mutate((items) => {
      const changed = [];
      for (const item of items) {
        if (item.status !== 'adopted' || !item.source.digest) continue;
        if (digests[item.source.ref] !== item.source.digest) {
          item.status = 'stale';
          item.version += 1;
          changed.push(item.id);
        }
      }
      return { changed: changed.length > 0, result: changed };
    });
    return outcome;
  }

  // Scope is an exact match on repo, role group and privacy domain. Results
  // never reveal whether other scopes hold anything. An unreadable store yields
  // nothing and says why, so the caller can tell "no memory" from "no access".
  select({ repoId, roleGroupId, privacyDomain, task, budgetChars = 2000 }) {
    const current = this.#read();
    const unavailable = current.state === 'ok' ? null : current.state;
    const wanted = tokens(task || '');
    const now = this.now();
    const scored = [];
    for (const item of current.items) {
      if (item.status !== 'adopted') continue;
      if (item.repoId !== repoId || item.roleGroupId !== roleGroupId || item.privacyDomain !== privacyDomain) continue;
      if (Date.parse(item.verifiedAt) + item.ttlMs < now) continue;
      const own = tokens(item.content);
      let score = 0;
      for (const token of wanted) if (own.has(token)) score += 1;
      if (score > 0) scored.push({ item, score });
    }
    scored.sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));

    const selected = [];
    let used = 0;
    let truncated = false;
    for (const { item } of scored) {
      if (used + item.content.length > budgetChars) { truncated = true; continue; }
      used += item.content.length;
      selected.push({ ...item });
    }
    return { items: selected, usedChars: used, truncated, unavailable };
  }
}

module.exports = { MemoryStore, MAX_CONTENT_CHARS, DEFAULT_TTL_MS };
