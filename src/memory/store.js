'use strict';

const fs = require('node:fs');
const nodePath = require('node:path');
const crypto = require('node:crypto');
const { checkPrivateRoot } = require('./paths');
const { scanSensitive } = require('./sensitive');
const { flatten, MIN_MATCHABLE_CHARS } = require('./text');

const SCHEMA_VERSION = 1;
const MAX_CONTENT_CHARS = 2000;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_LOCK = Object.freeze({ retries: 100, waitMs: 20, staleMs: 30000 });

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

class MemoryStore {
  constructor({ dir, repoRoot, now = () => Date.now(), context, lock } = {}) {
    const check = checkPrivateRoot(dir, repoRoot, context);
    if (!check.ok) {
      const error = new Error(`memory directory rejected: ${check.problems.join(', ')}`);
      error.problems = check.problems;
      throw error;
    }
    this.dir = dir;
    this.file = nodePath.join(dir, 'memory.json');
    this.lockFile = nodePath.join(dir, 'memory.lock');
    this.now = now;
    this.lockOptions = { ...DEFAULT_LOCK, ...lock };
  }

  // The file on disk is the only source of truth and is read fresh on every
  // call, so a second instance or process never works from a stale copy. A file
  // that cannot be parsed or has another schema version is reported, never
  // treated as empty, and is never overwritten.
  #read() {
    let text;
    try {
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

  #acquire() {
    const { retries, waitMs, staleMs } = this.lockOptions;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const descriptor = fs.openSync(this.lockFile, 'wx', 0o600);
        fs.writeSync(descriptor, `${process.pid}\n`);
        fs.closeSync(descriptor);
        return true;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          if (Date.now() - fs.statSync(this.lockFile).mtimeMs > staleMs) {
            fs.unlinkSync(this.lockFile);
            continue;
          }
        } catch {
          continue;
        }
        sleep(waitMs);
      }
    }
    return false;
  }

  #release() {
    try {
      fs.unlinkSync(this.lockFile);
    } catch {
      // Already removed as stale by another writer.
    }
  }

  // One writer at a time (lock file), always re-reading inside the lock, then a
  // temp file plus rename so a crash never leaves a half-written memory file.
  // The lock is advisory and per directory: it does not protect against a
  // process that ignores it, nor across a network file system.
  #mutate(apply) {
    if (!this.#acquire()) return { ok: false, reason: 'locked' };
    try {
      const current = this.#read();
      if (current.state !== 'ok') return { ok: false, reason: 'store-unavailable', detail: current.state };
      const outcome = apply(current.items);
      if (outcome.changed) this.#write(current.items);
      return outcome.result;
    } finally {
      this.#release();
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
