#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const SESSION_ID_ENV = 'MULTIAGENT_CLAUDE_SESSION_ID';
const SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,79}$/;
// Claude Code's own session id (the hook input field `session_id`): an opaque, short token.
const PROVIDER_SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
// The hook events this bridge understands (https://code.claude.com/docs/en/hooks, "Hook lifecycle").
// Anything else is ignored: an event we cannot map to a state is not evidence of one.
const HOOK_EVENTS = Object.freeze(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd']);
// The permission modes Claude Code documents (https://code.claude.com/docs/en/permission-modes; the `permission_mode` field of
// every hook input). Any other value is not kept.
const PERMISSION_MODES = Object.freeze(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']);
const HOOK_FILE_SUFFIX = '.hook.json';
// A Stop payload carries the last assistant message, so it may be long. Beyond this it is not read.
const MAX_STDIN_BYTES = 1024 * 1024;
const STDIN_TIMEOUT_MS = 3000;
const MAX_EXISTING_BYTES = 8 * 1024;

function hookRecordPath(configDir, managedSessionId) {
  return path.join(configDir, 'session-observations', `${managedSessionId}${HOOK_FILE_SUFFIX}`);
}

/**
 * The event name, session id and permission mode of a hook input, or null. Everything else in the input is dropped here. The
 * permission mode (#362) is the mode the CLI is really in, kept only when it is one of the documented values.
 */
function extractHookFields(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const { session_id: sessionId, hook_event_name: eventName, permission_mode: permissionMode } = payload;
  if (typeof sessionId !== 'string' || !PROVIDER_SESSION_ID.test(sessionId)) return null;
  if (typeof eventName !== 'string' || !HOOK_EVENTS.includes(eventName)) return null;
  return { sessionId, eventName, ...(PERMISSION_MODES.includes(permissionMode) ? { permissionMode } : {}) };
}

/** The sequence of the record already on disk (so a new one is always later), or 0. Never follows a link. */
function readExistingSequence(file) {
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_EXISTING_BYTES) return 0;
    const sequence = JSON.parse(fs.readFileSync(file, 'utf8')).sequence;
    return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : 0;
  } catch {
    return 0;
  }
}

function writeHookRecord(configDir, managedSessionId, fields, now) {
  const file = hookRecordPath(configDir, managedSessionId);
  const dir = path.dirname(file);
  // A real directory only: a symlink here would send the record wherever it points. Created private.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('observation-dir-not-a-directory');
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
  const observedAt = now.toISOString();
  const record = {
    schemaVersion: 1,
    eventId: randomUUID(),
    observedAt,
    sequence: Math.max(Date.parse(observedAt), readExistingSequence(file) + 1),
    providerSessionId: fields.sessionId,
    hook: { hookEventName: fields.eventName, ...(fields.permissionMode ? { permissionMode: fields.permissionMode } : {}) }
  };
  const temp = `${file}.tmp.${randomUUID()}`;
  try {
    // 'wx': never write through a link or over a file someone else put at that name.
    fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* never created or already moved */ }
    throw error;
  }
}

/**
 * Claude Code hook bridge, run as a `command` hook (https://code.claude.com/docs/en/hooks).
 *
 * It reads the hook input from stdin and keeps exactly three fields of it, `session_id`,
 * `hook_event_name` and `permission_mode` (only a documented value), after checking their shape. `transcript_path`, `cwd`, prompts, tool input and
 * everything else are dropped without being stored. It prints nothing, and always finishes with exit
 * code 0 (a hook that prints text on some events changes what Claude sees, and a non-zero exit shows an
 * error or, for exit 2, blocks the prompt, the tool call or the stop), whatever the input is.
 *
 * It writes only when the managed terminal gave it a valid MULTIAGENT_CLAUDE_SESSION_ID. The destination
 * is below CLAUDE_CONFIG_DIR, so an inherited environment value cannot choose an arbitrary location.
 *
 * Resolves (never rejects) once the input has been handled.
 */
function runHookBridge({ stdin = process.stdin, env = process.env, now = () => new Date(), timeoutMs = STDIN_TIMEOUT_MS, maxBytes = MAX_STDIN_BYTES } = {}) {
  return new Promise((resolve) => {
    let size = 0;
    let overflow = false;
    const chunks = [];
    let done = false;
    let timer;

    const finish = (handle) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { if (handle) handle(); } catch { /* fail closed: nothing is written, nothing is reported */ }
      try { if (typeof stdin.destroy === 'function') stdin.destroy(); } catch { /* already closed */ }
      resolve();
    };

    const handleInput = () => {
      if (overflow) return;
      const managedSessionId = env[SESSION_ID_ENV];
      const configDir = env.CLAUDE_CONFIG_DIR;
      if (typeof configDir !== 'string' || !path.isAbsolute(configDir) || typeof managedSessionId !== 'string' || !SESSION_ID.test(managedSessionId)) return;
      let parsed;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return; }
      const fields = extractHookFields(parsed);
      if (fields) writeHookRecord(configDir, managedSessionId, fields, now());
    };

    // Input that never ends (or ends too late) is abandoned: the hook must not hold the CLI up.
    timer = setTimeout(() => finish(null), timeoutMs);

    stdin.on('data', (chunk) => {
      if (done || overflow) return;
      size += chunk.length;
      if (size > maxBytes) { overflow = true; chunks.length = 0; return; }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stdin.on('end', () => finish(handleInput));
    stdin.on('error', () => finish(null));
    stdin.on('close', () => finish(null));
  });
}

if (require.main === module) {
  // Exit code 0 on every path; nothing is ever written to stdout or stderr.
  process.on('uncaughtException', () => process.exit(0));
  runHookBridge().then(() => process.exit(0), () => process.exit(0));
}

module.exports = { runHookBridge, extractHookFields, hookRecordPath, HOOK_EVENTS, HOOK_FILE_SUFFIX, SESSION_ID_ENV, PERMISSION_MODES };
