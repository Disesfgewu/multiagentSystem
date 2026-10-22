'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { stateOf, groupNotes, candidates } = require('../../src/memory/panel');

const NOW = Date.parse('2026-10-22T10:00:00.000Z');
const note = (over = {}) => ({ id: 'mem_a', repoId: 'o/r', roleGroupId: 'g1', privacyDomain: 'account:one', content: 'Run the full suite before pushing.', source: { kind: 'user', ref: 'panel' }, createdAt: '2026-10-20T00:00:00.000Z', verifiedAt: '2026-10-20T00:00:00.000Z', ttlMs: 7 * 86400000, status: 'adopted', version: 2, ...over });

test('each state is said in words, and only an adopted, switched-on, unexpired note is given to agents', () => {
  const cases = [[note(), 'active', true], [note({ disabled: true }), 'disabled', false], [note({ status: 'candidate' }), 'candidate', false], [note({ status: 'rejected' }), 'rejected', false], [note({ status: 'stale' }), 'stale', false],
    [note({ status: 'quarantined' }), 'quarantined', false], [note({ ttlMs: 1 }), 'expired', false], [note({ ttlMs: null }), 'expired', false], [note({ verifiedAt: 'never' }), 'expired', false], [{ status: 'odd' }, 'unknown', false], [null, 'unknown', false]];
  for (const [item, key, injected] of cases) assert.deepEqual([stateOf(item, NOW).key, stateOf(item, NOW).injected], [key, injected], JSON.stringify(item));
});

test('notes are grouped by role group and privacy domain, in a fixed order, with their scope, source and expiry', () => {
  const groups = groupNotes([note({ id: 'mem_b', privacyDomain: 'account:two' }), note({ id: 'mem_c', roleGroupId: 'g0' }), note(), null, 5, { id: 'x' }], { g1: 'Workers' }, NOW);
  assert.deepEqual(groups.map((group) => [group.roleGroupId, group.roleName]), [['g0', 'g0 (role group not found)'], ['g1', 'Workers']]);
  assert.deepEqual(groups[1].domains.map((domain) => [domain.domain, domain.items.map((item) => item.id)]), [['account:one', ['mem_a']], ['account:two', ['mem_b']]]);
  const row = groups[1].domains[0].items[0];
  assert.deepEqual([row.stateText, row.injected, row.source, row.expires, row.scope], ['active', true, 'user: panel', 'expires 2026-10-27', 'repository o/r']);
});

test('text from a note is one clean short line in the list and bounded in the tooltip', () => {
  const hostile = `a\nb‮c\u0007${'x'.repeat(5000)}`;
  const [{ domains: [{ items: [row] }] }] = groupNotes([note({ content: hostile })], {}, NOW);
  assert.ok(!/[\u0000-\u001f‮]/.test(row.label + row.full));
  assert.ok(Array.from(row.label).length <= 70 && Array.from(row.full).length <= 2000);
});

test('suggestions are the notes still waiting for review', () => {
  assert.deepEqual(candidates([note(), note({ id: 'mem_s', status: 'candidate' }), null]).map((item) => item.id), ['mem_s']);
  assert.deepEqual(candidates(undefined), []);
});
