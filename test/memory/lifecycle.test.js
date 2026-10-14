'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MemoryStore, CONFIRM_DELETE_SCOPE, DEFAULT_BUDGET_CHARS, MAX_BUDGET_CHARS, looksLikeTranscript } = require('../../src/memory/store');
const { renderContext, planInjection } = require('../../src/memory/injection');

const human = { kind: 'human', id: 'reviewer' };
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-01-01T00:00:00Z');

function setup(t, nowRef = { value: NOW }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multiagent-lifecycle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(repoRoot);
  const dir = path.join(root, 'private');
  const store = new MemoryStore({ dir, repoRoot, now: () => nowRef.value });
  return { root, repoRoot, dir, store, nowRef, file: path.join(dir, 'memory.json') };
}

const scope = (extra) => ({ repoId: 'repo-1', roleGroupId: 'impl', privacyDomain: 'domain-1', ...extra });
const TASK = 'build the release with the packaging script';
const content = 'Release builds are produced with the packaging script under scripts/package.';

function adopt(store, extra = {}) {
  const proposed = store.propose({ ...scope(), content, source: { kind: 'file', ref: 'docs/RELEASE.md', digest: 'd1' }, ...extra });
  assert.equal(proposed.ok, true, JSON.stringify(proposed));
  assert.equal(store.adopt(proposed.id, human).ok, true);
  return proposed.id;
}
const read = (store, extra) => store.select({ ...scope(), task: TASK, ...extra });
const rewrite = (file, change) => {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  change(data);
  fs.writeFileSync(file, JSON.stringify(data));
};

// ---- switching off and on ---------------------------------------------------

test('a memory that is switched off is kept but never read, and switching it on restores it exactly', (t) => {
  const { store } = setup(t);
  const id = adopt(store);
  const before = store.list()[0];
  assert.deepEqual(store.disable(id), { ok: true });
  assert.deepEqual(read(store).items, []);
  assert.equal(store.list()[0].status, 'adopted', 'its status did not change');
  assert.deepEqual(store.disable(id), { ok: false, reason: 'already-disabled' });
  assert.deepEqual(store.enable(id), { ok: true });
  assert.deepEqual(read(store).items.map((item) => item.id), [id]);
  const after = store.list()[0];
  assert.deepEqual({ ...after, version: before.version, disabled: undefined }, { ...before, disabled: undefined }, 'only the version moved');
  assert.equal(after.version, before.version + 2);
  assert.deepEqual(store.enable(id), { ok: false, reason: 'not-disabled' });
  assert.deepEqual(store.disable('mem_missing'), { ok: false, reason: 'not-found' });
  assert.deepEqual(store.enable('mem_missing'), { ok: false, reason: 'not-found' });
});

test('adopting a memory that is switched off does not switch it on', (t) => {
  const { store } = setup(t);
  const proposed = store.propose({ ...scope(), content, source: { kind: 'file', ref: 'docs/R.md', digest: 'd' } });
  store.disable(proposed.id);
  assert.equal(store.adopt(proposed.id, human).ok, true);
  assert.deepEqual(read(store).items, [], 'adopted but still switched off');
});

// ---- re-verifying -----------------------------------------------------------

test('a memory whose source changed can be read again only after a named person confirms it against the current source', (t) => {
  const { store, nowRef } = setup(t);
  const id = adopt(store);
  assert.deepEqual(store.revalidate({ 'docs/RELEASE.md': 'd2' }), [id]);
  assert.equal(store.list()[0].status, 'stale');
  assert.deepEqual(read(store).items, []);

  nowRef.value += 3 * DAY;
  assert.deepEqual(store.reverify(id, true, { digest: 'd2' }), { ok: false, reason: 'approver-required' });
  assert.deepEqual(store.reverify(id, { kind: 'human' }, { digest: 'd2' }), { ok: false, reason: 'approver-required' });
  assert.deepEqual(store.reverify(id, { kind: 'robot', id: 'x' }, { digest: 'd2' }), { ok: false, reason: 'approver-required' });
  for (const bad of [undefined, {}, { digest: '' }, { digest: 5 }, { digest: 'x'.repeat(201) }]) {
    assert.deepEqual(store.reverify(id, human, bad), { ok: false, reason: 'digest-required' }, JSON.stringify(bad));
  }
  assert.deepEqual(read(store).items, [], 'nothing was re-adopted by those attempts');

  assert.deepEqual(store.reverify(id, human, { digest: 'd2' }), { ok: true });
  const item = store.list()[0];
  assert.deepEqual([item.status, item.source.digest, item.approvedBy], ['adopted', 'd2', { kind: 'human', id: 'reviewer' }]);
  assert.equal(item.verifiedAt, new Date(nowRef.value).toISOString(), 'its time to live starts again from now');
  assert.deepEqual(read(store).items.map((entry) => entry.id), [id]);
  assert.deepEqual(store.reverify(id, human, { digest: 'd2' }), { ok: false, reason: 'not-stale' });
  assert.deepEqual(store.revalidate({ 'docs/RELEASE.md': 'd2' }), [], 'and it matches its source again');
});

test('only a stale memory can be re-verified', (t) => {
  const { store } = setup(t);
  const candidate = store.propose({ ...scope(), content, source: { kind: 'file', ref: 'docs/R.md', digest: 'd' } });
  assert.deepEqual(store.reverify(candidate.id, human, { digest: 'd' }), { ok: false, reason: 'not-stale' });
  store.adopt(candidate.id, human);
  assert.deepEqual(store.reverify(candidate.id, human, { digest: 'd' }), { ok: false, reason: 'not-stale' });
  store.reject(candidate.id);
  assert.deepEqual(store.reverify(candidate.id, human, { digest: 'd' }), { ok: false, reason: 'not-stale' });
  assert.deepEqual(store.reverify('mem_missing', human, { digest: 'd' }), { ok: false, reason: 'not-found' });
});

// ---- deleting a scope -------------------------------------------------------

test('deleting a scope needs all three parts and an explicit confirmation, and touches only that scope', (t) => {
  const { store } = setup(t);
  const mine = adopt(store);
  const otherDomain = adopt(store, { privacyDomain: 'domain-2', content: 'The packaging script is run from the release directory after tests pass.' });
  const otherRepo = adopt(store, { repoId: 'repo-2', content: 'Tests are run with the unit test script before the packaging script.' });
  const otherRole = adopt(store, { roleGroupId: 'review', content: 'Review packaging script changes for the release before approving them.' });
  const before = fs.readFileSync(path.join(store.dir, 'memory.json'), 'utf8');

  for (const bad of [undefined, {}, { repoId: 'repo-1' }, { repoId: 'repo-1', roleGroupId: 'impl' }, { ...scope(), privacyDomain: 'Bad Domain' },
    { ...scope(), repoId: '' }, { ...scope(), roleGroupId: 'a\nb' }, { repoId: '*', roleGroupId: '*', privacyDomain: '*' }]) {
    assert.deepEqual(store.removeScope(bad, { confirm: CONFIRM_DELETE_SCOPE }), { ok: false, reason: 'invalid-scope' }, JSON.stringify(bad));
  }
  for (const confirm of [undefined, true, 'yes', 'delete', 'DELETE-MEMORY-SCOPE']) {
    assert.deepEqual(store.removeScope(scope(), { confirm }), { ok: false, reason: 'confirmation-required' }, String(confirm));
  }
  assert.deepEqual(store.removeScope(scope()), { ok: false, reason: 'confirmation-required' });
  assert.equal(fs.readFileSync(path.join(store.dir, 'memory.json'), 'utf8'), before, 'nothing was changed by a refused request');

  assert.deepEqual(store.removeScope(scope(), { confirm: CONFIRM_DELETE_SCOPE }), { ok: true, removed: 1 });
  assert.deepEqual(store.list().map((item) => item.id).sort(), [otherDomain, otherRepo, otherRole].sort());
  assert.equal(store.list().some((item) => item.id === mine), false);
  assert.deepEqual(store.removeScope(scope(), { confirm: CONFIRM_DELETE_SCOPE }), { ok: true, removed: 0 });
});

// ---- rebuilding -------------------------------------------------------------

test('a rebuild takes out of use what no longer passes today\'s rules, and never puts anything into use', (t) => {
  const { store, file } = setup(t);
  const fine = adopt(store);
  const secretish = adopt(store, { content: 'The deployment helper reads its settings from the release configuration file.', source: { kind: 'file', ref: 'docs/D.md', digest: 'x' } });
  // Memory that was accepted under older rules: a secret-shaped value, a transcript, a malformed record.
  rewrite(file, (data) => {
    data.items.find((item) => item.id === secretish).content = 'Use token ghp_syntheticsyntheticsynthetic1234 for the release.';
    data.items.push({ id: 'mem_transcript', repoId: 'repo-1', roleGroupId: 'impl', privacyDomain: 'domain-1', status: 'adopted', content: 'User: how do I release?\nAssistant: run the packaging script.\nUser: and then?\nAssistant: tag it.', source: { kind: 'task', ref: 't', digest: null }, createdAt: '2026-01-01T00:00:00.000Z', verifiedAt: '2026-01-01T00:00:00.000Z', ttlMs: DAY * 30, version: 2 });
    data.items.push({ id: 'mem_broken', status: 'adopted', content: 'x' });
    data.items.push('not an object', null, 7);
  });
  const result = store.rebuild();
  assert.equal(result.ok, true);
  assert.equal(result.checked, 7, 'two stored notes, a transcript, a broken record and three entries that are not records');
  assert.equal(result.dropped, 3, 'entries that are not records at all are dropped');
  assert.deepEqual(result.quarantined.map((entry) => entry.id).sort(), ['mem_broken', 'mem_transcript', secretish].sort());
  const byId = Object.fromEntries(result.quarantined.map((entry) => [entry.id, entry.reasons]));
  assert.ok(byId[secretish].includes('sensitive:github-token'));
  assert.deepEqual(byId.mem_transcript, ['transcript-like']);
  assert.deepEqual(byId.mem_broken, ['invalid-record']);
  assert.equal(JSON.stringify(result).includes('syntheticsynthetic'), false, 'the report holds codes, never the content');

  const items = Object.fromEntries(store.list().map((item) => [item.id, item]));
  assert.equal(items[secretish].content, '', 'a value that is now recognised as secret is blanked, not kept');
  assert.deepEqual([items[secretish].status, items.mem_transcript.status, items.mem_broken.status], ['quarantined', 'quarantined', 'quarantined']);
  assert.equal(fs.readFileSync(file, 'utf8').includes('ghp_synthetic'), false, 'and is gone from the file');
  assert.deepEqual(read(store).items.map((item) => item.id), [fine], 'what passed is still read');
  assert.deepEqual(store.rebuild(), { ok: true, checked: 4, quarantined: [], duplicatesRejected: [], dropped: 0 }, 'a second rebuild finds nothing more');
});

test('a rebuild folds duplicates in one scope into the earliest, and leaves other scopes alone', (t) => {
  const { store, file, nowRef } = setup(t);
  const first = adopt(store);
  nowRef.value += DAY;
  const copy = adopt(store, { privacyDomain: 'domain-2' });
  rewrite(file, (data) => {
    // A later duplicate in the first scope, as an older version of the store could have written.
    const original = data.items.find((item) => item.id === first);
    data.items.push({ ...original, id: 'mem_later_copy', createdAt: '2026-01-05T00:00:00.000Z', content: `  ${original.content.toUpperCase()}  ` });
  });
  const result = store.rebuild();
  assert.deepEqual(result.duplicatesRejected, ['mem_later_copy']);
  const items = Object.fromEntries(store.list().map((item) => [item.id, item]));
  assert.deepEqual([items.mem_later_copy.status, items.mem_later_copy.duplicateOf], ['rejected', first]);
  assert.equal(items[first].status, 'adopted');
  assert.equal(items[copy].status, 'adopted', 'the same text in another domain is not a duplicate');
  assert.deepEqual(result.quarantined, []);
});

test('a rebuild that finds nothing wrong writes nothing', (t) => {
  const { store, file } = setup(t);
  adopt(store);
  const before = fs.readFileSync(file, 'utf8');
  const mtime = fs.statSync(file).mtimeMs;
  assert.deepEqual(store.rebuild(), { ok: true, checked: 1, quarantined: [], duplicatesRejected: [], dropped: 0 });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.statSync(file).mtimeMs, mtime);
});

test('a store that cannot be read is not rebuilt or exported, and says why', (t) => {
  const { store, file } = setup(t);
  adopt(store);
  fs.writeFileSync(file, '{ truncated');
  assert.deepEqual(store.rebuild(), { ok: false, reason: 'store-unavailable', detail: 'corrupt' });
  assert.deepEqual(store.exportMasked(), { ok: false, reason: 'corrupt' });
  assert.equal(fs.readFileSync(file, 'utf8'), '{ truncated');
});

// ---- the masked export ------------------------------------------------------

test('the masked export counts memory by state and scope and reveals nothing that identifies it', (t) => {
  const { store, nowRef } = setup(t);
  const ready = adopt(store);
  adopt(store, { content: 'Tests run with the unit test script before packaging.', source: { kind: 'file', ref: 'docs/T.md', digest: 't' } });
  store.propose({ ...scope(), content: 'A candidate note about the release process that nobody adopted.', source: { kind: 'file', ref: 'docs/C.md', digest: 'c' } });
  const stale = adopt(store, { content: 'The stale note about packaging that changed upstream recently.', source: { kind: 'file', ref: 'docs/S.md', digest: 's' } });
  // Every source is listed, so only the one that really changed becomes stale.
  store.revalidate({ 'docs/RELEASE.md': 'd1', 'docs/T.md': 't', 'docs/S.md': 'changed' });
  store.disable(ready);
  const rejected = store.propose({ ...scope(), content: 'A rejected note about nothing in particular for the release.', source: { kind: 'file', ref: 'docs/X.md' } });
  store.reject(rejected.id);
  const otherScope = adopt(store, { repoId: 'repo-private-name', roleGroupId: 'role-private-name', privacyDomain: 'domain-private-name', content: 'Another note kept in a different scope entirely for the release.', source: { kind: 'file', ref: 'docs/O.md', digest: 'o' } });
  nowRef.value += 31 * DAY;

  const exported = store.exportMasked();
  assert.equal(exported.ok, true);
  const body = exported.export;
  assert.equal(body.format, 'multiagent-memory-masked');
  assert.equal(body.exportedAt, new Date(nowRef.value).toISOString());
  assert.equal(body.items, 6);
  assert.deepEqual(body.totals, { ready: 0, candidate: 1, stale: 1, expired: 2, disabled: 1, rejected: 1, quarantined: 0 });
  assert.deepEqual(body.scopes.map((entry) => entry.alias), ['scope#1', 'scope#2']);
  assert.equal(body.scopes.reduce((total, entry) => total + Object.values(entry.counts).reduce((a, b) => a + b, 0), 0), 6);

  const text = JSON.stringify(exported);
  for (const secret of [ready, stale, otherScope, rejected.id, 'repo-1', 'impl', 'domain-1', 'repo-private-name', 'role-private-name', 'domain-private-name',
    'docs/RELEASE.md', 'docs/S.md', 'packaging', 'release', 'reviewer', 'human', content.slice(0, 20)]) {
    assert.equal(text.includes(secret), false, `${secret} must not appear`);
  }
});

test('the masked export is the same for the same data, whatever order it was written in', (t) => {
  // The scopes differ in what they hold, so a different order of aliases would show.
  const make = (t2, order) => {
    const { store } = setup(t2);
    const write = {
      'domain-a': () => adopt(store, { privacyDomain: 'domain-a', content: 'Note for domain a about the packaging script and release builds.' }),
      'domain-b': () => {
        adopt(store, { privacyDomain: 'domain-b', content: 'Note for domain b about the packaging script and release builds.' });
        store.propose({ ...scope({ privacyDomain: 'domain-b' }), content: 'A candidate for domain b about the packaging script and release.', source: { ref: 'docs/b.md' } });
      },
      'domain-c': () => {
        for (const n of [1, 2]) store.propose({ ...scope({ privacyDomain: 'domain-c' }), content: `Candidate number ${n} for domain c about the packaging script.`, source: { ref: `docs/c${n}.md` } });
      }
    };
    for (const domain of order) write[domain]();
    return JSON.stringify(store.exportMasked().export.scopes);
  };
  const forward = make(t, ['domain-a', 'domain-b', 'domain-c']);
  assert.equal(make(t, ['domain-c', 'domain-a', 'domain-b']), forward);
  assert.equal(make(t, ['domain-b', 'domain-c', 'domain-a']), forward);
  const scopes = JSON.parse(forward);
  assert.deepEqual(scopes.map((entry) => [entry.alias, entry.counts.ready, entry.counts.candidate]), [['scope#1', 1, 0], ['scope#2', 1, 1], ['scope#3', 0, 2]]);
});

// ---- expiry fails closed ----------------------------------------------------

test('a memory whose time of verification cannot be read counts as expired, not as valid for ever', (t) => {
  const { store, file } = setup(t);
  const id = adopt(store);
  assert.equal(read(store).items.length, 1);
  for (const broken of [null, 'yesterday', '', undefined, 12345678]) {
    rewrite(file, (data) => { const item = data.items.find((entry) => entry.id === id); if (broken === undefined) delete item.verifiedAt; else item.verifiedAt = broken; });
    assert.equal(read(store).items.length, 0, `verifiedAt ${JSON.stringify(broken)}`);
  }
  rewrite(file, (data) => { const item = data.items.find((entry) => entry.id === id); item.verifiedAt = '2026-01-01T00:00:00.000Z'; item.ttlMs = 'forever'; });
  assert.equal(read(store).items.length, 0, 'a time to live that is not a number');
  for (const ttl of [null, undefined, Number.NaN, Infinity, '30', {}, [], true]) {
    rewrite(file, (data) => { const item = data.items.find((entry) => entry.id === id); item.verifiedAt = '2026-01-01T00:00:00.000Z'; if (ttl === undefined) delete item.ttlMs; else item.ttlMs = ttl; });
    assert.equal(read(store).items.length, 0, `a time to live of ${String(ttl)} is not "valid for ever"`);
  }
  assert.equal(store.exportMasked().export.totals.expired, 1);
});

// ---- the budget -------------------------------------------------------------

test('what the size limit leaves out is reported, never dropped silently', (t) => {
  const { store } = setup(t);
  for (let n = 0; n < 4; n += 1) adopt(store, { content: `Packaging script note number ${n} describes release builds in some detail here.`, source: { kind: 'file', ref: `docs/${n}.md`, digest: `d${n}` } });
  const all = read(store, { budgetChars: 1000 });
  assert.equal(all.items.length, 4);
  assert.equal(all.truncated, false);
  assert.equal('omitted' in all, false, 'nothing was left out, so nothing is reported');

  const tight = read(store, { budgetChars: 160 });
  assert.equal(tight.items.length, 2);
  assert.equal(tight.truncated, true);
  assert.deepEqual(tight.omitted, { count: 2, chars: 2 * 'Packaging script note number 0 describes release builds in some detail here.'.length, reason: 'budget' });
  assert.ok(tight.usedChars <= 160);

  const none = read(store, { budgetChars: 0 });
  assert.deepEqual([none.items.length, none.omitted.count], [0, 4], 'a budget of nothing leaves everything out, and says so');
});

test('the budget is bounded: a larger request is capped and says so, an invalid one gets the default', (t) => {
  const { store } = setup(t);
  adopt(store);
  const capped = read(store, { budgetChars: MAX_BUDGET_CHARS * 10 });
  assert.equal(capped.budgetClamped, MAX_BUDGET_CHARS);
  assert.equal(read(store, { budgetChars: MAX_BUDGET_CHARS }).budgetClamped, undefined, 'exactly the limit is not a cap');
  assert.equal('budgetClamped' in read(store), false);
  assert.equal(MAX_BUDGET_CHARS > DEFAULT_BUDGET_CHARS, true);

  // Many notes together are bounded by the cap however large the request.
  const big = setup(t);
  for (let n = 0; n < 40; n += 1) {
    big.store.propose({ ...scope(), content: `Packaging script release note ${n}: ${'detail '.repeat(60)}`, source: { kind: 'file', ref: `docs/${n}.md`, digest: `d${n}` } });
  }
  for (const item of big.store.list()) big.store.adopt(item.id, human);
  const result = big.store.select({ ...scope(), task: TASK, budgetChars: 1e9 });
  assert.ok(result.usedChars <= MAX_BUDGET_CHARS, `${result.usedChars} chars`);
  assert.ok(result.omitted.count > 0);

  const defaulted = adopt(setup(t).store);
  assert.ok(defaulted);
  for (const bad of [-1, Number.NaN, 'big', null, Infinity, {}]) {
    const sized = big.store.select({ ...scope(), task: TASK, budgetChars: bad });
    assert.ok(sized.usedChars <= DEFAULT_BUDGET_CHARS, `${String(bad)}: ${sized.usedChars}`);
    assert.equal(sized.budgetClamped, undefined);
  }
});

test('the injected text says that notes were left out, and how many', () => {
  const roleGroup = { name: 'Implementation' };
  const rules = { forbids: [], requires: [], instructions: [] };
  const memory = { id: 'mem_1', content: 'Release builds use the packaging script.', source: { ref: 'docs/R.md' }, verifiedAt: '2026-01-01T00:00:00.000Z' };
  const plain = renderContext({ roleGroup, rules, memories: [memory] });
  assert.equal(plain.includes('left out'), false, 'nothing is said when nothing was left out');
  assert.match(renderContext({ roleGroup, rules, memories: [memory], omitted: { count: 3 } }), /- \(3 more reviewed notes were left out to stay within the size limit\.\)/);
  assert.match(renderContext({ roleGroup, rules, memories: [memory], omitted: { count: 1 } }), /- \(1 more reviewed note was left out/);
  assert.match(renderContext({ roleGroup, rules, memories: [], omitted: { count: 2 } }), /## Project notes[\s\S]*2 more reviewed notes were left out/, 'even when nothing fitted');
  for (const bad of [undefined, null, {}, { count: 0 }, { count: -1 }, { count: 1.5 }, { count: '3' }]) {
    assert.equal(renderContext({ roleGroup, rules, memories: [memory], omitted: bad }).includes('left out'), false, JSON.stringify(bad));
  }
});

test('a launch plan carries the note about what was left out', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multiagent-plan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(repoRoot);
  const plan = planInjection({
    provider: 'claude', roleGroup: { name: 'Implementation' }, rules: { forbids: [], requires: [], instructions: [] },
    memories: [{ id: 'mem_1', content: 'Release builds use the packaging script.', source: { ref: 'docs/R.md' }, verifiedAt: '2026-01-01T00:00:00.000Z' }],
    omitted: { count: 2 }, privateDir: path.join(root, 'private'), repoRoot, sessionToken: 'session-token-0001'
  });
  assert.match(plan.files[0].content, /2 more reviewed notes were left out/);
});

// ---- what may be stored -----------------------------------------------------

test('a memory is a short note: text shaped like a conversation is refused, and nothing is stored', (t) => {
  const { store, file } = setup(t);
  const transcripts = [
    'User: how do I build the release?\nAssistant: run the packaging script.\nUser: and then tag it?',
    'human: first question about builds\nai: first answer about builds\nhuman: second question\nai: second answer',
    'You: please package the release\nClaude: running the packaging script now\nYou: thanks for packaging',
    '<|im_start|>user\nhow do I release?<|im_end|>\n<|im_start|>assistant\nuse the packaging script<|im_end|>',
    '[INST] how do I release the package [/INST] use the packaging script from the scripts directory',
    'System: be helpful\nUser：全形冒號也算\nAssistant：這是回答',
    '<human>how do I release the package</human><assistant>use the packaging script</assistant>'
  ];
  for (const text of transcripts) {
    assert.equal(looksLikeTranscript(text), true, text.slice(0, 30));
    assert.deepEqual(store.propose({ ...scope(), content: text, source: { ref: 'docs/R.md' } }), { ok: false, reason: 'transcript-like' }, text.slice(0, 30));
  }
  assert.equal(fs.existsSync(file), false, 'nothing was written');

  const fine = [
    'Release builds use the packaging script.\nRun it from the scripts directory.',
    'User: the packaging script takes one argument.\nSystem: macOS and Windows are both supported.',
    'Note: the assistant role may read but not write; the user role is out of scope here.'
  ];
  for (const text of fine) assert.equal(looksLikeTranscript(text), false, text.slice(0, 30));
  assert.equal(store.propose({ ...scope(), content: fine[1], source: { ref: 'docs/R.md' } }).ok, true, 'two labelled lines are a note, not a conversation');
});
