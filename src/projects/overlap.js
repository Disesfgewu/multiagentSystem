'use strict';

/**
 * Which files are being changed in more than one worktree of the same repository: the places where two
 * agents are about to collide. Pure: the caller supplies, per worktree, a label and the repository-relative
 * files it changes (compared to the integration branch). Nothing here reads Git or the file system.
 *
 * @param {Array<{ id: string, files: Iterable<string> }>} entries
 * @returns {Array<{ file: string, worktrees: string[] }>} sorted by file; each lists the worktree ids in the order given
 */
function findOverlaps(entries) {
  const seen = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string') continue;
    for (const file of new Set(entry.files)) {
      if (typeof file !== 'string' || file === '') continue;
      const owners = seen.get(file);
      if (owners) owners.push(entry.id);
      else seen.set(file, [entry.id]);
    }
  }
  return [...seen]
    .filter(([, owners]) => owners.length > 1)
    .map(([file, worktrees]) => ({ file, worktrees: [...new Set(worktrees)] }))
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
