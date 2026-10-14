'use strict';

const crypto = require('node:crypto');
const { sameDirectory } = require('./profile');

const CONFIDENCE = Object.freeze({
  ACTUAL: 'actual',
  ESTIMATED: 'estimated',
  UNKNOWN: 'unknown'
});

// Default lifetime of a service-reported quota reading. Anything older is shown
// as stale and cannot be used as a hard dispatch gate.
const QUOTA_TTL_MS = 10 * 60 * 1000;

function toIso(value) {
  return new Date(value).toISOString();
}

function unknown(field, { source, observedAt, reason }) {
  return {
    field,
    value: null,
    unit: null,
    scope: null,
    source,
    observedAt: toIso(observedAt),
    confidence: CONFIDENCE.UNKNOWN,
    reason
  };
}

function observe(field, value, options) {
  const { unit = null, scope = null, source, observedAt, confidence = CONFIDENCE.ACTUAL,
    validForMs = null, reason = 'not-reported' } = options;
  if (value === null || value === undefined) {
    return unknown(field, { source, observedAt, reason });
  }
  return {
    field,
    value,
    unit,
    scope,
    source,
    observedAt: toIso(observedAt),
    confidence,
    validForMs
  };
}

// Only fresh, service-reported values may gate new work. Estimates and values
// with no stated lifetime can warn but never block or allow by themselves.
function isGateEligible(observation, now) {
  if (observation.confidence !== CONFIDENCE.ACTUAL) return false;
  if (observation.value === null || observation.validForMs === null) return false;
  return Date.parse(observation.observedAt) + observation.validForMs >= toTime(now);
}

function toTime(value) {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

// Opaque, in-memory comparison key for "is this the same real account". The
// raw identifier is never stored on the observation.
function subjectKey(provider, ...parts) {
  const hash = crypto.createHash('sha256');
  hash.update([provider, ...parts.map((part) => String(part).trim().toLowerCase())].join('\0'));
  return hash.digest('hex').slice(0, 32);
}

function claudeIdentityFromAuthStatus(status, { profile, observedAt, context }) {
  const source = 'claude auth status --json';
  const loggedIn = status.loggedIn === true;
  const authMethod = typeof status.authMethod === 'string' ? status.authMethod : 'unknown';
  const verifiable = loggedIn && authMethod === 'claude.ai' &&
    typeof status.email === 'string' && status.email !== '';
  const anomalies = [];

  const configDirMatches = typeof status.configDirectory === 'string'
    ? sameDirectory(status.configDirectory, profile.configDir, context)
    : null;
  if (configDirMatches === false) anomalies.push('config-dir-mismatch');
  if (typeof status.apiKeySource === 'string' && status.apiKeySource !== '') {
    anomalies.push('credential-from-environment');
  }
  if (profile.expectedAuthMethod && loggedIn && profile.expectedAuthMethod !== authMethod) {
    anomalies.push('auth-method-mismatch');
  }

  const unverifiedReason = loggedIn ? `auth-method:${authMethod}` : 'not-logged-in';
  return {
    profileId: profile.id,
    provider: 'claude',
    loggedIn,
    authMethod,
    apiProvider: status.apiProvider ?? null,
    configDirMatches,
    anomalies,
    subject: verifiable
      ? observe('subject', subjectKey('claude', status.email, status.orgId ?? ''), {
        scope: 'service-confirmed principal', source, observedAt
      })
      : unknown('subject', { source, observedAt, reason: unverifiedReason }),
    plan: observe('plan', verifiable ? status.subscriptionType ?? null : null, {
      scope: 'subscription plan', source, observedAt, reason: unverifiedReason
    })
  };
}

// The status line payload carries no account identity, so its quota values are
// bound to a profile only through the config directory the session launched with.
function claudeQuotaFromStatusLine(payload, { profileId, observedAt, ttlMs = QUOTA_TTL_MS }) {
  const source = 'claude status line rate_limits';
  const nowMs = toTime(observedAt);
  const limits = payload && payload.rate_limits;
  const windows = [
    ['five_hour', '5-hour window reported by service'],
    ['seven_day', '7-day window reported by service']
  ];
  const out = [];

  for (const [name, scope] of windows) {
    const window = limits && limits[name];
    const reasonMissing = limits
      ? 'window-absent'
      : 'rate_limits-absent (subscription accounts only, after first API response)';
    const resetsMs = window && Number.isFinite(window.resets_at) ? window.resets_at * 1000 : null;
    const expired = resetsMs !== null && resetsMs <= nowMs;
    const base = { source, observedAt, scope, validForMs: ttlMs };

    out.push(observe(
      `quota.${name}.used_percent`,
      !expired && window ? window.used_percentage : null,
      { ...base, unit: 'percent', reason: expired ? 'window-reset-passed' : reasonMissing }
    ));
    out.push(observe(
      `quota.${name}.resets_at`,
      !expired && resetsMs !== null ? toIso(resetsMs) : null,
      { ...base, unit: 'iso-8601', reason: expired ? 'window-reset-passed' : reasonMissing }
    ));
  }
  return { profileId, observations: out };
}

// `codexHome` is the effective CODEX_HOME echoed by the app-server `initialize`
// result, which lets the caller confirm the process really used the profile's dir.
function codexIdentityFromAccountRead(response, { profile, observedAt, codexHome, context }) {
  const source = 'codex app-server account/read';
  const account = response && response.account;
  const loggedIn = Boolean(account);
  const type = account ? account.type : null;
  const verifiable = type === 'chatgpt' && typeof account.email === 'string' && account.email !== '';
  const reason = loggedIn ? `account-type:${type}` : 'not-logged-in';
  const configDirMatches = typeof codexHome === 'string'
    ? sameDirectory(codexHome, profile.configDir, context)
    : null;
  const anomalies = configDirMatches === false ? ['config-dir-mismatch'] : [];

  return {
    profileId: profile.id,
    provider: 'codex',
    loggedIn,
    authMethod: type,
    apiProvider: null,
    configDirMatches,
    anomalies,
    subject: verifiable
      ? observe('subject', subjectKey('codex', account.email), {
        scope: 'service-confirmed principal', source, observedAt
      })
      : unknown('subject', { source, observedAt, reason }),
    plan: observe('plan', verifiable ? account.planType ?? null : null, {
      scope: 'subscription plan', source, observedAt, reason
    })
  };
}

// `resetsAt` has no documented unit in the protocol schema, so it is carried raw
// and labelled; nothing derives a time from it.
function codexQuotaFromRateLimits(response, { profileId, observedAt, ttlMs = QUOTA_TTL_MS }) {
  const source = 'codex app-server account/rateLimits/read';
  const snapshots = response && response.rateLimitsByLimitId
    ? Object.entries(response.rateLimitsByLimitId)
    : [['default', response && response.rateLimits]];
  const out = [];

  for (const [limitId, snapshot] of snapshots) {
    for (const slot of ['primary', 'secondary']) {
      const window = snapshot && snapshot[slot];
      const prefix = `quota.${limitId}.${slot}`;
      const scope = window && Number.isFinite(window.windowDurationMins)
        ? `${window.windowDurationMins}-minute window reported by service`
        : 'window length not reported';
      const base = { source, observedAt, scope, validForMs: ttlMs };
      out.push(observe(`${prefix}.used_percent`, window ? window.usedPercent : null,
        { ...base, unit: 'percent', reason: 'window-absent' }));
      out.push(observe(`${prefix}.resets_at_raw`, window ? window.resetsAt : null,
        { ...base, unit: 'epoch-unit-unspecified', reason: 'window-absent' }));
    }
  }
  return { profileId, observations: out };
}

// A real account reachable through two profiles must be counted once.
function groupBySubject(identities) {
  const groups = new Map();
  const unknownSubjects = [];
  for (const identity of identities) {
    if (identity.subject.confidence !== CONFIDENCE.ACTUAL) {
      unknownSubjects.push(identity.profileId);
      continue;
    }
    const key = `${identity.provider}:${identity.subject.value}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(identity.profileId);
  }
  return {
    accounts: [...groups.values()],
    duplicates: [...groups.values()].filter((ids) => ids.length > 1),
    unverified: unknownSubjects
  };
}

module.exports = {
  CONFIDENCE,
  QUOTA_TTL_MS,
  unknown,
  observe,
  isGateEligible,
  claudeIdentityFromAuthStatus,
  claudeQuotaFromStatusLine,
  codexIdentityFromAccountRead,
  codexQuotaFromRateLimits,
  groupBySubject
};
