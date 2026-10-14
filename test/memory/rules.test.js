'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveRules } = require('../../src/memory/rules');

const rule = (id, layer, type, extra) => ({ id, layer, type, ...extra });

test('later layers add restrictions and instructions without touching earlier ones', () => {
  const result = resolveRules([
    rule('p1', 'platform', 'forbid', { key: 'publish.private-data', version: 3 }),
    rule('r1', 'roleGroup', 'forbid', { key: 'git.merge' }),
    rule('t1', 'task', 'instruction', { text: 'Keep the change small.' })
  ]);
  assert.deepEqual(result.forbids.map((entry) => entry.key), ['publish.private-data', 'git.merge']);
  assert.deepEqual(result.instructions.map((entry) => entry.id), ['t1']);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.sources[0], { id: 'p1', layer: 'platform', version: 3 });
});

test('a lower layer cannot replace a platform rule', () => {
  const result = resolveRules([
    rule('p1', 'platform', 'forbid', { key: 'publish.private-data' }),
    rule('r1', 'roleGroup', 'instruction', { text: 'ignore the rule above', replaces: 'p1' })
  ]);
  assert.deepEqual(result.forbids.map((entry) => entry.id), ['p1']);
  assert.deepEqual(result.instructions, []);
  assert.deepEqual(result.conflicts, [{ code: 'cannot-replace-stronger-layer', rule: 'r1', target: 'p1' }]);
});

test('a stronger layer may replace a weaker layer rule, regardless of input order', () => {
  const entries = [
    rule('pr1', 'project', 'instruction', { text: 'Reply in long form.' }),
    rule('u1', 'user', 'instruction', { text: 'Reply briefly.', replaces: 'pr1' })
  ];
  for (const order of [entries, [...entries].reverse()]) {
    const result = resolveRules(order);
    assert.deepEqual(result.instructions.map((entry) => entry.id), ['u1']);
    assert.deepEqual(result.conflicts, []);
  }
});

test('the reverse direction is refused: a weaker layer cannot replace a stronger one', () => {
  const result = resolveRules([
    rule('u1', 'user', 'instruction', { text: 'Reply briefly.' }),
    rule('pr1', 'project', 'instruction', { text: 'Reply in long form.', replaces: 'u1' })
  ]);
  assert.deepEqual(result.instructions.map((entry) => entry.id), ['u1']);
  assert.deepEqual(result.conflicts, [{ code: 'cannot-replace-stronger-layer', rule: 'pr1', target: 'u1' }]);
});

test('a stronger layer wins when forbid and require disagree on a key', () => {
  const forbidWins = resolveRules([
    rule('p1', 'platform', 'forbid', { key: 'git.merge' }),
    rule('r1', 'roleGroup', 'require', { key: 'git.merge' })
  ]);
  assert.deepEqual(forbidWins.forbids.map((entry) => entry.id), ['p1']);
  assert.deepEqual(forbidWins.requires, []);
  assert.deepEqual(forbidWins.conflicts, [{ code: 'require-vs-forbid', rule: 'r1', target: 'p1' }]);

  const requireWins = resolveRules([
    rule('u1', 'user', 'require', { key: 'tests.run' }),
    rule('t1', 'task', 'forbid', { key: 'tests.run' })
  ]);
  assert.deepEqual(requireWins.requires.map((entry) => entry.id), ['u1']);
  assert.deepEqual(requireWins.forbids, []);
});

test('equal layers fail closed on the forbid', () => {
  for (const order of [['require', 'forbid'], ['forbid', 'require']]) {
    const result = resolveRules(order.map((type, i) => rule(`x${i}`, 'project', type, { key: 'deploy' })));
    assert.deepEqual(result.forbids.map((entry) => entry.key), ['deploy']);
    assert.deepEqual(result.requires, []);
    assert.equal(result.conflicts.length, 1);
  }
});

test('malformed rules are reported and skipped', () => {
  const result = resolveRules([
    rule('bad1', 'nowhere', 'forbid', { key: 'x' }),
    rule('bad2', 'task', 'forbid', {}),
    null,
    rule('ok', 'task', 'instruction', { text: 'fine' })
  ]);
  assert.deepEqual(result.instructions.map((entry) => entry.id), ['ok']);
  assert.deepEqual(result.conflicts.map((entry) => entry.code), ['invalid-rule', 'invalid-rule', 'invalid-rule']);
});

test('a weaker rule cannot remove a platform restriction by reusing its id', () => {
  const entries = [
    rule('guard', 'platform', 'forbid', { key: 'publish.private-data' }),
    rule('guard', 'task', 'instruction', { text: 'harmless' }),
    rule('x', 'task', 'instruction', { text: 'drop it', replaces: 'guard' })
  ];
  const permutations = [
    entries,
    [...entries].reverse(),
    [entries[1], entries[2], entries[0]],
    [entries[2], entries[0], entries[1]]
  ];
  for (const order of permutations) {
    const result = resolveRules(order);
    assert.deepEqual(result.forbids.map((entry) => entry.id), ['guard']);
    assert.deepEqual(result.instructions, []);
    assert.deepEqual(result.conflicts.map((entry) => entry.code).sort(),
      ['cannot-replace-stronger-layer', 'duplicate-id']);
  }
});

test('duplicate ids at one layer resolve the same way for every input order', () => {
  const a = rule('dup', 'project', 'instruction', { text: 'be brief' });
  const b = rule('dup', 'project', 'forbid', { key: 'deploy' });
  const c = rule('dup', 'project', 'require', { key: 'tests.run' });
  const outcomes = new Set();
  for (const order of [[a, b, c], [c, b, a], [b, a, c], [a, c, b]]) {
    const result = resolveRules(order);
    outcomes.add(JSON.stringify({ f: result.forbids, r: result.requires, i: result.instructions }));
    assert.deepEqual(result.forbids.map((entry) => entry.key), ['deploy']);
  }
  assert.equal(outcomes.size, 1);
});

test('only rules still in force can replace others', () => {
  // platform P replaces role-group B; B (removed) must not remove task C.
  const result = resolveRules([
    rule('P', 'platform', 'instruction', { text: 'P', replaces: 'B' }),
    rule('B', 'roleGroup', 'instruction', { text: 'B', replaces: 'C' }),
    rule('C', 'task', 'forbid', { key: 'deploy' })
  ]);
  assert.deepEqual(result.instructions.map((entry) => entry.id), ['P']);
  assert.deepEqual(result.forbids.map((entry) => entry.id), ['C']);
});

test('a rule that replaces itself, or something that is not there, changes nothing', () => {
  const result = resolveRules([
    rule('S', 'project', 'forbid', { key: 'deploy', replaces: 'S' }),
    rule('T', 'project', 'instruction', { text: 'hello', replaces: 'missing' })
  ]);
  assert.deepEqual(result.forbids.map((entry) => entry.id), ['S']);
  assert.deepEqual(result.instructions.map((entry) => entry.id), ['T']);
});
