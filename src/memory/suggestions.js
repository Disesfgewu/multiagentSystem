'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Memory suggestions an agent leaves for the person (issue #306): a small JSON file in the agent's OWN working folder,
 * `.multiagent-memory-suggestions.json`, shaped `{ "suggestions": [ { "text": "…" } ] }`. This module only READS and checks that file; it
 * writes nothing and adopts nothing. What it returns is text to be proposed as a CANDIDATE (the memory store's own checks follow), which
 * no agent is given until a person adopts it.
 *
 * The file is untrusted input from an agent: it is opened only at that exact name directly under the folder the session runs in, never
 * through a link, never more than MAX_BYTES of it, with at most MAX_SUGGESTIONS entries of at most MAX_TEXT_CHARS characters each, and
 * only the `text` of each entry is kept.
 */

const FILE_NAME = '.multiagent-memory-suggestions.json';
const MAX_BYTES = 64 * 1024;
const MAX_SUGGESTIONS = 20;
const MAX_TEXT_CHARS = 500;

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * @param {string} worktree absolute path of the folder the session runs in
 * @param {{ fsImpl?: object }} [options]
 * @returns {{ ok: true, suggestions: string[], skipped: number } | { ok: false, reason: string }}
 *   reasons: worktree-invalid, unsafe-worktree, no-file, unsafe-file, too-large, unreadable, not-json, wrong-shape
 */
function readSuggestionFile(worktree, { fsImpl = fs } = {}) {
  if (typeof worktree !== 'string' || !path.isAbsolute(worktree)) return { ok: false, reason: 'worktree-invalid' };
  const file = path.join(worktree, FILE_NAME);
  let fd;
  try {
    // The folder itself must not be a link: a link to another agent's folder would hand this session that agent's suggestions. (A link
    // higher up, such as /tmp on macOS, is fine: the file's real location is compared with the folder's real location below.)
    try {
      const root = fsImpl.lstatSync(worktree);
      if (root.isSymbolicLink() || !root.isDirectory()) return { ok: false, reason: 'unsafe-worktree' };
    } catch { return { ok: false, reason: 'unsafe-worktree' }; }
    let before;
    try { before = fsImpl.lstatSync(file); } catch (error) { return { ok: false, reason: error && error.code === 'ENOENT' ? 'no-file' : 'unreadable' }; }
    if (before.isSymbolicLink() || !before.isFile()) return { ok: false, reason: 'unsafe-file' };
    if (before.size > MAX_BYTES) return { ok: false, reason: 'too-large' };
    fd = fsImpl.openSync(file, fsImpl.constants.O_RDONLY | (fsImpl.constants.O_NOFOLLOW ?? 0) | (fsImpl.constants.O_NONBLOCK ?? 0));
    const opened = fsImpl.fstatSync(fd);
    // Whatever path led here, the file really lies directly in the folder's real location (no link in between).
    try { if (fsImpl.realpathSync(file) !== path.join(fsImpl.realpathSync(worktree), FILE_NAME)) return { ok: false, reason: 'unsafe-file' }; } catch { return { ok: false, reason: 'unsafe-file' }; }
    if (!opened.isFile() || opened.size > MAX_BYTES) return { ok: false, reason: opened.isFile() ? 'too-large' : 'unsafe-file' };
    const buffer = Buffer.alloc(opened.size);
    let read = 0;
    while (read < opened.size) { const count = fsImpl.readSync(fd, buffer, read, opened.size - read, read); if (count === 0) break; read += count; }
    let parsed;
    try { parsed = JSON.parse(buffer.subarray(0, read).toString('utf8')); } catch { return { ok: false, reason: 'not-json' }; }
    if (!isPlain(parsed) || !Array.isArray(parsed.suggestions)) return { ok: false, reason: 'wrong-shape' };
    const suggestions = [];
    let skipped = 0;
    for (const entry of parsed.suggestions.slice(0, MAX_SUGGESTIONS)) {
      const text = isPlain(entry) && typeof entry.text === 'string' ? entry.text.trim() : '';
      if (text === '' || Array.from(text).length > MAX_TEXT_CHARS) { skipped += 1; continue; }
      suggestions.push(text);
    }
    skipped += Math.max(0, parsed.suggestions.length - MAX_SUGGESTIONS);
    return { ok: true, suggestions, skipped };
  } catch {
    return { ok: false, reason: 'unreadable' };
  } finally {
    if (fd !== undefined) { try { fsImpl.closeSync(fd); } catch { /* nothing to do */ } }
  }
}

module.exports = { readSuggestionFile, FILE_NAME, MAX_BYTES, MAX_SUGGESTIONS, MAX_TEXT_CHARS };
