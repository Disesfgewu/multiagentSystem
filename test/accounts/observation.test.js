'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CONFIDENCE,
  QUOTA_TTL_MS,
  observe,
  isGateEligible,
  claudeIdentityFromAuthStatus,
  claudeQuotaFromStatusLine,
  codexIdentityFromAccountRead,
  codexQuotaFromRateLimits,
  groupBySubject
} = require('../../src/accounts/observation');

const identity = (value) => value;
const context = { platform: 'darwin', homeDir: '/home/user', repoRoot: '/work/project', realpath: identity };
const profile = { id: 'p1', provider: 'claude', label: 'Test account', configDir: '/home/user/accounts/a' };
const observedAt = '2026-01-01T00:00:00.000Z';
const nowSeconds = Date.parse(observedAt) / 1000;

const subscriptionStatus = {
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  configDirectory: '/home/user/accounts/a',
  email: 'person@example.test',
  orgId: 'org-synthetic',
  orgName: 'Synthetic Org',
  subscriptionType: 'max'
};

test('observe turns a missing value into an explicit unknown with a reason', () => {
  const result = observe('quota', undefined, { source: 's', observedAt, reason: 'window-absent' });
  assert.equal(result.confidence, CONFIDENCE.UNKNOWN);
  assert.equal(result.value, null);
  assert.equal(result.reason, 'window-absent');
});

test('only fresh actual values with a lifetime are gate eligible', () => {
  const fresh = observe('x', 10, { source: 's', observedAt, validForMs: 1000 });
  assert.equal(isGateEligible(fresh, new Date(Date.parse(observedAt) + 1000)), true);
  assert.equal(isGateEligible(fresh, new Date(Date.parse(observedAt) + 1001)), false);
  assert.equal(isGateEligible(observe('x', 10, { source: 's', observedAt }), observedAt), false);
  const estimate = observe('x', 10, { source: 's', observedAt, validForMs: 1000, confidence: CONFIDENCE.ESTIMATED });
  assert.equal(isGateEligible(estimate, observedAt), false);
  assert.equal(isGateEligible(observe('x', null, { source: 's', observedAt }), observedAt), false);
});

test('Claude subscription login yields a confirmed subject without storing the raw identity', () => {
  const result = claudeIdentityFromAuthStatus(subscriptionStatus, { profile, observedAt, context });
  assert.equal(result.subject.confidence, CONFIDENCE.ACTUAL);
  assert.equal(result.plan.value, 'max');
  assert.equal(result.configDirMatches, true);
  assert.deepEqual(result.anomalies, []);
  const serialized = JSON.stringify(result);
  for (const secret of ['person@example.test', 'org-synthetic', 'Synthetic Org']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('an API key from the environment is logged in but not a verified identity', () => {
  const status = {
    loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty',
    apiKeySource: 'ANTHROPIC_API_KEY', configDirectory: '/home/user/accounts/a'
  };
  const result = claudeIdentityFromAuthStatus(status, { profile, observedAt, context });
  assert.equal(result.loggedIn, true);
  assert.equal(result.subject.confidence, CONFIDENCE.UNKNOWN);
  assert.equal(result.subject.reason, 'auth-method:api_key');
  assert.deepEqual(result.anomalies, ['credential-from-environment']);
  assert.equal(result.plan.confidence, CONFIDENCE.UNKNOWN);
});

test('logged-out, directory mismatch and unexpected login method are flagged', () => {
  const loggedOut = claudeIdentityFromAuthStatus(
    { loggedIn: false, authMethod: 'none', configDirectory: '/home/user/accounts/a' },
    { profile, observedAt, context }
  );
  assert.equal(loggedOut.subject.reason, 'not-logged-in');

  const mismatch = claudeIdentityFromAuthStatus(
    { ...subscriptionStatus, configDirectory: '/home/user/.claude' },
    { profile, observedAt, context }
  );
  assert.deepEqual(mismatch.anomalies, ['config-dir-mismatch']);

  const wrongMethod = claudeIdentityFromAuthStatus(
    subscriptionStatus,
    { profile: { ...profile, expectedAuthMethod: 'console' }, observedAt, context }
  );
  assert.deepEqual(wrongMethod.anomalies, ['auth-method-mismatch']);
});

test('Claude status line quota keeps source, window and lifetime; zero percent is a real value', () => {
  const payload = {
    rate_limits: {
      five_hour: { used_percentage: 0, resets_at: nowSeconds + 3600 },
      seven_day: { used_percentage: 41.2, resets_at: nowSeconds + 86400 }
    }
  };
  const { observations } = claudeQuotaFromStatusLine(payload, { profileId: 'p1', observedAt });
  const byField = Object.fromEntries(observations.map((entry) => [entry.field, entry]));
  assert.equal(byField['quota.five_hour.used_percent'].value, 0);
  assert.equal(byField['quota.five_hour.used_percent'].unit, 'percent');
  assert.equal(byField['quota.five_hour.used_percent'].validForMs, QUOTA_TTL_MS);
  assert.equal(byField['quota.seven_day.resets_at'].value, new Date((nowSeconds + 86400) * 1000).toISOString());
  assert.equal(byField['quota.five_hour.used_percent'].source, 'claude status line rate_limits');
});

test('Claude status line quota is unknown when absent or after the window reset', () => {
  const none = claudeQuotaFromStatusLine({}, { profileId: 'p1', observedAt });
  assert.equal(none.observations.every((entry) => entry.confidence === CONFIDENCE.UNKNOWN), true);
  assert.match(none.observations[0].reason, /^rate_limits-absent/);

  const partial = claudeQuotaFromStatusLine(
    { rate_limits: { five_hour: { used_percentage: 5, resets_at: nowSeconds - 1 } } },
    { profileId: 'p1', observedAt }
  );
  const byField = Object.fromEntries(partial.observations.map((entry) => [entry.field, entry]));
  assert.equal(byField['quota.five_hour.used_percent'].reason, 'window-reset-passed');
  assert.equal(byField['quota.seven_day.used_percent'].reason, 'window-absent');
});

test('Codex account types map to verified or unknown subjects', () => {
  const chatgpt = codexIdentityFromAccountRead(
    { account: { type: 'chatgpt', email: 'person@example.test', planType: 'plus' }, requiresOpenaiAuth: true },
    { profile: { ...profile, provider: 'codex' }, observedAt }
  );
  assert.equal(chatgpt.subject.confidence, CONFIDENCE.ACTUAL);
  assert.equal(chatgpt.plan.value, 'plus');
  assert.equal(JSON.stringify(chatgpt).includes('person@example.test'), false);

  const apiKey = codexIdentityFromAccountRead(
    { account: { type: 'apiKey' }, requiresOpenaiAuth: true },
    { profile: { ...profile, provider: 'codex' }, observedAt }
  );
  assert.equal(apiKey.loggedIn, true);
  assert.equal(apiKey.subject.reason, 'account-type:apiKey');

  const out = codexIdentityFromAccountRead(
    { account: null, requiresOpenaiAuth: true },
    { profile: { ...profile, provider: 'codex' }, observedAt }
  );
  assert.equal(out.loggedIn, false);
  assert.equal(out.subject.reason, 'not-logged-in');
});

test('Codex rate limits are listed per bucket with the reset value left raw', () => {
  const response = {
    rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1767225600 } },
    rateLimitsByLimitId: {
      codex: {
        primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1767225600 },
        secondary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: null }
      }
    }
  };
  const { observations } = codexQuotaFromRateLimits(response, { profileId: 'p2', observedAt });
  const byField = Object.fromEntries(observations.map((entry) => [entry.field, entry]));
  assert.equal(byField['quota.codex.primary.used_percent'].value, 10);
  assert.equal(byField['quota.codex.primary.used_percent'].scope, '300-minute window reported by service');
  assert.equal(byField['quota.codex.primary.resets_at_raw'].value, 1767225600);
  assert.equal(byField['quota.codex.primary.resets_at_raw'].unit, 'epoch-unit-unspecified');
  assert.equal(byField['quota.codex.secondary.resets_at_raw'].confidence, CONFIDENCE.UNKNOWN);
  assert.equal(Object.keys(byField).some((field) => field.startsWith('quota.default')), false);
});

test('two profiles on one real account are grouped; other providers and unknowns are not merged', () => {
  const claudeA = claudeIdentityFromAuthStatus(subscriptionStatus, { profile, observedAt, context });
  const claudeB = claudeIdentityFromAuthStatus(
    { ...subscriptionStatus, email: 'PERSON@example.test ' },
    { profile: { ...profile, id: 'p2' }, observedAt, context }
  );
  const codexSameEmail = codexIdentityFromAccountRead(
    { account: { type: 'chatgpt', email: 'person@example.test', planType: 'plus' } },
    { profile: { ...profile, id: 'p3', provider: 'codex' }, observedAt }
  );
  const apiKey = claudeIdentityFromAuthStatus(
    { loggedIn: true, authMethod: 'api_key', apiKeySource: 'ANTHROPIC_API_KEY' },
    { profile: { ...profile, id: 'p4' }, observedAt, context }
  );
  const groups = groupBySubject([claudeA, claudeB, codexSameEmail, apiKey]);
  assert.deepEqual(groups.duplicates, [['p1', 'p2']]);
  assert.deepEqual(groups.accounts, [['p1', 'p2'], ['p3']]);
  assert.deepEqual(groups.unverified, ['p4']);
});
