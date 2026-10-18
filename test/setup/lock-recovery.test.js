'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { lockRecoveryPlan } = require('../../src/setup/lockRecovery');

test('a lock whose owner process is still running is never recoverable from the interactive command, however old it looks', () => {
  for (const stale of [true, false]) {
    const plan = lockRecoveryPlan({ detail: 'owner-alive', stale });
    assert.equal(plan.blocked, true, `stale=${stale}`);
    assert.equal(plan.force, false);
    assert.match(plan.refusal, /still running here/);
  }
});

test('a lock whose owner is provably gone needs no force; one a program cannot judge is forced only when it is old enough', () => {
  assert.deepEqual([lockRecoveryPlan({ detail: 'owner-dead', stale: false }).blocked, lockRecoveryPlan({ detail: 'owner-dead', stale: false }).force], [false, false]);
  for (const detail of ['owner-other-host', 'owner-unreadable']) {
    const old = lockRecoveryPlan({ detail, stale: true });
    assert.deepEqual([old.blocked, old.force], [false, true], detail);
    assert.match(old.ownerLine, /old enough to recover/);
    const young = lockRecoveryPlan({ detail, stale: false });
    assert.deepEqual([young.blocked, young.force], [false, false], detail);
    assert.match(young.ownerLine, /not old enough/);
  }
});

test('a missing or odd inspection is treated as an owner nobody can judge, never as alive and never as forced when young', () => {
  for (const inspected of [undefined, null, {}, { detail: 42 }, { detail: 'something-new', stale: false }]) {
    const plan = lockRecoveryPlan(inspected);
    assert.equal(plan.blocked, false);
    assert.equal(plan.force, false);
  }
});
