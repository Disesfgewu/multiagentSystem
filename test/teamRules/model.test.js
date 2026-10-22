'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateTeamRules, applyEdit, teamRuleLayer, describeTeamRules, emptyTeamRules, MAX_RULES, MAX_TEXT_CHARS } = require('../../src/teamRules/model');
const { resolveRules } = require('../../src/memory/rules');

const NOW = new Date('2026-10-22T10:00:00.000Z');
const add = (doc, text) => applyEdit(doc, { kind: 'add', text }, NOW);

test('rules are added with fresh ids, edited and removed, and every change raises the version', () => {
  let doc = emptyTeamRules();
  assert.equal(doc.version, 0);
  let step = add(doc, 'Run the tests before you push.');
  assert.equal(step.ok, true);
  doc = step.doc;
  assert.deepEqual(doc.rules.map((rule) => rule.id), ['team:1']);
  assert.equal(doc.version, 1);
  doc = add(doc, 'Write in the project\'s language.').doc;
  assert.deepEqual(doc.rules.map((rule) => rule.id), ['team:1', 'team:2']);
  doc = applyEdit(doc, { kind: 'edit', id: 'team:1', text: 'Run all the tests.' }, NOW).doc;
  assert.equal(doc.rules[0].text, 'Run all the tests.');
  doc = applyEdit(doc, { kind: 'remove', id: 'team:1' }, NOW).doc;
  assert.deepEqual(doc.rules.map((rule) => rule.id), ['team:2']);
  assert.equal(add(doc, 'More.').doc.rules.at(-1).id, 'team:3', 'an id is never reused for the next rule');
  assert.equal(doc.version, 4);
  assert.equal(doc.updatedAt, NOW.toISOString());
});

test('text a person cannot see, empty text, over-long text and too many rules are refused, and nothing changes', () => {
  const doc = add(emptyTeamRules(), 'ok').doc;
  for (const text of ['', 'a‮b', 'a​b', 'a\u0007b', 'x'.repeat(MAX_TEXT_CHARS + 1), 5, null]) assert.deepEqual(add(doc, text), { ok: false, reason: 'invalid-text' }, JSON.stringify(text));
  let full = emptyTeamRules();
  for (let i = 0; i < MAX_RULES; i += 1) full = add(full, `rule ${i}`).doc;
  assert.deepEqual(add(full, 'one more'), { ok: false, reason: 'too-many-rules' });
  assert.deepEqual(applyEdit(doc, { kind: 'edit', id: 'team:9', text: 'x' }, NOW), { ok: false, reason: 'rule-not-found' });
  assert.deepEqual(applyEdit(doc, { kind: 'remove', id: 'team:9' }, NOW), { ok: false, reason: 'rule-not-found' });
  for (const change of [null, {}, { kind: 'wipe' }, 'add']) assert.equal(applyEdit(doc, change, NOW).ok, false);
});

test('a stored list that is damaged is an error, never an empty list', () => {
  const good = add(emptyTeamRules(), 'ok').doc;
  assert.equal(validateTeamRules(good).ok, true);
  for (const bad of [null, [], {}, { ...good, extra: 1 }, { ...good, version: -1 }, { ...good, version: 1.5 }, { ...good, updatedAt: 'never' }, { ...good, rules: 'x' },
    { ...good, rules: [{ id: 'team:1', type: 'forbid', key: 'k' }] }, { ...good, rules: [{ id: 'rg:1', type: 'instruction', text: 'x' }] }, { ...good, rules: [{ id: 'team:1', type: 'instruction', text: 'x', extra: 1 }] },
    { ...good, rules: [good.rules[0], good.rules[0]] }, { ...good, rules: [{ id: 'team:1', type: 'instruction', text: 'a‮b' }] }]) {
    assert.equal(validateTeamRules(bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(teamRuleLayer({ nonsense: true }).length, 0);
  assert.match(describeTeamRules({ nonsense: true }), /unknown.*NOT reflected/);
});

test('the rules are an instruction list for the user layer and compose with a role group\'s rules, the team\'s first', () => {
  const doc = add(add(emptyTeamRules(), 'First team rule.').doc, 'Second team rule.').doc;
  const layer = teamRuleLayer(doc);
  assert.deepEqual(layer, [{ id: 'team:1', type: 'instruction', text: 'First team rule.' }, { id: 'team:2', type: 'instruction', text: 'Second team rule.' }]);
  const resolved = resolveRules([...layer.map((rule) => ({ ...rule, layer: 'user' })), { id: 'role-1', layer: 'roleGroup', type: 'instruction', text: 'Role rule.' }]);
  assert.deepEqual(resolved.instructions.map((entry) => entry.id), ['team:1', 'team:2', 'role-1']);
});

test('the summary line says what applies and that nothing enforces it', () => {
  assert.match(describeTeamRules(emptyTeamRules()), /none/);
  const doc = add(emptyTeamRules(), 'ok').doc;
  assert.match(describeTeamRules(doc), /^Team rules \(v1\): 1 instruction given to every agent started after this version, ahead of its role group's rules\. The CLI is told; nothing here enforces them\.$/);
});

test('a rule that looks like a credential, an email address or a local path is not saved', () => {
  const token = ['gh', 'p_', 'a'.repeat(36)].join('');
  const path = ['', 'Users', 'someone', 'project'].join('/');
  const address = ['someone', 'example.test'].join(String.fromCharCode(64));
  const doc = add(emptyTeamRules(), 'fine').doc;
  for (const text of [`use ${token} for pushes`, `work in ${path}`, `ask ${address}`]) {
    assert.deepEqual(add(doc, text), { ok: false, reason: 'sensitive-text' }, text.slice(0, 10));
    assert.deepEqual(applyEdit(doc, { kind: 'edit', id: 'team:1', text }, NOW), { ok: false, reason: 'sensitive-text' });
  }
  assert.equal(add(doc, 'Run the tests before you push.').ok, true);
});
