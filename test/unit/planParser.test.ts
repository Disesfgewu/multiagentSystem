import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parsePlan } from '../../src/plan/parser';

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
    for (const field of ['負責：', '依賴：', '證據：', '下一決策：', '更新：']) assert.ok(line.includes(field), `${task.id}: ${field}`);
  }
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
