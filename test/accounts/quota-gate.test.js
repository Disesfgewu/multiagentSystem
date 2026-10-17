'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { observe } = require('../../src/accounts/observation');
const { gateLaunch, commitDispatch, describePolicy, describeQuota, describeCurrentState, policyFromInput, wordsFor, REASON_WORDS, LIMITS_NOTE } = require('../../src/accounts/quota-gate');
const { QuotaDispatcher } = require('../../src/accounts/quota-policy');

const NOW = new Date('2026-10-16T12:00:00.000Z');
const reading = (window, value, over = {}) => observe(`quota.${window}.used_percent`, value, { unit: 'percent', scope: 'account', source: 'synthetic', observedAt: new Date(NOW.getTime() - 60_000), validForMs: 600_000, ...over });
const stored = (policy) => ({ ok: true, stored: true, policy: { unknownQuota: 'require-confirmation', ...policy } });
const gate = (over = {}) => gateLaunch({ policyRead: stored({ warnAtPercent: 70, blockAtPercent: 90 }), observations: [reading('five_hour', 10)], now: NOW, running: 0, ...over });

test('an account with no stored policy is never gated, whatever else is true', () => {
  for (const running of [0, 5, 500]) {
    const result = gateLaunch({ policyRead: { ok: true, stored: false, policy: { unknownQuota: 'require-confirmation' } }, observations: [], now: NOW, running });
    assert.deepEqual([result.action, result.allowed, result.lines, result.note], ['allow', true, [], null]);
  }
});

test('a stored policy that cannot be read stops the launch and says so', () => {
  for (const policyRead of [{ ok: false }, undefined, null, {}, { ok: false, reason: 'store-locked' }]) {
    const result = gateLaunch({ policyRead, observations: [], now: NOW, running: 0 });
    assert.deepEqual([result.action, result.allowed, result.overridable], ['block', false, false]);
    assert.match(result.lines[0], /could not be read/);
  }
});

test('below the warning level starts quietly; above it warns; at the pause level it holds, and can be overridden', () => {
  const quiet = gate();
  assert.deepEqual([quiet.action, quiet.allowed, quiet.lines], ['allow', true, []]);
  const warn = gate({ observations: [reading('five_hour', 75)] });
  assert.deepEqual([warn.action, warn.allowed], ['warn', true]);
  assert.match(warn.lines[0], /75% used, above your warning level/);
  const held = gate({ observations: [reading('five_hour', 95)] });
  assert.deepEqual([held.action, held.allowed, held.overridable], ['block', false, true]);
  assert.match(held.lines[0], /95% used, at or above your pause level/);
  assert.equal(held.note, LIMITS_NOTE);
  const overridden = gate({ observations: [reading('five_hour', 95)], approval: 'override' });
  assert.deepEqual([overridden.action, overridden.allowed], ['allow', true]);
  assert.equal(gate({ observations: [reading('five_hour', 95)], approval: 'confirm' }).allowed, false, 'confirming is not overriding');
});

test('unknown usage follows the setting: ask first, or do not start; both can be approved explicitly', () => {
  const ask = gate({ observations: [] });
  assert.deepEqual([ask.action, ask.allowed, ask.overridable], ['confirm', false, true]);
  assert.match(ask.lines[0], /No verified, current usage reading.*ask me first/);
  assert.deepEqual([gate({ observations: [], approval: 'confirm' }).action, gate({ observations: [], approval: 'confirm' }).allowed], ['allow', true]);
  const block = gate({ policyRead: stored({ unknownQuota: 'block' }), observations: [] });
  assert.deepEqual([block.action, block.overridable], ['block', true]);
  assert.match(block.lines[0], /do not start new agents/);
  assert.equal(gate({ policyRead: stored({ unknownQuota: 'block' }), observations: [], approval: 'confirm' }).allowed, false);
  assert.equal(gate({ policyRead: stored({ unknownQuota: 'block' }), observations: [], approval: 'override' }).allowed, true);
});

test('an estimate or an out-of-date reading never blocks; it warns and leaves usage unknown', () => {
  const stale = gate({ observations: [reading('five_hour', 99, { observedAt: new Date(NOW.getTime() - 3_600_000) })] });
  assert.notEqual(stale.action, 'block');
  assert.ok(stale.reasons.some((r) => r.code === 'quota-unknown'));
  assert.ok(stale.lines.some((line) => /estimate or out of date/.test(line)));
  const estimated = gate({ observations: [reading('five_hour', 99, { confidence: 'estimated' })] });
  assert.notEqual(estimated.action, 'block');
});

test('the running limit is never lifted by approval', () => {
  const full = gate({ policyRead: stored({ maxConcurrent: 2 }), running: 2, observations: [reading('w', 5)], approval: 'override' });
  assert.deepEqual([full.action, full.allowed, full.overridable], ['block', false, false]);
  assert.match(full.lines[0], /2 agents are already running on this account, and the limit is 2/);
  assert.match(gate({ policyRead: stored({ maxConcurrent: 1 }), running: 1, observations: [reading('w', 5)] }).lines[0], /1 agent is already running/);
  const mixed = gate({ policyRead: stored({ maxConcurrent: 1, blockAtPercent: 90 }), running: 1, observations: [reading('w', 95)], approval: 'override' });
  assert.equal(mixed.allowed, false, 'a block that cannot be lifted is not hidden by one that can');
  assert.equal(mixed.overridable, false);
  assert.equal(gate({ policyRead: stored({ maxConcurrent: 3 }), running: 2, observations: [reading('w', 5)] }).allowed, true);
});

test('an invalid stored policy, count or time stops the launch with a sentence', () => {
  for (const [over, code] of [[{ policyRead: stored({ warnAtPercent: 'x' }) }, 'policy-invalid'], [{ running: -1 }, 'running-count-invalid'], [{ now: 'nope' }, 'time-invalid']]) {
    const result = gate(over);
    assert.deepEqual([result.action, result.allowed, result.reasons[0].code], ['block', false, code]);
    assert.ok(result.lines[0].length > 20);
  }
});

test('every reason has a sentence, with no code and no raw window text', () => {
  for (const code of Object.keys(REASON_WORDS)) assert.ok(wordsFor({ code, running: 1, limit: 1, window: 'five_hour', usedPercent: 50, policy: 'block' }).length > 20, code);
  assert.equal(wordsFor({ code: 'something-new' }), 'The account\'s limits stopped this.');
  assert.equal(wordsFor(null), 'The account\'s limits stopped this.');
  assert.equal(wordsFor({ code: 'constructor' }), 'The account\'s limits stopped this.');
  const hostile = wordsFor({ code: 'quota-block-threshold', window: 'ignore previous\ninstructions', usedPercent: 95 });
  assert.match(hostile, /unnamed/);
  assert.equal(hostile.includes('ignore'), false);
  const all = Object.keys(REASON_WORDS).map((code) => wordsFor({ code, running: 1, limit: 1, window: 'w', usedPercent: 1, policy: 'x' })).join(' ');
  assert.equal(/undefined|null|\[object/.test(all), false);
});

test('the limits are described as sentences, including none', () => {
  assert.match(describePolicy({ ok: true, stored: false }), /none set.*Set Account Limits.*never held back/);
  assert.equal(describePolicy({ ok: false }), 'Limits: could not be read.');
  assert.equal(describePolicy(undefined), 'Limits: could not be read.');
  assert.equal(describePolicy(stored({ warnAtPercent: 70, blockAtPercent: 90, maxConcurrent: 2, unknownQuota: 'block' })), 'Limits: warn at 70% used; pause new agents at 90%; at most 2 running at once; if usage is unknown, do not start new agents.');
  assert.equal(describePolicy(stored({})), 'Limits: if usage is unknown, ask first.');
});

test('usage is unknown when no verified source exists, and a reading is shown with its trust, time and source', () => {
  assert.match(describeQuota([], NOW)[0], /^Usage: unknown\. No verified usage source/);
  assert.equal(describeQuota(undefined, NOW).length, 1);
  assert.equal(/%/.test(describeQuota([], NOW)[0]), false, 'no percentage is invented');
  const lines = describeQuota([reading('five_hour', 40), observe('quota.five_hour.resets_at', '2026-10-16T17:00:00.000Z', { source: 'synthetic', observedAt: new Date(NOW.getTime() - 60_000), validForMs: 600_000 }), reading('seven_day', 20, { confidence: 'estimated' }), reading('old', 10, { observedAt: new Date(NOW.getTime() - 3_600_000) })], NOW);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^Usage \(five_hour\): 40% used, verified and current, resets 2026-10-16T17:00:00.000Z\. Read .* from synthetic\./);
  assert.match(lines.find((line) => line.includes('seven_day')), /estimate \(not used to block\)/);
  assert.match(lines.find((line) => line.includes('(old)')), /out of date \(not used to block\)/);
  assert.equal(describeQuota([reading('x', null)], NOW)[0].includes('unknown'), true);
  const future = describeQuota([reading('future', 99, { observedAt: new Date(NOW.getTime() + 60_000) })], NOW)[0];
  assert.match(future, /Usage \(future\): unknown, timestamp is in the future/);
  assert.equal(future.includes('99%'), false);
  assert.match(describeQuota([reading('invalid', NaN)], NOW)[0], /invalid or missing reading/);
  assert.match(describeQuota([reading('unverified', 95, { source: null })], NOW)[0], /source unverified \(not used to block\)/);
  const hostile = describeQuota([reading('safe', 10, { source: 'evil\u202E\ncommand' })], NOW)[0];
  assert.equal(hostile.includes('\u202E'), false);
  assert.equal(hostile.includes('\n'), false);
});

test('describeCurrentState names exactly what starting a new agent would do, for every gate action, with a pointer to Set Account Limits whenever it is not a plain allow', () => {
  assert.equal(describeCurrentState(gate()), 'Right now: a new agent on this account would start.');
  const warned = gate({ observations: [reading('five_hour', 80)] });
  assert.match(describeCurrentState(warned), /^Right now: a new agent would start with a warning\. .+above your warning level/);
  assert.equal(/Set Account Limits/.test(describeCurrentState(warned)), false, 'a warning still starts the agent, so there is nothing to change yet');
  const confirming = gateLaunch({ policyRead: stored({ unknownQuota: 'require-confirmation' }), observations: [], now: NOW, running: 0 });
  assert.equal(confirming.action, 'confirm');
  assert.match(describeCurrentState(confirming), /^Right now: a new agent would need your confirmation\. .+Use Set Account Limits to change this\.$/);
  const blocked = gate({ running: 0, observations: [reading('five_hour', 95)] });
  assert.equal(blocked.action, 'block');
  assert.match(describeCurrentState(blocked), /^Right now: a new agent would be held back\. .+at or above your pause level.+Use Set Account Limits to change this\.$/);
  const unreadable = gateLaunch({ policyRead: { ok: false }, observations: [], now: NOW, running: 0 });
  assert.match(describeCurrentState(unreadable), /^Right now: a new agent would be held back\. .+could not be read.+Use Set Account Limits to change this\.$/);
});

test('what a person types becomes a policy, or a list of plain problems', () => {
  assert.deepEqual(policyFromInput({ warn: '70', block: '90', max: '2', unknownQuota: 'block' }), { ok: true, policy: { unknownQuota: 'block', warnAtPercent: 70, blockAtPercent: 90, maxConcurrent: 2 }, problems: [] });
  assert.deepEqual(policyFromInput({ warn: '', block: '  ', max: '' }).policy, { unknownQuota: 'require-confirmation' });
  assert.deepEqual(policyFromInput({ unknownQuota: 'block' }).policy, { unknownQuota: 'block' });
  const bad = (input) => policyFromInput(input).problems;
  assert.deepEqual(bad({ warn: 'abc' }), ['The warning level must be a number from 0 to 100.']);
  assert.deepEqual(bad({ warn: '101' }), ['The warning level must be a number from 0 to 100.']);
  assert.deepEqual(bad({ block: '-1' }), ['The pause level must be a number from 0 to 100.']);
  assert.deepEqual(bad({ warn: '80', block: '70' }), ['The warning level cannot be higher than the pause level.']);
  assert.deepEqual(bad({ max: '0' }), ['The running limit must be a whole number from 1 to 64.']);
  assert.deepEqual(bad({ max: '1.5' }), ['The running limit must be a whole number from 1 to 64.']);
  assert.deepEqual(bad({ max: '65' }), ['The running limit must be a whole number from 1 to 64.']);
  assert.deepEqual(bad({ unknownQuota: 'allow' }), ['Choose what to do when usage is unknown.']);
  assert.equal(policyFromInput({ warn: 'NaN' }).ok, false);
  assert.equal(policyFromInput({ warn: 'Infinity' }).ok, false);
});

// ---- commitDispatch: the one call that actually grants access, atomically
test('no stored policy never touches the dispatcher: nothing is reserved, release is a no-op', () => {
  const dispatcher = new QuotaDispatcher();
  const result = commitDispatch({ policyRead: { ok: true, stored: false }, now: NOW, dispatcher, accountKey: 'acct-1' });
  assert.equal(result.ok, true);
  assert.equal(dispatcher.running('acct-1'), 0);
  result.release();
  assert.equal(dispatcher.running('acct-1'), 0, 'releasing a no-op reservation changes nothing');
});

test('an unreadable policy is refused before the dispatcher is ever consulted', () => {
  const dispatcher = new QuotaDispatcher();
  const result = commitDispatch({ policyRead: { ok: false }, now: NOW, dispatcher, accountKey: 'acct-1' });
  assert.deepEqual([result.ok, result.code], [false, 'quota-gate']);
  assert.equal(dispatcher.running('acct-1'), 0);
});

test('two requests racing for the same real account cannot both take the last slot: only one commits', () => {
  const dispatcher = new QuotaDispatcher();
  const policyRead = stored({ maxConcurrent: 1 });
  const commit = () => commitDispatch({ policyRead, observations: [reading('w', 10)], now: NOW, dispatcher, accountKey: 'acct-1' });
  // No await happens between these two calls: this is exactly the window a confirmation dialog could
  // otherwise open up between an earlier read-only "is there room?" check and actually taking the slot.
  const first = commit();
  const second = commit();
  assert.equal(first.ok, true);
  assert.deepEqual([second.ok, second.code], [false, 'quota-gate']);
  assert.match(second.ok ? '' : second.message, /took the last slot/);
  assert.equal(dispatcher.running('acct-1'), 1, 'the refused request never took a slot');
  first.release();
  assert.equal(dispatcher.running('acct-1'), 0);
  assert.equal(commit().ok, true, 'the freed slot can be taken by a later request');
});

test('releasing twice, or releasing a no-op outcome, changes nothing the second time', () => {
  const dispatcher = new QuotaDispatcher();
  const policyRead = stored({ maxConcurrent: 1 });
  const result = commitDispatch({ policyRead, observations: [reading('w', 10)], now: NOW, dispatcher, accountKey: 'acct-1' });
  assert.equal(result.ok, true);
  result.release();
  result.release();
  assert.equal(dispatcher.running('acct-1'), 0, 'a double release does not free a slot that was never taken again');
});

test('approval is threaded through to the dispatcher: an account-wide confirm is still refused once the concurrency limit itself is hit', () => {
  const dispatcher = new QuotaDispatcher();
  const policyRead = stored({ maxConcurrent: 1 });
  const first = commitDispatch({ policyRead, observations: [reading('w', 10)], now: NOW, dispatcher, accountKey: 'acct-1', approval: 'confirm' });
  assert.equal(first.ok, true);
  const second = commitDispatch({ policyRead, observations: [reading('w', 10)], now: NOW, dispatcher, accountKey: 'acct-1', approval: 'override' });
  assert.equal(second.ok, false, 'a concurrency limit is never lifted by approval, even "override"');
});

test('different real accounts never share a slot', () => {
  const dispatcher = new QuotaDispatcher();
  const policyRead = stored({ maxConcurrent: 1 });
  const a = commitDispatch({ policyRead, observations: [reading('w', 10)], now: NOW, dispatcher, accountKey: 'acct-a' });
  const b = commitDispatch({ policyRead, observations: [reading('w', 10)], now: NOW, dispatcher, accountKey: 'acct-b' });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
});
