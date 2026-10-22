'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TeamRulesStore } = require('../../src/teamRules/store');
const { applyEdit, emptyTeamRules } = require('../../src/teamRules/model');

const memory = (initial) => {
  const map = new Map(initial === undefined ? [] : [['team', initial]]);
  return {
    get: (_c, id) => (map.has(id) ? { ok: true, found: true, value: map.get(id) } : { ok: true, found: false }),
    transact: (work) => ({ ok: true, value: work({ get: (_c, id) => map.get(id) ?? null, put: (_c, id, value) => map.set(id, value) }) })
  };
};
const doc1 = applyEdit(emptyTeamRules(), { kind: 'add', text: 'one' }, new Date('2026-10-22T10:00:00Z')).doc;

test('nothing stored is an empty list; a saved list reads back', () => {
  const store = new TeamRulesStore(memory());
  assert.deepEqual(store.get(), { ok: true, doc: emptyTeamRules() });
  assert.equal(store.save(doc1, 0).ok, true);
  assert.deepEqual(store.get().doc.rules.map((rule) => rule.text), ['one']);
});

test('a save is accepted only on top of the version it was based on', () => {
  const store = new TeamRulesStore(memory());
  assert.equal(store.save(doc1, 0).ok, true);
  assert.deepEqual(store.save(doc1, 0), { ok: false, reason: 'stale-version' }, 'a second window with the old version cannot overwrite');
  assert.deepEqual(store.save({ ...doc1, version: 5 }, 1), { ok: false, reason: 'invalid-version' });
  assert.deepEqual(store.save({ nonsense: true }, 1), { ok: false, reason: 'invalid-team-rules' });
});

test('a damaged stored record is an error on read and is never overwritten', () => {
  const store = new TeamRulesStore(memory({ version: 'x' }));
  assert.deepEqual(store.get(), { ok: false, reason: 'invalid-team-rules-record' });
  assert.deepEqual(store.save(doc1, 0), { ok: false, reason: 'invalid-team-rules-record' });
  assert.throws(() => new TeamRulesStore(null), /private-store-required/);
  assert.equal(new TeamRulesStore({ get: () => ({ ok: false, reason: 'storage-unavailable' }), transact: () => ({}) }).get().reason, 'storage-unavailable');
});
