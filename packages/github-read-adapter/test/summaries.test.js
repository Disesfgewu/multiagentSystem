'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeChecks, mergeBranchRequirements, extractIssueReferences, createUrlBuilder } = require('../src');
const { checkRunState } = require('../src/models');
const { REPO, SHA_A } = require('./helpers/fixtures');

const run = (name, state) => ({ source: 'check_run', name, state });
const status = (name, state) => ({ source: 'status', name, state });
const report = (checkRuns = [], statuses = []) => ({ headSha: SHA_A, checkRuns, statuses });

test('check run conclusions map to passing/failing/pending', () => {
  assert.equal(checkRunState('completed', 'success'), 'passing');
  assert.equal(checkRunState('completed', 'neutral'), 'passing');
  assert.equal(checkRunState('completed', 'skipped'), 'passing');
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale', 'surprise', null]) {
    assert.equal(checkRunState('completed', conclusion), 'failing', String(conclusion));
  }
  for (const s of ['queued', 'in_progress', 'waiting', 'requested', 'pending']) assert.equal(checkRunState(s, null), 'pending');
});

test('no reported checks is "none", never "passing"', () => {
  const summary = summarizeChecks(report());
  assert.equal(summary.state, 'none');
  assert.equal(summary.requiredState, 'unknown');
});

test('failing beats pending beats passing, across check runs and statuses', () => {
  assert.equal(summarizeChecks(report([run('a', 'passing')], [status('b', 'passing')])).state, 'passing');
  assert.equal(summarizeChecks(report([run('a', 'passing'), run('b', 'pending')])).state, 'pending');
  const failing = summarizeChecks(report([run('a', 'pending')], [status('b', 'failing')]));
  assert.equal(failing.state, 'failing');
  assert.deepEqual(failing.failing, ['b']);
  assert.deepEqual(failing.pending, ['a']);
});

test('required contexts: missing means pending, failure means failing, unknown stays unknown', () => {
  const checks = report([run('build', 'passing'), run('lint', 'failing')]);
  assert.equal(summarizeChecks(checks, null).requiredState, 'unknown');
  assert.equal(summarizeChecks(checks, []).requiredState, 'not_required');
  assert.equal(summarizeChecks(checks, ['build']).requiredState, 'passing');
  assert.equal(summarizeChecks(checks, ['lint']).requiredState, 'failing');
  const missing = summarizeChecks(checks, ['build', 'deploy']);
  assert.equal(missing.requiredState, 'pending');
  assert.deepEqual(missing.missingRequired, ['deploy']);
  assert.equal(summarizeChecks(report(), ['build']).requiredState, 'pending');
});

test('a required context reported several times must pass every time', () => {
  const checks = report([run('build', 'passing'), run('build', 'failing')]);
  assert.equal(summarizeChecks(checks, ['build']).requiredState, 'failing');
});

const ok = (data) => ({ kind: data.length === 0 ? 'empty' : 'ok', data });

test('rulesets and classic protection merge into one set of requirements', () => {
  const rules = ok([
    { type: 'pull_request', parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: true, required_review_thread_resolution: true } },
    { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'build' }], strict_required_status_checks_policy: true } },
    { type: 'non_fast_forward', parameters: {} }
  ]);
  const protection = { kind: 'ok', data: { required_pull_request_reviews: { required_approving_review_count: 2, require_code_owner_reviews: true }, required_status_checks: { contexts: ['lint'], checks: [{ context: 'build' }], strict: false } } };
  const merged = mergeBranchRequirements({ rules, protection });
  assert.equal(merged.requiredApprovingReviewCount, 2);
  assert.equal(merged.dismissStaleReviewsOnPush, true);
  assert.equal(merged.requireCodeOwnerReview, true);
  assert.equal(merged.requireThreadResolution, true);
  assert.equal(merged.strictStatusChecks, true);
  assert.deepEqual(merged.requiredStatusChecks, ['build', 'lint']);
  assert.equal(merged.complete, true);
});

test('an unreadable source makes requirements a lower bound, not "none"', () => {
  const merged = mergeBranchRequirements({ rules: ok([{ type: 'pull_request', parameters: { required_approving_review_count: 1 } }]), protection: { kind: 'denied' } });
  assert.equal(merged.complete, false);
  assert.deepEqual(merged.unavailable, { protection: 'denied' });
  assert.equal(merged.requiredApprovingReviewCount, 1);
});

test('confirmed no rules and no protection is complete with nothing required', () => {
  const merged = mergeBranchRequirements({ rules: ok([]), protection: { kind: 'empty', data: null } });
  assert.equal(merged.complete, true);
  assert.equal(merged.requiredApprovingReviewCount, 0);
  assert.deepEqual(merged.ruleTypes, []);
});

test('issue references are read from PR text, same repository only', () => {
  const body = ['Refs #15', 'closes #3', 'Fixes example-org/example-repo#9', 'fixes other-org/other-repo#4', 'see #99', 'Resolves: #7'].join('\n');
  assert.deepEqual(extractIssueReferences(body, REPO), [
    { number: 3, closes: true },
    { number: 7, closes: true },
    { number: 9, closes: true },
    { number: 15, closes: false }
  ]);
});

test('references inside code, comments or HTML comments are ignored; closing wins over refs', () => {
  const body = 'Refs #1\n`closes #2`\n```\nfixes #3\n```\n<!-- fixes #4 -->\nrefs #5 and closes #5';
  assert.deepEqual(extractIssueReferences(body, REPO), [{ number: 1, closes: false }, { number: 5, closes: true }]);
  assert.deepEqual(extractIssueReferences(null, REPO), []);
  assert.deepEqual(extractIssueReferences('', REPO), []);
});

test('page URLs are built for the right repository and objects', () => {
  const urls = createUrlBuilder('https://github.com');
  assert.equal(urls.issue(REPO, 15), 'https://github.com/example-org/example-repo/issues/15');
  assert.equal(urls.pullRequest(REPO, 7), 'https://github.com/example-org/example-repo/pull/7');
  assert.equal(urls.pullRequestChecks(REPO, 7), 'https://github.com/example-org/example-repo/pull/7/checks');
  assert.equal(urls.pullRequestFiles(REPO, 7), 'https://github.com/example-org/example-repo/pull/7/files');
  assert.equal(urls.commit(REPO, SHA_A), `https://github.com/example-org/example-repo/commit/${SHA_A}`);
});

test('API-supplied links are only trusted on the expected https origin', () => {
  const urls = createUrlBuilder('https://github.com');
  const fallback = 'https://github.com/example-org/example-repo/issues/1';
  assert.equal(urls.safe('https://github.com/example-org/example-repo/issues/1#issuecomment-5', fallback), 'https://github.com/example-org/example-repo/issues/1#issuecomment-5');
  for (const bad of ['http://github.com/x', 'https://evil.example.invalid/x', 'https://github.com.evil.example.invalid/x', 'https://user:pw@github.com/x', 'javascript:alert(1)', 'not a url', undefined, null, 5]) {
    assert.equal(urls.safe(bad, fallback), fallback, String(bad));
  }
  assert.throws(() => createUrlBuilder('http://github.com'), TypeError);
});
