'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOverview } = require('../../src/overview/model');

const REPO = 'Owner/Repo';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const session = (over = {}) => ({ id: 's1', roleGroupId: 'worker', accountProfileId: 'a1', worktree: '/private/place/wt', state: 'cli-observed', observedAt: 't', ...over });
const account = (over = {}) => ({ id: 'a1', provider: 'claude', label: { value: 'Main' }, health: 'ready', verifiedIdentity: { state: 'verified' }, issues: [], ...over });
const pr = (over = {}, checks = {}) => ({
  pullRequest: { number: 7, title: 'T', state: 'open', draft: false, headRef: 'feat/x', headSha: SHA_A, headRepository: 'owner/repo', ...over },
  checks: { state: 'passing', requiredState: 'passing', headSha: SHA_A, ...checks }
});
const github = (pullRequests, kind = 'ok') => ({ kind, fetchedAt: 'now', pullRequests });
const view = (over = {}) => buildOverview({ sessions: [session()], accounts: [account()], roleGroups: { worker: 'Worker' }, branches: { s1: 'feat/x' }, repository: REPO, github: github([pr()]), ...over });
const row = (over) => view(over).rows[0];

test('joins session, role, account, branch, PR and CI; the link is built, not copied', () => {
  const v = view();
  assert.equal(v.empty, null);
  assert.equal(v.problems, 0);
  const [r] = v.rows;
  assert.deepEqual(r.role, { state: 'known', id: 'worker', name: 'Worker' });
  assert.equal(r.account.label, 'Main');
  assert.deepEqual(r.pullRequest, { state: 'open', number: 7, title: 'T', draft: false, url: 'https://github.com/Owner/Repo/pull/7' });
  assert.deepEqual(r.ci, { state: 'known', value: 'passing', required: 'passing', headSha: SHA_A });
});

test('every missing source is unknown, never filled in', () => {
  const [r] = buildOverview({ sessions: [session({ state: 'unknown' })] }).rows;
  assert.equal(r.role.state, 'unknown');
  assert.equal(r.account.reason, 'account-not-found');
  assert.equal(r.branch.state, 'unknown');
  assert.equal(r.sessionState.reason, 'not-observed');
  assert.equal(r.pullRequest.reason, 'no-branch');
  assert.equal(r.ci.state, 'unknown');
  assert.equal(JSON.stringify(r).includes('percent'), false);
});

test('only ok and empty are complete answers; partial, truncated and failures are unknown, never "none"', () => {
  for (const kind of ['partial', 'truncated']) {
    assert.equal(row({ github: github([], kind) }).pullRequest.reason, 'github-incomplete', kind);
    assert.equal(row({ github: github([pr()], kind) }).pullRequest.reason, 'github-incomplete', kind);
    assert.equal(view({ github: github([], kind) }).github.reason, 'github-incomplete');
  }
  for (const kind of ['denied', 'rate_limited', 'transient', 'offline', 'cancelled', 'invalid', 'not_found', 'weird', undefined]) {
    assert.equal(row({ github: { kind, pullRequests: [pr()] } }).pullRequest.reason, 'github-unavailable', String(kind));
  }
  assert.deepEqual(row({ github: github([], 'empty') }).pullRequest, { state: 'none' });
  assert.equal(row({ github: { kind: 'ok' } }).pullRequest.reason, 'github-unavailable');
  assert.deepEqual(view().github, { state: 'ok', fetchedAt: 'now' });
});

test('a branch with no open PR is none; two open PRs on one branch is ambiguous', () => {
  const none = row({ github: github([pr({ headRef: 'other' }), pr({ state: 'closed' })]) });
  assert.deepEqual(none.pullRequest, { state: 'none' });
  assert.equal(none.ci.reason, 'no-pull-request');
  assert.equal(row({ github: github([pr(), pr({ number: 8 })]) }).pullRequest.reason, 'ambiguous-branch');
});

test('a same-named branch from a fork, or with no repository reported, is not adopted and not "none"', () => {
  for (const headRepository of ['someone-else/r-fork', null, undefined, '', 7]) {
    const r = row({ github: github([pr({ number: 99, headRepository })]) });
    assert.equal(r.pullRequest.reason, 'pull-request-repository-unverified', String(headRepository));
    assert.equal(r.ci.state, 'unknown');
    assert.equal(JSON.stringify(r).includes('99'), false);
  }
  assert.equal(row({ github: github([pr({ headRepository: 'OWNER/REPO' })]) }).pullRequest.state, 'open');
  // our own PR plus a fork's PR on the same branch name: still cannot say which is the session's
  assert.equal(row({ github: github([pr(), pr({ number: 99, headRepository: 'x/y' })]) }).pullRequest.reason, 'pull-request-repository-unverified');
});

test('without a valid current repository nothing is adopted', () => {
  for (const repository of [undefined, null, '', 'owner', 'a/b/c', '../x', 'a/..', 'a b/c', 7]) {
    assert.equal(row({ repository }).pullRequest.reason, 'repository-unknown', String(repository));
  }
});

test('CI for another head is unknown; both SHAs must be complete and equal (case-insensitive)', () => {
  assert.equal(row({ github: github([pr({}, { headSha: SHA_B })]) }).ci.reason, 'checks-for-other-head');
  for (const headSha of [undefined, null, '', 'aaaa', SHA_A.slice(0, 7), 'g'.repeat(40)]) {
    assert.equal(row({ github: github([pr({}, { headSha })]) }).ci.reason, 'checks-for-other-head', String(headSha));
    assert.equal(row({ github: github([pr({ headSha })]) }).ci.reason, 'checks-for-other-head', String(headSha));
  }
  // equal but incomplete values are not a match either
  assert.equal(row({ github: github([pr({ headSha: 'abc1234' }, { headSha: 'abc1234' })]) }).ci.reason, 'checks-for-other-head');
  assert.equal(row({ github: github([pr({ headSha: SHA_A.toUpperCase() }, { headSha: SHA_A })]) }).ci.state, 'known');
  assert.equal(row({ github: github([pr({}, { headSha: SHA_A.toUpperCase() })]) }).ci.headSha, SHA_A);
});

test('checks that were not read are unknown', () => {
  const entry = pr();
  delete entry.checks;
  assert.equal(row({ github: github([entry]) }).ci.reason, 'checks-not-read');
});

test('the title is cleaned of control, bidirectional and separator characters and limited', () => {
  const evil = ['a', String.fromCodePoint(0x202e), 'b', String.fromCodePoint(0), 'c', String.fromCodePoint(0x1b), '[31m', String.fromCodePoint(0x2028), 'd', String.fromCodePoint(0x2029), String.fromCodePoint(0x200b), 'e'].join('');
  const clean = row({ github: github([pr({ title: evil })]) }).pullRequest.title;
  assert.equal(clean, 'a b c [31m d e');
  assert.equal(row({ github: github([pr({ title: `x${String.fromCodePoint(0x2029)}y` })]) }).pullRequest.title, 'x y');
  assert.equal(Array.from(row({ github: github([pr({ title: 'x'.repeat(5000) })]) }).pullRequest.title).length, 200);
  assert.equal(row({ github: github([pr({ title: 42 })]) }).pullRequest.title, '');
});

test('a PR number that is not a positive integer is unreadable, and no link is made', () => {
  for (const number of [0, -1, 1.5, '7', null, undefined]) {
    assert.equal(row({ github: github([pr({ number })]) }).pullRequest.reason, 'pull-request-unreadable', String(number));
  }
});

test('account data: missing health and duplicated ids are unknown, not known and not "last wins"', () => {
  assert.equal(row({ accounts: [account({ health: undefined })] }).account.reason, 'account-health-missing');
  const dup = row({ accounts: [account(), account({ label: { value: 'Other' }, health: 'attention', verifiedIdentity: { state: 'unknown' } })] });
  assert.equal(dup.account.reason, 'ambiguous-account');
  assert.equal(dup.account.state, 'unknown');
  assert.equal(row().account.verified, true);
  assert.equal(row({ accounts: [account({ label: { value: 'Verified' }, verifiedIdentity: { state: 'unknown' } })] }).account.verified, false);
});

test('a broken session or account becomes an unknown row or is counted, and does not break the overview', () => {
  const v = buildOverview({ sessions: [null, session(), 'x', { id: 7 }], accounts: [null, account(), 3], repository: REPO, branches: { s1: 'feat/x' }, github: github([pr()]) });
  assert.equal(v.rows.length, 4);
  assert.equal(v.problems, 5);
  assert.equal(v.rows[0].malformed, true);
  assert.equal(v.rows[0].pullRequest.state, 'unknown');
  assert.equal(v.rows[1].account.state, 'known');
});

test('prototype keys never read as known', () => {
  for (const key of ['constructor', '__proto__', 'toString']) {
    const r = row({ sessions: [session({ id: key, roleGroupId: key })] });
    assert.equal(r.role.state, 'unknown');
    assert.equal(r.branch.state, 'unknown');
  }
});

test('rows never carry the local worktree path', () => {
  assert.equal(JSON.stringify(view()).includes('/private/place'), false);
});

test('empty sessions give an empty state; bad input throws', () => {
  assert.equal(buildOverview({ sessions: [] }).empty, 'no-sessions');
  assert.throws(() => buildOverview({}), TypeError);
});
