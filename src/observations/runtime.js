'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { SessionObservationCore } = require('./session');
const { createClaudeSessionEvidenceAdapter } = require('./claude');

const SESSION_ID_ENV = 'MULTIAGENT_CLAUDE_SESSION_ID';
const SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,79}$/;
const RECORD_KEYS = new Set(['schemaVersion', 'eventId', 'observedAt', 'sequence', 'statusLine']);
const STATUS_KEYS = new Set(['model', 'cost']);

const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function observationPath(configDir, sessionId) {
  if (typeof configDir !== 'string' || !path.isAbsolute(configDir) || !SESSION_ID.test(sessionId)) {
    throw new TypeError('managed observation binding is invalid');
  }
  return path.join(configDir, 'session-observations', `${sessionId}.json`);
}

function readRecord(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isPlain(parsed) || Object.keys(parsed).some(key => !RECORD_KEYS.has(key)) || parsed.schemaVersion !== 1 ||
        typeof parsed.eventId !== 'string' || typeof parsed.observedAt !== 'string' ||
        !Number.isSafeInteger(parsed.sequence) || !isPlain(parsed.statusLine) ||
        Object.keys(parsed.statusLine).some(key => !STATUS_KEYS.has(key))) return null;
    return parsed;
  } catch {
    return null;
  }
}

class SessionObservationRuntime {
  constructor(options = {}) {
    this.core = options.core ?? new SessionObservationCore(options);
    this.bindings = new Map();
  }

  prepare({ sessionId, provider, accountProfileId, env }) {
    if (provider !== 'claude' || !env || typeof env.CLAUDE_CONFIG_DIR !== 'string' || accountProfileId === 'unassigned') {
      return { env, active: false };
    }
    const file = observationPath(env.CLAUDE_CONFIG_DIR, sessionId);
    try { fs.rmSync(file, { force: true }); } catch { /* An unreadable old file stays unknown. */ }
    this.core.register({ sessionId, provider, accountProfileId });
    this.bindings.set(sessionId, {
      file,
      adapter: createClaudeSessionEvidenceAdapter({ core: this.core, sessionId, accountProfileId })
    });
    return { env: { ...env, [SESSION_ID_ENV]: sessionId }, active: true };
  }

  snapshot(sessionId, at = new Date().toISOString()) {
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
    const binding = this.bindings.get(sessionId);
    this.bindings.delete(sessionId);
    if (binding) {
      try { fs.rmSync(binding.file, { force: true }); } catch { /* Local cleanup failure exposes no data. */ }
    }
  }
}

module.exports = { SessionObservationRuntime, SESSION_ID_ENV, observationPath, readRecord };
