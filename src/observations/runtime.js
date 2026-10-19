'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { SessionObservationCore, DEFAULT_TTL_MS } = require('./session');
const { createSessionEvidenceAdapter } = require('./factory');
const { CODEX_APP_SERVER_SCHEMA_VERSION } = require('./codex');

const SESSION_ID_ENV = 'MULTIAGENT_CLAUDE_SESSION_ID';
const CODEX_SESSION_ID_ENV = 'MULTIAGENT_CODEX_SESSION_ID';
const SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,79}$/;
const RECORD_KEYS = new Set(['schemaVersion', 'eventId', 'observedAt', 'sequence', 'statusLine', 'providerSessionId', 'notification', 'threadId']);
const PROVIDER_SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const STATUS_KEYS = new Set(['model', 'cost']);
const NOTIFICATION_KEYS = new Set(['method', 'params']);
const PARAM_KEYS = new Set(['threadId', 'status']);
const STATUS_METHOD = 'thread/status/changed';
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
        !Number.isSafeInteger(parsed.sequence)) return null;

    const hasStatusLine = parsed.statusLine !== undefined;
    const hasNotification = parsed.notification !== undefined;
    if ((hasStatusLine && hasNotification) || (!hasStatusLine && !hasNotification)) return null;

    if (hasStatusLine) {
      if (!isPlain(parsed.statusLine) || Object.keys(parsed.statusLine).some(key => !STATUS_KEYS.has(key))) return null;
      if (parsed.threadId !== undefined) return null;
      if (parsed.providerSessionId !== undefined && !(typeof parsed.providerSessionId === 'string' && PROVIDER_SESSION_ID.test(parsed.providerSessionId))) return null;
    }

    if (hasNotification) {
      if (!isPlain(parsed.notification) || Object.keys(parsed.notification).some(key => !NOTIFICATION_KEYS.has(key)) ||
          parsed.notification.method !== STATUS_METHOD || !isPlain(parsed.notification.params) ||
          Object.keys(parsed.notification.params).some(key => !PARAM_KEYS.has(key))) return null;
      const { params } = parsed.notification;
      if (typeof params.threadId !== 'string' || !PROVIDER_SESSION_ID.test(params.threadId) ||
          !isPlain(params.status)) return null;
      if (parsed.threadId !== undefined && (typeof parsed.threadId !== 'string' || !PROVIDER_SESSION_ID.test(parsed.threadId) || parsed.threadId !== params.threadId)) return null;
      if (parsed.providerSessionId !== undefined && (typeof parsed.providerSessionId !== 'string' || !PROVIDER_SESSION_ID.test(parsed.providerSessionId) || parsed.providerSessionId !== params.threadId)) return null;
    }

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
    this.ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS;
    this.pollMs = Number.isFinite(options.pollMs) && options.pollMs > 0 ? options.pollMs : POLL_MS;
    this.nowMs = typeof options.nowMs === 'function' ? options.nowMs : Date.now;
    this.now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
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
   * Ties a record to the managed session by the provider's own session id (or thread id for Codex).
   * The first record that carries one fixes the mapping. After that, a record with another id (the
   * same terminal now runs a different session, or two instances write to one file) or without one
   * withdraws all evidence for this managed session for good: values may never be attributed to the wrong session.
   * Records that never carried an id stay "unbound": routed by the managed terminal's environment only.
   */
  #judgeProvider(sessionId, binding, record) {
    if (binding.providerSession === 'mismatch') return;
    if (binding.provider === 'claude') {
      const id = record.providerSessionId;
      if (binding.providerSessionId === null) {
        if (id !== undefined) { binding.providerSessionId = id; binding.providerSession = 'bound'; }
        return;
      }
      if (id !== binding.providerSessionId) {
        binding.providerSession = 'mismatch';
        this.core.retract(sessionId, id === undefined ? 'provider-session-missing' : 'provider-session-changed');
      }
    } else if (binding.provider === 'codex') {
      const incomingThreadId = record.threadId ?? record.notification?.params?.threadId;
      if (binding.threadId === null) {
        if (incomingThreadId !== undefined) {
          binding.threadId = incomingThreadId;
          binding.providerSessionId = incomingThreadId;
          binding.providerSession = 'bound';
          binding.adapter = createSessionEvidenceAdapter('codex', {
            core: this.core,
            sessionId,
            accountProfileId: binding.accountProfileId,
            threadId: incomingThreadId,
            schemaVersion: CODEX_APP_SERVER_SCHEMA_VERSION
          });
        }
        return;
      }
      if (incomingThreadId !== binding.threadId) {
        binding.providerSession = 'mismatch';
        this.core.retract(sessionId, incomingThreadId === undefined ? 'thread-binding-missing' : 'thread-binding-mismatch');
      }
    }
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
        if (record) this.#judgeProvider(sessionId, binding, record);
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

  prepare({ sessionId, provider, accountProfileId, env, threadId }) {
    if ((provider !== 'claude' && provider !== 'codex') || !env || accountProfileId === 'unassigned') {
      return { env, active: false };
    }
    const configDir = provider === 'claude' ? env.CLAUDE_CONFIG_DIR : env.CODEX_HOME;
    if (typeof configDir !== 'string') {
      return { env, active: false };
    }
    const envVar = provider === 'claude' ? SESSION_ID_ENV : CODEX_SESSION_ID_ENV;
    const file = observationPath(configDir, sessionId);
    removeRecord(file);
    sweepStale(path.dirname(file), this.nowMs(), new Set([...this.bindings.values()].map((binding) => path.basename(binding.file))));
    this.core.register({ sessionId, provider, accountProfileId });

    let adapter = null;
    let boundThreadId = null;
    let providerSession = 'unbound';
    let providerSessionId = null;

    if (provider === 'claude') {
      adapter = createSessionEvidenceAdapter('claude', { core: this.core, sessionId, accountProfileId });
    } else if (provider === 'codex') {
      if (typeof threadId === 'string' && PROVIDER_SESSION_ID.test(threadId)) {
        boundThreadId = threadId;
        providerSessionId = threadId;
        providerSession = 'bound';
        adapter = createSessionEvidenceAdapter('codex', {
          core: this.core,
          sessionId,
          accountProfileId,
          threadId,
          schemaVersion: CODEX_APP_SERVER_SCHEMA_VERSION
        });
      }
    }

    this.bindings.set(sessionId, {
      provider,
      accountProfileId,
      file,
      adapter,
      signature: fileSignature(file),
      providerSessionId,
      providerSession,
      threadId: boundThreadId,
      expiresAtMs: null,
      expiryNotified: false
    });
    this.#syncTimer();
    return { env: { ...env, [envVar]: sessionId }, active: true };
  }

  ingestCodexNotification(sessionId, notification, meta = {}) {
    const binding = this.bindings.get(sessionId);
    if (!binding || binding.provider !== 'codex') {
      return { ok: false, reason: 'session-unknown' };
    }
    if (!notification || typeof notification !== 'object' || notification.method !== STATUS_METHOD ||
        !notification.params || typeof notification.params !== 'object' || typeof notification.params.threadId !== 'string') {
      return { ok: false, reason: 'codex-evidence-invalid' };
    }
    const incomingThreadId = notification.params.threadId;
    if (!PROVIDER_SESSION_ID.test(incomingThreadId)) {
      return { ok: false, reason: 'codex-evidence-invalid' };
    }
    if (binding.threadId === null) {
      binding.threadId = incomingThreadId;
      binding.providerSessionId = incomingThreadId;
      binding.providerSession = 'bound';
      binding.adapter = createSessionEvidenceAdapter('codex', {
        core: this.core,
        sessionId,
        accountProfileId: binding.accountProfileId,
        threadId: incomingThreadId,
        schemaVersion: CODEX_APP_SERVER_SCHEMA_VERSION
      });
    } else if (incomingThreadId !== binding.threadId) {
      binding.providerSession = 'mismatch';
      this.core.retract(sessionId, 'thread-binding-mismatch');
      this.#notify(sessionId);
      return { ok: false, reason: 'thread-binding-mismatch' };
    }
    const observedAt = meta.observedAt ?? (typeof this.now === 'function' ? this.now() : new Date().toISOString());
    binding.lastSeq = (binding.lastSeq ?? 0) + 1;
    const sequence = meta.sequence ?? binding.lastSeq;
    const eventId = meta.eventId ?? `codex-event-${Date.parse(observedAt)}-${sequence}`;

    const acceptResult = binding.adapter.accept({
      eventId,
      observedAt,
      sequence,
      notification
    });
    if (acceptResult.ok) {
      const observedMs = Date.parse(observedAt);
      binding.expiresAtMs = Number.isFinite(observedMs) ? observedMs + this.ttlMs : null;
      binding.expiryNotified = false;
      this.#notify(sessionId);
    }
    return acceptResult;
  }

  snapshot(sessionId, at = new Date().toISOString()) {
    const binding = this.bindings.get(sessionId);
    if (!binding) return null;
    const record = readRecord(binding.file);
    if (record) {
      this.#judgeProvider(sessionId, binding, record);
      if (binding.providerSession !== 'mismatch' && binding.adapter) {
        if (binding.provider === 'claude' && record.statusLine) {
          const { eventId, observedAt, sequence, statusLine } = record;
          binding.adapter.accept({ eventId, observedAt, sequence, statusLine });
        } else if (binding.provider === 'codex' && record.notification) {
          const { eventId, observedAt, sequence, notification } = record;
          binding.adapter.accept({ eventId, observedAt, sequence, notification });
        }
      }
    }
    const snapshot = this.core.snapshot(sessionId, at);
    return snapshot ? { ...snapshot, providerSession: binding.providerSession } : snapshot;
  }

  enrich(sessions, at = new Date().toISOString()) {
    return sessions.map(session => ({ ...session, providerObservation: this.snapshot(session.id, at) }));
  }

  release(sessionId) {
    const binding = this.bindings.get(sessionId);
    this.bindings.delete(sessionId);
    if (binding) {
      removeRecord(binding.file);
    }
    this.#syncTimer();
  }
}

module.exports = { SessionObservationRuntime, SESSION_ID_ENV, CODEX_SESSION_ID_ENV, MAX_RECORD_BYTES, observationPath, readRecord, sweepStale, STALE_MS };
