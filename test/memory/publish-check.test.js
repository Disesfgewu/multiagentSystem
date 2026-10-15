'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MemoryStore } = require('../../src/memory/store');
const { findPrivateFragments, scanMemoryStorePublication } = require('../../src/memory/publish-check');

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

test('publication checks the actual MemoryStore list result and blocks if the store becomes unreadable', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multiagent-publish-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(repoRoot);
  const dir = path.join(root, 'private');
  const store = new MemoryStore({ dir, repoRoot });
  const content = 'The private release gate requires two reviewers before the deployment.';
  assert.equal(store.propose({
    repoId: 'repo', roleGroupId: 'pm', privacyDomain: 'local', content,
    source: { kind: 'file', ref: 'docs/RELEASE.md', digest: 'd1' }
  }).ok, true);
  const listed = store.list();
  const items = Array.isArray(listed) ? listed : listed.items;
  assert.deepEqual(scanMemoryStorePublication(`Notes: ${content}`, store).findings,
    [{ code: 'memory-fragment', id: items[0].id }]);
  assert.equal(scanMemoryStorePublication('A public change with no private text.', store).blocked, false);

  fs.writeFileSync(path.join(dir, 'memory.json'), '{broken');
  assert.equal(store.status().ok, false);
  assert.deepEqual(scanMemoryStorePublication('A public change with no private text.', store), {
    blocked: true, findings: [{ code: 'private-memory-unavailable', id: null }], unmatchable: []
  });
});

test('publication rejects the new result shape when its memory read is unavailable', () => {
  const store = { status: () => ({ ok: true }), list: () => ({ ok: false, reason: 'unsafe-path', items: [] }) };
  assert.equal(scanMemoryStorePublication('Any text', store).blocked, true);
});
