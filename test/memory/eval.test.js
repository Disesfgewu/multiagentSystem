'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { measureInjection, evaluateChecks, summarizeUsage, assessSavingsClaim, renderReport, TOKEN_FIELDS, MIN_TASKS_FOR_CLAIM } = require('../../src/memory/eval');
const suite = require('../../src/memory/eval-suite');
const { run } = require('../../scripts/memory-eval');

const ids = (n) => Array.from({ length: n }, (_, i) => `t${String(i + 1).padStart(2, '0')}`);
const rec = (arm, taskId, field, value, over = {}) => ({ arm, taskId, field, value, source: 'provider-reported', billing: 'api', ...over });
function fullUsage(taskIds, { off = 1000, on = 800 } = {}) {
  const records = [];
  for (const id of taskIds) for (const [arm, base] of [['off', off], ['on', on]]) {
    records.push(rec(arm, id, 'input_tokens', base), rec(arm, id, 'output_tokens', 100));
  }
  // the memory arm also pays to build and retrieve memory
  for (const id of taskIds) records.push(rec('on', id, 'memory_build_tokens', 20), rec('on', id, 'memory_retrieval_tokens', 10));
  return records;
}
const quality = (on, off) => ({ byArm: { on, off } });
const good = { pass: 10, fail: 0, notRun: 0, passRate: 1 };
const claimOf = (over = {}) => {
  const taskIds = over.taskIds || ids(MIN_TASKS_FOR_CLAIM);
  return assessSavingsClaim({ usage: summarizeUsage({ records: over.records || fullUsage(taskIds), taskIds }), quality: over.quality || quality(good, good), taskCount: taskIds.length, real: 'real' in over ? over.real : true });
};

test('the synthetic run is reproducible and states that it is synthetic', () => {
  const first = run();
  const second = run();
  assert.equal(first.report, second.report);
  assert.match(first.report, /synthetic only/);
  assert.equal(first.claim.supported, false);
  assert.ok(first.claim.reasons.includes('no-real-measurement'));
});

test('injected size is exact and the memory arm is larger than the rules-only arm', () => {
  const { runs } = run();
  for (const entry of runs) {
    assert.equal(entry.off.chars, entry.contexts.off.length);
    assert.equal(entry.on.chars, entry.contexts.on.length);
    assert.ok(entry.on.chars > entry.off.chars);
    assert.equal(entry.off.memories, 0);
  }
});

test('the other privacy domain never reaches the context, so the leak checks pass', () => {
  const { runs, quality: q } = run();
  for (const entry of runs) assert.equal(/orange-falcon/i.test(entry.contexts.on + entry.contexts.off), false);
  const leak = q.results.filter((entry) => entry.checkId === 'no-leak');
  assert.equal(leak.length, suite.tasks.length * 2);
  assert.ok(leak.every((entry) => entry.status === 'pass'));
});

test('a leak is detected: a check that excludes text the context does hold fails', () => {
  const runs = [{ taskId: 'x', contexts: { off: 'rules only', on: 'rules and secret-plan' } }];
  const checked = evaluateChecks({ tasks: [{ id: 'x', checks: [{ id: 'no-leak', kind: 'context-excludes', text: 'SECRET-PLAN' }] }], runs });
  assert.deepEqual(checked.results.map((entry) => [entry.arm, entry.status]), [['off', 'pass'], ['on', 'fail']]);
  assert.deepEqual([checked.byArm.on.fail, checked.byArm.on.passRate, checked.byArm.off.passRate], [1, 0, 1]);
});

test('output checks need a recorded output; without one they are not run and never pass', () => {
  const runs = [{ taskId: 'x', contexts: { off: '', on: '' } }];
  const tasks = [{ id: 'x', checks: [{ id: 'follows', kind: 'output-includes', text: 'tests were run' }] }];
  const none = evaluateChecks({ tasks, runs });
  assert.deepEqual(none.results.map((entry) => entry.status), ['not-run', 'not-run']);
  assert.equal(none.byArm.on.passRate, null);
  const recorded = evaluateChecks({ tasks, runs, outputs: { x: { on: 'All TESTS WERE RUN.', off: 'nothing' } } });
  assert.deepEqual(recorded.results.map((entry) => [entry.arm, entry.status]), [['off', 'fail'], ['on', 'pass']]);
  const avoid = evaluateChecks({ tasks: [{ id: 'x', checks: [{ id: 'a', kind: 'output-excludes', text: 'merge' }] }], runs, outputs: { x: { on: 'did merge', off: 'fine' } } });
  assert.deepEqual(avoid.results.map((entry) => entry.status), ['pass', 'fail']);
});

test('invalid tasks and checks are rejected', () => {
  const store = { select: () => ({ items: [], usedChars: 0 }) };
  const base = { store, scope: suite.SCOPE, roleGroup: suite.roleGroup, rules: suite.rules };
  assert.throws(() => measureInjection({ ...base, tasks: [] }), TypeError);
  assert.throws(() => measureInjection({ ...base, tasks: [{ id: 'a', task: 'x' }, { id: 'a', task: 'y' }] }), TypeError);
  assert.throws(() => measureInjection({ ...base, tasks: [{ id: '', task: 'x' }] }), TypeError);
  assert.throws(() => measureInjection({ ...base, store: {}, tasks: [{ id: 'a', task: 'x' }] }), TypeError);
  for (const check of [{ id: 'c', kind: 'subjective-score', text: 'x' }, { id: 'c', kind: 'context-includes', text: '' }, { id: '', kind: 'context-includes', text: 'x' }, { id: 'c', kind: 'context-includes', text: 'x', arm: 'both' }, null]) {
    assert.throws(() => evaluateChecks({ tasks: [{ id: 'a', checks: [check] }], runs: [{ taskId: 'a', contexts: { off: '', on: '' } }] }), TypeError, JSON.stringify(check));
  }
});

test('what the budget leaves out is reported', () => {
  const store = { select: () => ({ items: [], usedChars: 0, omitted: { count: 3, chars: 90, reason: 'budget' } }) };
  const [entry] = measureInjection({ store, scope: suite.SCOPE, roleGroup: suite.roleGroup, rules: suite.rules, tasks: [{ id: 'a', task: 'x' }] });
  assert.deepEqual(entry.on.omitted, { count: 3, chars: 90, reason: 'budget' });
  assert.match(entry.contexts.on, /3 more reviewed notes were left out/);
});

test('usage records: bad values, unknown sources, estimates without a method, character counts and bad billing are refused', () => {
  const taskIds = ['a'];
  for (const bad of [
    rec('both', 'a', 'input_tokens', 1), rec('on', '', 'input_tokens', 1), rec('on', 'a', 'input_chars', 1), rec('on', 'a', 'cost_usd', 1),
    rec('on', 'a', 'input_tokens', -1), rec('on', 'a', 'input_tokens', NaN), rec('on', 'a', 'input_tokens', '5'), rec('on', 'a', 'input_tokens', Infinity),
    rec('on', 'a', 'input_tokens', 1, { source: 'guess' }), rec('on', 'a', 'input_tokens', 1, { source: 'estimated' }), rec('on', 'a', 'input_tokens', 1, { source: 'estimated', method: '  ' }),
    rec('on', 'a', 'input_tokens', 1, { billing: 'free' }), null, 'x'
  ]) {
    const result = summarizeUsage({ records: [bad], taskIds });
    assert.equal(result.problems.length, 1, JSON.stringify(bad));
    assert.equal(result.billings.length, 0);
  }
  assert.throws(() => summarizeUsage({ records: 'x', taskIds }), TypeError);
  assert.throws(() => summarizeUsage({ records: [], taskIds: null }), TypeError);
});

test('a total is complete only when every task has a provider value; a missing value is missing, not zero; estimates are kept apart with their method', () => {
  const taskIds = ['a', 'b'];
  const records = [rec('on', 'a', 'input_tokens', 10), rec('on', 'b', 'input_tokens', 5, { source: 'estimated', method: 'chars / 4, rough' }), rec('on', 'a', 'output_tokens', 3), rec('on', 'b', 'output_tokens', 4)];
  const { summary } = summarizeUsage({ records, taskIds });
  const input = summary.on.api.input_tokens;
  assert.deepEqual([input.providerReported, input.estimated, input.estimateMethods, input.tasksWithoutProviderValue, input.complete], [10, 5, ['chars / 4, rough'], 1, false]);
  assert.equal(summary.on.api.output_tokens.complete, true);
  assert.equal(summary.off.api.input_tokens.providerReported, null, 'nothing reported means unknown, not zero');
  assert.equal(summary.off.api.input_tokens.complete, false);
  for (const field of TOKEN_FIELDS) assert.ok(field in summary.on.api);
});

test('billing modes are summarized apart and never added together', () => {
  const taskIds = ['a'];
  const { billings, summary } = summarizeUsage({ taskIds, records: [rec('on', 'a', 'input_tokens', 10, { billing: 'api' }), rec('on', 'a', 'input_tokens', 7, { billing: 'subscription' }), rec('on', 'a', 'output_tokens', 1, { billing: undefined })] });
  assert.deepEqual(billings, ['api', 'subscription', 'unknown']);
  assert.equal(summary.on.api.input_tokens.providerReported, 10);
  assert.equal(summary.on.subscription.input_tokens.providerReported, 7);
});

test('the saving claim: supported only with real, complete, single-billing, lower totals and no quality regression', () => {
  const ok = claimOf();
  assert.deepEqual([ok.supported, ok.reasons], [true, []]);
  assert.deepEqual(ok.totals, { off: 11000, on: 9300 });
});

test('the saving claim is refused for each missing ingredient', () => {
  const taskIds = ids(MIN_TASKS_FOR_CLAIM);
  const reasons = (over) => claimOf(over).reasons;
  assert.deepEqual(reasons({ real: false }), ['no-real-measurement']);
  assert.deepEqual(reasons({ real: undefined }), ['no-real-measurement']);
  assert.ok(reasons({ taskIds: ids(MIN_TASKS_FOR_CLAIM - 1) }).includes('too-few-tasks'));
  assert.ok(reasons({ records: [] }).includes('no-usage'));
  assert.ok(reasons({ records: fullUsage(taskIds).slice(2) }).includes('off-input_tokens-incomplete'));
  assert.ok(reasons({ records: fullUsage(taskIds).filter((r) => !(r.arm === 'on' && r.field === 'output_tokens')) }).includes('on-output_tokens-incomplete'));
  assert.ok(reasons({ records: fullUsage(taskIds, { off: 1000, on: 1000 }) }).includes('total-not-lower'));
  assert.ok(reasons({ records: fullUsage(taskIds, { off: 1000, on: 1200 }) }).includes('total-not-lower'));
  assert.ok(reasons({ records: [...fullUsage(taskIds), { ...rec('on', 't01', 'input_tokens', 1), billing: 'subscription' }] }).includes('billing-mixed-or-unknown'));
  assert.ok(reasons({ records: fullUsage(taskIds).map((r) => ({ ...r, billing: 'unknown' })) }).includes('billing-mixed-or-unknown'));
  assert.ok(reasons({ records: [...fullUsage(taskIds), rec('on', 't01', 'input_tokens', -5)] }).includes('invalid-usage-records'));
  assert.ok(reasons({ records: [...fullUsage(taskIds), rec('on', 't01', 'cache_read_tokens', 5, { source: 'estimated', method: 'm' })] }).includes('on-cache_read_tokens-estimated'));
});

test('memory build and retrieval cost count against the saving', () => {
  const taskIds = ids(MIN_TASKS_FOR_CLAIM);
  const records = [...fullUsage(taskIds, { off: 1000, on: 950 }).filter((r) => !r.field.startsWith('memory_')), ...taskIds.map((id) => rec('on', id, 'memory_build_tokens', 30)), ...taskIds.map((id) => rec('on', id, 'memory_retrieval_tokens', 30))];
  const result = claimOf({ records });
  assert.ok(result.reasons.includes('total-not-lower'));
  assert.deepEqual(result.totals, { off: 11000, on: 11100 });
});

test('quality: not measured, regressed in rate, or with more failures all refuse the claim', () => {
  assert.ok(claimOf({ quality: quality(good, { ...good, passRate: null }) }).reasons.includes('quality-not-measured'));
  assert.ok(claimOf({ quality: quality({ pass: 8, fail: 2, notRun: 0, passRate: 0.8 }, good) }).reasons.includes('quality-regressed'));
  assert.ok(claimOf({ quality: quality({ pass: 20, fail: 1, notRun: 0, passRate: 20 / 21 }, { pass: 5, fail: 0, notRun: 0, passRate: 1 }) }).reasons.includes('quality-regressed'));
  assert.ok(claimOf({ quality: quality({ pass: 10, fail: 1, notRun: 0, passRate: 0.99 }, { pass: 9, fail: 0, notRun: 0, passRate: 0.9 }) }).reasons.includes('quality-regressed'), 'more failures than the control');
  assert.equal(claimOf({ quality: quality({ pass: 10, fail: 0, notRun: 0, passRate: 1 }, { pass: 9, fail: 1, notRun: 0, passRate: 0.9 }) }).supported, true);
});

test('the report has a fixed shape, names sources, never turns characters into tokens, and states the conclusion', () => {
  const taskIds = suite.tasks.map((task) => task.id);
  const result = run({ usageRecords: [rec('on', 't01', 'input_tokens', 120), rec('off', 't01', 'input_tokens', 90, { source: 'estimated', method: 'documented estimate' })] });
  const text = result.report;
  for (const heading of ['# Memory A/B report: synthetic-v1', '## Injected size', '## Quality (machine checks)', '## Tokens (source named)', '## Conclusion', '## Notes']) assert.ok(text.includes(heading), heading);
  assert.match(text, /Characters are not tokens/);
  assert.match(text, /documented estimate/);
  assert.match(text, /Not supported\. Reasons: /);
  assert.equal(text.includes('NaN') || text.includes('undefined'), false);
  assert.ok(text.indexOf('| t01 |') < text.indexOf('| t02 |'));
  assert.equal(taskIds.length, 6);
});

test('a supported claim still says a sum of tokens is not a cost', () => {
  const taskIds = ids(MIN_TASKS_FOR_CLAIM);
  const usage = summarizeUsage({ records: fullUsage(taskIds), taskIds });
  const claim = assessSavingsClaim({ usage, quality: quality(good, good), taskCount: taskIds.length, real: true });
  const text = renderReport({ suiteId: 's', real: true, runs: [], quality: quality(good, good), usage, claim });
  assert.match(text, /Supported: total token use was lower/);
  assert.match(text, /not a cost/);
  assert.match(text, /real \(provider-reported usage supplied\)/);
});

test('with no tasks nothing is complete', () => {
  const { summary } = summarizeUsage({ records: [], taskIds: [] });
  assert.deepEqual(summary, { off: {}, on: {} });
  const none = summarizeUsage({ records: [rec('on', 'a', 'input_tokens', 1)], taskIds: [] });
  assert.deepEqual(none.problems, ['unknown-task']);
  assert.equal(none.billings.length, 0);
});

test('an extra token field reported for only some tasks makes the claim incomplete', () => {
  const taskIds = ids(MIN_TASKS_FOR_CLAIM);
  const records = [...fullUsage(taskIds), rec('on', 't01', 'cache_read_tokens', 50)];
  assert.ok(claimOf({ records }).reasons.includes('on-cache_read_tokens-incomplete'));
});

test('a lower pass rate refuses the claim even when the failure count is equal', () => {
  const on = { pass: 5, fail: 1, notRun: 0, passRate: 5 / 6 };
  const off = { pass: 20, fail: 1, notRun: 0, passRate: 20 / 21 };
  assert.ok(claimOf({ quality: quality(on, off) }).reasons.includes('quality-regressed'));
});

test('the report orders tasks by id whatever order they come in', () => {
  const result = run();
  const reversed = renderReport({ suiteId: 'x', real: false, runs: [...result.runs].reverse(), quality: result.quality, usage: result.usage, claim: result.claim });
  assert.ok(reversed.indexOf('| t01 |') < reversed.indexOf('| t06 |'));
});

// The three ways the claim gate used to say SUPPORTED when the saving did not hold.
const honest = (taskIds) => {
  const records = [];
  for (const id of taskIds) {
    records.push(rec('off', id, 'input_tokens', 1000), rec('off', id, 'output_tokens', 200), rec('on', id, 'input_tokens', 1100), rec('on', id, 'output_tokens', 200), rec('on', id, 'memory_build_tokens', 5), rec('on', id, 'memory_retrieval_tokens', 5));
  }
  return records;
};

test('the honest baseline (memory costs more) is not supported', () => {
  const taskIds = ids(10);
  assert.deepEqual(claimOf({ records: honest(taskIds), taskIds }).reasons, ['total-not-lower']);
});

test('duplicate records are reported and not added, and the claim is refused', () => {
  const taskIds = ids(10);
  const records = honest(taskIds);
  const doubled = [...records, ...records.filter((r) => r.arm === 'off')];
  const usage = summarizeUsage({ records: doubled, taskIds });
  assert.equal(usage.summary.off.api.input_tokens.providerReported, 10000, 'not added twice');
  assert.deepEqual([...new Set(usage.problems)], ['duplicate-record']);
  const result = claimOf({ records: doubled, taskIds });
  assert.equal(result.supported, false);
  assert.ok(result.reasons.includes('invalid-usage-records'));
  assert.ok(result.reasons.includes('total-not-lower'), 'and the totals are still the honest ones');
  // the same measurement from another source is not a duplicate; another billing mode is not either
  const other = summarizeUsage({ taskIds, records: [rec('on', 't01', 'input_tokens', 1), rec('on', 't01', 'input_tokens', 2, { source: 'estimated', method: 'm' }), rec('on', 't01', 'input_tokens', 3, { billing: 'subscription' })] });
  assert.deepEqual(other.problems, []);
});

test('a record for a task that is not in the suite is reported and not added', () => {
  const taskIds = ids(10);
  const records = [...honest(taskIds), rec('off', 'ghost', 'input_tokens', 99999)];
  const usage = summarizeUsage({ records, taskIds });
  assert.equal(usage.summary.off.api.input_tokens.providerReported, 10000);
  assert.deepEqual(usage.problems, ['unknown-task']);
  const result = claimOf({ records, taskIds });
  assert.equal(result.supported, false);
  assert.ok(result.reasons.includes('invalid-usage-records'));
  assert.deepEqual(result.totals, { off: 12000, on: 13100 });
});

test('missing memory build or retrieval cost is unknown, not zero: the memory arm must report both for every task', () => {
  const taskIds = ids(10);
  const cheap = (extra) => [...taskIds.flatMap((id) => [rec('off', id, 'input_tokens', 1000), rec('off', id, 'output_tokens', 200), rec('on', id, 'input_tokens', 900), rec('on', id, 'output_tokens', 200)]), ...extra];
  const none = claimOf({ records: cheap([]), taskIds });
  assert.equal(none.supported, false);
  assert.deepEqual(none.reasons.filter((r) => r.includes('memory')), ['on-memory_build_tokens-missing', 'on-memory_retrieval_tokens-missing']);
  const onlyBuild = claimOf({ records: cheap(taskIds.map((id) => rec('on', id, 'memory_build_tokens', 1))), taskIds });
  assert.deepEqual(onlyBuild.reasons.filter((r) => r.includes('memory')), ['on-memory_retrieval_tokens-missing']);
  const partial = claimOf({ records: cheap([...taskIds.map((id) => rec('on', id, 'memory_build_tokens', 1)), ...taskIds.slice(1).map((id) => rec('on', id, 'memory_retrieval_tokens', 1))]), taskIds });
  assert.deepEqual(partial.reasons.filter((r) => r.includes('memory')), ['on-memory_retrieval_tokens-incomplete']);
  const estimated = claimOf({ records: cheap([...taskIds.map((id) => rec('on', id, 'memory_build_tokens', 1)), ...taskIds.map((id) => rec('on', id, 'memory_retrieval_tokens', 1, { source: 'estimated', method: 'm' }))]), taskIds });
  assert.ok(estimated.reasons.includes('on-memory_retrieval_tokens-missing'));
  const full = claimOf({ records: cheap([...taskIds.map((id) => rec('on', id, 'memory_build_tokens', 1)), ...taskIds.map((id) => rec('on', id, 'memory_retrieval_tokens', 1))]), taskIds });
  assert.deepEqual([full.supported, full.totals], [true, { off: 12000, on: 11020 }]);
});

test('a cache field reported by either arm must be reported by both, completely', () => {
  const taskIds = ids(10);
  for (const field of ['cache_read_tokens', 'cache_write_tokens']) {
    const base = fullUsage(taskIds);
    const onlyOn = claimOf({ records: [...base, ...taskIds.map((id) => rec('on', id, field, 5))], taskIds });
    assert.ok(onlyOn.reasons.includes(`off-${field}-missing`), field);
    const onlyOff = claimOf({ records: [...base, ...taskIds.map((id) => rec('off', id, field, 5))], taskIds });
    assert.ok(onlyOff.reasons.includes(`on-${field}-missing`), field);
    assert.equal(onlyOff.supported, false);
    const both = claimOf({ records: [...base, ...taskIds.map((id) => rec('on', id, field, 5)), ...taskIds.map((id) => rec('off', id, field, 50))], taskIds });
    assert.equal(both.supported, true, field);
    const incomplete = claimOf({ records: [...base, ...taskIds.map((id) => rec('on', id, field, 5)), ...taskIds.slice(1).map((id) => rec('off', id, field, 50))], taskIds });
    assert.ok(incomplete.reasons.includes(`off-${field}-incomplete`), field);
  }
});

test('the report masks the names of shared privacy domains', () => {
  const run1 = { taskId: 't', off: { chars: 1 }, on: { chars: 2, memories: 1, memoryChars: 1, omitted: null, sharedFrom: ['account:someone-private'] } };
  const text = renderReport({ suiteId: 's', real: false, runs: [run1], quality: quality(good, good), usage: summarizeUsage({ records: [], taskIds: ['t'] }), claim: { supported: false, reasons: ['x'] } });
  assert.equal(text.includes('someone-private'), false);
  assert.match(text, /domain-[0-9a-f]{8}/);
});
