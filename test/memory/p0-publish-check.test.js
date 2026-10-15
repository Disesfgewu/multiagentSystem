'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MemoryStore } = require('../../src/memory/store');
const { checkPublicationText } = require('../../scripts/p0/check-memory-injection');

test('the P0 publish experiment still catches an adopted memory fragment through MemoryStore.list()', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multiagent-p0-publish-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(repoRoot);
  const store = new MemoryStore({ dir: path.join(root, 'private'), repoRoot });
  const content = 'The synthetic deployment uses the private blue lantern sequence.';
  const proposed = store.propose({
    repoId: 'synthetic-repo', roleGroupId: 'worker', privacyDomain: 'private', content,
    source: { kind: 'task', ref: 'synthetic' }
  });
  assert.equal(proposed.ok, true);
  assert.equal(store.adopt(proposed.id, { kind: 'human', id: 'reviewer' }).ok, true);

  const result = checkPublicationText(store, `Release note: ${content}`);
  assert.equal(result.blocked, true);
  assert.ok(result.findings.some((finding) => finding.code === 'memory-fragment'));
});

test('the P0 publish experiment blocks when its private memory store cannot be read', () => {
  const broken = { list: () => ({ ok: false, reason: 'unsafe-path', items: [] }) };
  assert.deepEqual(checkPublicationText(broken, 'ordinary public text'), {
    blocked: true, findings: [], unmatchable: [], reason: 'memory-store-unavailable'
  });
});

test('the P0 publish experiment passes clean text when the memory store was read successfully', () => {
  const empty = { list: () => ({ ok: true, items: [] }) };
  assert.deepEqual(checkPublicationText(empty, 'Adds validation and covers the directory checks with tests.'), {
    blocked: false, findings: [], unmatchable: []
  });
});
