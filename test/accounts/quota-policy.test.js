'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { observe, CONFIDENCE } = require('../../src/accounts/observation');
const { PrivateStore } = require('../../src/storage/private-store');
const { validatePolicy, decideDispatch, summarizeQuota, QuotaDispatcher, savePolicy, loadPolicy, DEFAULT_POLICY } = require('../../src/accounts/quota-policy');
const { sandbox, COLLECTIONS } = require('../storage/helpers');

const NOW = new Date('2026-10-15T12:00:00.000Z');
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60_000);
const reading = (window, value, over = {}) => observe(`quota.${window}.used_percent`, value, {
  unit: 'percent', scope: 'account', source: 'synthetic status line', observedAt: minutesAgo(1), validForMs: 10 * 60_000, ...over
});
const policy = (over = {}) => ({ warnAtPercent: 70, blockAtPercent: 90, ...over });
const decide = (over = {}) => decideDispatch({ policy: policy(), observations: [reading('five_hour', 10)], now: NOW, ...over });
const codes = (result) => result.reasons.map((reason) => reason.code);

test('policy validation: thresholds, limit and unknown-quota setting; unknown fields rejected', () => {
  assert.equal(validatePolicy({}).ok, true);
  assert.equal(validatePolicy({}).policy.unknownQuota, 'require-confirmation');
  assert.equal(validatePolicy(policy({ maxConcurrent: 2, unknownQuota: 'block' })).ok, true);
  for (const [input, problem] of [
    [null, 'policy-not-object'], [[], 'policy-not-object'], ['x', 'policy-not-object'],
    [{ extra: 1 }, 'policy-unknown-field'],
    [{ warnAtPercent: -1 }, 'warn-percent-invalid'], [{ warnAtPercent: 101 }, 'warn-percent-invalid'], [{ warnAtPercent: NaN }, 'warn-percent-invalid'], [{ warnAtPercent: '70' }, 'warn-percent-invalid'],
    [{ blockAtPercent: Infinity }, 'block-percent-invalid'], [{ blockAtPercent: null }, 'block-percent-invalid'],
    [{ warnAtPercent: 80, blockAtPercent: 70 }, 'warn-above-block'],
    [{ maxConcurrent: 0 }, 'max-concurrent-invalid'], [{ maxConcurrent: 1.5 }, 'max-concurrent-invalid'], [{ maxConcurrent: 65 }, 'max-concurrent-invalid'], [{ maxConcurrent: '2' }, 'max-concurrent-invalid'],
    [{ unknownQuota: 'allow' }, 'unknown-quota-invalid'], [{ unknownQuota: null }, 'unknown-quota-invalid']
  ]) {
    const checked = validatePolicy(input);
    assert.equal(checked.ok, false, JSON.stringify(input));
    assert.ok(checked.problems.includes(problem), `${JSON.stringify(input)} -> ${checked.problems}`);
  }
  assert.equal(validatePolicy(policy({ warnAtPercent: 90 })).ok, true, 'warn equal to block is allowed');
  assert.ok(Object.isFrozen(validatePolicy({}).policy));
});

test('threshold boundaries: below warns nothing, at warn warns, at block blocks', () => {
  assert.deepEqual([decide({ observations: [reading('w', 69.99)] }).decision, decide({ observations: [reading('w', 70)] }).decision], ['allow', 'warn']);
  assert.deepEqual([decide({ observations: [reading('w', 89.99)] }).decision, decide({ observations: [reading('w', 90)] }).decision], ['warn', 'block']);
  assert.equal(decide({ observations: [reading('w', 100)] }).allowed, false);
  assert.equal(decide({ observations: [reading('w', 0)] }).allowed, true);
  assert.equal(decide({ policy: {}, observations: [reading('w', 99)] }).decision, 'allow', 'no thresholds, no gate');
});

test('the worst window decides, and a warning is allowed', () => {
  const result = decide({ observations: [reading('five_hour', 20), reading('seven_day', 95)] });
  assert.equal(result.decision, 'block');
  assert.deepEqual(result.reasons.find((r) => r.code === 'quota-block-threshold').window, 'seven_day');
  const warn = decide({ observations: [reading('a', 75)] });
  assert.deepEqual([warn.decision, warn.allowed], ['warn', true]);
});

test('only a fresh service-reported reading can block; estimates and stale readings only warn', () => {
  const estimate = reading('w', 99, { confidence: CONFIDENCE.ESTIMATED });
  const stale = reading('w', 99, { observedAt: minutesAgo(30) });
  const future = reading('w', 99, { observedAt: new Date(NOW.getTime() + 60_000) });
  const noLifetime = reading('w', 99, { validForMs: null });
  for (const item of [estimate, stale, future, noLifetime]) {
    const result = decide({ observations: [item] });
    assert.notEqual(result.decision, 'block', JSON.stringify(item));
    assert.ok(codes(result).includes('quota-unknown'), 'no usable reading means the quota is unknown');
    assert.equal(codes(result).includes('unverified-reading-over-warning'), item !== future, JSON.stringify(item));
  }
  const futureSummary = summarizeQuota([future], NOW)[0];
  assert.deepEqual([futureSummary.usedPercent, futureSummary.confidence, futureSummary.gateEligible], [null, 'unknown', false]);
  const noSource = reading('without_source', 95, { source: null });
  const withoutSource = decide({ observations: [noSource] });
  assert.equal(codes(withoutSource).includes('quota-block-threshold'), false);
  assert.ok(codes(withoutSource).includes('quota-unknown'));
  assert.equal(summarizeQuota([noSource], NOW)[0].gateEligible, false);
  const mixed = decide({ observations: [estimate, reading('x', 10)] });
  assert.equal(mixed.decision, 'warn');
  assert.ok(codes(mixed).includes('unverified-reading-over-warning'));
});

test('a reading expires exactly at its lifetime, and at the reset', () => {
  assert.equal(decide({ observations: [reading('w', 95, { observedAt: minutesAgo(9.99) })] }).decision, 'block');
  assert.ok(codes(decide({ observations: [reading('w', 95, { observedAt: minutesAgo(10) })] })).includes('quota-unknown'));
  // the lifetime of a reading is cut at the reset; an expired one no longer gates after the window reset
  const cut = reading('w', 95, { validForMs: 2 * 60_000, observedAt: minutesAgo(2) });
  assert.ok(codes(decide({ observations: [cut] })).includes('quota-unknown'));
});

test('unknown quota follows the setting: confirmation by default, or block; never silently allowed', () => {
  for (const observations of [[], undefined, null, 'x', [null, 7, {}], [observe('quota.w.used_percent', null, { source: 's', observedAt: NOW })]]) {
    const result = decide({ observations });
    assert.equal(result.decision, 'confirm', String(observations));
    assert.equal(result.allowed, false);
    assert.ok(codes(result).includes('quota-unknown'));
  }
  assert.equal(decide({ policy: policy({ unknownQuota: 'block' }), observations: [] }).decision, 'block');
  assert.equal(decide({ policy: {}, observations: [] }).decision, 'confirm', 'default setting');
});

test('approval: confirm lifts a confirmation, only override lifts a quota block, nothing lifts a concurrency limit', () => {
  const unknown = { observations: [] };
  assert.equal(decide({ ...unknown, approval: 'confirm' }).allowed, true);
  assert.equal(decide({ ...unknown, approval: 'confirm' }).approvedBy, 'confirm');
  assert.equal(decide({ ...unknown, approval: 'yes' }).allowed, false);
  assert.equal(decide({ ...unknown, approval: true }).allowed, false);

  const blocked = { observations: [reading('w', 95)] };
  assert.equal(decide({ ...blocked, approval: 'confirm' }).allowed, false);
  assert.equal(decide({ ...blocked, approval: 'override' }).allowed, true);
  const blockUnknown = { policy: policy({ unknownQuota: 'block' }), observations: [] };
  assert.equal(decide({ ...blockUnknown, approval: 'confirm' }).allowed, false);
  assert.equal(decide({ ...blockUnknown, approval: 'override' }).allowed, true);

  const full = decide({ policy: policy({ maxConcurrent: 1 }), running: 1, approval: 'override' });
  assert.deepEqual([full.decision, full.allowed, codes(full)], ['block', false, ['concurrency-limit']]);
  assert.equal(full.reasons[0].overridable, false);
  assert.equal(decide({ approval: 'override' }).approvedBy, undefined, 'an allowed task records no approval');
});

test('concurrency limit boundary and bad counts', () => {
  const limited = policy({ maxConcurrent: 2 });
  assert.equal(decide({ policy: limited, running: 1 }).allowed, true);
  assert.equal(decide({ policy: limited, running: 2 }).allowed, false);
  assert.equal(decide({ policy: limited, running: 3 }).allowed, false);
  assert.equal(decide({ policy: {}, observations: [reading('w', 1)], running: 100 }).allowed, true, 'no limit set');
  for (const running of [-1, 1.5, NaN, '1', null]) assert.deepEqual(codes(decide({ running })), ['running-count-invalid'], String(running));
});

test('invalid policy or time blocks and names the problem without echoing values', () => {
  assert.deepEqual(codes(decide({ policy: { warnAtPercent: 'secret-value' } })), ['policy-invalid']);
  assert.deepEqual(codes(decide({ policy: undefined })), ['policy-invalid']);
  assert.equal(JSON.stringify(decide({ policy: { warnAtPercent: 'secret-value' } })).includes('secret-value'), false);
  for (const now of ['nope', undefined, NaN, null]) assert.deepEqual(codes(decide({ now })), ['time-invalid'], String(now));
  assert.equal(decide({ now: NOW.toISOString() }).decision, 'allow');
});

test('summary shows window, source, read time, trust, freshness and reset time, in a fixed order', () => {
  const observations = [
    reading('seven_day', 40), reading('five_hour', 20, { confidence: CONFIDENCE.ESTIMATED }),
    observe('quota.seven_day.resets_at', '2026-10-20T00:00:00.000Z', { source: 'synthetic status line', observedAt: minutesAgo(1), validForMs: 600_000 }),
    observe('quota.old.used_percent', 10, { unit: 'percent', source: 's', observedAt: minutesAgo(60), validForMs: 600_000 })
  ];
  const rows = summarizeQuota(observations, NOW);
  assert.deepEqual(rows.map((row) => row.window), ['five_hour', 'old', 'seven_day']);
  assert.deepEqual(rows[0], { window: 'five_hour', usedPercent: 20, source: 'synthetic status line', observedAt: minutesAgo(1).toISOString(), confidence: 'estimated', fresh: true, gateEligible: false, resetsAt: null });
  assert.deepEqual([rows[1].fresh, rows[1].gateEligible], [false, false]);
  assert.deepEqual([rows[2].gateEligible, rows[2].resetsAt], [true, '2026-10-20T00:00:00.000Z']);
  assert.deepEqual(summarizeQuota(undefined, NOW), []);
  const unread = summarizeQuota([observe('quota.w.used_percent', null, { source: 's', observedAt: NOW })], NOW);
  assert.deepEqual([unread[0].usedPercent, unread[0].confidence, unread[0].gateEligible], [null, 'unknown', false]);
});

test('quota thresholds and summaries require an explicit percent unit', () => {
  for (const unit of [undefined, null, 'tokens']) {
    const malformed = reading('five_hour', 99, { unit });
    const result = decide({ observations: [malformed], approval: 'override' });
    assert.ok(codes(result).includes('window-unverified'), `unit ${String(unit)} remains unverified`);
    assert.equal(codes(result).includes('unverified-reading-over-warning'), false);
    assert.equal(codes(result).includes('quota-block-threshold'), false);
    const [row] = summarizeQuota([malformed], NOW);
    assert.equal(row.usedPercent, null);
    assert.equal(row.gateEligible, false);
  }
});

test('double dispatch: two requests for the last slot cannot both succeed; a release frees it once', () => {
  const dispatcher = new QuotaDispatcher();
  const request = { accountKey: 'real-1', policy: policy({ maxConcurrent: 1 }), observations: [reading('w', 10)], now: NOW };
  const first = dispatcher.reserve(request);
  const second = dispatcher.reserve(request);
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  assert.deepEqual(codes(second), ['concurrency-limit']);
  assert.equal(dispatcher.running('real-1'), 1);
  assert.equal(dispatcher.release(first.reservation), true);
  assert.equal(dispatcher.release(first.reservation), false, 'releasing twice changes nothing');
  assert.equal(dispatcher.running('real-1'), 0);
  assert.equal(dispatcher.reserve(request).allowed, true);
});

test('slots are per real account, and external running agents count', () => {
  const dispatcher = new QuotaDispatcher();
  const base = { policy: policy({ maxConcurrent: 2 }), observations: [reading('w', 10)], now: NOW };
  assert.equal(dispatcher.reserve({ ...base, accountKey: 'a' }).allowed, true);
  assert.equal(dispatcher.reserve({ ...base, accountKey: 'b' }).allowed, true);
  assert.equal(dispatcher.reserve({ ...base, accountKey: 'a', externalRunning: 1 }).allowed, false);
  assert.equal(dispatcher.reserve({ ...base, accountKey: 'a' }).allowed, true);
  assert.equal(dispatcher.reserve({ ...base, accountKey: 'a' }).allowed, false);
  assert.equal(dispatcher.running('b'), 1);
  assert.equal(dispatcher.release({ accountKey: 'b', id: 'slot-1' }), false, 'a slot of another account is not released');
  assert.equal(dispatcher.running('a'), 2);
});

test('a refused request takes no slot; bad requests are refused', () => {
  const dispatcher = new QuotaDispatcher();
  const blocked = dispatcher.reserve({ accountKey: 'a', policy: policy(), observations: [reading('w', 99)], now: NOW });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reservation, undefined);
  assert.equal(dispatcher.running('a'), 0);
  for (const accountKey of ['', undefined, 5, null]) assert.deepEqual(codes(dispatcher.reserve({ accountKey, policy: policy(), now: NOW })), ['account-key-invalid']);
  assert.deepEqual(codes(dispatcher.reserve({ accountKey: 'a', externalRunning: -1, policy: policy(), now: NOW })), ['running-count-invalid']);
  for (const reservation of [null, undefined, 'slot-1', {}, { accountKey: 'zzz', id: 'slot-1' }]) assert.equal(dispatcher.release(reservation), false);
});

test('an approved confirmation takes a slot and is recorded', () => {
  const dispatcher = new QuotaDispatcher();
  const result = dispatcher.reserve({ accountKey: 'a', policy: policy(), observations: [], now: NOW, approval: 'confirm' });
  assert.deepEqual([result.allowed, result.approvedBy, dispatcher.running('a')], [true, 'confirm', 1]);
});

test('policies persist in the private store; invalid ones are refused; a bad stored record is an error, not the default', (t) => {
  const box = sandbox(t);
  const store = new PrivateStore({ dir: box.dir, repoRoot: box.repoRoot, collections: COLLECTIONS });
  assert.deepEqual(loadPolicy(store, 'acct-aaaaaaaaaaaa'), { ok: true, policy: DEFAULT_POLICY, stored: false });
  assert.equal(savePolicy(store, 'acct-aaaaaaaaaaaa', policy({ maxConcurrent: 2, unknownQuota: 'block' })).ok, true);
  const again = new PrivateStore({ dir: box.dir, repoRoot: box.repoRoot, collections: COLLECTIONS });
  assert.deepEqual(loadPolicy(again, 'acct-aaaaaaaaaaaa').policy, { warnAtPercent: 70, blockAtPercent: 90, maxConcurrent: 2, unknownQuota: 'block' });
  assert.equal(loadPolicy(again, 'acct-bbbbbbbbbbbb').stored, false, 'one record per account');
  const refused = savePolicy(store, 'acct-aaaaaaaaaaaa', { warnAtPercent: 'x' });
  assert.deepEqual([refused.ok, refused.reason], [false, 'policy-invalid']);
  assert.equal(loadPolicy(store, 'acct-aaaaaaaaaaaa').policy.maxConcurrent, 2, 'a refused save changes nothing');
  assert.equal(store.put('policies', 'quota-acct-cccccccccccc', { warnAtPercent: 500 }).ok, true);
  const bad = loadPolicy(store, 'acct-cccccccccccc');
  assert.deepEqual([bad.ok, bad.reason], [false, 'stored-policy-invalid']);
  assert.equal(bad.policy, undefined);
});

test('a later, milder window or reason never lowers an earlier, stricter one', () => {
  const blockFirst = decide({ observations: [reading('a_window', 95), reading('b_window', 75), reading('c_window', 1)] });
  assert.equal(blockFirst.decision, 'block');
  const limitFirst = decide({ policy: policy({ maxConcurrent: 1 }), running: 1, observations: [reading('w', 75)], approval: 'override' });
  assert.deepEqual([limitFirst.decision, limitFirst.allowed], ['block', false]);
  const confirmFirst = decide({ observations: [reading('a', 10, { confidence: CONFIDENCE.ESTIMATED }), reading('b', 10, { confidence: CONFIDENCE.ESTIMATED })] });
  assert.equal(confirmFirst.decision, 'confirm');
});

test('an out-of-range unverified value is not reported as "over the warning level"', () => {
  const crafted = { field: 'quota.w.used_percent', value: 150, unit: 'percent', scope: 'account', source: 's', observedAt: minutesAgo(1).toISOString(), confidence: CONFIDENCE.ESTIMATED, validForMs: 600_000 };
  assert.ok(codes(decide({ observations: [crafted] })).includes('window-unverified'));
  assert.equal(codes(decide({ observations: [crafted] })).includes('unverified-reading-over-warning'), false);
  const noWarnLevel = decide({ policy: {}, observations: [reading('w', 99, { confidence: CONFIDENCE.ESTIMATED })] });
  assert.ok(codes(noWarnLevel).includes('window-unverified'));
});

test('the summary treats a window without a usable value as unknown whatever its stated confidence', () => {
  const crafted = { field: 'quota.w.used_percent', value: null, unit: 'percent', scope: 'account', source: 's', observedAt: minutesAgo(1).toISOString(), confidence: CONFIDENCE.ACTUAL, validForMs: 600_000 };
  const [row] = summarizeQuota([crafted], NOW);
  assert.deepEqual([row.usedPercent, row.confidence, row.fresh, row.gateEligible], [null, 'unknown', false, false]);
});
