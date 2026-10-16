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

function toTime(value) {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function isPercent(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
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
  if (unit === 'percent' && !isPercent(value)) {
    return unknown(field, { source, observedAt, reason: 'invalid-value' });
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

// Only fresh, service-reported values may gate new work. Estimates, values with
// no usable lifetime, samples from the future and out-of-range percentages can
// warn but never block or allow by themselves. The lifetime ends exactly at
// observedAt + validForMs, which for quota readings never passes the reset.
function isGateEligible(observation, now) {
  if (observation.confidence !== CONFIDENCE.ACTUAL) return false;
  if (typeof observation.source !== 'string' || observation.source.trim() === '') return false;
  return isFresh(observation, now);
}

// Freshness is independent of confidence: estimates can remain fresh enough to display,
// while isGateEligible still restricts hard decisions to service-reported actual values.
function isFresh(observation, now) {
  if (!observation || ![CONFIDENCE.ACTUAL, CONFIDENCE.ESTIMATED].includes(observation.confidence)) return false;
  if (observation.value === null || observation.value === undefined) return false;
  if (observation.unit === 'percent' && !isPercent(observation.value)) return false;

  const observedMs = Date.parse(observation.observedAt);
  const nowMs = toTime(now);
  if (!Number.isFinite(observedMs) || !Number.isFinite(nowMs)) return false;
  if (observedMs > nowMs) return false;

  const lifetime = observation.validForMs;
  if (typeof lifetime !== 'number' || !Number.isFinite(lifetime) || lifetime <= 0) return false;
  return nowMs < observedMs + lifetime;
}

// Lifetime of a quota reading: the configured TTL, cut short so it never
// reaches the window's reset instant when that is known.
function quotaLifetime(ttlMs, nowMs, resetsMs) {
  const cap = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : QUOTA_TTL_MS;
  return resetsMs === null ? cap : Math.min(cap, resetsMs - nowMs);
}

// `resetsAt` has no documented unit in the protocol schema. Magnitude separates
// seconds (~1.7e9) from milliseconds (~1.7e12); the result is only used to
// shorten a reading's lifetime, so a wrong guess cannot extend it.
function codexResetMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value < 1e11 ? value * 1000 : value;
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
    const rawReset = window ? window.resets_at : undefined;
    const resetGiven = rawReset !== undefined && rawReset !== null;
    const resetsMs = resetGiven && Number.isFinite(rawReset) && rawReset > 0 ? rawReset * 1000 : null;
    const resetInvalid = resetGiven && resetsMs === null;
    const expired = resetsMs !== null && resetsMs <= nowMs;
    let reason = reasonMissing;
    if (expired) reason = 'window-reset-passed';
    else if (resetInvalid) reason = 'invalid-reset';
    const usable = Boolean(window) && !expired && !resetInvalid;
    const base = { source, observedAt, scope, validForMs: quotaLifetime(ttlMs, nowMs, resetsMs) };

    out.push(observe(`quota.${name}.used_percent`, usable ? window.used_percentage : null,
      { ...base, unit: 'percent', reason }));
    out.push(observe(`quota.${name}.resets_at`, usable && resetsMs !== null ? toIso(resetsMs) : null,
      { ...base, unit: 'iso-8601', reason }));
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

// The raw `resetsAt` value is carried and labelled as-is; the derived instant is
// used only to end a reading's lifetime at the reset.
function codexQuotaFromRateLimits(response, { profileId, observedAt, ttlMs = QUOTA_TTL_MS }) {
  const source = 'codex app-server account/rateLimits/read';
  const nowMs = toTime(observedAt);
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
      const rawReset = window ? window.resetsAt : undefined;
      const resetGiven = rawReset !== undefined && rawReset !== null;
      const resetsMs = resetGiven ? codexResetMs(rawReset) : null;
      const resetInvalid = resetGiven && resetsMs === null;
      const expired = resetsMs !== null && resetsMs <= nowMs;
      let reason = 'window-absent';
      if (expired) reason = 'window-reset-passed';
      else if (resetInvalid) reason = 'invalid-reset';
      const usable = Boolean(window) && !expired && !resetInvalid;
      const base = { source, observedAt, scope, validForMs: quotaLifetime(ttlMs, nowMs, resetsMs) };
      out.push(observe(`${prefix}.used_percent`, usable ? window.usedPercent : null,
        { ...base, unit: 'percent', reason }));
      out.push(observe(`${prefix}.resets_at_raw`, usable && resetGiven ? rawReset : null,
        { ...base, unit: 'epoch-unit-unspecified', reason }));
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
  isFresh,
  isGateEligible,
  claudeIdentityFromAuthStatus,
  claudeQuotaFromStatusLine,
  codexIdentityFromAccountRead,
  codexQuotaFromRateLimits,
  groupBySubject
};
