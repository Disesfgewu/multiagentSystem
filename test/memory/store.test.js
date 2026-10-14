'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MemoryStore } = require('../../src/memory/store');

function setup(t, nowRef = { value: Date.parse('2026-01-01T00:00:00Z') }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multiagent-memory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(repoRoot);
  const dir = path.join(root, 'private');
  const store = new MemoryStore({ dir, repoRoot, now: () => nowRef.value });
  return { root, repoRoot, dir, store, nowRef };
}

const scopeA = { repoId: 'repo-1', roleGroupId: 'impl', privacyDomain: 'domain-1' };
const note = (extra) => ({
  ...scopeA,
  content: 'Release builds are produced with the packaging script under scripts/package.',
  source: { kind: 'file', ref: 'docs/RELEASE.md', digest: 'd1' },
  ...extra
});
const human = { kind: 'human', id: 'reviewer' };

test('refuses a memory directory inside the repository', (t) => {
  const { repoRoot } = setup(t);
  assert.throws(
    () => new MemoryStore({ dir: path.join(repoRoot, '.memory'), repoRoot }),
    (error) => error.problems.includes('private-root-inside-repo')
  );
});

test('a proposal is a candidate: not retrievable until a named approver adopts it', (t) => {
  const { store } = setup(t);
  const proposed = store.propose(note());
  assert.equal(proposed.ok, true);
  const query = { ...scopeA, task: 'build the release with the packaging script' };
  assert.deepEqual(store.select(query).items, []);

  assert.deepEqual(store.adopt(proposed.id, true), { ok: false, reason: 'approver-required' });
  assert.deepEqual(store.adopt(proposed.id, { kind: 'human' }), { ok: false, reason: 'approver-required' });
  assert.deepEqual(store.adopt(proposed.id, human), { ok: true });
  assert.deepEqual(store.select(query).items.map((item) => item.id), [proposed.id]);
  assert.deepEqual(store.adopt(proposed.id, human), { ok: false, reason: 'not-a-candidate' });
});

test('secret-shaped content is refused and nothing is written', (t) => {
  const { store, dir } = setup(t);
  const result = store.propose(note({ content: 'Use token ghp_syntheticsyntheticsynthetic1234 for the release.' }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'sensitive-content');
  assert.equal(JSON.stringify(result).includes('synthetic'), false);
  assert.equal(fs.existsSync(path.join(dir, 'memory.json')), false);
  assert.deepEqual(store.list(), []);
});

test('missing scope fields, empty and oversized content are rejected', (t) => {
  const { store } = setup(t);
  assert.equal(store.propose(note({ roleGroupId: '' })).reason, 'missing-fields');
  assert.equal(store.propose(note({ source: {} })).reason, 'missing-fields');
  assert.equal(store.propose(note({ content: '   ' })).reason, 'invalid-length');
  assert.equal(store.propose(note({ content: 'x'.repeat(2001) })).reason, 'invalid-length');
});

test('duplicates within one scope are refused, other scopes are independent', (t) => {
  const { store } = setup(t);
  const first = store.propose(note());
  assert.deepEqual(store.propose(note({ content: `  ${note().content.toUpperCase()} ` })),
    { ok: false, reason: 'duplicate', duplicateOf: first.id });
  assert.equal(store.propose(note({ roleGroupId: 'review' })).ok, true);
});

test('retrieval is limited to the exact repo, role group and privacy domain', (t) => {
  const { store } = setup(t);
  const id = store.propose(note()).id;
  store.adopt(id, human);
  const task = 'build the release with the packaging script';
  assert.equal(store.select({ ...scopeA, task }).items.length, 1);
  for (const other of [{ roleGroupId: 'review' }, { repoId: 'repo-2' }, { privacyDomain: 'domain-2' }]) {
    const result = store.select({ ...scopeA, ...other, task });
    assert.deepEqual(result, { items: [], usedChars: 0, truncated: false });
  }
});

test('a changed or missing source marks adopted memory stale and stops retrieval', (t) => {
  const { store } = setup(t);
  const id = store.propose(note()).id;
  store.adopt(id, human);
  assert.deepEqual(store.revalidate({ 'docs/RELEASE.md': 'd1' }), []);
  assert.deepEqual(store.revalidate({ 'docs/RELEASE.md': 'd2' }), [id]);
  assert.equal(store.list()[0].status, 'stale');
  assert.deepEqual(store.select({ ...scopeA, task: 'release packaging script' }).items, []);
});

test('memory expires after its time to live', (t) => {
  const { store, nowRef } = setup(t);
  const id = store.propose(note({ ttlMs: 1000 })).id;
  store.adopt(id, human);
  const query = { ...scopeA, task: 'release packaging script' };
  nowRef.value += 1000;
  assert.equal(store.select(query).items.length, 1);
  nowRef.value += 1;
  assert.equal(store.select(query).items.length, 0);
});

test('ranking, relevance cut-off and character budget', (t) => {
  const { store } = setup(t);
  const add = (content, ref) => {
    const id = store.propose(note({ content, source: { kind: 'file', ref, digest: ref } })).id;
    store.adopt(id, human);
    return id;
  };
  const best = add('Database migrations run with the migrate script before tests.', 'a');
  const weak = add('Tests use the migrate helper.', 'b');
  add('The logo is stored under assets.', 'c');

  const task = 'run database migrations then tests';
  const all = store.select({ ...scopeA, task });
  assert.deepEqual(all.items.map((item) => item.id), [best, weak]);

  const tight = store.select({ ...scopeA, task, budgetChars: 40 });
  assert.deepEqual(tight.items.map((item) => item.id), [weak]);
  assert.equal(tight.truncated, true);
});

test('matches Chinese task text through bigrams', (t) => {
  const { store } = setup(t);
  const id = store.propose(note({ content: '發佈流程需要兩位審查者核准。' })).id;
  store.adopt(id, human);
  assert.equal(store.select({ ...scopeA, task: '請說明發佈流程' }).items.length, 1);
  assert.equal(store.select({ ...scopeA, task: '調整字型大小' }).items.length, 0);
});

test('data persists across instances, with owner-only permissions where supported', (t) => {
  const { dir, repoRoot, store, nowRef } = setup(t);
  const id = store.propose(note()).id;
  store.adopt(id, human);
  const reopened = new MemoryStore({ dir, repoRoot, now: () => nowRef.value });
  assert.equal(reopened.list()[0].status, 'adopted');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(dir, 'memory.json')).mode & 0o777, 0o600);
  }
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
  assert.deepEqual(reopened.remove(id), { ok: true });
  assert.deepEqual(new MemoryStore({ dir, repoRoot }).list(), []);
});
