'use strict';

/**
 * Which files are being changed in more than one worktree of the same repository: the places where two
 * agents are about to collide. Pure: the caller supplies, per worktree, a label and the repository-relative
 * files it changes (compared to the integration branch). Nothing here reads Git or the file system.
 *
 * @param {Array<{ id: string, files: Iterable<string> }>} entries
 * @param {{ foldNames?: boolean }} [options] fold case and Unicode form; defaults to the file systems that do (Windows, macOS)
 * @returns {Array<{ file: string, worktrees: string[] }>} sorted by file; each lists the worktree ids in the order given
 */
function findOverlaps(entries, { foldNames = process.platform === 'win32' || process.platform === 'darwin' } = {}) {
  // On a case-insensitive or Unicode-normalizing file system (Windows, macOS) README.md and readme.md, or the
  // two spellings of "café", are one file: comparing them exactly would miss a real collision. Elsewhere names
  // are compared as they are. The first spelling seen is the one shown.
  const keyOf = (file) => (foldNames ? file.normalize('NFC').toLowerCase() : file);
  const seen = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string') continue;
    for (const file of new Set(entry.files)) {
      if (typeof file !== 'string' || file === '') continue;
      const key = keyOf(file);
      const known = seen.get(key);
      if (known) known.owners.push(entry.id);
      else seen.set(key, { file, owners: [entry.id] });
    }
  }
  return [...seen.values()]
    .filter(({ owners }) => owners.length > 1)
    .map(({ file, owners }) => ({ file, worktrees: [...new Set(owners)] }))
    .filter((item) => item.worktrees.length > 1)
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/** "a.ts, b.ts" style summary used in messages: counts and at most `limit` names, never a path outside the repository. */
function summarizeOverlaps(overlaps, limit = 5) {
  if (overlaps.length === 0) return 'No file is being changed in more than one worktree.';
  const shown = overlaps.slice(0, limit).map((item) => item.file);
  const more = overlaps.length > shown.length ? ` and ${overlaps.length - shown.length} more` : '';
  return `${overlaps.length} file${overlaps.length === 1 ? ' is' : 's are'} being changed in more than one worktree: ${shown.join(', ')}${more}.`;
}

module.exports = { findOverlaps, summarizeOverlaps };
