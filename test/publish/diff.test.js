'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseUnifiedDiff } = require('../../src/publish/diff');

const lines = (...values) => `${values.join('\n')}\n`;

test('added lines get their line numbers in the new file; removed and context lines are not returned', () => {
  const diff = lines(
    'diff --git a/src/a.js b/src/a.js',
    'index 1111111..2222222 100644',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -10,4 +10,5 @@ function x() {',
    ' context one',
    '-removed line',
    '+added line A',
    '+added line B',
    ' context two',
    ' context three',
    '@@ -40,2 +41,3 @@',
    ' keep',
    '+later addition',
    ' keep too'
  );
  const parsed = parseUnifiedDiff(diff);
  assert.equal(parsed.malformed, false);
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0].newPath, 'src/a.js');
  assert.deepEqual(parsed.files[0].added, [
    { line: 11, text: 'added line A' },
    { line: 12, text: 'added line B' },
    { line: 42, text: 'later addition' }
  ]);
});

test('new, deleted and renamed files are described; a deleted file adds nothing', () => {
  const diff = lines(
    'diff --git a/new.txt b/new.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1,2 @@',
    '+one',
    '+two',
    'diff --git a/gone.txt b/gone.txt',
    'deleted file mode 100644',
    '--- a/gone.txt',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-x',
    '-y',
    'diff --git a/old name.txt b/moved/new name.txt',
    'similarity index 100%',
    'rename from old name.txt',
    'rename to moved/new name.txt'
  );
  const { files, malformed } = parseUnifiedDiff(diff);
  assert.equal(malformed, false);
  assert.deepEqual(files.map((f) => [f.newPath, f.isNew, f.isRename, f.added.length]), [['new.txt', true, false, 2], [null, false, false, 0], ['moved/new name.txt', false, true, 0]]);
});

test('content that itself starts with +++ or --- is read as content, not as a header', () => {
  const diff = lines('diff --git a/a.md b/a.md', '--- a/a.md', '+++ b/a.md', '@@ -1,1 +1,3 @@', ' keep', '+++ added text that looks like a header', '+--- another');
  const { files, malformed } = parseUnifiedDiff(diff);
  assert.equal(malformed, false);
  assert.deepEqual(files[0].added.map((a) => a.text), ['++ added text that looks like a header', '--- another']);
});

test('quoted paths with escapes and UTF-8 octal bytes are decoded', () => {
  const diff = lines('diff --git "a/caf\\303\\251 \\"x\\".txt" "b/caf\\303\\251 \\"x\\".txt"', 'new file mode 100644', '--- /dev/null', '+++ "b/caf\\303\\251 \\"x\\".txt"', '@@ -0,0 +1 @@', '+hi');
  assert.equal(parseUnifiedDiff(diff).files[0].newPath, 'café "x".txt');
});

test('binary files, missing-newline markers and CRLF are handled', () => {
  const binary = lines('diff --git a/img.png b/img.png', 'new file mode 100644', 'Binary files /dev/null and b/img.png differ');
  assert.equal(parseUnifiedDiff(binary).files[0].binary, true);
  const noNewline = lines('diff --git a/a b/a', '--- a/a', '+++ b/a', '@@ -1 +1 @@', '-old', '+new', '\\ No newline at end of file');
  assert.deepEqual(parseUnifiedDiff(noNewline).files[0].added, [{ line: 1, text: 'new' }]);
  const crlf = 'diff --git a/a b/a\r\n--- a/a\r\n+++ b/a\r\n@@ -0,0 +1,2 @@\r\n+first\r\n+second\r\n';
  const parsed = parseUnifiedDiff(crlf);
  assert.equal(parsed.malformed, false);
  assert.deepEqual(parsed.files[0].added.map((a) => a.text), ['first', 'second']);
});

test('a diff that cannot be read with confidence is reported as malformed', () => {
  for (const text of [
    'just some text that is not a diff',
    lines('diff --git a/a b/a', '--- a/a', '+++ b/a', '@@ -1,3 +1,3 @@', ' only one line before the diff stops'),
    lines('diff --git a/a b/a', '--- a/a', '+++ b/a', '@@ garbage @@'),
    lines('diff --git a/a b/a', '--- a/a', '+++ b/a', '@@ -1,1 +1,1 @@', '?unexpected marker')
  ]) {
    assert.equal(parseUnifiedDiff(text).malformed, true, text.slice(0, 30));
  }
  assert.equal(parseUnifiedDiff('').malformed, false);
});

test('paths come from the diff --git line when no ---/+++ lines follow (binary files, pure renames)', () => {
  const diff = lines(
    'diff --git a/assets/logo.png b/assets/logo.png',
    'new file mode 100644',
    'Binary files /dev/null and b/assets/logo.png differ',
    'diff --git a/dir with space/a b.txt b/dir with space/a b.txt',
    'new file mode 100644',
    'Binary files /dev/null and "b/dir with space/a b.txt" differ',
    'diff --git a/old.txt b/sub/new.txt',
    'similarity index 100%',
    'rename from old.txt',
    'rename to sub/new.txt'
  );
  const { files, malformed } = parseUnifiedDiff(diff);
  assert.equal(malformed, false);
  assert.deepEqual(files.map((f) => [f.newPath, f.binary, f.isNew]), [['assets/logo.png', true, true], ['dir with space/a b.txt', true, true], ['sub/new.txt', false, false]]);
});

test('a plain ---/+++ diff without diff --git lines is split into files by the second --- line', () => {
  const diff = lines('--- a/one.txt', '+++ b/one.txt', '@@ -1 +1 @@', '-a', '+b', '--- a/two.txt', '+++ b/two.txt', '@@ -1 +1 @@', '-c', '+d');
  const { files, malformed } = parseUnifiedDiff(diff);
  assert.equal(malformed, false);
  assert.deepEqual(files.map((f) => [f.newPath, f.added.map((a) => a.text)]), [['one.txt', ['b']], ['two.txt', ['d']]]);
});
