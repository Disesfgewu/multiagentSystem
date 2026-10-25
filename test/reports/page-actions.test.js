'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ACTIONS, WORDS, abilitiesFor, reasonText } = require('../../src/reports/page-actions');

const clear = { review: 'clear', merge: 'clear', branch: 'clear', close: 'clear' };
const prFacts = (extra = {}) => ({ publisher: 'configured', pending: clear, state: 'open', authority: 'pm', review: { ok: true }, merge: { ok: true }, ...extra });
const pr = (facts, extra = {}) => abilitiesFor({ kind: 'pullRequest', writer: true, trusted: true, version: true, facts, ...extra });
const issue = (facts, extra = {}) => abilitiesFor({ kind: 'issue', writer: true, trusted: true, version: true, facts, ...extra });
const codes = (abilities) => Object.fromEntries(Object.entries(abilities).map(([name, value]) => [name, value.ok ? 'on' : value.code]));

test('a pull request page offers Approve, Request changes, Merge and Delete branch; an Issue page the two ways to close (#383)', () => {
  assert.deepEqual(Object.keys(pr(prFacts())), ['approve', 'requestChanges', 'merge', 'deleteBranch']);
  assert.deepEqual(Object.keys(issue({ publisher: 'configured', pending: clear, state: 'open' })), ['closeCompleted', 'closeNotPlanned']);
  assert.deepEqual(ACTIONS.pullRequest, ['approve', 'requestChanges', 'merge', 'deleteBranch']);
});

test('an open pull request that every check allows: review and merge are on; Delete branch waits for the merge (#383)', () => {
  assert.deepEqual(codes(pr(prFacts())), { approve: 'on', requestChanges: 'on', merge: 'on', deleteBranch: 'pr-not-merged' });
  assert.deepEqual(codes(pr(prFacts({ state: 'merged' }))), { approve: 'pr-not-open', requestChanges: 'pr-not-open', merge: 'pr-not-open', deleteBranch: 'on' });
  assert.deepEqual(codes(pr(prFacts({ state: 'closed' }))), { approve: 'pr-not-open', requestChanges: 'pr-not-open', merge: 'pr-not-open', deleteBranch: 'pr-not-merged' });
});

test('the window, the trust and the publisher come first, and turn everything off with their own reason (#383)', () => {
  for (const [input, code] of [[{ writer: false }, 'no-writer'], [{ trusted: false }, 'untrusted'], [{ version: false }, 'version-unknown']]) {
    assert.deepEqual(new Set(Object.values(codes(pr(prFacts(), input)))), new Set([code]), JSON.stringify(input));
  }
  assert.deepEqual(new Set(Object.values(codes(pr(prFacts({ publisher: 'none' }))))), new Set(['publisher-not-configured']));
  assert.deepEqual(new Set(Object.values(codes(pr(prFacts({ publisher: 'unreadable' }))))), new Set(['unknown']));
  assert.match(pr(prFacts(), { trusted: false }).merge.reason, /Trust this workspace/);
});

test('merge follows the merge authority and then the merge assessment, word for word (#383)', () => {
  assert.equal(pr(prFacts({ authority: 'human' })).merge.code, 'human-merge-required');
  assert.match(pr(prFacts({ authority: 'human' })).merge.reason, /Human only/);
  assert.equal(pr(prFacts({ authority: 'unreadable' })).merge.code, 'unknown');
  for (const reason of ['ci-failing', 'ci-pending', 'threads-unresolved', 'branch-rules-unsupported', 'current-pm-approval-required', 'merge-conflict']) {
    const merge = pr(prFacts({ merge: { ok: false, reason } })).merge;
    assert.equal(merge.code, reason);
    assert.equal(merge.reason, WORDS[reason]);
    assert.equal(pr(prFacts({ merge: { ok: false, reason } })).approve.ok, true, 'a merge that waits does not stop a review');
  }
  assert.equal(pr(prFacts({ merge: null })).merge.code, 'unknown');
  assert.equal(pr(prFacts({ merge: 'yes' })).merge.code, 'unknown', 'anything but a check result is unknown');
  assert.equal(pr(prFacts({ merge: { ok: 'yes' } })).merge.code, 'unknown', 'a result whose "ok" is not true or false is unknown');
  assert.equal(pr(prFacts({ review: { ok: 1 } })).approve.code, 'unknown');
});

test('a review follows the publication policy; a check that could not be made is unknown (#383)', () => {
  assert.deepEqual(codes(pr(prFacts({ review: { ok: false, reason: 'self-review-forbidden' } }))).approve, 'self-review-forbidden');
  assert.equal(pr(prFacts({ review: { ok: false, reason: 'github-sign-in-required' } })).requestChanges.code, 'github-sign-in-required');
  assert.equal(pr(prFacts({ review: null })).approve.code, 'unknown');
  assert.equal(pr(prFacts({ state: 'draft' })).approve.ok, true, 'a draft can be reviewed');
  assert.equal(pr(prFacts({ state: 'strange' })).approve.code, 'unknown');
});

test('an earlier attempt with an unknown outcome stops only its own action; an unreadable record stops it as unknown (#383)', () => {
  assert.deepEqual(codes(pr(prFacts({ pending: { ...clear, merge: 'unknown' } }))), { approve: 'on', requestChanges: 'on', merge: 'outcome-unknown', deleteBranch: 'pr-not-merged' });
  assert.deepEqual(codes(pr(prFacts({ pending: { ...clear, review: 'unreadable' } }))).approve, 'unknown');
  assert.equal(pr(prFacts({ pending: { ...clear, branch: 'unknown' }, state: 'merged' })).deleteBranch.code, 'outcome-unknown');
  assert.equal(pr(prFacts({ pending: {} })).approve.code, 'unknown');
});

test('an Issue can be closed only while it is open; no facts at all is unknown (#383)', () => {
  const facts = { publisher: 'configured', pending: clear, state: 'open' };
  assert.deepEqual(codes(issue(facts)), { closeCompleted: 'on', closeNotPlanned: 'on' });
  assert.deepEqual(codes(issue({ ...facts, state: 'closed' })), { closeCompleted: 'issue-not-open', closeNotPlanned: 'issue-not-open' });
  assert.deepEqual(codes(issue({ ...facts, pending: { ...clear, close: 'unknown' } })), { closeCompleted: 'outcome-unknown', closeNotPlanned: 'outcome-unknown' });
  assert.deepEqual(codes(issue(null)), { closeCompleted: 'unknown', closeNotPlanned: 'unknown' });
  assert.deepEqual(codes(abilitiesFor(undefined)), { approve: 'no-writer', requestChanges: 'no-writer', merge: 'no-writer', deleteBranch: 'no-writer' });
});

test('a reason code without words is shown as itself only when it looks like a code (#383)', () => {
  assert.equal(reasonText('ci-failing'), 'Checks failed on this head.');
  assert.equal(reasonText('some-new-code'), 'Not available (some-new-code).');
  assert.equal(reasonText('<b>x</b>'), 'Not available (unknown).');
  assert.equal(reasonText(undefined), 'Not available (unknown).');
  for (const text of Object.values(WORDS)) assert.ok(text.length > 0 && text.length < 200 && !/[<>]/.test(text), text);
});
