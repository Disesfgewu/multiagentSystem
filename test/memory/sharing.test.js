'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MemoryStore } = require('../../src/memory/store');
const { createDomainPolicy } = require('../../src/memory/domains');

const human = { kind: 'human', id: 'reviewer' };
const NOW = Date.parse('2026-01-01T00:00:00Z');

function setup(t, domains, nowRef = { value: NOW }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multiagent-sharing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(repoRoot);
  const store = new MemoryStore({ dir: path.join(root, 'private'), repoRoot, now: () => nowRef.value, domains });
  return { root, store, nowRef, file: path.join(root, 'private', 'memory.json') };
}

const scope = (privacyDomain, extra) => ({ repoId: 'repo-1', roleGroupId: 'impl', privacyDomain, ...extra });
const TASK = 'build the release with the packaging script';

function adopted(store, privacyDomain, content = 'Release builds are produced with the packaging script under scripts/package.', extra) {
  const proposed = store.propose({ ...scope(privacyDomain), content, source: { kind: 'file', ref: `docs/${privacyDomain}.md`, digest: 'd1' }, ...extra });
  assert.equal(proposed.ok, true, JSON.stringify(proposed));
  assert.equal(store.adopt(proposed.id, human).ok, true);
  return proposed.id;
}
const read = (store, privacyDomain, extra) => store.select({ ...scope(privacyDomain), task: TASK, ...extra });
const ids = (result) => result.items.map((item) => item.id);

test('without a policy a reader sees only its own domain, however the others are named', (t) => {
  const { store } = setup(t);
  const a = adopted(store, 'domain-a');
  adopted(store, 'domain-b', 'The packaging script is run from the release directory after tests pass.');
  assert.deepEqual(ids(read(store, 'domain-a')), [a]);
  assert.equal(read(store, 'domain-a').items[0].sharedFrom, undefined, 'its own memory is not marked as shared');
  for (const other of ['domain-c', 'account:acct-x', 'domain-a2']) assert.deepEqual(read(store, other).items, [], other);
});

test('a grant lets one domain read another: only that way round, only for the same repository and role group', (t) => {
  const policy = createDomainPolicy({ grants: [{ reader: 'domain-b', source: 'domain-a' }] });
  const { store } = setup(t, policy);
  const a = adopted(store, 'domain-a');
  const b = adopted(store, 'domain-b', 'The packaging script is run from the release directory after tests pass.');

  const seenByB = read(store, 'domain-b');
  assert.deepEqual(ids(seenByB).sort(), [a, b].sort());
  assert.equal(seenByB.items.find((item) => item.id === a).sharedFrom, 'domain-a', 'shared memory says where it came from');
  assert.equal(seenByB.items.find((item) => item.id === b).sharedFrom, undefined);

  assert.deepEqual(ids(read(store, 'domain-a')), [a], 'the grant is not symmetric: a cannot read b');
  assert.deepEqual(read(store, 'domain-c').items, [], 'and nobody else gets anything');
  // Repository and role group are never shared by a domain grant.
  assert.deepEqual(store.select({ repoId: 'repo-2', roleGroupId: 'impl', privacyDomain: 'domain-b', task: TASK }).items, []);
  assert.deepEqual(store.select({ repoId: 'repo-1', roleGroupId: 'review', privacyDomain: 'domain-b', task: TASK }).items, []);
});

test('a grant is not passed on: reading a domain does not give the domains it reads', (t) => {
  const policy = createDomainPolicy({ grants: [{ reader: 'domain-c', source: 'domain-b' }, { reader: 'domain-b', source: 'domain-a' }] });
  const { store } = setup(t, policy);
  const a = adopted(store, 'domain-a');
  const b = adopted(store, 'domain-b', 'The packaging script is run from the release directory after tests pass.');
  assert.deepEqual(ids(read(store, 'domain-c')), [b], 'c reads b, and not a through b');
  assert.deepEqual(ids(read(store, 'domain-b')).sort(), [a, b].sort());
});

test('shared memory is held to the same rules as any other: not adopted, stale, switched off or expired cannot be read', (t) => {
  const policy = createDomainPolicy({ grants: [{ reader: 'domain-b', source: 'domain-a' }] });
  const { store, nowRef } = setup(t, policy);
  const usable = adopted(store, 'domain-a');
  assert.deepEqual(ids(read(store, 'domain-b')), [usable]);

  const candidate = store.propose({ ...scope('domain-a'), content: 'A candidate note about the packaging script that nobody has adopted.', source: { kind: 'file', ref: 'docs/c.md', digest: 'c' } });
  assert.equal(candidate.ok, true);
  assert.deepEqual(ids(read(store, 'domain-b')), [usable], 'a candidate in the other domain is not read');

  assert.equal(store.disable(usable).ok, true);
  assert.deepEqual(read(store, 'domain-b').items, [], 'switched off');
  store.enable(usable);
  assert.equal(store.revalidate({ 'docs/domain-a.md': 'changed' }).length, 1);
  assert.deepEqual(read(store, 'domain-b').items, [], 'stale');
  assert.equal(store.reverify(usable, human, { digest: 'changed' }).ok, true);
  assert.deepEqual(ids(read(store, 'domain-b')), [usable]);
  nowRef.value += 31 * 24 * 60 * 60 * 1000;
  assert.deepEqual(read(store, 'domain-b').items, [], 'expired');
});

test('a policy that fails or answers wrongly grants nothing beyond the reader\'s own domain', (t) => {
  const answers = {
    throws: () => { throw new Error('policy failed'); },
    notAList: () => 'domain-a',
    anObject: () => ({ 0: 'domain-b', length: 1 }),
    ownMissing: () => ['domain-a'],
    ownNotFirst: () => ['domain-a', 'domain-b'],
    invalidDomain: () => ['domain-b', 'Domain A'],
    wildcard: () => ['domain-b', '*'],
    nonString: () => ['domain-b', 7],
    undefinedAnswer: () => undefined,
    empty: () => []
  };
  for (const [name, answer] of Object.entries(answers)) {
    const { store } = setup(t, { readableDomains: answer });
    adopted(store, 'domain-a');
    const own = adopted(store, 'domain-b', 'The packaging script is run from the release directory after tests pass.');
    assert.deepEqual(ids(read(store, 'domain-b')), [own], name);
  }
  // Duplicates in an otherwise valid answer do no harm.
  const { store } = setup(t, { readableDomains: () => ['domain-b', 'domain-a', 'domain-a'] });
  const a = adopted(store, 'domain-a');
  assert.deepEqual(ids(read(store, 'domain-b')), [a]);
});

test('a store takes a policy built by createDomainPolicy; anything else is refused when it is built', (t) => {
  for (const bad of [{}, { readableDomains: 'x' }, 'policy', 5, true, []]) {
    assert.throws(() => setup(t, bad), TypeError, JSON.stringify(bad));
  }
  assert.doesNotThrow(() => setup(t, null));
  assert.doesNotThrow(() => setup(t, undefined));
});

test('asking for a domain that is not a valid name finds nothing, and the answer looks like any other empty answer', (t) => {
  const policy = createDomainPolicy({ grants: [{ reader: 'domain-b', source: 'domain-a' }] });
  const { store } = setup(t, policy);
  adopted(store, 'domain-a');
  for (const bad of ['Domain-A', 'domain a', '*', '', undefined, null, 5]) {
    assert.deepEqual(store.select({ ...scope(bad), task: TASK }), { items: [], usedChars: 0, truncated: false, unavailable: null }, String(bad));
  }
  assert.deepEqual(read(store, 'domain-never-used'), { items: [], usedChars: 0, truncated: false, unavailable: null });
});

test('a domain that is not a plain label cannot be written either', (t) => {
  const { store } = setup(t);
  for (const bad of ['Domain-A', 'a@b.test', 'a/b', 'a b', '*', 'x'.repeat(65)]) {
    const result = store.propose({ ...scope(bad), content: 'Release builds are produced with the packaging script.', source: { ref: 'docs/R.md' } });
    assert.deepEqual([result.ok, result.reason, result.fields], [false, 'invalid-scope', ['privacyDomain']], bad);
  }
  for (const [field, value] of [['repoId', 'x'.repeat(201)], ['repoId', 'a\nb'], ['roleGroupId', 'a\u0000b'], ['roleGroupId', 'y'.repeat(201)]]) {
    const result = store.propose({ ...scope('domain-a'), [field]: value, content: 'Release builds are produced with the packaging script.', source: { ref: 'docs/R.md' } });
    assert.deepEqual([result.ok, result.reason, result.fields], [false, 'invalid-scope', [field]], `${field}`);
  }
  assert.deepEqual(store.list(), []);
});
