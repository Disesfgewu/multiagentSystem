'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { findPrivateFragments } = require('../../src/memory/publish-check');

const memories = [
  { id: 'mem_1', content: 'The release gate for this repo is the Orion checklist, step nine requires two reviewers.' },
  { id: 'mem_2', content: 'Short note' }
];
const rules = [{ id: 'r_1', text: 'Never mention the Orion checklist numbering outside the team.' }];

test('verbatim and lightly reformatted reuse is flagged by id', () => {
  const body = 'Notes:\n\nthe RELEASE gate for this repo is the Orion checklist -- step nine requires two reviewers!';
  const result = findPrivateFragments(body, { memories, rules });
  assert.equal(result.blocked, true);
  assert.deepEqual(result.findings.filter((f) => f.code === 'memory-fragment').map((f) => f.id), ['mem_1']);
});

test('rule text is checked separately from memory', () => {
  const result = findPrivateFragments('Please never mention the Orion checklist numbering outside the team.', { rules });
  assert.deepEqual(result.findings, [{ code: 'rule-fragment', id: 'r_1' }]);
});

test('unrelated public text passes', () => {
  const body = 'This change adds validation for configuration directories and tests for path handling.';
  assert.deepEqual(findPrivateFragments(body, { memories, rules }), { blocked: false, findings: [], unmatchable: [] });
});

test('secret-shaped text is reported by code only', () => {
  const body = 'debug output: ghp_syntheticsyntheticsynthetic1234 and /Users/someone/work';
  const result = findPrivateFragments(body, { memories, rules });
  assert.deepEqual(result.findings.map((f) => f.code).sort(), ['github-token', 'home-path']);
  assert.equal(JSON.stringify(result).includes('synthetic'), false);
});

test('a known short private fragment is matched as a whole, not silently ignored', () => {
  const short = [{ id: 'mem_s', content: '內部暗號甲乙' }];
  const result = findPrivateFragments('審查備註：內部暗號甲乙，請勿外傳。', { memories: short });
  assert.equal(result.blocked, true);
  assert.deepEqual(result.findings, [{ code: 'memory-fragment', id: 'mem_s' }]);
  assert.deepEqual(result.unmatchable, []);
  assert.equal(findPrivateFragments('Short note', { memories }).blocked, true);
});

test('private text too short to match reliably is reported, not skipped quietly', () => {
  const tiny = [{ id: 'mem_t', content: 'abc' }];
  const rule = [{ id: 'r_t', text: 'OK!' }];
  const result = findPrivateFragments('abc OK!', { memories: tiny, rules: rule });
  assert.equal(result.blocked, false);
  assert.deepEqual(result.unmatchable, ['mem_t', 'r_t']);
});
