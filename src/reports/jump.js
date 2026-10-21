'use strict';

const path = require('node:path');

/**
 * Jumping from a pull request report to code (issue #308). Pure logic: which line of a file's patch a review comment points at,
 * which lines of the report are such comments, and which working folder (if any) holds exactly the pull request's head. Nothing here
 * opens anything; the report view does, and only for names and numbers this module has checked against what the report itself shows.
 */

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
const MAX_LINE = 10_000_000;
const SHA = /^[0-9a-f]{40}$/;

const isLine = (value) => Number.isSafeInteger(value) && value >= 1 && value <= MAX_LINE;

/**
 * The zero-based row of the patch text where line `newLine` of the NEW version of the file is shown (a context line or an added
 * line), or null when the patch does not show that line (it lies outside the changed parts, or the patch is not text).
 */
function patchRowFor(patch, newLine) {
  if (typeof patch !== 'string' || !isLine(newLine)) return null;
  const rows = patch.split('\n');
  let current = null;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const hunk = HUNK.exec(row);
    if (hunk) { current = Number(hunk[1]); continue; }
    if (current === null || row.startsWith('\\')) continue;
    if (row.startsWith('-')) continue;
    if (current === newLine) return index;
    current += 1;
  }
  return null;
}

// "- <author> · <path>:<line> · <commit note>…": the one-line header the report writes for each inline review comment.
const INLINE_BULLET = /^- .+? · (.+):(\d{1,8}) · (?:on the latest head|on an OLDER head|head unknown)/;

/**
 * The inline review comments in the rendered report, as places that can be clicked: the row, the path and line named, and the column
 * range of `path:line`. A comment is only trusted when its path is one of `filenames`, the files the report itself listed; anything
 * else is ignored rather than guessed at.
 * @returns {Array<{ lineNumber: number, filename: string, line: number, start: number, end: number }>}
 */
function inlineCommentLinks(lines, filenames) {
  const names = new Set(Array.isArray(filenames) ? filenames : []);
  const found = [];
  let inSection = false;
  (Array.isArray(lines) ? lines : []).forEach((text, lineNumber) => {
    if (typeof text !== 'string') return;
    if (text === 'INLINE REVIEW DISCUSSION') { inSection = true; return; }
    if (inSection && /^[A-Z][A-Z ]+$/.test(text)) { inSection = false; return; }
    if (!inSection) return;
    const match = INLINE_BULLET.exec(text);
    if (!match || !names.has(match[1])) return;
    const lineValue = Number(match[2]);
    if (!isLine(lineValue)) return;
    const start = text.indexOf(`${match[1]}:${match[2]}`);
    if (start < 0) return;
    found.push({ lineNumber, filename: match[1], line: lineValue, start, end: start + match[1].length + 1 + match[2].length });
  });
  return found;
}

/** A path inside a repository: relative, no `..`, no empty parts, no NUL, no backslash tricks. */
function isRepositoryPath(value) {
  if (typeof value !== 'string' || value === '' || value.length > 1024 || value.includes('\0') || value.includes('\\')) return false;
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.split('/');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..');
}

/**
 * The working folder whose checked-out commit is EXACTLY the pull request's head, for a file of that pull request. Only an exact
 * match counts: a folder on the same branch name but another commit would show other code under the pull request's name.
 * @param {{ filename: unknown, headSha: unknown, worktrees: Array<{ path?: unknown, headSha?: unknown }> }} input
 * @returns {{ folder: string, relative: string } | null}
 */
function worktreeFor({ filename, headSha, worktrees }) {
  if (!isRepositoryPath(filename) || typeof headSha !== 'string' || !SHA.test(headSha.toLowerCase())) return null;
  for (const entry of Array.isArray(worktrees) ? worktrees : []) {
    if (!entry || typeof entry.path !== 'string' || !path.isAbsolute(entry.path) || typeof entry.headSha !== 'string') continue;
    if (entry.headSha.toLowerCase() === headSha.toLowerCase()) return { folder: entry.path, relative: filename };
  }
  return null;
}

/** Whether `real` is `folder` itself or inside it (both already resolved). */
function isInside(folder, real) {
  const relative = path.relative(folder, real);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

module.exports = { patchRowFor, inlineCommentLinks, worktreeFor, isRepositoryPath, isInside, isLine, MAX_LINE };
