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
  assert.deepEqual(overlaps, [{ file: 'a.ts', worktrees: ['feat/a', 'feat/b'] }, { file: 'z.ts', worktrees: ['feat/a', 'feat/b', 'feat/c'] }]);
});

test('one worktree never overlaps itself, even if its list repeats a file or a label repeats', () => {
  assert.deepEqual(findOverlaps([{ id: 'a', files: ['x', 'x'] }]), []);
  assert.deepEqual(findOverlaps([{ id: 'a', files: ['x'] }, { id: 'a', files: ['x'] }]), [], 'the same label is the same worktree');
  assert.deepEqual(findOverlaps([]), []);
});

test('malformed entries and names are ignored rather than trusted', () => {
  assert.deepEqual(findOverlaps([null, { files: ['x'] }, { id: 5, files: ['x'] }, { id: 'a', files: ['', 5, null, 'x'] }, { id: 'b', files: ['x'] }]), [{ file: 'x', worktrees: ['a', 'b'] }]);
});

test('the summary counts, names at most five files and never says "none" about files it did not compare', () => {
  assert.equal(summarizeOverlaps([]), 'No file is being changed in more than one worktree.');
  const many = Array.from({ length: 7 }, (_, index) => ({ file: `f${index}`, worktrees: ['a', 'b'] }));
  assert.equal(summarizeOverlaps(many), '7 files are being changed in more than one worktree: f0, f1, f2, f3, f4 and 2 more.');
  assert.equal(summarizeOverlaps([many[0]]), '1 file is being changed in more than one worktree: f0.');
});
