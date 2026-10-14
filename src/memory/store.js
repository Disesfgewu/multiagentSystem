'use strict';

const fs = require('node:fs');
const nodePath = require('node:path');
const crypto = require('node:crypto');
const { checkPrivateRoot } = require('./paths');
const { DirectoryLock, LockIoError } = require('../shared/lock');
const { scanSensitive } = require('./sensitive');
const { flatten, MIN_MATCHABLE_CHARS } = require('./text');
const { byCodeUnit } = require('./order');
const { validDomain } = require('./domains');

const SCHEMA_VERSION = 1;
const MAX_CONTENT_CHARS = 2000;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// What may be injected is bounded: a caller cannot ask for more than this, and an invalid
// request gets the default instead of an unbounded one.
const DEFAULT_BUDGET_CHARS = 2000;
const MAX_BUDGET_CHARS = 8000;
const CONFIRM_DELETE_SCOPE = 'delete-memory-scope';
const STATUSES = Object.freeze(['candidate', 'adopted', 'stale', 'rejected', 'quarantined']);
const MAX_SCOPE_FIELD = 200;

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

// A memory is a short note, not a conversation. Content that is shaped like a transcript (turns
// labelled by speaker, or chat markup) is refused so a whole exchange cannot be stored as memory.
const TURN = /^\s*(?:user|assistant|human|ai|system|claude|codex|you|me)\s*[:\uff1a]/i;
const CHAT_MARKUP = /<\|(?:im_start|im_end|endoftext)\|>|\[\/?INST\]|<\/?(?:human|assistant)>/i;
function looksLikeTranscript(text) {
  if (CHAT_MARKUP.test(text)) return true;
  let turns = 0;
  for (const line of text.split(/\r?\n/)) if (TURN.test(line)) turns += 1;
  return turns >= 3;
}

const scopeText = (value) => typeof value === 'string' && value.length >= 1 && value.length <= MAX_SCOPE_FIELD && !/[\u0000-\u001f\u007f]/.test(value);

// Fail closed: a time of verification or a time to live that is missing, not of the right type or
// not readable means the memory has expired. (JavaScript would read a null time to live as zero and
// a text one as a string to append to, so the types are checked and not left to coercion.)
const isExpired = (item, now) => {
  if (typeof item.verifiedAt !== 'string' || typeof item.ttlMs !== 'number' || !Number.isFinite(item.ttlMs)) return true;
  return !(Date.parse(item.verifiedAt) + item.ttlMs >= now);
};

// What may be read: adopted, switched on, and inside its time to live.
const isReadable = (item, now) => item.status === 'adopted' && item.disabled !== true && !isExpired(item, now);

// The state an item is in for a person looking at counts: the first that applies.
function effectiveState(item, now) {
  if (item.status === 'quarantined') return 'quarantined';
  if (item.status === 'rejected') return 'rejected';
  if (item.disabled === true) return 'disabled';
  if (item.status === 'candidate') return 'candidate';
  if (item.status === 'stale') return 'stale';
  return isExpired(item, now) ? 'expired' : 'ready';
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Windows has no uid; its access control is the user profile's default and is
// not verified here.
const ownedByCurrentUser = (stat) => typeof process.getuid !== 'function' || stat.uid === process.getuid();

class MemoryStore {
  // `domains` is a policy from createDomainPolicy. Without one a reader sees only its own privacy
  // domain; sharing across domains exists only when a policy with explicit grants is given.
  constructor({ dir, repoRoot, now = () => Date.now(), context, lock, domains } = {}) {
    if (domains !== undefined && domains !== null && typeof domains.readableDomains !== 'function') {
      throw new TypeError('domains must be a policy from createDomainPolicy');
    }
    this.domains = domains || null;
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
    const badScope = [['repoId', scopeText(input.repoId)], ['roleGroupId', scopeText(input.roleGroupId)], ['privacyDomain', validDomain(input.privacyDomain)]]
      .filter(([, ok]) => !ok).map(([name]) => name);
    if (badScope.length > 0) return { ok: false, reason: 'invalid-scope', fields: badScope };
    if (content === '' || content.length > MAX_CONTENT_CHARS) return { ok: false, reason: 'invalid-length' };
    if (flatten(content).length < MIN_MATCHABLE_CHARS) return { ok: false, reason: 'too-short' };
    if (looksLikeTranscript(content)) return { ok: false, reason: 'transcript-like' };

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

  // The domains `privacyDomain` may read. A policy that fails, or that answers with anything but
  // a list of valid domains starting with the reader's own, grants nothing beyond the reader's own.
  #readableDomains(privacyDomain) {
    if (!validDomain(privacyDomain)) return [];
    if (!this.domains) return [privacyDomain];
    try {
      const answer = this.domains.readableDomains(privacyDomain);
      const ok = Array.isArray(answer) && answer[0] === privacyDomain && answer.every(validDomain);
      return ok ? [...new Set(answer)] : [privacyDomain];
    } catch {
      return [privacyDomain];
    }
  }

  // Repository and role group are an exact match, and so is the privacy domain unless another
  // domain has been shared with the reader by an explicit grant. Results never reveal whether
  // other scopes hold anything. An unreadable store yields nothing and says why, so the caller
  // can tell "no memory" from "no access". Only adopted, switched-on, unexpired memory is read.
  // What the budget leaves out is reported (`omitted`), not silently dropped.
  select({ repoId, roleGroupId, privacyDomain, task, budgetChars }) {
    const current = this.#read();
    const unavailable = current.state === 'ok' ? null : current.state;
    const wanted = tokens(task || '');
    const now = this.now();
    const readable = this.#readableDomains(privacyDomain);
    const scored = [];
    for (const item of current.items) {
      if (!isReadable(item, now)) continue;
      if (item.repoId !== repoId || item.roleGroupId !== roleGroupId || !readable.includes(item.privacyDomain)) continue;
      const own = tokens(item.content);
      let score = 0;
      for (const token of wanted) if (own.has(token)) score += 1;
      if (score > 0) scored.push({ item, score });
    }
    scored.sort((a, b) => b.score - a.score || byCodeUnit(a.item.id, b.item.id));

    const wasAsked = budgetChars !== undefined;
    const valid = Number.isFinite(budgetChars) && budgetChars >= 0;
    const limit = valid ? Math.min(Math.floor(budgetChars), MAX_BUDGET_CHARS) : DEFAULT_BUDGET_CHARS;
    const selected = [];
    let used = 0;
    let omittedCount = 0;
    let omittedChars = 0;
    for (const { item } of scored) {
      if (used + item.content.length > limit) {
        omittedCount += 1;
        omittedChars += item.content.length;
        continue;
      }
      used += item.content.length;
      const copy = { ...item };
      if (item.privacyDomain !== privacyDomain) copy.sharedFrom = item.privacyDomain;
      selected.push(copy);
    }
    const result = { items: selected, usedChars: used, truncated: omittedCount > 0, unavailable };
    if (omittedCount > 0) result.omitted = { count: omittedCount, chars: omittedChars, reason: 'budget' };
    if (wasAsked && valid && budgetChars > MAX_BUDGET_CHARS) result.budgetClamped = MAX_BUDGET_CHARS;
    return result;
  }

  // ---- switching off, re-verifying, deleting a scope, rebuilding, exporting ----------------

  // A memory that is switched off is kept but never read. Switching it on again restores it
  // exactly as it was.
  disable(id) {
    return this.#mutate((items) => {
      const item = items.find((entry) => entry.id === id);
      if (!item) return { changed: false, result: { ok: false, reason: 'not-found' } };
      if (item.disabled === true) return { changed: false, result: { ok: false, reason: 'already-disabled' } };
      item.disabled = true;
      item.version += 1;
      return { changed: true, result: { ok: true } };
    });
  }

  enable(id) {
    return this.#mutate((items) => {
      const item = items.find((entry) => entry.id === id);
      if (!item) return { changed: false, result: { ok: false, reason: 'not-found' } };
      if (item.disabled !== true) return { changed: false, result: { ok: false, reason: 'not-disabled' } };
      item.disabled = false;
      item.version += 1;
      return { changed: true, result: { ok: true } };
    });
  }

  // A memory whose source changed is `stale`: it cannot be read until someone looks at it again.
  // That someone is named, and gives the source's current digest; nothing re-adopts it quietly.
  reverify(id, approvedBy, { digest } = {}) {
    if (!approvedBy || !['human', 'rule'].includes(approvedBy.kind) || !approvedBy.id) return { ok: false, reason: 'approver-required' };
    if (typeof digest !== 'string' || digest === '' || digest.length > 200) return { ok: false, reason: 'digest-required' };
    return this.#mutate((items) => {
      const item = items.find((entry) => entry.id === id);
      if (!item) return { changed: false, result: { ok: false, reason: 'not-found' } };
      if (item.status !== 'stale') return { changed: false, result: { ok: false, reason: 'not-stale' } };
      item.source = { ...item.source, digest };
      item.status = 'adopted';
      item.approvedBy = { kind: approvedBy.kind, id: approvedBy.id };
      item.verifiedAt = new Date(this.now()).toISOString();
      item.version += 1;
      return { changed: true, result: { ok: true } };
    });
  }

  // Deletes every memory of one scope. It takes all three parts of the scope and an explicit
  // confirmation, so it cannot be a wildcard and cannot happen by accident.
  removeScope({ repoId, roleGroupId, privacyDomain } = {}, { confirm } = {}) {
    if (!scopeText(repoId) || !scopeText(roleGroupId) || !validDomain(privacyDomain)) return { ok: false, reason: 'invalid-scope' };
    if (confirm !== CONFIRM_DELETE_SCOPE) return { ok: false, reason: 'confirmation-required' };
    return this.#mutate((items) => {
      let removed = 0;
      for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index];
        if (item && item.repoId === repoId && item.roleGroupId === roleGroupId && item.privacyDomain === privacyDomain) {
          items.splice(index, 1);
          removed += 1;
        }
      }
      return { changed: removed > 0, result: { ok: true, removed } };
    });
  }

  // Re-checks everything that is stored against today's rules, as after the sensitive-content
  // patterns were widened. What no longer passes is quarantined: it is blanked, and never read.
  // Duplicates inside one scope are folded into the earliest. Nothing is ever promoted: a rebuild
  // can only take memory out of use, never put it into use.
  rebuild() {
    return this.#mutate((items) => {
      const report = { ok: true, checked: items.length, quarantined: [], duplicatesRejected: [], dropped: 0 };
      let changed = false;
      const quarantine = (item, reasons) => {
        item.status = 'quarantined';
        item.quarantineReasons = reasons;
        item.content = '';
        item.version = Number.isInteger(item.version) ? item.version + 1 : 1;
        report.quarantined.push({ id: item.id, reasons });
        changed = true;
      };

      for (let index = items.length - 1; index >= 0; index -= 1) {
        if (items[index] === null || typeof items[index] !== 'object' || Array.isArray(items[index])) {
          items.splice(index, 1);
          report.dropped += 1;
          changed = true;
        }
      }

      for (const item of items) {
        if (item.status === 'quarantined' || item.status === 'rejected') continue;
        const reasons = [];
        const shape = typeof item.id === 'string' && scopeText(item.repoId) && scopeText(item.roleGroupId) && validDomain(item.privacyDomain) &&
          STATUSES.includes(item.status) && typeof item.content === 'string' && item.source && typeof item.source === 'object' &&
          typeof item.source.ref === 'string' && Number.isFinite(item.ttlMs) && Number.isInteger(item.version);
        if (!shape) {
          reasons.push('invalid-record');
        } else {
          if (item.content.length === 0 || item.content.length > MAX_CONTENT_CHARS) reasons.push('invalid-length');
          else if (flatten(item.content).length < MIN_MATCHABLE_CHARS) reasons.push('too-short');
          if (looksLikeTranscript(item.content)) reasons.push('transcript-like');
          for (const finding of scanSensitive(item.content)) reasons.push(`sensitive:${finding.code}`);
        }
        if (reasons.length > 0) quarantine(item, reasons);
      }

      const ordered = items.filter((item) => item.status !== 'quarantined' && item.status !== 'rejected')
        .sort((a, b) => byCodeUnit(String(a.createdAt), String(b.createdAt)) || byCodeUnit(a.id, b.id));
      const seen = new Map();
      for (const item of ordered) {
        const key = JSON.stringify([item.repoId, item.roleGroupId, item.privacyDomain, normalize(item.content)]);
        if (seen.has(key)) {
          item.status = 'rejected';
          item.duplicateOf = seen.get(key);
          item.version += 1;
          report.duplicatesRejected.push(item.id);
          changed = true;
        } else {
          seen.set(key, item.id);
        }
      }
      return { changed, result: report };
    });
  }

  // For diagnostics and support: how much memory there is, by state and scope, with nothing that
  // identifies it. No content, no id, no source, and no repository, role group or domain name:
  // scopes are shown as aliases numbered in a fixed order.
  exportMasked() {
    const current = this.#read();
    if (current.state !== 'ok') return { ok: false, reason: current.state };
    const now = this.now();
    const STATES = ['ready', 'candidate', 'stale', 'expired', 'disabled', 'rejected', 'quarantined'];
    const empty = () => Object.fromEntries(STATES.map((state) => [state, 0]));
    const scopes = new Map();
    const totals = empty();
    for (const item of current.items) {
      if (item === null || typeof item !== 'object') continue;
      const key = JSON.stringify([String(item.repoId), String(item.roleGroupId), String(item.privacyDomain)]);
      if (!scopes.has(key)) scopes.set(key, empty());
      const state = effectiveState(item, now);
      scopes.get(key)[state] += 1;
      totals[state] += 1;
    }
    const ordered = [...scopes.keys()].sort(byCodeUnit);
    return {
      ok: true,
      export: {
        format: 'multiagent-memory-masked',
        schemaVersion: SCHEMA_VERSION,
        exportedAt: new Date(now).toISOString(),
        note: 'Counts by state and by scope. No content, identifiers, sources or scope names. For diagnostics, not backup.',
        items: current.items.length,
        totals,
        scopes: ordered.map((key, index) => ({ alias: `scope#${index + 1}`, counts: scopes.get(key) }))
      }
    };
  }
}

module.exports = { MemoryStore, MAX_CONTENT_CHARS, DEFAULT_TTL_MS, DEFAULT_BUDGET_CHARS, MAX_BUDGET_CHARS, CONFIRM_DELETE_SCOPE, looksLikeTranscript };
