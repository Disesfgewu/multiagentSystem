'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { SessionObservationCore, DEFAULT_TTL_MS, USAGE_FIELDS } = require('./session');
const { unknown } = require('../accounts/observation');
const { createClaudeSessionEvidenceAdapter, createClaudeHookEvidenceAdapter, deriveClaudeHookState } = require('./claude');

const SESSION_ID_ENV = 'MULTIAGENT_CLAUDE_SESSION_ID';
const SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,79}$/;
const RECORD_KEYS = new Set(['schemaVersion', 'eventId', 'observedAt', 'sequence', 'statusLine', 'hook', 'providerSessionId']);
// The hook events a record may name (the six the hook bridge writes); the state each means is decided in claude.js.
const HOOK_EVENT_NAMES = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd']);
const { PERMISSION_MODES } = require('../accounts/claudeHookBridge');
// The status line bridge and the hook bridge write different files: both fire often and independently, so
// sharing one file would let each overwrite the other's evidence.
const HOOK_SUFFIX = '.hook';
const PROVIDER_SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const STATUS_KEYS = new Set(['model', 'cost']);
// A record holds an id, a time and two short fields: a few hundred bytes. Anything larger is not one.
const MAX_RECORD_BYTES = 8 * 1024;
const POLL_MS = 2000;
// How long the CLI's last hook event still tells what the CLI is doing when a broadcast is delivered. A CLI that is waiting for
// the person sends no further event, so the display lifetime (30 seconds) would make every idle agent look unknown.
const DELIVERY_STATE_MAX_MS = 12 * 60 * 60 * 1000;
// A live session rewrites its file on every status line refresh, so a file untouched for a day belongs
// to a session that is long gone (a crash or a closed window never ran its cleanup).
const STALE_MS = 24 * 60 * 60 * 1000;
const MAX_SWEEP = 200;
const RECORD_FILE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,79}(?:\.hook)?\.json$/;
// What the bridge leaves behind if it stops between writing a temporary file and renaming it.
const TEMP_FILE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,79}(?:\.hook)?\.json\.tmp\.[A-Za-z0-9.-]{1,80}$/;

const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function observationPath(configDir, sessionId, kind = 'statusLine') {
  if (typeof configDir !== 'string' || !path.isAbsolute(configDir) || !SESSION_ID.test(sessionId)) {
    throw new TypeError('managed observation binding is invalid');
  }
  return path.join(configDir, 'session-observations', `${sessionId}${kind === 'hook' ? HOOK_SUFFIX : ''}.json`);
}

/**
 * Reads one observation file without trusting it. The file sits in a folder the CLI (and anything else
 * running as the user) can write to, so it must be a plain, small, singly-linked regular file: a symlink
 * (to a secret or a huge file), a FIFO or device (which would block the Extension Host on open) and an
 * oversized file are all refused before anything is read.
 */
function readRecord(file, kind = 'statusLine') {
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
        !Number.isSafeInteger(parsed.sequence) ||
        (parsed.providerSessionId !== undefined && !(typeof parsed.providerSessionId === 'string' && PROVIDER_SESSION_ID.test(parsed.providerSessionId)))) return null;
    if (kind === 'hook') {
      // A hook record is exactly an event name, the CLI's session id and, when the CLI reported one, its permission mode.
      if (parsed.statusLine !== undefined || typeof parsed.providerSessionId !== 'string' || !isPlain(parsed.hook) ||
          Object.keys(parsed.hook).some((key) => key !== 'hookEventName' && key !== 'permissionMode') || !HOOK_EVENT_NAMES.has(parsed.hook.hookEventName) ||
          (parsed.hook.permissionMode !== undefined && !PERMISSION_MODES.includes(parsed.hook.permissionMode))) return null;
    } else if (parsed.hook !== undefined || !isPlain(parsed.statusLine) ||
        Object.keys(parsed.statusLine).some(key => !STATUS_KEYS.has(key))) {
      return null;
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
    const temporary = TEMP_FILE.test(name);
    if (!(RECORD_FILE.test(name) || temporary) || keep.has(name)) continue;
    const file = path.join(dir, name);
    try {
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || nowMs - info.mtimeMs < STALE_MS) continue;
      // Only a recognizable record of this feature, not any old file that happens to have such a name.
      if (!temporary && readRecord(file, name.endsWith(`${HOOK_SUFFIX}.json`) ? 'hook' : 'statusLine') === null) continue;
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

  /**
   * Ties a record to the managed session by the provider's own session id. The first record that
   * carries one fixes the mapping. After that, a record with another id (the same terminal now runs a
   * different Claude session, or two instances write to one file) or without one withdraws all
   * evidence for this managed session for good: values may never be attributed to the wrong session.
   * Records that never carried an id stay "unbound": routed by the managed terminal's environment only.
   */
  #judgeProvider(sessionId, binding, record) {
    if (binding.providerSession === 'mismatch') return;
    const id = record.providerSessionId;
    if (binding.providerSessionId === null) {
      if (id !== undefined) { binding.providerSessionId = id; binding.providerSession = 'bound'; }
      return;
    }
    if (id !== binding.providerSessionId) {
      binding.providerSession = 'mismatch';
      this.core.retract(sessionId, id === undefined ? 'provider-session-missing' : 'provider-session-changed');
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
      let changed = false;
      for (const [kind, watch] of Object.entries(binding.watches)) {
        const signature = fileSignature(watch.file);
        if (signature !== watch.signature) {
          watch.signature = signature;
          const record = signature === 'absent' ? null : readRecord(watch.file, kind);
          if (record) this.#judgeProvider(sessionId, binding, record);
          const observed = record ? Date.parse(record.observedAt) : Number.NaN;
          watch.expiresAtMs = Number.isFinite(observed) ? observed + this.ttlMs : null;
          watch.expiryNotified = false;
          changed = true;
        } else if (watch.expiresAtMs !== null && !watch.expiryNotified && now >= watch.expiresAtMs) {
          watch.expiryNotified = true;
          changed = true;
        }
      }
      if (changed) this.#notify(sessionId);
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
    const files = { statusLine: observationPath(env.CLAUDE_CONFIG_DIR, sessionId), hook: observationPath(env.CLAUDE_CONFIG_DIR, sessionId, 'hook') };
    // Whatever an earlier run of this id left is not evidence for this one.
    for (const file of Object.values(files)) removeRecord(file);
    sweepStale(path.dirname(files.statusLine), this.nowMs(), new Set([...this.bindings.values()].flatMap((binding) => Object.values(binding.watches).map((watch) => path.basename(watch.file)))));
    // Preparing an id again starts it afresh: nothing seen for an earlier run of that id carries over.
    this.core.unregister(sessionId);
    this.core.register({ sessionId, provider, accountProfileId });
    this.bindings.set(sessionId, {
      watches: Object.fromEntries(Object.entries(files).map(([kind, file]) => [kind, { file, signature: fileSignature(file), expiresAtMs: null, expiryNotified: false }])),
      sessionId,
      accountProfileId,
      adapter: createClaudeSessionEvidenceAdapter({ core: this.core, sessionId, accountProfileId }),
      providerSessionId: null,
      providerSession: 'unbound'
    });
    this.#syncTimer();
    return { env: { ...env, [SESSION_ID_ENV]: sessionId }, active: true };
  }

  /**
   * What the CLI itself last said it was doing, for deciding whether a broadcast can be typed into it (issue #295). The LAST
   * hook event of the session counts until the next one replaces it (`Stop` and `Notification` mean waiting, `UserPromptSubmit`
   * and the tool events mean working, `SessionEnd` means ended), the terminal closes, or DELIVERY_STATE_MAX_MS passes: unlike
   * the display lifetime, silence from an idle CLI does not turn it into "unknown". Nothing but the hook record is read, never
   * terminal text. A session without a hook source (Codex, agy, a Claude without the hook bridge), a record that is not bound to
   * this session's CLI, or one that is too old is `unknown` with the reason.
   * @returns {{ state: 'waiting'|'working'|'ended'|'unknown', reason: string, since: string|null }}
   */
  deliveryState(sessionId, nowMs = this.nowMs()) {
    const unknownState = (reason) => ({ state: 'unknown', reason, since: null });
    if (this.unobservable.has(sessionId)) return unknownState('no-verified-event-source');
    const binding = this.bindings.get(sessionId);
    if (!binding) return unknownState('no-hook-bridge');
    const record = readRecord(binding.watches.hook.file, 'hook');
    if (!record) return unknownState('no-hook-event');
    this.#judgeProvider(sessionId, binding, record);
    if (binding.providerSession === 'mismatch') return unknownState('provider-session-mismatch');
    const state = deriveClaudeHookState(record.hook.hookEventName);
    const observed = Date.parse(record.observedAt);
    if (state === null || !Number.isFinite(observed) || observed > nowMs + 60_000) return unknownState('hook-event-unusable');
    if (nowMs - observed > DELIVERY_STATE_MAX_MS) return unknownState('hook-event-too-old');
    return { state, reason: 'last-hook-event', since: new Date(observed).toISOString() };
  }

  /**
   * The permission mode the CLI itself last reported (#362), from the same hook record as `deliveryState` and under the same
   * rules (bound to this session's CLI, not from the future, not older than DELIVERY_STATE_MAX_MS), or null.
   * @returns {{ mode: string, since: string } | null}
   */
  permissionMode(sessionId, nowMs = this.nowMs()) {
    if (this.unobservable.has(sessionId)) return null;
    const binding = this.bindings.get(sessionId);
    if (!binding) return null;
    const record = readRecord(binding.watches.hook.file, 'hook');
    if (!record || typeof record.hook.permissionMode !== 'string') return null;
    this.#judgeProvider(sessionId, binding, record);
    if (binding.providerSession === 'mismatch') return null;
    const observed = Date.parse(record.observedAt);
    if (!Number.isFinite(observed) || observed > nowMs + 60_000 || nowMs - observed > DELIVERY_STATE_MAX_MS) return null;
    return { mode: record.hook.permissionMode, since: new Date(observed).toISOString() };
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
    const records = Object.entries(binding.watches)
      .map(([kind, watch]) => ({ kind, record: readRecord(watch.file, kind) }))
      .filter((entry) => entry.record !== null)
      .sort((left, right) => left.record.sequence - right.record.sequence);
    for (const { kind, record } of records) {
      this.#judgeProvider(sessionId, binding, record);
      if (binding.providerSession === 'mismatch') break;
      const { eventId, observedAt, sequence } = record;
      if (kind === 'hook') {
        // The hook adapter accepts only events of the CLI session this managed session is bound to.
        createClaudeHookEvidenceAdapter({
          core: this.core, sessionId, accountProfileId: binding.accountProfileId, claudeSessionId: binding.providerSessionId
        }).accept({ eventId, observedAt, sequence, notification: { session_id: record.providerSessionId, hook_event_name: record.hook.hookEventName } });
      } else {
        binding.adapter.accept({ eventId, observedAt, sequence, statusLine: record.statusLine });
      }
    }
    const snapshot = this.core.snapshot(sessionId, at);
    return snapshot ? { ...snapshot, providerSession: binding.providerSession } : snapshot;
  }

  enrich(sessions, at = new Date().toISOString()) {
    return sessions.map(session => ({ ...session, providerObservation: this.snapshot(session.id, at), deliveryState: this.deliveryState(session.id, Date.parse(at)), reportedPermissionMode: this.permissionMode(session.id, Date.parse(at)) }));
  }

  release(sessionId) {
    this.unobservable.delete(sessionId);
    const binding = this.bindings.get(sessionId);
    this.bindings.delete(sessionId);
    if (binding) {
      for (const watch of Object.values(binding.watches)) removeRecord(watch.file);
      this.core.unregister(sessionId);
    }
    this.#syncTimer();
  }
}

module.exports = { DELIVERY_STATE_MAX_MS, SessionObservationRuntime, SESSION_ID_ENV, MAX_RECORD_BYTES, observationPath, readRecord, sweepStale, STALE_MS };
