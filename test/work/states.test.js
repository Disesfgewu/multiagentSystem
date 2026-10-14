'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { STATES, TERMINAL, ROLES, EVENTS, transition, readyToMergeProblems } = require('../../src/work/states');
const { SHA } = require('./helpers');

const A = SHA('a');
const B = SHA('b');
const link = (state, extra) => ({ state, headSha: null, reviewKind: null, ...extra });
const go = (state, event, role, evidence, extra, config) => transition(link(state, extra), event, { role, evidence, config });

// Every legal move, written out by hand: (state, event) -> next state, and who may do it.
const LEGAL = [
  ['ready', 'claim', 'claimed', ['worker', 'pm']],
  ['claimed', 'start', 'in_progress', ['worker']],
  ['claimed', 'release', 'ready', ['worker', 'pm', 'human']],
  ['in_progress', 'release', 'ready', ['worker', 'pm', 'human']],
  ['claimed', 'block', 'blocked', ['worker', 'pm']],
  ['in_progress', 'block', 'blocked', ['worker', 'pm']],
  ['pr_open', 'block', 'blocked', ['worker', 'pm']],
  ['changes_requested', 'block', 'blocked', ['worker', 'pm']],
  ['worker_updates', 'block', 'blocked', ['worker', 'pm']],
  ['blocked', 'unblock', 'ready', ['pm']],
  ['in_progress', 'open_pr', 'pr_open', ['worker']],
  ['pr_open', 'request_review', 'review_pending', ['worker']],
  ['review_pending', 'request_changes', 'changes_requested', ['pm']],
  ['changes_requested', 'worker_update', 'worker_updates', ['worker']],
  ['worker_updates', 'resubmit', 'review_pending', ['worker']],
  ['review_pending', 'pm_pass', 'pm_passed', ['pm']],
  ['pm_passed', 'mark_ready_to_merge', 'ready_to_merge', ['system']],
  ['ready_to_merge', 'conditions_failed', 'pm_passed', ['system']],
  ['ready_to_merge', 'merge', 'merged', ['human', 'pm']]
];
const CLOSABLE = ['ready', 'claimed', 'in_progress', 'blocked', 'pr_open', 'review_pending', 'changes_requested', 'worker_updates', 'pm_passed', 'ready_to_merge'];
const HEAD_CHANGED_FROM = ['pr_open', 'review_pending', 'changes_requested', 'worker_updates', 'pm_passed', 'ready_to_merge'];

const legalPairs = new Set([
  ...LEGAL.map(([state, event]) => `${state}|${event}`),
  ...CLOSABLE.map((state) => `${state}|close`),
  ...HEAD_CHANGED_FROM.map((state) => `${state}|head_changed`)
]);

test('the vocabulary is exactly the states, events and roles of the plan', () => {
  assert.deepEqual([...STATES].sort(), ['blocked', 'changes_requested', 'claimed', 'closed', 'in_progress', 'merged', 'pm_passed', 'pr_open', 'ready', 'ready_to_merge', 'review_pending', 'worker_updates'].sort());
  assert.deepEqual([...TERMINAL].sort(), ['closed', 'merged']);
  assert.deepEqual([...ROLES].sort(), ['human', 'pm', 'system', 'worker']);
  assert.deepEqual([...EVENTS].sort(), ['block', 'claim', 'close', 'conditions_failed', 'head_changed', 'mark_ready_to_merge', 'merge', 'open_pr', 'pm_pass', 'release', 'request_changes', 'request_review', 'resubmit', 'start', 'unblock', 'worker_update'].sort());
  assert.equal(EVENTS.includes('createIssue') || EVENTS.includes('editIssue') || EVENTS.includes('define_requirements'), false, 'no event can define or change requirements');
});

test('every move that is not on the list of legal ones is refused, for every role', () => {
  for (const state of STATES) {
    for (const event of EVENTS) {
      if (legalPairs.has(`${state}|${event}`)) continue;
      for (const role of ROLES) {
        const result = transition(link(state), event, { role, evidence: {} });
        assert.equal(result.ok, false, `${state} + ${event} as ${role}`);
        assert.equal(result.reason, TERMINAL.includes(state) ? 'terminal-state' : 'illegal-transition', `${state} + ${event} as ${role}`);
      }
    }
  }
});

test('terminal states accept nothing at all', () => {
  for (const state of TERMINAL) for (const event of EVENTS) for (const role of ROLES) {
    assert.equal(transition(link(state), event, { role, evidence: {} }).reason, 'terminal-state');
  }
});

test('unknown states, events, roles and malformed links are refused, not guessed at', () => {
  assert.equal(transition(link('flying'), 'claim', { role: 'worker' }).reason, 'unknown-state');
  assert.equal(transition(link('ready'), 'teleport', { role: 'worker' }).reason, 'unknown-event');
  assert.equal(transition(link('ready'), 'claim', { role: 'admin' }).reason, 'unknown-role');
  assert.equal(transition(link('ready'), 'claim', {}).reason, 'unknown-role');
  for (const bad of [null, undefined, 'ready', 7, [], {}]) assert.equal(transition(bad, 'claim', { role: 'worker' }).reason, 'unknown-state');
  assert.equal(transition(link('ready'), 'claim').reason, 'unknown-role');
});

// Evidence the events that need none are given: a claim, a start, a block and so on.
const noEvidence = (event) => ['claim', 'start', 'release', 'block', 'unblock', 'request_review', 'worker_update', 'close'].includes(event);

test('who may do what: only the roles listed for a legal move are allowed, everyone else gets role-forbidden', () => {
  const evidence = {
    open_pr: { prNumber: 3, headSha: A },
    request_changes: { review: { state: 'CHANGES_REQUESTED' } },
    resubmit: { headSha: B },
    pm_pass: { headSha: A, approval: { status: 'approved', headSha: A } },
    head_changed: { headSha: B },
    mark_ready_to_merge: { headSha: A, consistent: true, approval: { status: 'approved', headSha: A }, checks: { state: 'passing', requiredState: 'passing' }, unresolvedThreads: 0, mergeable: true },
    conditions_failed: { headSha: A, consistent: true, approval: { status: 'approved', headSha: A }, checks: { state: 'failing', requiredState: 'failing' }, unresolvedThreads: 0, mergeable: true },
    merge: { mergeAuthority: 'pm' }
  };
  const base = { headSha: A, reviewKind: 'formal' };
  for (const [state, event, next, allowed] of LEGAL) {
    for (const role of ROLES) {
      const result = go(state, event, role, noEvidence(event) ? undefined : evidence[event], base);
      if (allowed.includes(role)) {
        assert.equal(result.ok, true, `${state} + ${event} as ${role}: ${JSON.stringify(result)}`);
        assert.equal(result.state, next, `${state} + ${event}`);
      } else {
        assert.deepEqual([result.ok, result.reason], [false, 'role-forbidden'], `${state} + ${event} as ${role}`);
      }
    }
  }
  // closing, and a new head, as a role each
  for (const state of CLOSABLE) {
    assert.equal(go(state, 'close', 'pm').state, 'closed');
    assert.equal(go(state, 'close', 'human').state, 'closed');
    assert.equal(go(state, 'close', 'worker').reason, 'role-forbidden');
    assert.equal(go(state, 'close', 'system').reason, 'role-forbidden');
  }
});

test('a worker can never define requirements, review, approve, merge or close', () => {
  for (const event of ['unblock', 'request_changes', 'pm_pass', 'head_changed', 'mark_ready_to_merge', 'conditions_failed', 'merge', 'close']) {
    for (const state of STATES.filter((entry) => !TERMINAL.includes(entry))) {
      const result = transition(link(state, { headSha: A, reviewKind: 'formal' }), event, { role: 'worker', evidence: { mergeAuthority: 'pm', headSha: B, review: { state: 'CHANGES_REQUESTED' } } });
      assert.equal(result.ok, false, `${state} + ${event}`);
    }
  }
});

test('merging is by a person unless the repository is set to merge by the PM, and then only with that evidence', () => {
  assert.equal(go('ready_to_merge', 'merge', 'human', { mergeAuthority: 'human' }).state, 'merged');
  assert.equal(go('ready_to_merge', 'merge', 'human', { mergeAuthority: 'pm' }).state, 'merged', 'a person may always merge');
  assert.deepEqual(go('ready_to_merge', 'merge', 'pm', { mergeAuthority: 'human' }), { ok: false, reason: 'role-forbidden', role: 'pm', event: 'merge', why: 'merge-authority-is-human' });
  assert.equal(go('ready_to_merge', 'merge', 'pm', { mergeAuthority: 'pm' }).state, 'merged');
  assert.equal(go('ready_to_merge', 'merge', 'worker', { mergeAuthority: 'pm' }).reason, 'role-forbidden');
  for (const bad of [undefined, null, {}, { mergeAuthority: 'worker' }, { mergeAuthority: 'PM' }, { mergeAuthority: true }]) {
    assert.equal(go('ready_to_merge', 'merge', 'human', bad).reason, 'evidence-missing');
  }
});

// ---- evidence ---------------------------------------------------------------

test('opening a pull request needs the pull request number and its head', () => {
  assert.deepEqual(go('in_progress', 'open_pr', 'worker', { prNumber: 12, headSha: A }), { ok: true, state: 'pr_open', prNumber: 12, headSha: A, reviewKind: null });
  for (const bad of [undefined, {}, { prNumber: 12 }, { headSha: A }, { prNumber: 0, headSha: A }, { prNumber: 1.5, headSha: A }, { prNumber: 12, headSha: 'abc' }, { prNumber: 12, headSha: 'A'.repeat(40) }]) {
    assert.equal(go('in_progress', 'open_pr', 'worker', bad).reason, 'evidence-missing', JSON.stringify(bad));
  }
});

test('changes are requested only on the evidence of a CHANGES_REQUESTED review', () => {
  assert.equal(go('review_pending', 'request_changes', 'pm', { review: { state: 'CHANGES_REQUESTED' } }).state, 'changes_requested');
  for (const bad of [undefined, {}, { review: null }, { review: { state: 'COMMENTED' } }, { review: { state: 'APPROVED' } }, { review: { state: 'changes_requested' } }]) {
    assert.equal(go('review_pending', 'request_changes', 'pm', bad).reason, 'evidence-missing', JSON.stringify(bad));
  }
});

test('a resubmission needs a commit the review has not seen', () => {
  const resubmitted = go('worker_updates', 'resubmit', 'worker', { headSha: B }, { headSha: A, reviewKind: 'formal' });
  assert.deepEqual(resubmitted, { ok: true, state: 'review_pending', headSha: B, reviewKind: null });
  assert.equal(go('worker_updates', 'resubmit', 'worker', { headSha: A }, { headSha: A }).reason, 'no-new-commit');
  assert.equal(go('worker_updates', 'resubmit', 'worker', {}, { headSha: A }).reason, 'evidence-missing');
});

test('a new head returns a passed pull request to review, and forgets the old review', () => {
  for (const state of ['pm_passed', 'ready_to_merge']) {
    const result = go(state, 'head_changed', 'system', { headSha: B }, { headSha: A, reviewKind: 'formal' });
    assert.deepEqual(result, { ok: true, state: 'review_pending', headSha: B, reviewKind: null }, state);
  }
  for (const state of ['pr_open', 'review_pending', 'changes_requested', 'worker_updates']) {
    const result = go(state, 'head_changed', 'system', { headSha: B }, { headSha: A, reviewKind: 'informal' });
    assert.deepEqual(result, { ok: true, state, headSha: B, reviewKind: null }, `${state} keeps its state and takes the new head`);
  }
  assert.equal(go('pm_passed', 'head_changed', 'system', { headSha: A }, { headSha: A }).reason, 'head-unchanged');
  assert.equal(go('pm_passed', 'head_changed', 'system', {}, { headSha: A }).reason, 'evidence-missing');
});

test('a pass needs a formal approval of the current head, and an old approval does not count', () => {
  const at = (extra) => go('review_pending', 'pm_pass', 'pm', { headSha: A, ...extra }, { headSha: A });
  assert.deepEqual(at({ approval: { status: 'approved', headSha: A } }), { ok: true, state: 'pm_passed', reviewKind: 'formal' });
  assert.equal(at({ approval: { status: 'approved', headSha: B } }).reason, 'evidence-stale');
  assert.equal(go('review_pending', 'pm_pass', 'pm', { headSha: B, approval: { status: 'approved', headSha: B } }, { headSha: A }).reason, 'evidence-stale');
  for (const status of ['not_approved', 'changes_requested', 'unknown', undefined]) {
    assert.equal(at({ approval: { status } }).reason, 'approval-not-current', String(status));
  }
  assert.equal(at({}).reason, 'evidence-missing');
  assert.equal(go('review_pending', 'pm_pass', 'pm', {}, { headSha: A }).reason, 'evidence-missing');
});

test('a technical review left as a comment counts only when the configuration allows it, and is remembered as informal', () => {
  const informal = { headSha: A, informalReview: { commitId: A } };
  assert.equal(go('review_pending', 'pm_pass', 'pm', informal, { headSha: A }).reason, 'evidence-missing', 'not by default');
  const allowed = go('review_pending', 'pm_pass', 'pm', informal, { headSha: A }, { allowInformalPass: true });
  assert.deepEqual(allowed, { ok: true, state: 'pm_passed', reviewKind: 'informal' });
  const stale = go('review_pending', 'pm_pass', 'pm', { headSha: A, informalReview: { commitId: B } }, { headSha: A }, { allowInformalPass: true });
  assert.equal(stale.reason, 'evidence-stale', 'a comment on an older commit is not a review of this one');
  assert.equal(go('review_pending', 'pm_pass', 'pm', informal, { headSha: A }, { allowInformalPass: 'yes' }).ok, false, 'only the value true allows it');
});

// ---- ready to merge ----------------------------------------------------------

const GOOD = {
  headSha: A, consistent: true, approval: { status: 'approved', headSha: A },
  checks: { state: 'passing', requiredState: 'passing' }, unresolvedThreads: 0, mergeable: true
};
const formal = link('pm_passed', { headSha: A, reviewKind: 'formal' });

test('ready to merge needs every condition shown to hold; each one missing or unknown stops it, with its own reason', () => {
  assert.equal(transition(formal, 'mark_ready_to_merge', { role: 'system', evidence: GOOD }).state, 'ready_to_merge');
  const cases = [
    ['head moved', { headSha: B }, 'head-changed'],
    ['head unknown', { headSha: 'abc' }, 'head-unknown'],
    ['snapshot not consistent', { consistent: false }, 'snapshot-inconsistent'],
    ['snapshot consistency missing', { consistent: undefined }, 'snapshot-inconsistent'],
    ['approval missing', { approval: undefined }, 'approval-not-current'],
    ['approval not approved', { approval: { status: 'not_approved', headSha: A } }, 'approval-not-current'],
    ['approval unknown', { approval: { status: 'unknown' } }, 'approval-not-current'],
    ['approval of an older head', { approval: { status: 'approved', headSha: B } }, 'approval-for-older-head'],
    ['checks failing', { checks: { state: 'failing', requiredState: 'passing' } }, 'checks-failing'],
    ['required checks failing', { checks: { state: 'passing', requiredState: 'failing' } }, 'checks-failing'],
    ['checks pending', { checks: { state: 'pending', requiredState: 'passing' } }, 'checks-pending'],
    ['required checks pending', { checks: { state: 'passing', requiredState: 'pending' } }, 'checks-pending'],
    ['checks unknown', { checks: { state: 'unknown', requiredState: 'unknown' } }, 'checks-unknown'],
    ['required checks unknown', { checks: { state: 'passing', requiredState: 'unknown' } }, 'checks-unknown'],
    ['checks missing', { checks: undefined }, 'checks-unknown'],
    ['an unrecognised check state', { checks: { state: 'weird', requiredState: 'passing' } }, 'checks-not-passing'],
    ['an unrecognised required state', { checks: { state: 'passing', requiredState: 'weird' } }, 'checks-not-passing'],
    ['unresolved conversations', { unresolvedThreads: 2 }, 'threads-unresolved'],
    ['conversations unknown', { unresolvedThreads: null }, 'threads-unknown'],
    ['conversations missing', { unresolvedThreads: undefined }, 'threads-unknown'],
    ['merge conflict', { mergeable: false }, 'merge-conflict'],
    ['mergeability unknown', { mergeable: null }, 'mergeability-unknown'],
    ['mergeability missing', { mergeable: undefined }, 'mergeability-unknown']
  ];
  for (const [name, change, problem] of cases) {
    const result = transition(formal, 'mark_ready_to_merge', { role: 'system', evidence: { ...GOOD, ...change } });
    assert.equal(result.ok, false, name);
    assert.equal(result.reason, 'not-ready-to-merge', name);
    assert.ok(result.problems.includes(problem), `${name}: ${JSON.stringify(result.problems)}`);
  }
  assert.equal(transition(formal, 'mark_ready_to_merge', { role: 'system', evidence: undefined }).reason, 'not-ready-to-merge');
  // "not required" and "no checks" are different from "unknown", and are fine.
  const none = { ...GOOD, checks: { state: 'none', requiredState: 'not_required' } };
  assert.equal(transition(formal, 'mark_ready_to_merge', { role: 'system', evidence: none }).state, 'ready_to_merge');
});

test('what kind of review the pull request passed on decides what is needed to merge', () => {
  const evidence = { ...GOOD, approval: undefined };
  const informal = link('pm_passed', { headSha: A, reviewKind: 'informal' });
  assert.ok(readyToMergeProblems(evidence, informal, {}).includes('formal-review-required'), 'an informal review is not enough by default');
  assert.deepEqual(readyToMergeProblems(evidence, informal, { allowInformalPass: true }), [], 'and is enough only when allowed');
  assert.ok(readyToMergeProblems(GOOD, link('pm_passed', { headSha: A, reviewKind: null }), { allowInformalPass: true }).includes('review-kind-unknown'));
  assert.ok(readyToMergeProblems(GOOD, link('pm_passed', { headSha: A, reviewKind: 'something' }), {}).includes('review-kind-unknown'));
  assert.deepEqual(readyToMergeProblems(GOOD, formal, {}), []);
  assert.ok(readyToMergeProblems(evidence, formal, { allowInformalPass: true }).includes('approval-not-current'), 'a formal review is re-checked even when informal ones are allowed');
});

test('a pull request leaves ready to merge when its conditions stop holding, and not before', () => {
  const ready = link('ready_to_merge', { headSha: A, reviewKind: 'formal' });
  assert.equal(transition(ready, 'conditions_failed', { role: 'system', evidence: GOOD }).reason, 'conditions-still-hold');
  const failing = transition(ready, 'conditions_failed', { role: 'system', evidence: { ...GOOD, checks: { state: 'failing', requiredState: 'failing' } } });
  assert.deepEqual([failing.ok, failing.state], [true, 'pm_passed']);
  assert.equal(transition(ready, 'conditions_failed', { role: 'system', evidence: { ...GOOD, unresolvedThreads: 1 } }).state, 'pm_passed');
  assert.equal(transition(ready, 'conditions_failed', { role: 'worker', evidence: { ...GOOD, unresolvedThreads: 1 } }).reason, 'role-forbidden');
});

test('the happy path, start to finish, as the plan describes it', () => {
  let current = link('ready');
  const step = (event, role, evidence, config) => {
    const result = transition(current, event, { role, evidence, config });
    assert.equal(result.ok, true, `${event}: ${JSON.stringify(result)}`);
    current = { ...current, state: result.state, ...(result.headSha !== undefined ? { headSha: result.headSha } : {}), ...(result.reviewKind !== undefined ? { reviewKind: result.reviewKind } : {}) };
  };
  step('claim', 'worker');
  step('start', 'worker');
  step('open_pr', 'worker', { prNumber: 9, headSha: A });
  step('request_review', 'worker');
  step('request_changes', 'pm', { review: { state: 'CHANGES_REQUESTED' } });
  step('worker_update', 'worker');
  step('resubmit', 'worker', { headSha: B });
  step('pm_pass', 'pm', { headSha: B, approval: { status: 'approved', headSha: B } });
  assert.equal(current.reviewKind, 'formal');
  step('mark_ready_to_merge', 'system', { ...GOOD, headSha: B, approval: { status: 'approved', headSha: B } });
  step('merge', 'human', { mergeAuthority: 'human' });
  assert.equal(current.state, 'merged');
});

test('a push after the pass sends the pull request back to review, and the old pass no longer helps', () => {
  let current = link('pm_passed', { headSha: A, reviewKind: 'formal' });
  const moved = transition(current, 'head_changed', { role: 'system', evidence: { headSha: B } });
  current = { ...current, state: moved.state, headSha: moved.headSha, reviewKind: moved.reviewKind };
  assert.deepEqual([current.state, current.reviewKind], ['review_pending', null]);
  // The old approval, for the old head, cannot pass the new one.
  assert.equal(transition(current, 'pm_pass', { role: 'pm', evidence: { headSha: B, approval: { status: 'approved', headSha: A } } }).reason, 'evidence-stale');
  assert.equal(transition({ ...current, state: 'pm_passed' }, 'mark_ready_to_merge', { role: 'system', evidence: { ...GOOD, headSha: B } }).problems.includes('review-kind-unknown'), true);
});

test('blocked is entered from work under way and left only by the PM, back to ready', () => {
  for (const state of ['claimed', 'in_progress', 'pr_open', 'changes_requested', 'worker_updates']) assert.equal(go(state, 'block', 'worker').state, 'blocked');
  for (const state of ['ready', 'review_pending', 'pm_passed', 'ready_to_merge', 'blocked']) assert.equal(go(state, 'block', 'worker').reason, 'illegal-transition', state);
  assert.equal(go('blocked', 'unblock', 'pm').state, 'ready');
  for (const role of ['worker', 'human', 'system']) assert.equal(go('blocked', 'unblock', role).reason, 'role-forbidden');
  for (const event of ['claim', 'start', 'release', 'open_pr', 'request_review', 'resubmit']) {
    assert.equal(go('blocked', event, 'worker', { prNumber: 1, headSha: A }).reason, 'illegal-transition', `blocked + ${event}`);
  }
});
