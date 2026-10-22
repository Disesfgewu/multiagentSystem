'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { patchRowFor, inlineCommentLinks, worktreeFor, isUsableWorktree, isRepositoryPath, isInside } = require('../../src/reports/jump');

const PATCH = ['@@ -1,4 +10,5 @@ function a() {', ' keep ten', '-removed', '+added eleven', ' keep twelve', '+added thirteen', '\\ No newline at end of file', '@@ -40,2 +60,2 @@', ' keep sixty', '+added sixty-one'].join('\n');

test('a line of the new file is found in the patch: context and added lines count, removed lines do not', () => {
  assert.equal(patchRowFor(PATCH, 10), 1);
  assert.equal(patchRowFor(PATCH, 11), 3, 'the added line follows the removed one');
  assert.equal(patchRowFor(PATCH, 12), 4);
  assert.equal(patchRowFor(PATCH, 13), 5);
  assert.equal(patchRowFor(PATCH, 60), 8, 'the second hunk starts its own count');
  assert.equal(patchRowFor(PATCH, 61), 9);
});

test('a line outside every hunk, or a patch that is not text, is not found', () => {
  for (const line of [1, 9, 14, 59, 62, 1000]) assert.equal(patchRowFor(PATCH, line), null, String(line));
  for (const patch of [null, undefined, 5, '', 'no hunks at all', 'binary']) assert.equal(patchRowFor(patch, 10), null);
  for (const line of [0, -1, 1.5, NaN, '10', null, undefined, 10_000_001]) assert.equal(patchRowFor(PATCH, line), null, String(line));
});

const report = ['PR', 'INLINE REVIEW DISCUSSION', '- alice · src/a.js:11 · on the latest head', '  say [x] - bob · src/a.js:12 · on the latest head', '- bob · src/other.js:5 · on an OLDER head · reply to #3', '- carol · src/a.js:7 · head unknown · 2026-10-22', '- dave · README.md:3 · on the latest head', 'DECISIONS', '- mallory · src/a.js:99 · on the latest head'];

test('inline review comments become places to click, only for files the report listed and only inside its own section', () => {
  const links = inlineCommentLinks(report, ['src/a.js', 'README.md']);
  assert.deepEqual(links.map((link) => [link.lineNumber, link.filename, link.line]), [[2, 'src/a.js', 11], [5, 'src/a.js', 7], [6, 'README.md', 3]]);
  const first = links[0];
  assert.equal(report[2].slice(first.start, first.end), 'src/a.js:11', 'the clickable range is the path and line only');
  assert.deepEqual(inlineCommentLinks(report, []), []);
  assert.deepEqual(inlineCommentLinks(report, ['src/other.js']).map((link) => link.line), [5]);
  for (const bad of [null, undefined, 'x', 5]) assert.deepEqual(inlineCommentLinks(bad, ['a']), []);
  assert.deepEqual(inlineCommentLinks(['INLINE REVIEW DISCUSSION', '- a · src/a.js:0 · on the latest head', '- a · src/a.js:99999999999 · on the latest head', 5, null], ['src/a.js']), []);
});

test('only a relative path inside the repository can be opened from a worktree', () => {
  for (const good of ['a.js', 'src/a/b.ts', 'dir/.hidden', 'dir/with space/x']) assert.equal(isRepositoryPath(good), true, good);
  for (const bad of ['.git/config', '.GIT/hooks/x', '', '/etc/passwd', '../x', 'a/../../x', 'a//b', './a', 'a/./b', 'C:/x', 'c:\\x', 'a\\b', 'a\0b', 5, null, undefined, 'x'.repeat(1025), 'a/']) assert.equal(isRepositoryPath(bad), false, String(bad));
});

const HEAD = 'a'.repeat(40);

test('a working folder counts only when its checked-out commit is exactly the pull request head', () => {
  const folder = path.resolve('/work/agent-1');
  const worktrees = [{ path: path.resolve('/work/other'), headSha: 'b'.repeat(40) }, { path: folder, headSha: HEAD.toUpperCase() }];
  assert.deepEqual(worktreeFor({ filename: 'src/a.js', headSha: HEAD, worktrees }), { folder, relative: 'src/a.js' });
  assert.equal(worktreeFor({ filename: 'src/a.js', headSha: 'c'.repeat(40), worktrees }), null, 'same branch name, another commit: not used');
  assert.equal(worktreeFor({ filename: 'src/a.js', headSha: HEAD.slice(0, 12), worktrees }), null, 'a short id is not enough');
  assert.equal(worktreeFor({ filename: '../x', headSha: HEAD, worktrees }), null);
  assert.equal(worktreeFor({ filename: 'src/a.js', headSha: null, worktrees }), null);
  for (const bad of [null, undefined, 'x', [null, {}, { path: 'relative', headSha: HEAD }, { path: folder }]]) assert.equal(worktreeFor({ filename: 'a', headSha: HEAD, worktrees: bad }), null);
});

test('containment is by resolved path: the folder itself, a sibling with the same prefix and a parent are not inside', () => {
  const folder = path.resolve('/work/agent-1');
  assert.equal(isInside(folder, path.join(folder, 'src', 'a.js')), true);
  assert.equal(isInside(folder, folder), false);
  assert.equal(isInside(folder, `${folder}-evil${path.sep}a.js`), false);
  assert.equal(isInside(folder, path.resolve('/work')), false);
  assert.equal(isInside(folder, path.resolve('/etc/passwd')), false);
});

test('a working folder is used only when Git read it and it has no change and no untracked file', () => {
  const entry = { path: '/work/agent', headSha: 'a'.repeat(40) };
  const known = (over = {}) => ({ state: 'known', changed: 0, untracked: 0, dirty: false, ...over });
  assert.equal(isUsableWorktree(entry, known()), true);
  assert.equal(isUsableWorktree(entry, known({ changed: 2, dirty: true })), false, 'an uncommitted change');
  assert.equal(isUsableWorktree(entry, known({ untracked: 1, dirty: true })), false, 'an untracked file');
  assert.equal(isUsableWorktree(entry, { state: 'unknown', reason: 'not-readable' }), false, 'Git could not read it');
  assert.equal(isUsableWorktree(entry, known({ dirty: undefined })), false, 'no answer about changes is not "clean"');
  assert.equal(isUsableWorktree(entry, known({ dirty: 0 })), false, 'only an exact false counts');
  for (const bad of [null, undefined, {}, 5]) assert.equal(isUsableWorktree(entry, bad), false, String(bad));
  for (const odd of [{ ...entry, bare: true }, { ...entry, prunable: true }, { path: 5, headSha: entry.headSha }, { path: entry.path }, null]) assert.equal(isUsableWorktree(odd, known()), false, JSON.stringify(odd));
});

test('openFileDiff refuses a line that is not a whole number from 1 to 10,000,000 before it opens anything', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(path.join(__dirname, '../../src/reports/reportsView.ts'), 'utf8').replace(/\r\n/g, '\n');
  const body = source.slice(source.indexOf('async function openFileDiff('), source.indexOf('function activeTarget()'));
  assert.match(body, /if \(input\.line !== undefined && !isLine\(input\.line\)\) return \{ ok: false, code: 'invalid-file-diff' \};/);
  assert.ok(body.indexOf('!isLine(input.line)') < body.indexOf('openTextDocument('), 'validated first');
  const { isLine } = require('../../src/reports/jump');
  for (const bad of [0, -1, NaN, Infinity, 1.5, '5', null, {}, [], 10_000_001]) assert.equal(isLine(bad), false, String(bad));
  for (const good of [1, 2, 10_000_000]) assert.equal(isLine(good), true);
});
