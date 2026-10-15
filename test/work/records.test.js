'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { STATES } = require('../../src/work/states');
const { DEFAULT_LABELS, normalizeLabels, publicLabelFor, publicProjection } = require('../../src/work/labels');
const { SYNC, repoKey, linkKey, validateLink, createMemoryLinkStore } = require('../../src/work/links');
const { REPO, PRIVATE, SHA } = require('./helpers');

const valid = (extra) => ({
  repoId: 'example-org/example-repo', issueNumber: 7, state: 'claimed', sync: 'confirmed', ...PRIVATE,
  headSha: null, prNumber: null, reviewKind: null, claimedAt: '2026-10-14T12:00:00.000Z', lastSyncedAt: '2026-10-14T12:00:00.000Z', ...extra
});

test('the status shown on GitHub is one neutral label, and a finished issue shows none of ours', () => {
  const expected = {
    ready: 'ready', blocked: 'blocked', claimed: 'in-progress', in_progress: 'in-progress', pr_open: 'in-progress', review_pending: 'in-progress',
    changes_requested: 'in-progress', worker_updates: 'in-progress', pm_passed: 'in-progress', ready_to_merge: 'in-progress', merged: null, closed: null
  };
  assert.deepEqual(Object.keys(expected).sort(), [...STATES].sort(), 'every state is covered');
  for (const [state, label] of Object.entries(expected)) assert.equal(publicLabelFor(state), label, state);
  assert.equal(publicLabelFor('unknown'), null);
  assert.deepEqual(publicLabelFor('claimed', { ready: 'a', claimed: 'b', blocked: 'c' }), 'b');
});

test('only the repository, the issue number and the neutral label may leave the machine', () => {
  const projected = publicProjection(valid({ state: 'in_progress' }));
  assert.deepEqual(projected, { repo: 'example-org/example-repo', issueNumber: 7, label: 'in-progress' });
  const text = JSON.stringify(projected);
  for (const secret of [PRIVATE.sessionId, PRIVATE.worktree, PRIVATE.branch]) assert.equal(text.includes(secret), false);
});

test('label names are plain status words: short, lower case, no path, no address, no identifier', () => {
  assert.deepEqual({ ...normalizeLabels() }, { ...DEFAULT_LABELS });
  assert.deepEqual({ ...normalizeLabels({ claimed: 'doing' }) }, { ready: 'ready', claimed: 'doing', blocked: 'blocked' });
  for (const bad of ['', ' ', 'Capital', 'a/b', 'a\\b', 'a@b', 'a:b', 'a.b', 'a'.repeat(51), '-leading', 'tab\there', 'new\nline', 5, null, {}, []]) {
    assert.throws(() => normalizeLabels({ claimed: bad }), TypeError, JSON.stringify(bad));
  }
  assert.throws(() => normalizeLabels({ ready: 'x', claimed: 'x' }), TypeError);
  assert.throws(() => normalizeLabels({ ready: 'in-progress' }), TypeError, 'two states cannot share one label');
  assert.equal(Object.isFrozen(normalizeLabels()), true);
  assert.equal(Object.isFrozen(DEFAULT_LABELS), true);
});

test('repositories compare without case, and a bad repository or issue number is a programming error', () => {
  assert.equal(repoKey({ owner: 'Example-Org', name: 'Example-Repo' }), 'example-org/example-repo');
  assert.equal(linkKey({ owner: 'A', name: 'b' }, 3), 'a/b#3');
  for (const bad of [null, undefined, 'a/b', {}, { owner: 'a' }, { owner: 'a', name: '..' }, { owner: '.', name: 'b' }, { owner: 'a b', name: 'c' }, { owner: 'a', name: 'b/c' }]) {
    assert.throws(() => repoKey(bad), TypeError, JSON.stringify(bad));
  }
  for (const bad of [0, -1, 1.5, '7', null, Number.NaN, 2 ** 60]) assert.throws(() => linkKey(REPO, bad), TypeError, String(bad));
});

test('a link record is checked field by field, and its problems name the field, never the value', () => {
  assert.equal(validateLink(valid()).ok, true);
  assert.deepEqual(validateLink(valid({ worktree: undefined, branch: undefined, headSha: undefined, prNumber: undefined, reviewKind: undefined })).link.worktree, null);
  const cases = [
    [{ repoId: 'Example/Repo' }, 'repoId'], [{ repoId: 'no-slash' }, 'repoId'], [{ issueNumber: 0 }, 'issueNumber'], [{ state: 'flying' }, 'state'],
    [{ sync: 'maybe' }, 'sync'], [{ sessionId: 'x y' }, 'sessionId'], [{ sessionId: '' }, 'sessionId'], [{ worktree: '' }, 'worktree'],
    [{ worktree: 'a\u0000b' }, 'worktree'], [{ branch: 'x'.repeat(256) }, 'branch'], [{ headSha: 'abc' }, 'headSha'], [{ headSha: 'A'.repeat(40) }, 'headSha'],
    [{ prNumber: 0 }, 'prNumber'], [{ reviewKind: 'sort-of' }, 'reviewKind'], [{ claimedAt: 'yesterday' }, 'claimedAt'], [{ lastSyncedAt: 5 }, 'lastSyncedAt'],
    [{ state: 'merged' }, 'terminal-state-is-not-kept'], [{ state: 'closed' }, 'terminal-state-is-not-kept'], [{ extra: 1 }, 'unknown-field']
  ];
  for (const [change, problem] of cases) {
    const result = validateLink(valid(change));
    assert.equal(result.ok, false, JSON.stringify(change));
    assert.ok(result.problems.includes(problem), `${JSON.stringify(change)} -> ${result.problems}`);
    assert.equal(JSON.stringify(result).includes(PRIVATE.worktree), false, 'no value is repeated');
  }
  for (const bad of [null, undefined, 'link', 7, []]) assert.deepEqual(validateLink(bad), { ok: false, problems: ['not-an-object'] });
  assert.deepEqual([...SYNC].sort(), ['claiming', 'confirmed', 'conflict', 'needs_confirmation', 'unverified']);
});

test('the store keeps its own copies, refuses what is invalid, and finds an issue whichever way the name is written', async () => {
  const store = createMemoryLinkStore();
  const link = valid({ headSha: SHA('a') });
  await store.save(link);
  link.state = 'in_progress'; // changing the caller's object does not change the store
  assert.equal((await store.get({ owner: 'EXAMPLE-ORG', name: 'Example-Repo' }, 7)).state, 'claimed');
  const listed = await store.list();
  listed[0].state = 'ready';
  assert.equal((await store.get(REPO, 7)).state, 'claimed');
  await assert.rejects(() => store.save({ repoId: 'a/b' }), TypeError);
  await store.remove({ owner: 'Example-Org', name: 'example-repo' }, 7);
  assert.equal(await store.get(REPO, 7), null);
  assert.deepEqual(await store.list(), []);
  await store.remove(REPO, 99);
});
