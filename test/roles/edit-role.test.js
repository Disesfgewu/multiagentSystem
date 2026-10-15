'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFromTemplate } = require('../../src/roles/templates');
const { editRoleRecord } = require('../../src/roles/edit-role');

const role = (templateId = 'worker') => buildFromTemplate({ templateId, provider: 'claude', name: '', newId: 'role-edit' }).record;
const changed = (record, change) => {
  const result = editRoleRecord(record, change, { newId: () => 'synthetic' });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.record.group.version, record.group.version + 1);
  assert.deepEqual(record, role(record.group.role === 'pm' ? 'pm' : 'worker'), 'the editor must not mutate the previously read record');
  return result.record;
};

test('rename, tool permission, account default and both scopes each produce a validated new version', () => {
  assert.equal(changed(role(), { kind: 'rename', name: 'New name' }).group.name, 'New name');
  assert.equal(changed(role(), { kind: 'tool', tool: 'network', level: 'deny' }).group.toolPermissions.network, 'deny');
  assert.equal(changed(role(), { kind: 'account', profileId: 'acct-test' }).group.defaultAccountProfileId, 'acct-test');
  assert.equal(changed(role(), { kind: 'repositories', entries: ['owner/repo'] }).group.allowedScope.repositories[0], 'owner/repo');
  assert.equal(changed(role(), { kind: 'paths', entries: ['src'] }).group.allowedScope.paths[0], 'src');
});

test('PM template replaces its own instruction once and cannot be put in a worker role', () => {
  const pm = role('pm');
  const first = editRoleRecord(pm, { kind: 'pm-template', text: 'Review work.' });
  assert.equal(first.ok, true);
  const again = editRoleRecord(first.record, { kind: 'pm-template', text: 'Review carefully.' });
  assert.equal(again.ok, true);
  assert.equal(again.record.group.rules.filter((rule) => rule.id === 'pm-system-prompt').length, 1);
  assert.equal(again.record.group.rules.find((rule) => rule.id === 'pm-system-prompt').text, 'Review carefully.');
  assert.deepEqual(editRoleRecord(role(), { kind: 'pm-template', text: 'No.' }), { ok: false, reason: 'invalid-edit' });
});

test('add, edit and remove instruction work in both role and preview layers without changing other layers', () => {
  for (const layer of ['roleGroup', 'task', 'project', 'user', 'platform']) {
    const source = role();
    const beforeCount = source.group.rules.length;
    const added = editRoleRecord(source, { kind: 'add', layer, text: 'Synthetic instruction.' }, { newId: () => 'synthetic' });
    assert.equal(added.ok, true);
    const rules = layer === 'roleGroup' ? added.record.group.rules : added.record.layers[layer];
    assert.equal(rules.find((rule) => rule.id === 'instruction-synthetic').text, 'Synthetic instruction.');
    const edited = editRoleRecord(added.record, { kind: 'edit', layer, ruleId: 'instruction-synthetic', text: 'Revised.' });
    const revised = layer === 'roleGroup' ? edited.record.group.rules : edited.record.layers[layer];
    assert.equal(revised.find((rule) => rule.id === 'instruction-synthetic').version, 2);
    assert.equal(revised.find((rule) => rule.id === 'instruction-synthetic').text, 'Revised.');
    const removed = editRoleRecord(edited.record, { kind: 'remove', layer, ruleId: 'instruction-synthetic' });
    const finalRules = layer === 'roleGroup' ? removed.record.group.rules : removed.record.layers[layer];
    assert.equal(finalRules.some((rule) => rule.id === 'instruction-synthetic'), false);
    if (layer !== 'roleGroup') assert.equal(removed.record.group.rules.length, beforeCount);
    assert.equal(source.group.version, 1);
  }
});

test('invalid input, missing target and unsafe values leave the original record unchanged', () => {
  const source = role();
  const snapshot = structuredClone(source);
  for (const change of [
    { kind: 'rename', name: 'bad\nname' },
    { kind: 'tool', tool: 'merge', level: 'permit' },
    { kind: 'account', profileId: '../bad' },
    { kind: 'paths', entries: ['../outside'] },
    { kind: 'repositories', entries: ['not-a-repository'] },
    { kind: 'add', layer: 'task', text: '' },
    { kind: 'edit', layer: 'task', ruleId: 'missing', text: 'Text' },
    { kind: 'remove', layer: 'task', ruleId: 'missing' },
    { kind: 'unknown' }
  ]) assert.equal(editRoleRecord(source, change).ok, false, change.kind);
  assert.deepEqual(source, snapshot);
});
