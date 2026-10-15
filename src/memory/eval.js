'use strict';

const { renderContext } = require('./injection');
const { byCodeUnit } = require('./order');

// A reproducible A/B evaluation framework for shared memory: arm `off` injects rules only, arm
// `on` injects rules and the selected memory. It runs no CLI and reads no real account. What it
// measures from the injected text is exact (size, items, what the budget left out). Token
// numbers are never derived from that text: a token count is only ever one the provider
// reported, or an estimate that names its method, and the two are never added together silently.
//
// Quality is a machine check: does the injected context hold a rule, does it leak other-domain
// text, does a recorded output contain or avoid a phrase. There is no subjective score.
//
// The conclusion "memory lowers total token use" is not made by this module unless real,
// provider-reported numbers for every task and both arms back it and quality did not regress.

const ARMS = Object.freeze(['off', 'on']);
const TOKEN_FIELDS = Object.freeze(['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'memory_build_tokens', 'memory_retrieval_tokens']);
const BILLING = Object.freeze(['subscription', 'api', 'unknown']);
const SOURCES = Object.freeze(['provider-reported', 'estimated']);
const CHECK_KINDS = Object.freeze(['context-includes', 'context-excludes', 'output-includes', 'output-excludes']);
const MIN_TASKS_FOR_CLAIM = 10;
const MEMORY_COST_FIELDS = Object.freeze(['memory_build_tokens', 'memory_retrieval_tokens']);

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim() !== '';
const has = (haystack, needle) => haystack.toLowerCase().includes(needle.toLowerCase());

/**
 * Measures what each arm would inject for each task. `store` is a MemoryStore (or anything with
 * `select`), `scope` is `{ repoId, roleGroupId, privacyDomain }`.
 */
function measureInjection({ store, scope, roleGroup, rules, tasks, budgetChars }) {
  if (!store || typeof store.select !== 'function') throw new TypeError('store.select is required');
  if (!Array.isArray(tasks) || tasks.length === 0) throw new TypeError('tasks must be a non-empty list');
  const ids = new Set();
  const runs = tasks.map((task) => {
    if (!isPlain(task) || !text(task.id) || !text(task.task) || ids.has(task.id)) throw new TypeError('each task needs a unique id and a task text');
    ids.add(task.id);
    const selection = store.select({ ...scope, task: task.task, budgetChars });
    const off = renderContext({ roleGroup, rules, memories: [], omitted: undefined });
    const on = renderContext({ roleGroup, rules, memories: selection.items, omitted: selection.omitted });
    return {
      taskId: task.id,
      contexts: { off, on },
      off: { chars: off.length, memories: 0 },
      on: {
        chars: on.length,
        memories: selection.items.length,
        memoryChars: selection.usedChars,
        omitted: selection.omitted ? { count: selection.omitted.count, chars: selection.omitted.chars, reason: selection.omitted.reason } : null,
        unavailable: selection.unavailable ?? null,
        sharedFrom: [...new Set(selection.items.filter((item) => item.sharedFrom).map((item) => item.sharedFrom))].sort(byCodeUnit)
      }
    };
  });
  return runs;
}

/**
 * Evaluates machine checks. `outputs` is `{ [taskId]: { off?: string, on?: string } }` recorded by
 * the caller; an output check with no recorded output is `not-run`, never a pass.
 */
function evaluateChecks({ tasks, runs, outputs = {} }) {
  const results = [];
  for (const task of tasks) {
    const run = runs.find((entry) => entry.taskId === task.id);
    for (const check of Array.isArray(task.checks) ? task.checks : []) {
      if (!isPlain(check) || !text(check.id) || !CHECK_KINDS.includes(check.kind) || !text(check.text)) throw new TypeError('invalid check');
      for (const arm of check.arm ? [check.arm] : ARMS) {
        if (!ARMS.includes(arm)) throw new TypeError('invalid check arm');
        let subject;
        if (check.kind.startsWith('context')) subject = run ? run.contexts[arm] : undefined;
        else subject = isPlain(outputs[task.id]) && typeof outputs[task.id][arm] === 'string' ? outputs[task.id][arm] : undefined;
        let status = 'not-run';
        if (typeof subject === 'string') status = (check.kind.endsWith('includes') ? has(subject, check.text) : !has(subject, check.text)) ? 'pass' : 'fail';
        results.push({ taskId: task.id, checkId: check.id, kind: check.kind, arm, status });
      }
    }
  }
  const byArm = Object.fromEntries(ARMS.map((arm) => {
    const mine = results.filter((entry) => entry.arm === arm);
    const pass = mine.filter((entry) => entry.status === 'pass').length;
    const fail = mine.filter((entry) => entry.status === 'fail').length;
    return [arm, { pass, fail, notRun: mine.length - pass - fail, passRate: pass + fail === 0 ? null : pass / (pass + fail) }];
  }));
  return { results, byArm };
}

function checkRecord(record) {
  if (!isPlain(record) || !ARMS.includes(record.arm) || !text(record.taskId) || !TOKEN_FIELDS.includes(record.field)) return 'invalid-record';
  if (typeof record.value !== 'number' || !Number.isFinite(record.value) || record.value < 0) return 'invalid-value';
  if (!SOURCES.includes(record.source)) return 'unknown-source';
  if (record.source === 'estimated' && !text(record.method)) return 'estimate-without-method';
  if (record.billing !== undefined && !BILLING.includes(record.billing)) return 'invalid-billing';
  return null;
}

/**
 * Summarizes usage records `{ arm, taskId, field, value, source, method?, billing? }`.
 * A total is `complete` only when every task has a provider-reported value for the field; a missing
 * value is reported as missing (never as zero); estimates are counted apart and keep their method.
 * Billing modes are summarized separately and never added together.
 */
function summarizeUsage({ records = [], taskIds }) {
  if (!Array.isArray(records) || !Array.isArray(taskIds)) throw new TypeError('records and taskIds must be lists');
  const problems = [];
  const valid = [];
  const known = new Set(taskIds);
  const seen = new Set();
  for (const record of records) {
    const problem = checkRecord(record);
    if (problem) { problems.push(problem); continue; }
    // A record for a task that is not in the suite, or a second record for the same measurement,
    // would be added to a total it does not belong to. Both are reported and neither is counted.
    if (!known.has(record.taskId)) { problems.push('unknown-task'); continue; }
    const billing = record.billing ?? 'unknown';
    const key = JSON.stringify([record.arm, record.taskId, record.field, billing, record.source]);
    if (seen.has(key)) { problems.push('duplicate-record'); continue; }
    seen.add(key);
    valid.push({ ...record, billing });
  }
  const billings = [...new Set(valid.map((record) => record.billing))].sort(byCodeUnit);
  const summary = {};
  for (const arm of ARMS) {
    summary[arm] = {};
    for (const billing of billings) {
      summary[arm][billing] = {};
      for (const field of TOKEN_FIELDS) {
        const mine = valid.filter((record) => record.arm === arm && record.billing === billing && record.field === field);
        const reportedTasks = new Set(mine.filter((record) => record.source === 'provider-reported').map((record) => record.taskId));
        const reported = mine.filter((record) => record.source === 'provider-reported').reduce((sum, record) => sum + record.value, 0);
        const estimated = mine.filter((record) => record.source === 'estimated');
        summary[arm][billing][field] = {
          providerReported: reportedTasks.size === 0 ? null : reported,
          estimated: estimated.length === 0 ? null : estimated.reduce((sum, record) => sum + record.value, 0),
          estimateMethods: [...new Set(estimated.map((record) => record.method))].sort(byCodeUnit),
          tasksWithProviderValue: reportedTasks.size,
          tasksWithoutProviderValue: taskIds.filter((id) => !reportedTasks.has(id)).length,
          complete: taskIds.length > 0 && taskIds.every((id) => reportedTasks.has(id))
        };
      }
    }
  }
  return { billings, summary, problems };
}

/**
 * Decides whether "memory lowers total token use" may be said. It may only when the evidence is
 * real, complete, in a single known billing mode, lower for the memory arm including the cost of
 * building and retrieving memory, and quality did not regress. Otherwise it says why not.
 */
function assessSavingsClaim({ usage, quality, taskCount, real }) {
  const reasons = [];
  if (real !== true) reasons.push('no-real-measurement');
  if (!Number.isInteger(taskCount) || taskCount < MIN_TASKS_FOR_CLAIM) reasons.push('too-few-tasks');
  if (usage.problems.length > 0) reasons.push('invalid-usage-records');
  const known = usage.billings.filter((billing) => billing !== 'unknown');
  if (usage.billings.length !== 1 || known.length !== 1) reasons.push(usage.billings.length === 0 ? 'no-usage' : 'billing-mixed-or-unknown');

  let totals = null;
  if (usage.billings.length === 1) {
    const billing = usage.billings[0];
    const sum = (arm) => {
      let total = 0;
      for (const field of ['input_tokens', 'output_tokens']) {
        const entry = usage.summary[arm][billing][field];
        if (!entry.complete) { reasons.push(`${arm}-${field}-incomplete`); continue; }
        total += entry.providerReported;
      }
      for (const field of ['cache_read_tokens', 'cache_write_tokens', 'memory_build_tokens', 'memory_retrieval_tokens']) {
        const entry = usage.summary[arm][billing][field];
        const other = usage.summary[arm === 'on' ? 'off' : 'on'][billing][field];
        if (entry.estimated !== null) reasons.push(`${arm}-${field}-estimated`);
        // The cost of building and retrieving memory belongs to the memory arm and must be reported
        // for every task. A cache field reported by either arm must be reported by both. A value that
        // is missing is unknown, never zero.
        const required = MEMORY_COST_FIELDS.includes(field) ? arm === 'on' : other.providerReported !== null || entry.providerReported !== null;
        if (required && entry.providerReported === null) reasons.push(`${arm}-${field}-missing`);
        else if (entry.providerReported !== null) {
          if (!entry.complete) reasons.push(`${arm}-${field}-incomplete`);
          total += entry.providerReported;
        }
      }
      return total;
    };
    totals = { off: sum('off'), on: sum('on') };
    if (totals.on >= totals.off) reasons.push('total-not-lower');
  }
  if (ARMS.some((arm) => quality.byArm[arm].passRate === null)) reasons.push('quality-not-measured');
  else if (quality.byArm.on.passRate < quality.byArm.off.passRate || quality.byArm.on.fail > quality.byArm.off.fail) reasons.push('quality-regressed');

  const unique = [...new Set(reasons)].sort(byCodeUnit);
  return { supported: unique.length === 0, reasons: unique, totals };
}

const maskDomain = (name) => `domain-${require('node:crypto').createHash('sha256').update(String(name)).digest('hex').slice(0, 8)}`;
const fmt = (value) => (value === null || value === undefined ? 'unknown' : String(value));
const pct = (value) => (value === null ? 'unknown' : `${(value * 100).toFixed(1)}%`);

/** A fixed-format Markdown report. Nothing in it comes from a real account unless `real` is true. */
function renderReport({ suiteId, real, runs, quality, usage, claim, notes = [] }) {
  const lines = [
    `# Memory A/B report: ${suiteId}`,
    '',
    `Measurement: ${real === true ? 'real (provider-reported usage supplied)' : 'synthetic only. No real account or CLI was used, and nothing below is a measured saving.'}`,
    '',
    '## Injected size (exact, from the rendered context)',
    '',
    '| task | off chars | on chars | memories | memory chars | omitted | shared from |',
    '| --- | ---: | ---: | ---: | ---: | --- | --- |'
  ];
  for (const run of [...runs].sort((a, b) => byCodeUnit(a.taskId, b.taskId))) {
    const omitted = run.on.omitted ? `${run.on.omitted.count} (${run.on.omitted.chars} chars, ${run.on.omitted.reason})` : 'none';
    lines.push(`| ${run.taskId} | ${run.off.chars} | ${run.on.chars} | ${run.on.memories} | ${fmt(run.on.memoryChars)} | ${omitted} | ${run.on.sharedFrom.map(maskDomain).join(', ') || 'none'} |`);
  }
  lines.push('', 'Characters are not tokens and are never converted into tokens here.', '', '## Quality (machine checks)', '', '| arm | pass | fail | not run | pass rate |', '| --- | ---: | ---: | ---: | ---: |');
  for (const arm of ARMS) lines.push(`| ${arm} | ${quality.byArm[arm].pass} | ${quality.byArm[arm].fail} | ${quality.byArm[arm].notRun} | ${pct(quality.byArm[arm].passRate)} |`);
  lines.push('', '## Tokens (source named)', '');
  if (usage.billings.length === 0) lines.push('No usage records. All token values are unknown.', '');
  for (const billing of usage.billings) {
    lines.push(`Billing: ${billing}`, '', '| arm | field | provider-reported | estimated (method) | tasks without a provider value | complete |', '| --- | --- | ---: | --- | ---: | --- |');
    for (const arm of ARMS) for (const field of TOKEN_FIELDS) {
      const entry = usage.summary[arm][billing][field];
      const estimate = entry.estimated === null ? 'none' : `${entry.estimated} (${entry.estimateMethods.join('; ')})`;
      lines.push(`| ${arm} | ${field} | ${fmt(entry.providerReported)} | ${estimate} | ${entry.tasksWithoutProviderValue} | ${entry.complete ? 'yes' : 'no'} |`);
    }
    lines.push('');
  }
  lines.push('## Conclusion', '', claim.supported ? 'Supported: total token use was lower with memory and quality did not regress (see sample limits).' : `Not supported. Reasons: ${claim.reasons.join(', ')}.`);
  if (claim.supported) lines.push('', 'A sum of tokens is not a cost: cache tokens are priced differently, and subscription and API billing differ.');
  if (notes.length > 0) lines.push('', '## Notes', '', ...notes.map((note) => `- ${note}`));
  return `${lines.join('\n')}\n`;
}

module.exports = { measureInjection, evaluateChecks, summarizeUsage, assessSavingsClaim, renderReport, ARMS, TOKEN_FIELDS, MIN_TASKS_FOR_CLAIM };
