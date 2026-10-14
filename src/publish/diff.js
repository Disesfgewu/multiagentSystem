'use strict';

// Reads a unified diff (git's format) and returns what is being ADDED: the new file paths and
// the added lines with their line numbers in the new file. Removed and context lines are already
// in history and are not new publication, so they are not returned.
//
// If the diff cannot be read with confidence, `malformed` is set and the caller scans the whole
// text instead of trusting a partial parse. Nothing here returns matched text to a log.

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function unquote(path) {
  if (!(path.startsWith('"') && path.endsWith('"') && path.length >= 2)) return path;
  const bytes = [];
  const inner = path.slice(1, -1);
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i];
    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf8'));
      continue;
    }
    const next = inner[i + 1];
    const octal = /^[0-7]{3}/.exec(inner.slice(i + 1, i + 4));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      i += 3;
    } else {
      const map = { n: 10, t: 9, r: 13, '"': 34, '\\': 92 };
      bytes.push(map[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function headerPath(raw) {
  const value = unquote(raw.replace(/\t.*$/, ''));
  if (value === '/dev/null') return null;
  return value.replace(/^[ab]\//, '');
}

// `diff --git a/P b/P` (same path both sides) or `a/P b/Q`. Used when no ---/+++ lines follow, as for
// binary files and pure renames. Returns [oldPath, newPath] or null when it cannot be split safely.
function gitHeaderPaths(rest) {
  if (rest.startsWith('"')) {
    const match = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/.exec(rest);
    return match ? [headerPath(match[1]), headerPath(match[2])] : null;
  }
  if (!rest.startsWith('a/')) return null;
  for (let at = rest.indexOf(' b/'); at !== -1; at = rest.indexOf(' b/', at + 1)) {
    const left = rest.slice(2, at);
    const right = rest.slice(at + 3);
    if (left === right) return [left, right];
  }
  const only = rest.indexOf(' b/');
  return only === -1 ? null : [rest.slice(2, only), rest.slice(only + 3)];
}

/**
 * @returns {{ files: Array<{ index: number, oldPath: string|null, newPath: string|null,
 *   isNew: boolean, isRename: boolean, binary: boolean, added: Array<{ line: number, text: string }> }>,
 *   malformed: boolean }}
 */
function parseUnifiedDiff(text) {
  const files = [];
  let current = null;
  let malformed = false;
  let oldLeft = 0;
  let newLeft = 0;
  let newLine = 0;

  const start = () => {
    current = { index: files.length, oldPath: null, newPath: null, isNew: false, isRename: false, binary: false, sawOld: false, added: [] };
    files.push(current);
    oldLeft = 0;
    newLeft = 0;
  };

  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (oldLeft > 0 || newLeft > 0) {
      const marker = line[0];
      if (marker === '+') {
        if (newLeft === 0) malformed = true;
        current.added.push({ line: newLine, text: raw.endsWith('\r') ? raw.slice(1, -1) : raw.slice(1) });
        newLine += 1;
        newLeft -= 1;
      } else if (marker === '-') {
        if (oldLeft === 0) malformed = true;
        oldLeft -= 1;
      } else if (marker === ' ' || line === '') {
        oldLeft -= 1;
        newLeft -= 1;
        newLine += 1;
      } else if (marker === '\\') {
        // "\ No newline at end of file"
      } else {
        malformed = true;
        oldLeft = 0;
        newLeft = 0;
      }
      if (oldLeft < 0 || newLeft < 0) {
        malformed = true;
        oldLeft = Math.max(oldLeft, 0);
        newLeft = Math.max(newLeft, 0);
      }
      continue;
    }

    if (line.startsWith('diff --git ')) {
      start();
      const paths = gitHeaderPaths(line.slice('diff --git '.length));
      if (paths) {
        current.oldPath = paths[0];
        current.newPath = paths[1];
      }
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      // A `---` line after this file's own `---` line (or after its hunks) begins another file
      // in a diff that has no `diff --git` lines.
      if (!current || (line.startsWith('--- ') && current.sawOld)) start();
      if (line.startsWith('--- ')) {
        current.sawOld = true;
        current.oldPath = headerPath(line.slice(4));
      } else current.newPath = headerPath(line.slice(4));
      continue;
    }
    if (!current) continue;
    if (line.startsWith('new file mode')) current.isNew = true;
    else if (line.startsWith('deleted file mode')) current.newPath = null;
    else if (line.startsWith('rename to ')) {
      current.isRename = true;
      current.newPath = headerPath(line.slice('rename to '.length));
    } else if (line.startsWith('rename from ')) current.oldPath = headerPath(line.slice('rename from '.length));
    else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) current.binary = true;
    else {
      const hunk = HUNK.exec(line);
      if (hunk) {
        oldLeft = hunk[2] === undefined ? 1 : Number.parseInt(hunk[2], 10);
        newLeft = hunk[4] === undefined ? 1 : Number.parseInt(hunk[4], 10);
        newLine = Number.parseInt(hunk[3], 10);
      } else if (line.startsWith('@@')) {
        malformed = true;
      }
    }
  }
  if (oldLeft > 0 || newLeft > 0) malformed = true;
  if (files.length === 0 && text.trim() !== '') malformed = true;
  // `diff --git` is optional in some producers; a file without any path is not understood.
  if (files.some((file) => file.newPath === null && file.oldPath === null)) malformed = true;
  for (const file of files) delete file.sawOld;
  return { files, malformed };
}

module.exports = { parseUnifiedDiff };
