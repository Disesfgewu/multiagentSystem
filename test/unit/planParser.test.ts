import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parsePlan, planOwners, planReportLinks } from '../../src/plan/parser';

test('the project core plan has 65 unique decisions and traceable fields', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'docs', 'MASTER_PLAN.md'), 'utf8');
  const parsed = parsePlan(source);
  const tasks = parsed.sections.flatMap((section) => section.tasks);
  assert.deepEqual(parsed.errors, []);
  assert.equal(tasks.length, 65);
  assert.equal(new Set(tasks.map((task) => task.id)).size, tasks.length);
  assert.equal(tasks.filter((task) => task.id.startsWith('DEC-')).length, 6);
  for (const task of tasks) {
    const line = source.split(/\r?\n/)[task.line];
    assert.ok(line.startsWith(`- [ ] ${task.id} `));
    assert.ok((task.owners?.length ?? 0) > 0, `${task.id}: owners`);
    for (const field of ['負責：', '依賴：', '證據：', '下一決策：', '更新：']) assert.ok(line.includes(field), `${task.id}: ${field}`);
  }
});

test('role-group owners are parsed from Chinese and English owner fields', () => {
  assert.deepEqual(planOwners('M1-001 title。負責：PM＋Worker；依賴：#106；'), ['pm', 'worker']);
  assert.deepEqual(planOwners('M1-018 title。負責：Researcher＋Worker；依賴：#89；'), ['researcher', 'worker']);
  assert.deepEqual(planOwners('DEC-001 title。Owner: Owner / QA; dependency: #1;'), ['owner', 'qa']);
  assert.deepEqual(planOwners('M1-099 title without owner field'), []);
});

test('invalid and duplicate IDs are reported without making them clickable', () => {
  const parsed = parsePlan('## M1\n- [ ] M1-001 first\n- [x] M1-001 duplicate\n- [ ] no-id text\n## M2\n- [ ] M2-001 second');
  assert.equal(parsed.errors.length, 2);
  assert.deepEqual(parsed.sections.flatMap((section) => section.tasks.map((task) => task.id)), ['M1-001', 'M2-001']);
});

test('one hundred TODOs remain addressable by source line', () => {
  const source = ['# Project', '## M1', ...Array.from({ length: 100 }, (_, index) => `- [ ] M1-${String(index + 1).padStart(3, '0')} Task ${index + 1}`)].join('\n');
  const parsed = parsePlan(source);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.sections[0].tasks.length, 100);
  assert.equal(parsed.sections[0].tasks[99].line, 101);
});

test('dependency, ordinary evidence and acceptance links preserve kinds and precedence', () => {
  assert.deepEqual(planReportLinks('M1-001 title #999。負責：PM；依賴：#106、#111；證據：PR #112／#108 已合併，Issue #73；下一決策：#900；'), [
    { kind: 'issue', number: 106, field: 'dependency' }, { kind: 'issue', number: 111, field: 'dependency' },
    { kind: 'pullRequest', number: 112, field: 'evidence' }, { kind: 'pullRequest', number: 108, field: 'evidence' }, { kind: 'issue', number: 73, field: 'evidence' }
  ]);
  assert.deepEqual(planReportLinks('dependency: Issue #12, PR #7; evidence: PR #7;'), [{ kind: 'issue', number: 12, field: 'dependency' }, { kind: 'pullRequest', number: 7, field: 'evidence' }], 'the same reference named again as evidence upgrades from a plain dependency');
  assert.deepEqual(planReportLinks('依賴：PR #7；證據：PR #7、#8；驗收依據：PR #7；acceptance: Issue #9;'), [
    { kind: 'pullRequest', number: 7, field: 'acceptance' },
    { kind: 'pullRequest', number: 8, field: 'evidence' },
    { kind: 'issue', number: 9, field: 'acceptance' }
  ]);
  assert.deepEqual(planReportLinks('證據：#123 待確認；依賴：#0、#9007199254740992；'), []);
  assert.deepEqual(planReportLinks('dependency: other/repo#12, https://github.com/o/r/issues/7#123;'), [], 'foreign shorthand and URL fragments must not become same-project links');
  assert.deepEqual(planReportLinks('evidence: [PR #7](https://github.com/other/repo/pull/7);'), [], 'Markdown labels must not redirect a foreign report into this project');
  assert.deepEqual(parsePlan('## M1\n- [ ] M1-001 Task。負責：PM；依賴：#12；證據：PR #7；').sections[0].tasks[0].reports, [{ kind: 'issue', number: 12, field: 'dependency' }, { kind: 'pullRequest', number: 7, field: 'evidence' }]);
});
