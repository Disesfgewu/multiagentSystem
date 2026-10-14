'use strict';

const fs = require('node:fs');
const nodePath = require('node:path');
const crypto = require('node:crypto');
const { checkPrivateRoot } = require('./paths');
const { scanSensitive } = require('./sensitive');

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

class MemoryStore {
  constructor({ dir, repoRoot, now = () => Date.now(), context } = {}) {
    const check = checkPrivateRoot(dir, repoRoot, context);
    if (!check.ok) {
      const error = new Error(`memory directory rejected: ${check.problems.join(', ')}`);
      error.problems = check.problems;
      throw error;
    }
    this.dir = dir;
    this.file = nodePath.join(dir, 'memory.json');
    this.now = now;
    this.items = this.#load();
  }

  #load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return data.schemaVersion === SCHEMA_VERSION ? data.items : [];
    } catch {
      return [];
    }
  }

  // Write to a temp file in the same directory and rename, so a crash never
  // leaves a half-written memory file.
  #save() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const temp = nodePath.join(this.dir, `.memory.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    fs.writeFileSync(temp, JSON.stringify({ schemaVersion: SCHEMA_VERSION, items: this.items }, null, 2),
      { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }

  list() {
    return this.items.map((item) => ({ ...item }));
  }

  // New items always start as unreviewed candidates. Anything matching a secret
  // pattern is refused outright and nothing about its content is stored.
  propose(input) {
    const content = typeof input.content === 'string' ? input.content.trim() : '';
    const missing = ['repoId', 'roleGroupId', 'privacyDomain'].filter((key) => !input[key]);
    if (missing.length > 0 || !input.source || !input.source.ref) {
      return { ok: false, reason: 'missing-fields', fields: [...missing, ...(input.source && input.source.ref ? [] : ['source.ref'])] };
    }
    if (content === '' || content.length > MAX_CONTENT_CHARS) return { ok: false, reason: 'invalid-length' };

    const findings = scanSensitive(content);
    if (findings.length > 0) return { ok: false, reason: 'sensitive-content', findings };

    const same = (item) => item.repoId === input.repoId && item.roleGroupId === input.roleGroupId &&
      item.privacyDomain === input.privacyDomain && item.status !== 'rejected' &&
      normalize(item.content) === normalize(content);
    const duplicate = this.items.find(same);
    if (duplicate) return { ok: false, reason: 'duplicate', duplicateOf: duplicate.id };

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
    this.items.push(item);
    this.#save();
    return { ok: true, id: item.id };
  }

  // Adoption is the only path into retrieval and requires a named approver
  // (a person or a rule id); a bare boolean is not accepted.
  adopt(id, approvedBy) {
    const item = this.items.find((entry) => entry.id === id);
    if (!item || item.status !== 'candidate') return { ok: false, reason: 'not-a-candidate' };
    if (!approvedBy || !['human', 'rule'].includes(approvedBy.kind) || !approvedBy.id) {
      return { ok: false, reason: 'approver-required' };
    }
    item.status = 'adopted';
    item.approvedBy = { kind: approvedBy.kind, id: approvedBy.id };
    item.verifiedAt = new Date(this.now()).toISOString();
    item.version += 1;
    this.#save();
    return { ok: true };
  }

  reject(id) {
    const item = this.items.find((entry) => entry.id === id);
    if (!item || item.status === 'rejected') return { ok: false, reason: 'not-found' };
    item.status = 'rejected';
    item.version += 1;
    this.#save();
    return { ok: true };
  }

  remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((entry) => entry.id !== id);
    if (this.items.length !== before) this.#save();
    return { ok: this.items.length !== before };
  }

  // `digests` maps a source ref to its current digest. An adopted item whose
  // source changed (or disappeared) is no longer retrievable until re-verified.
  revalidate(digests) {
    const changed = [];
    for (const item of this.items) {
      if (item.status !== 'adopted' || !item.source.digest) continue;
      if (digests[item.source.ref] !== item.source.digest) {
        item.status = 'stale';
        item.version += 1;
        changed.push(item.id);
      }
    }
    if (changed.length > 0) this.#save();
    return changed;
  }

  // Scope is an exact match on repo, role group and privacy domain. Results
  // never reveal whether other scopes hold anything.
  select({ repoId, roleGroupId, privacyDomain, task, budgetChars = 2000 }) {
    const wanted = tokens(task || '');
    const now = this.now();
    const scored = [];
    for (const item of this.items) {
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
    return { items: selected, usedChars: used, truncated };
  }
}

module.exports = { MemoryStore, MAX_CONTENT_CHARS, DEFAULT_TTL_MS };
