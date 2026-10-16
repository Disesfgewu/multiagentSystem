'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildIssueReport, buildPullRequestReport, parseConclusion, neighbour, render, line, WHAT_IS_NOT_VERIFIED } = require('../../src/reports/report');

const cp = (...codes) => String.fromCodePoint(...codes);
const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const ok = (data) => ({ kind: 'ok', data });
const issue = (over = {}) => ({ number: 12, title: 'Build the report view', state: 'open', author: 'pm-user', labels: ['mvp', 'ready'], assignees: [], body: 'The user must read a report without a number.', updatedAt: '2026-10-16T00:00:00Z', ...over });
const pr = (over = {}) => ({ number: 7, title: 'Add reports', state: 'open', draft: false, merged: false, author: 'worker', headSha: HEAD, headRef: 'feat/x', headRepository: 'o/r', baseRef: 'main', body: 'Refs #12\n\n**使用者可操作結果：** x', referencedIssues: [{ number: 12 }], updatedAt: 'now', ...over });
const snapshot = (over = {}) => ({ status: 'complete', consistent: true, headSha: HEAD, approval: { status: 'not_approved', reason: 'no_approval' }, checksSummary: { state: 'passing', requiredState: 'passing', headSha: HEAD, failing: [] }, unresolvedThreads: 0, ...over });
const comment = (body, over = {}) => ({ author: 'pm-user', createdAt: '2026-10-16T01:00:00Z', body, ...over });
const prReport = (over = {}) => render(buildPullRequestReport({ repository: 'o/r', pullRequest: pr(), snapshot: snapshot(), reviews: ok([]), comments: ok([]), filesHeadVerified: true, ...over }));
const issueReport = (over = {}) => render(buildIssueReport({ repository: 'o/r', issue: issue(), comments: ok([]), pullRequests: ok([pr()]), ...over }));

test('an issue report shows the requirement, labels, related pull requests, discussion, and what is not verified', () => {
  const text = issueReport({ comments: ok([comment('Scope is the read-only part.')]) });
  for (const part of ['Issue #12: Build the report view', 'Repository: o/r · State: open', 'Labels: mvp, ready', 'Assigned to: (nobody)', 'REQUIREMENT AND SCOPE', 'The user must read a report without a number.', 'RELATED PULL REQUESTS', '- #7 Add reports (open, branch feat/x)', 'DISCUSSION AND PM COMMENTS', 'Scope is the read-only part.', 'DECISIONS', 'A private note can be saved locally', 'NOT VERIFIED']) assert.ok(text.includes(part), part);
  assert.match(text, /PM REPORT\nPending: no structured PM report/);
  for (const item of WHAT_IS_NOT_VERIFIED) assert.ok(text.includes(item));
});

test('an issue with no related pull request says so; an unread list is unknown, never "none"', () => {
  assert.match(issueReport({ pullRequests: ok([pr({ referencedIssues: [{ number: 99 }] })]) }), /No open pull request refers to this Issue\./);
  assert.match(issueReport({ pullRequests: ok([]) }), /No open pull request refers to this Issue\./);
  assert.match(issueReport({ pullRequests: { kind: 'empty' } }), /No open pull request refers to this Issue\./);
  for (const kind of ['partial', 'truncated', 'denied', 'offline', 'rate_limited', 'invalid']) {
    const text = issueReport({ pullRequests: { kind, data: [pr()] } });
    assert.match(text, new RegExp(`Pull request list: unknown \\(${kind}\\)`), kind);
    assert.equal(text.includes('No open pull request refers'), false, kind);
    assert.equal(text.includes('- #7'), false, `${kind}: an incomplete list is not used`);
  }
  assert.match(issueReport({ pullRequests: undefined }), /Pull request list: unknown \(not read\)/);
});

test('comments that could not be read are unknown, empty ones say no comments', () => {
  assert.match(issueReport({ comments: ok([]) }), /No comments\./);
  assert.match(issueReport({ comments: { kind: 'empty' } }), /No comments\./);
  assert.match(prReport({ comments: { kind: 'empty' } }), /No comments\./);
  assert.match(prReport({ comments: { kind: 'ok' } }), /Comments: unknown \(ok\)/);
  assert.match(prReport({ reviews: { kind: 'ok' } }), /Reviews: unknown \(ok\)/);
  assert.match(issueReport({ comments: { kind: 'partial', data: [comment('x')] } }), /Comments: unknown \(partial\)/);
  assert.match(issueReport({ comments: undefined }), /Comments: unknown \(not read\)/);
});

test('a pull request report ties review and CI to the latest head', () => {
  const text = prReport();
  for (const part of ['Pull request #7: Add reports', 'Source: this repository branch', 'Head repository: o/r · Branch: feat/x → main', `Latest head: ${HEAD}`, 'Refers to: Issue #12', 'WHAT THIS CHANGES', 'REVIEW AND CI (for the latest head)', 'Formal approval on the latest head: not_approved (no_approval)', 'CI for this head: passing (required: passing)', 'Unresolved review threads: 0', 'No formal reviews.', 'No comments.', 'It cannot approve, request changes or merge']) assert.ok(text.includes(part), part);
});

test('a complete empty reviews result keeps the rest of the pull request readable', () => {
  const text = prReport({ reviews: { kind: 'empty' }, comments: { kind: 'empty' }, files: { kind: 'empty' } });
  assert.match(text, /WHAT THIS CHANGES[\s\S]*Refs #12/);
  assert.match(text, /No changed files were reported\./);
  assert.match(text, /No formal reviews\./);
  assert.match(text, /No comments\./);
  assert.match(text, /CI for this head: passing/);
});

test('fork source and plain diff are shown only when the exact head is verified; failures stay unknown', () => {
  const files = ok([{ filename: 'src/x.ts', status: 'modified', additions: 1, deletions: 1, patch: `@@ -1 +1 @@\n-old\n+new${cp(0x202e)}${cp(0)}` }]);
  const fork = prReport({ pullRequest: pr({ headRepository: 'outside/fork', author: 'outside-worker', headRef: 'feat/x' }), files });
  assert.match(fork, /Source: fork \/ external contributor/);
  assert.match(fork, /Head repository: outside\/fork · Branch: feat\/x/);
  assert.match(fork, /src\/x\.ts[\s\S]*\+new/);
  assert.equal(fork.includes(cp(0x202e)), false);
  assert.match(prReport({ pullRequest: pr({ headRepository: null }), files }), /Source: unknown/);
  assert.match(prReport({ files: { kind: 'truncated', data: files.data } }), /Changed files: unknown \(truncated\)/);
  assert.equal(prReport({ files: { kind: 'truncated', data: files.data } }).includes('+new'), false);
  for (const stale of [snapshot({ consistent: false }), snapshot({ headSha: OLD })]) {
    const text = prReport({ snapshot: stale, files });
    assert.match(text, /Diff for this head: unknown/);
    assert.equal(text.includes('+new'), false);
  }
  const moved = prReport({ files, filesHeadVerified: false });
  assert.match(moved, /Diff for this head: unknown/);
  assert.equal(moved.includes('+new'), false);
});

test('CI that belongs to another head, or could not be read, is unknown', () => {
  assert.match(prReport({ snapshot: snapshot({ checksSummary: { state: 'passing', requiredState: 'passing', headSha: OLD } }) }), /CI for this head: unknown/);
  assert.match(prReport({ snapshot: snapshot({ checksSummary: undefined }) }), /CI for this head: unknown/);
  assert.match(prReport({ snapshot: snapshot({ checksSummary: { state: 'passing', requiredState: 'passing', headSha: HEAD.toUpperCase() } }) }), /CI for this head: passing/);
  for (const status of ['partial', 'unavailable', 'cancelled']) {
    const text = prReport({ snapshot: { status, checksSummary: { state: 'passing', headSha: HEAD } } });
    assert.match(text, new RegExp(`Review and CI: unknown \\(${status}\\)`), status);
    assert.equal(text.includes('CI for this head: passing'), false, status);
  }
  assert.match(prReport({ snapshot: undefined }), /Review and CI: unknown \(not read\)/);
  assert.match(prReport({ snapshot: snapshot({ unresolvedThreads: null }) }), /Unresolved review threads: unknown/);
  assert.match(prReport({ snapshot: snapshot({ checksSummary: { state: 'failing', requiredState: 'failing', headSha: HEAD, failing: ['unit tests', 'host smoke'] } }) }), /CI for this head: failing[\s\S]*Failing: unit tests, host smoke/);
});

test('a review verdict in a comment says which head it covers', () => {
  const comments = ok([
    comment('結論：Pass｜head `aaaaaaaaaaaa`｜CI 全綠'),
    comment('結論：Needs changes｜head `bbbbbbbbbbbb`'),
    comment('Pass, no head here'),
    comment('just a remark, no verdict')
  ]);
  const text = prReport({ comments });
  assert.match(text, /verdict "Pass" applies to the current head/);
  assert.match(text, /verdict "Needs changes" was written for an OLDER head: it does not cover the current one/);
  assert.match(text, /verdict "Pass" does not say which head it covers/);
  assert.equal((text.match(/verdict "/g) ?? []).length, 3, 'a remark with no verdict is not given one');
});

test('parseConclusion reads the verdict and head, and never invents either', () => {
  assert.deepEqual(parseConclusion('結論：Pass｜head `91ff89d`', '91ff89d90b'), { verdict: 'Pass', head: '91ff89d', applies: 'current-head' });
  assert.deepEqual(parseConclusion('Needs changes | head 1234567', 'abcdef0'), { verdict: 'Needs changes', head: '1234567', applies: 'older-head' });
  assert.equal(parseConclusion('結論：Pass', HEAD).applies, 'head-not-stated');
  assert.equal(parseConclusion('結論：Pass｜head `91ff89d`', '').applies, 'head-not-stated');
  assert.equal(parseConclusion('結論：Pass｜head `91ff89d`', null).applies, 'head-not-stated');
  for (const body of ['no verdict here', '', undefined, null, 5, {}]) assert.equal(parseConclusion(body, HEAD), null);
  assert.equal(parseConclusion(`${'x'.repeat(700)} Pass`, HEAD), null, 'a verdict far into the text is not read');
  assert.equal(parseConclusion('Passing the buck', HEAD), null, 'only the word Pass counts');
});

test('formal reviews are listed with the head they were on', () => {
  const reviews = ok([{ reviewer: 'pm-user', state: 'COMMENTED', commitId: HEAD, body: 'looks fine' }, { reviewer: 'other', state: 'APPROVED', commitId: OLD, body: '' }, { reviewer: 'third', state: 'APPROVED', commitId: undefined }]);
  const text = prReport({ reviews });
  assert.match(text, /- pm-user · COMMENTED · on the latest head\n {2}looks fine/);
  assert.match(text, /- other · APPROVED · on an OLDER head/);
  assert.match(text, /- third · APPROVED · head unknown/);
  assert.match(prReport({ reviews: { kind: 'denied' } }), /Reviews: unknown \(denied\)/);
});

test('text from GitHub is shown as plain text: control and bidirectional characters removed, long fields cut', () => {
  const evil = `${cp(0x202e)}evil${cp(0)}${cp(0x1b)}[31m${cp(0x200b)}title`;
  const text = prReport({ pullRequest: pr({ title: evil, author: evil, headRef: evil, body: `line one\r\nline two${cp(0x202e)}${cp(0x2028)}line three${cp(0)}` }), comments: ok([comment(`${cp(0x202e)}bad${cp(0)}`, { author: evil })]) });
  assert.equal(new RegExp(`[${cp(0)}${cp(0x1b)}${cp(0x202e)}${cp(0x200b)}${cp(0x2028)}]`).test(text), false);
  assert.match(text, /line one\nline two +line three/);
  const long = prReport({ pullRequest: pr({ title: 'x'.repeat(5000), body: 'y'.repeat(50000) }), comments: ok([comment('z'.repeat(9000))]) });
  assert.match(long, /… \(30000 more characters not shown\)/);
  assert.ok(Math.max(...long.split('\n').map((l) => l.length)) <= 20100);
  assert.match(long, /… \(\d+ more characters not shown\)/);
  assert.equal(line(undefined), '');
  assert.equal(line(5), '');
});

test('only the latest comments are shown and the count of the earlier ones is stated', () => {
  const many = ok(Array.from({ length: 20 }, (_, i) => comment(`comment number ${i}`)));
  const text = prReport({ comments: many });
  assert.match(text, /\(12 earlier comments are not shown\)/);
  assert.equal(text.includes('comment number 11'), false);
  assert.ok(text.includes('comment number 19'));
});

test('a draft or merged pull request says so; missing fields are unknown, not blank', () => {
  assert.match(prReport({ pullRequest: pr({ draft: true }) }), /State: open \(draft\)/);
  assert.match(prReport({ pullRequest: pr({ state: 'closed', merged: true }) }), /State: closed \(merged\)/);
  const sparse = prReport({ pullRequest: { number: 3 }, snapshot: undefined, reviews: undefined, comments: undefined });
  assert.match(sparse, /Latest head: unknown/);
  assert.match(sparse, /Refers to: \(no Issue reference found\)/);
  assert.match(sparse, /Author: unknown/);
  assert.equal(/undefined|null|\[object|NaN/.test(sparse), false);
  const sparseIssue = render(buildIssueReport({ repository: 'o/r', issue: { number: 4 } }));
  assert.equal(/undefined|null|\[object|NaN/.test(sparseIssue), false);
  assert.match(sparseIssue, /\(none\)/);
});

test('a report is about one item: nothing from another item appears', () => {
  const text = prReport({ pullRequest: pr({ number: 7, referencedIssues: [{ number: 12 }, { number: 'x' }, null] }) });
  assert.match(text, /Refers to: Issue #12\n/);
  const second = prReport({ pullRequest: pr({ number: 8, title: 'Another', referencedIssues: [] }) });
  assert.equal(second.includes('Add reports'), false);
  assert.equal(second.includes('Issue #12'), false);
});

test('neighbour moves through the list in order and wraps around', () => {
  assert.equal(neighbour([3, 5, 9], 5, 1), 9);
  assert.equal(neighbour([3, 5, 9], 9, 1), 3);
  assert.equal(neighbour([3, 5, 9], 3, -1), 9);
  assert.equal(neighbour([3, 5, 9], 5, -1), 3);
  assert.equal(neighbour([3, 5, 9], 99, 1), 3, 'an item that is not in the list starts from the first');
  assert.equal(neighbour([3, 5, 9], 99, -1), 9);
  assert.equal(neighbour([7], 7, 1), 7);
  for (const bad of [[], undefined, null, 'x']) assert.equal(neighbour(bad, 1, 1), null);
});

test('a pull request whose head is unknown does not break the report, and its CI is unknown', () => {
  const text = prReport({ pullRequest: pr({ headSha: undefined }), snapshot: snapshot() });
  assert.match(text, /Latest head: unknown/);
  assert.match(text, /CI for this head: unknown/);
});

test('long titles are cut to a fixed length', () => {
  const text = prReport({ pullRequest: pr({ title: 'x'.repeat(5000) }) });
  assert.ok(text.split('\n')[0].length <= 'Pull request #7: '.length + 300);
  assert.ok(issueReport({ issue: issue({ title: 'y'.repeat(5000) }) }).split('\n')[0].length <= 'Issue #12: '.length + 300);
});
