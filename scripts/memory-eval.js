#!/usr/bin/env node
'use strict';

// Runs the fixed synthetic suite against a temporary MemoryStore and prints the report. It uses
// no real account, CLI or repository, and says so in the report. Usage records come only from a
// JSON file given with --usage (provider-reported numbers recorded elsewhere); without one every
// token value is unknown and no saving can be claimed.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MemoryStore } = require('../src/memory/store');
const { measureInjection, evaluateChecks, summarizeUsage, assessSavingsClaim, renderReport } = require('../src/memory/eval');
const suite = require('../src/memory/eval-suite');

function run({ usageRecords = [], budgetChars } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multiagent-memory-eval-'));
  try {
    const repoRoot = path.join(root, 'repo');
    fs.mkdirSync(repoRoot);
    const store = new MemoryStore({ dir: path.join(root, 'private'), repoRoot });
    for (const memory of suite.memories) {
      const proposed = store.propose({ repoId: suite.SCOPE.repoId, roleGroupId: suite.SCOPE.roleGroupId, privacyDomain: memory.privacyDomain, content: memory.content, source: { ref: `synthetic/${memory.id}.md` } });
      if (!proposed.ok) throw new Error(`could not set up synthetic memory ${memory.id}: ${proposed.reason}`);
      const adopted = store.adopt(proposed.id, { kind: 'rule', id: 'synthetic-eval' });
      if (!adopted.ok) throw new Error(`could not adopt synthetic memory ${memory.id}: ${adopted.reason}`);
    }
    const runs = measureInjection({ store, scope: suite.SCOPE, roleGroup: suite.roleGroup, rules: suite.rules, tasks: suite.tasks, budgetChars });
    const quality = evaluateChecks({ tasks: suite.tasks, runs });
    const taskIds = suite.tasks.map((task) => task.id);
    const usage = summarizeUsage({ records: usageRecords, taskIds });
    const claim = assessSavingsClaim({ usage, quality, taskCount: taskIds.length, real: false });
    return { runs, quality, usage, claim, report: renderReport({ suiteId: suite.suiteId, real: false, runs, quality, usage, claim, notes: ['The suite is synthetic and fixed; it measures injected size and machine checks only.'] }) };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const index = process.argv.indexOf('--usage');
  let usageRecords = [];
  if (index > 0) usageRecords = JSON.parse(fs.readFileSync(process.argv[index + 1], 'utf8'));
  process.stdout.write(run({ usageRecords }).report);
}

module.exports = { run };
