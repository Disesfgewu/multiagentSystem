'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findOverlaps, summarizeOverlaps } = require('../../src/projects/overlap');

test('only files present in two or more worktrees are overlaps, sorted, with the owners in the order given', () => {
  const overlaps = findOverlaps([
    { id: 'feat/a', files: ['z.ts', 'a.ts', 'only-a.ts'] },
    { id: 'feat/b', files: new Set(['a.ts', 'z.ts', 'only-b.ts']) },
    { id: 'feat/c', files: ['z.ts'] }
  ]);
  assert.deepEqual(overlaps, [{ file: 'a.ts', worktrees: ['feat/a', 'feat/b'], names: ['a.ts', 'a.ts'], exact: true }, { file: 'z.ts', worktrees: ['feat/a', 'feat/b', 'feat/c'], names: ['z.ts', 'z.ts', 'z.ts'], exact: true }]);
});

test('one worktree never overlaps itself, even if its list repeats a file or a label repeats', () => {
  assert.deepEqual(findOverlaps([{ id: 'a', files: ['x', 'x'] }]), []);
  assert.deepEqual(findOverlaps([{ id: 'a', files: ['x'] }, { id: 'a', files: ['x'] }]), [], 'the same label is the same worktree');
  assert.deepEqual(findOverlaps([]), []);
});

test('malformed entries and names are ignored rather than trusted', () => {
  assert.deepEqual(findOverlaps([null, { files: ['x'] }, { id: 5, files: ['x'] }, { id: 'a', files: ['', 5, null, 'x'] }, { id: 'b', files: ['x'] }]), [{ file: 'x', worktrees: ['a', 'b'], names: ['x', 'x'], exact: true }]);
});

test('the summary counts, names at most five files and never says "none" about files it did not compare', () => {
  assert.equal(summarizeOverlaps([]), 'No file is being changed in more than one worktree.');
  const many = Array.from({ length: 7 }, (_, index) => ({ file: `f${index}`, worktrees: ['a', 'b'], names: [`f${index}`, `f${index}`], exact: true }));
  assert.equal(summarizeOverlaps(many), '7 files are being changed in more than one worktree: f0, f1, f2, f3, f4 and 2 more.');
  assert.equal(summarizeOverlaps([many[0]]), '1 file is being changed in more than one worktree: f0.');
});

test('names that differ only in case or Unicode form are a possible collision with every spelling kept, never a certain one', () => {
  const nfc = 'caf\u00e9.txt';
  const nfd = 'cafe\u0301.txt';
  const entries = [{ id: 'a', files: ['README.md', nfc, 'src/Util.ts', 'same.ts'] }, { id: 'b', files: ['readme.md', nfd, 'src/util.ts', 'other.ts', 'same.ts'] }];
  const found = findOverlaps(entries);
  const byFirst = Object.fromEntries(found.map((item) => [item.file, item]));
  assert.deepEqual(byFirst['same.ts'], { file: 'same.ts', worktrees: ['a', 'b'], names: ['same.ts', 'same.ts'], exact: true });
  assert.deepEqual(byFirst['README.md'], { file: 'README.md', worktrees: ['a', 'b'], names: ['README.md', 'readme.md'], exact: false }, 'each worktree keeps its own spelling');
  assert.deepEqual(byFirst[nfc].names, [nfc, nfd]);
  assert.equal(byFirst[nfc].exact, false);
  assert.deepEqual(byFirst['src/Util.ts'].names, ['src/Util.ts', 'src/util.ts']);
  assert.equal(found.length, 4);
  assert.deepEqual(findOverlaps([{ id: 'a', files: ['A.txt', 'a.txt'] }]), [], 'one worktree never overlaps itself');
});

test('the summary keeps certain and possible apart and says the possible ones are not confirmed', () => {
  const overlaps = [{ file: 'a.ts', worktrees: ['x', 'y'], names: ['a.ts', 'a.ts'], exact: true }, { file: 'B.ts', worktrees: ['x', 'y'], names: ['B.ts', 'b.ts'], exact: false }];
  const text = summarizeOverlaps(overlaps);
  assert.match(text, /^1 file is being changed in more than one worktree: a\.ts\./);
  assert.match(text, /1 name differs only in letter case or Unicode form between worktrees and may be the same file on a case-insensitive or normalizing file system \(not confirmed\): B\.ts\./);
  assert.equal(/being changed in more than one worktree: [^.]*B\.ts/.test(text), false, 'a possible match is not listed as a certain one');
  assert.doesNotMatch(summarizeOverlaps([overlaps[0]]), /not confirmed/);
});
