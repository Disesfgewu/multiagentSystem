'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { SessionObservationCore, DEFAULT_TTL_MS, USAGE_FIELDS } = require('./session');
const { unknown } = require('../accounts/observation');
const { createClaudeSessionEvidenceAdapter } = require('./claude');

const SESSION_ID_ENV = 'MULTIAGENT_CLAUDE_SESSION_ID';
const SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,79}$/;
const RECORD_KEYS = new Set(['schemaVersion', 'eventId', 'observedAt', 'sequence', 'statusLine']);
const STATUS_KEYS = new Set(['model', 'cost']);
// A record holds an id, a time and two short fields: a few hundred bytes. Anything larger is not one.
const MAX_RECORD_BYTES = 8 * 1024;
const POLL_MS = 2000;
// A live session rewrites its file on every status line refresh, so a file untouched for a day belongs
// to a session that is long gone (a crash or a closed window never ran its cleanup).
const STALE_MS = 24 * 60 * 60 * 1000;
const MAX_SWEEP = 200;
const RECORD_FILE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,79}\.json$/;

const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function observationPath(configDir, sessionId) {
  if (typeof configDir !== 'string' || !path.isAbsolute(configDir) || !SESSION_ID.test(sessionId)) {
    throw new TypeError('managed observation binding is invalid');
  }
  return path.join(configDir, 'session-observations', `${sessionId}.json`);
}

/**
 * Reads one observation file without trusting it. The file sits in a folder the CLI (and anything else
 * running as the user) can write to, so it must be a plain, small, singly-linked regular file: a symlink
 * (to a secret or a huge file), a FIFO or device (which would block the Extension Host on open) and an
 * oversized file are all refused before anything is read.
 */
function readRecord(file) {
  let descriptor;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_RECORD_BYTES) return null;
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
    descriptor = fs.openSync(file, flags);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.size > MAX_RECORD_BYTES || (process.platform !== 'win32' && opened.nlink !== 1)) return null;
    const buffer = Buffer.alloc(opened.size);
    let read = 0;
    while (read < buffer.length) {
      const count = fs.readSync(descriptor, buffer, read, buffer.length - read, read);
      if (count === 0) break;
      read += count;
    }
    const parsed = JSON.parse(buffer.subarray(0, read).toString('utf8'));
    if (!isPlain(parsed) || Object.keys(parsed).some(key => !RECORD_KEYS.has(key)) || parsed.schemaVersion !== 1 ||
        typeof parsed.eventId !== 'string' || typeof parsed.observedAt !== 'string' ||
        !Number.isSafeInteger(parsed.sequence) || !isPlain(parsed.statusLine) ||
        Object.keys(parsed.statusLine).some(key => !STATUS_KEYS.has(key))) return null;
    return parsed;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch { /* already closed */ } }
  }
}

/** A cheap change marker that never follows a link: it changes when the file is replaced or rewritten. */
/** Removes record files nobody has written to for STALE_MS: plain files with a record name that also read back as a valid record, in a real (not linked) folder. */
function sweepStale(dir, nowMs, keep = new Set()) {
  let names;
  try {
    // A link here would list (and delete from) whatever it points at.
    const info = fs.lstatSync(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) return 0;
    names = fs.readdirSync(dir);
  } catch { return 0; }
  let removed = 0;
  for (const name of names.slice(0, MAX_SWEEP)) {
    if (!RECORD_FILE.test(name) || keep.has(name)) continue;
    const file = path.join(dir, name);
    try {
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || nowMs - info.mtimeMs < STALE_MS) continue;
      // Only a recognizable record of this feature, not any old file that happens to have such a name.
      if (readRecord(file) === null) continue;
      fs.rmSync(file, { force: true });
      removed += 1;
    } catch { /* Best effort: a file that cannot be judged stays. */ }
  }
  return removed;
}

const realFolder = (dir) => {
  try { const info = fs.lstatSync(dir); return info.isDirectory() && !info.isSymbolicLink(); } catch { return false; }
};

/** Deletes one record file, but never through a linked folder. */
function removeRecord(file) {
  if (!realFolder(path.dirname(file))) return;
  try { fs.rmSync(file, { force: true }); } catch { /* An unreadable old file stays unknown. */ }
}

function fileSignature(file) {
  try {
    const stat = fs.lstatSync(file);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return 'absent';
  }
}

class SessionObservationRuntime {
  constructor(options = {}) {
    this.core = options.core ?? new SessionObservationCore(options);
    this.bindings = new Map();
    // Managed sessions of a provider with no verifiable event source: shown as unknown, with the reason.
    this.unobservable = new Map();
    this.ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS;
    this.pollMs = Number.isFinite(options.pollMs) && options.pollMs > 0 ? options.pollMs : POLL_MS;
    this.nowMs = typeof options.nowMs === 'function' ? options.nowMs : Date.now;
    this.listeners = new Set();
    this.timer = null;
  }

  /**
   * Tells the caller when a managed session's evidence may have changed: its observation file was
   * written, replaced or removed, or what it showed has just aged out and must fall back to unknown.
   * There is no timer unless something listens AND a session is bound, and `dispose()` of the returned
   * handle (or of the runtime) removes it.
   */
  onDidChange(listener) {
    this.listeners.add(listener);
    this.#syncTimer();
    return { dispose: () => { this.listeners.delete(listener); this.#syncTimer(); } };
  }

  #syncTimer() {
    const wanted = this.listeners.size > 0 && this.bindings.size > 0;
    if (wanted && this.timer === null) {
      this.timer = setInterval(() => this.poll(), this.pollMs);
      if (typeof this.timer.unref === 'function') this.timer.unref();
    } else if (!wanted && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * A Codex session started in a native terminal has no event source this extension can verify: the
   * app-server notifications the Codex adapter understands come from a separate server process that is
   * not the terminal's. Starting one and presenting its numbers as the terminal's would be misattribution,
   * and terminal text and login files are off limits. So the session is registered as "unavailable":
   * every value reads unknown, with the reason, and the screen says so instead of staying blank.
   */
  #prepareUnobservable({ sessionId, provider, accountProfileId, env }) {
    this.unobservable.set(sessionId, { provider, accountProfileId });
    return { env, active: false };
  }

  #notify(sessionId) {
    for (const listener of [...this.listeners]) {
      try { listener(sessionId); } catch { /* one listener's failure never stops another */ }
    }
  }

  /** One pass over the bound sessions. Called by the timer; also callable directly. */
  poll() {
    const now = this.nowMs();
    for (const [sessionId, binding] of [...this.bindings]) {
      const signature = fileSignature(binding.file);
      if (signature !== binding.signature) {
        binding.signature = signature;
        const record = signature === 'absent' ? null : readRecord(binding.file);
        const observed = record ? Date.parse(record.observedAt) : Number.NaN;
        binding.expiresAtMs = Number.isFinite(observed) ? observed + this.ttlMs : null;
        binding.expiryNotified = false;
        this.#notify(sessionId);
      } else if (binding.expiresAtMs !== null && !binding.expiryNotified && now >= binding.expiresAtMs) {
        binding.expiryNotified = true;
        this.#notify(sessionId);
      }
    }
  }

  dispose() {
    this.listeners.clear();
    this.bindings.clear();
    this.#syncTimer();
  }

  prepare({ sessionId, provider, accountProfileId, env }) {
    if (provider === 'codex') return this.#prepareUnobservable({ sessionId, provider, accountProfileId, env });
    if (provider !== 'claude' || !env || typeof env.CLAUDE_CONFIG_DIR !== 'string' || accountProfileId === 'unassigned') {
      return { env, active: false };
    }
    const file = observationPath(env.CLAUDE_CONFIG_DIR, sessionId);
    removeRecord(file);
    sweepStale(path.dirname(file), this.nowMs(), new Set([...this.bindings.values()].map((binding) => path.basename(binding.file))));
    this.core.register({ sessionId, provider, accountProfileId });
    this.bindings.set(sessionId, {
      file,
      adapter: createClaudeSessionEvidenceAdapter({ core: this.core, sessionId, accountProfileId }),
      signature: fileSignature(file),
      expiresAtMs: null,
      expiryNotified: false
    });
    this.#syncTimer();
    return { env: { ...env, [SESSION_ID_ENV]: sessionId }, active: true };
  }

  snapshot(sessionId, at = new Date().toISOString()) {
    const unobservable = this.unobservable.get(sessionId);
    if (unobservable) {
      const reason = 'no-verified-event-source';
      const source = 'not-observed';
      return {
        sessionId,
        ...unobservable,
        status: unknown('session.state', { source, observedAt: at, reason }),
        model: unknown('session.model', { source, observedAt: at, reason }),
        usage: USAGE_FIELDS.map((field) => unknown(field, { source, observedAt: at, reason })),
        freshness: 'unknown',
        providerSession: 'unavailable'
      };
    }
    const binding = this.bindings.get(sessionId);
    if (!binding) return null;
    const record = readRecord(binding.file);
    if (record) {
      const { eventId, observedAt, sequence, statusLine } = record;
      binding.adapter.accept({ eventId, observedAt, sequence, statusLine });
    }
    return this.core.snapshot(sessionId, at);
  }

  enrich(sessions, at = new Date().toISOString()) {
    return sessions.map(session => ({ ...session, providerObservation: this.snapshot(session.id, at) }));
  }

  release(sessionId) {
    this.unobservable.delete(sessionId);
    const binding = this.bindings.get(sessionId);
    this.bindings.delete(sessionId);
    if (binding) {
      removeRecord(binding.file);
    }
    this.#syncTimer();
  }
}

module.exports = { SessionObservationRuntime, SESSION_ID_ENV, MAX_RECORD_BYTES, observationPath, readRecord, sweepStale, STALE_MS };
