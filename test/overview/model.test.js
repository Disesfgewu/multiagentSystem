'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOverview } = require('../../src/overview/model');

const session = (over = {}) => ({ id: 's1', roleGroupId: 'worker', accountProfileId: 'a1', worktree: '/private/place/wt', state: 'cli-observed', observedAt: 't', ...over });
const account = { id: 'a1', provider: 'claude', label: { value: 'Main' }, health: 'ready', verifiedIdentity: { state: 'verified' }, issues: [] };
const pr = (over = {}) => ({ pullRequest: { number: 7, title: 'T', state: 'open', draft: false, headRef: 'feat/x', htmlUrl: 'https://github.com/o/r/pull/7', ...over }, checks: { state: 'passing', requiredState: 'passing', headSha: 'a'.repeat(40) } });
const github = (pullRequests) => ({ state: 'ok', fetchedAt: 'now', pullRequests });

test('joins session, role, account, branch, PR and CI', () => {
  const { rows, empty } = buildOverview({ sessions: [session()], accounts: [account], roleGroups: { worker: 'Worker' }, branches: { s1: 'feat/x' }, github: github([pr()]) });
  assert.equal(empty, null);
  assert.deepEqual(rows[0].role, { state: 'known', id: 'worker', name: 'Worker' });
  assert.equal(rows[0].account.label, 'Main');
  assert.equal(rows[0].pullRequest.number, 7);
  assert.deepEqual(rows[0].ci, { state: 'known', value: 'passing', required: 'passing', headSha: 'a'.repeat(40) });
});

test('every missing source is unknown, never filled in', () => {
  const { rows } = buildOverview({ sessions: [session({ state: 'unknown' })] });
  const [row] = rows;
  assert.equal(row.role.state, 'unknown');
  assert.equal(row.account.reason, 'account-not-found');
  assert.equal(row.branch.state, 'unknown');
  assert.equal(row.sessionState.reason, 'not-observed');
  assert.equal(row.pullRequest.reason, 'no-branch');
  assert.equal(row.ci.state, 'unknown');
  assert.equal(JSON.stringify(rows).includes('percent'), false);
});

test('GitHub unavailable makes PR and CI unknown rather than none', () => {
  const view = buildOverview({ sessions: [session()], branches: { s1: 'feat/x' }, github: { state: 'unavailable' } });
  assert.equal(view.rows[0].pullRequest.reason, 'github-unavailable');
  assert.equal(view.github.state, 'unknown');
});

test('a branch with no open PR is none; two open PRs on one branch is ambiguous', () => {
  const none = buildOverview({ sessions: [session()], branches: { s1: 'feat/x' }, github: github([pr({ headRef: 'other' }), pr({ state: 'closed' })]) });
  assert.deepEqual(none.rows[0].pullRequest, { state: 'none' });
  assert.equal(none.rows[0].ci.reason, 'no-pull-request');
  const two = buildOverview({ sessions: [session()], branches: { s1: 'feat/x' }, github: github([pr(), pr({ number: 8 })]) });
  assert.equal(two.rows[0].pullRequest.reason, 'ambiguous-branch');
});

test('checks that were not read are unknown; a non-GitHub link is dropped', () => {
  const entry = pr({ htmlUrl: 'https://evil.test/x' });
  delete entry.checks;
  const { rows } = buildOverview({ sessions: [session()], branches: { s1: 'feat/x' }, github: github([entry]) });
  assert.equal(rows[0].ci.reason, 'checks-not-read');
  assert.equal(rows[0].pullRequest.url, null);
});

test('rows never carry the local worktree path', () => {
  const view = buildOverview({ sessions: [session()], accounts: [account] });
  assert.equal(JSON.stringify(view).includes('/private/place'), false);
});

test('empty sessions give an empty state; bad input throws', () => {
  assert.equal(buildOverview({ sessions: [] }).empty, 'no-sessions');
  assert.throws(() => buildOverview({}), TypeError);
});

test('an unavailable GitHub result is not trusted even if it carries pull requests', () => {
  const view = buildOverview({ sessions: [session()], branches: { s1: 'feat/x' }, github: { state: 'unavailable', pullRequests: [pr()] } });
  assert.equal(view.rows[0].pullRequest.reason, 'github-unavailable');
});
