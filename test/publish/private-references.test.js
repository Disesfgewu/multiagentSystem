'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { collectPrivateReferences, STRUCTURAL_KEYS } = require('../../src/publish/private-references');
const { scanPublication } = require('../../src/publish/scan');
const { blockedSentence } = require('../../src/publish/blocked-words');

const hash = (text) => createHash('sha256').update(text).digest('hex');
const COLLECTIONS = ['profiles', 'accountChecks', 'roleGroups', 'sessions', 'policies', 'reportFeedback', 'broadcasts', 'skills', 'ownerPosts'];
// A private store as the extension keeps it, with every kind of private value and the fixed words around them.
const RECORDS = {
  // As profile-service.js writes them: no e-mail address or organization is ever stored (an e-mail is stopped by its shape).
  profiles: [{ id: 'prof-1', value: { kind: 'profile-v1', provider: 'claude', label: 'Work A', status: 'active', configDir: '/Users/someone/.claude-work-a', secretRef: 'secret:default/acct-1', createdAt: '2026-10-20T01:02:03.000Z' } }],
  accountChecks: [{ id: 'acct-1', value: { reason: 'checked', source: 'claude auth status --json', checkedAt: '2026-10-20T01:02:03.000Z', identity: { profileId: 'acct-1', authMethod: 'claude.ai', anomalies: ['config-dir-mismatch'], plan: { field: 'plan', value: 'team', source: 'claude auth status --json' } } } }],
  skills: [{ id: 'sk-1', value: { name: 'release-notes', description: 'Write the private release notes for Project Falcon', body: 'Steps…', source: 'owner', roles: ['role-1'] } }],
  roleGroups: [{ id: 'rg-1', value: { group: { id: 'rg-1', role: 'worker', name: 'Night Shift Builders', rules: 'Always run the private smoke suite first.', toolPermissions: { shell: 'allow', merge: 'deny' } } } }],
  sessions: [{ id: 'sess_1', value: { kind: 'session-v1', provider: 'claude', name: 'E2E Agent 1', cwd: '/Users/someone/projects/secret-app', state: 'active', bodyHash: 'a'.repeat(64) } }],
  policies: [{ id: 'public-feedback-publisher', value: { kind: 'public-feedback-publisher-v1', login: 'owner-login' } }],
  reportFeedback: [{ id: 'fb-1', value: { note: 'Ask about the layoffs before review', headSha: 'b'.repeat(40) } }],
  broadcasts: [{ id: 'bc-1', value: { text: 'Everyone stop and rotate the staging password', state: 'sent' } }],
  ownerPosts: []
};
const store = (records = RECORDS) => ({ list: (collection) => ({ ok: true, items: records[collection] ?? [] }) });
const own = (collection, id) => collection === 'policies' && id === 'public-feedback-publisher';
const refs = () => collectPrivateReferences(store(), COLLECTIONS, { skip: own, hash });
const scan = (text) => scanPublication([{ kind: 'comment', text }], { ...refs(), privateReferencesChecked: undefined });

test('the private values themselves are still stopped, each under an id that names where it is kept (#389)', () => {
  for (const [text, words] of [
    ['please mail someone.private@corp.example', /e-mail address/],
    ['see: Write the private release notes for Project Falcon', /skill/],
    ['config is in /Users/someone/.claude-work-a', /path of this computer|detail of one of your accounts/],
    ['note: Ask about the layoffs before review', /private note on a report/],
    ['Everyone stop and rotate the staging password', /broadcast/],
    ['I used Work A for this', /account name/],
    ['ask Night Shift Builders', /role group/]
  ]) {
    const result = scan(text);
    assert.equal(result.status, 'blocked', text);
    const sentence = blockedSentence(result.findings.map((finding) => ({ category: finding.category, id: finding.id })));
    assert.match(sentence, words, `${text} → ${sentence}`);
    assert.equal(JSON.stringify(result.findings).includes('someone.private'), false, 'the value is never in the findings');
  }
});

test('ordinary sentences are no longer stopped by fixed words or by a private value inside a longer word (#389)', () => {
  for (const text of [
    'Checked on this head: the page draws Markdown as a tree.',
    'The worker is active and the owner approved it; claude and codex both ran.',
    'The team checked it with claude.ai and the release notes are done.',
    'The source of this is the latest build.',
    'Work Area and Workshop are different from the account.'
  ]) assert.equal(scan(text).status, 'clear', text);
  // A private value that is part of a longer word is not that value.
  const tiny = { profiles: [{ id: 'p', value: { label: 'test' } }] };
  const checked = (text) => scanPublication([{ kind: 'comment', text }], collectPrivateReferences(store(tiny), ['profiles'], { hash }));
  assert.equal(checked('the latest run').status, 'clear');
  assert.equal(checked('my test account').status, 'blocked');
});

test('fixed fields, times and hashes are not collected; free-form fields are, under collection:hash:field ids (#389)', () => {
  const { knownValues, rules } = refs();
  const values = knownValues.map((entry) => entry.value);
  for (const fixed of ['allow', 'deny', 'active', 'owner', 'claude.ai', 'team', 'checked', 'claude auth status --json', 'config-dir-mismatch', 'secret:default/acct-1', 'acct-1', 'role-1', 'rg-1', 'profile-v1', '2026-10-20T01:02:03.000Z', 'a'.repeat(64), 'b'.repeat(40), 'sent', 'worker', 'owner-login']) assert.equal(values.includes(fixed), false, fixed);
  for (const free of ['Work A', 'release-notes', 'Write the private release notes for Project Falcon', '/Users/someone/.claude-work-a', 'Night Shift Builders', 'E2E Agent 1', '/Users/someone/projects/secret-app', 'Ask about the layoffs before review', 'Everyone stop and rotate the staging password']) assert.ok(values.includes(free), free);
  const label = knownValues.find((entry) => entry.value === 'Work A');
  assert.equal(label.id, `profiles:${hash('prof-1').slice(0, 12)}:label`);
  assert.deepEqual(rules.map((rule) => rule.id.split(':')[0]), ['reportFeedback', 'broadcasts'], 'notes and broadcasts are also matched as reworded text');
  for (const key of ['source', 'reason', 'status', 'kind', 'id']) assert.ok(STRUCTURAL_KEYS.includes(key), key);
  for (const key of ['label', 'name', 'configDir', 'worktree', 'text', 'body', 'description', 'note', 'login', 'repoId', 'ownerHost', 'model', 'codename', 'paths', 'repositories', 'rules']) assert.equal(STRUCTURAL_KEYS.includes(key), false, `${key} is free-form`);
});

test('anything that cannot be read stops the scan from being trusted (#389)', () => {
  assert.equal(collectPrivateReferences({ list: () => ({ ok: false }) }, ['profiles'], { hash }), null);
  assert.equal(collectPrivateReferences(store({ profiles: [{ id: 'p', value: [] }] }), ['profiles'], { hash }), null);
  assert.equal(collectPrivateReferences(store({ reportFeedback: [{ id: 'f', value: { note: '  ' } }] }), ['reportFeedback'], { hash }), null);
  assert.equal(collectPrivateReferences(store({ broadcasts: [{ id: 'b', value: { state: 'sent' } }] }), ['broadcasts'], { hash }), null);
  const many = { profiles: Array.from({ length: 5001 }, (_, index) => ({ id: `p${index}`, value: { label: `Account number ${index}` } })) };
  assert.equal(collectPrivateReferences(store(many), ['profiles'], { hash }), null, 'more than the scan can hold');
});

test('every collection of the private store was read for the list of fixed fields; a new one fails here until it is (#389)', () => {
  const { REVIEWED_COLLECTIONS } = require('../../src/publish/private-references');
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../src/storage/extensionStorage.ts'), 'utf8');
  const listed = /export const COLLECTIONS = \[([^\]]*)\]/.exec(source);
  assert.ok(listed, 'COLLECTIONS is found');
  const collections = [...listed[1].matchAll(/'([A-Za-z]+)'/g)].map((match) => match[1]);
  assert.ok(collections.length >= 16);
  assert.deepEqual([...collections].sort(), [...REVIEWED_COLLECTIONS].sort(), 'read the new collection\'s writers, add any fixed field to STRUCTURAL_KEYS or STRUCTURAL_PATHS, then add it to REVIEWED_COLLECTIONS');
});
