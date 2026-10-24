'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { e2eGitHubFixture, fixtureReader } = require('../../src/reports/e2eGitHub');

const FIXTURE = { repository: 'example/project', issues: [{ number: 12, state: 'open', title: 'x' }], pullRequests: [{ number: 7, state: 'open', title: 'y', snapshot: { status: 'complete' } }], comments: { 12: [{ id: 1, body: 'hi' }] } };
const fakeFs = (text) => ({ statSync: () => ({ size: text.length }), readFileSync: () => text });

test('the synthetic GitHub is read only in development mode with the end-to-end variable; never when installed (#353)', () => {
  const env = { MULTIAGENT_E2E_GITHUB: '/tmp/fixture.json' };
  const fs = fakeFs(JSON.stringify(FIXTURE));
  assert.equal(e2eGitHubFixture(2, env, fs).repository, 'example/project');
  for (const mode of [1, 3, undefined]) assert.equal(e2eGitHubFixture(mode, env, fs), null, `mode ${mode}`);
  assert.equal(e2eGitHubFixture(2, {}, fs), null);
  assert.equal(e2eGitHubFixture(2, { MULTIAGENT_E2E_GITHUB: '' }, fs), null);
  for (const bad of ['not json', JSON.stringify({ ...FIXTURE, repository: '../x' }), JSON.stringify({ repository: 'a/b' })]) assert.equal(e2eGitHubFixture(2, env, fakeFs(bad)), null, bad);
});

test('the synthetic reader has the read calls only, answering from the fixture (#353)', async () => {
  const reader = fixtureReader(FIXTURE);
  assert.deepEqual(Object.keys(reader).sort(), ['getIssue', 'getIssueComments', 'getPullRequest', 'getPullRequestFiles', 'getPullRequestSnapshot', 'getReviewComments', 'getReviews', 'listIssues', 'listPullRequests']);
  assert.deepEqual(await reader.getIssue(12), { kind: 'ok', data: FIXTURE.issues[0] });
  assert.deepEqual(await reader.getIssue(99), { kind: 'not_found' });
  assert.deepEqual(await reader.getIssueComments(12), { kind: 'ok', data: [{ id: 1, body: 'hi' }] });
  assert.deepEqual(await reader.listIssues({ state: 'closed' }), { kind: 'ok', data: [] });
  assert.deepEqual(await reader.getPullRequestSnapshot(7), { status: 'complete' });
});
