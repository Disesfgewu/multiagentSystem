'use strict';

/**
 * Which files are being changed in more than one worktree of the same repository: the places where two
 * agents are about to collide. Pure: the caller supplies, per worktree, an id and the repository-relative
 * files it changes (compared to the integration branch). Nothing here reads Git or the file system.
 *
 * Two kinds of match are kept apart. The same name in two worktrees is a collision (`exact: true`). Names that
 * differ only in letter case or in Unicode form (README.md / readme.md, the two spellings of "café") are one
 * file on a case-insensitive or normalizing volume and two files on another; nothing here can tell which
 * volume this is, so they are reported as a possible collision (`exact: false`) with every worktree's own
 * spelling kept. A possible match is never presented as a certain one.
 *
 * @param {Array<{ id: string, files: Iterable<string> }>} entries
 * @returns {Array<{ file: string, worktrees: string[], names: string[], exact: boolean }>}
 *   sorted; `names[i]` is the spelling used in `worktrees[i]`, and `file` is the first of them
 */
function findOverlaps(entries) {
  const keyOf = (file) => file.normalize('NFC').toLowerCase();
  const groups = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string') continue;
    for (const file of new Set(entry.files)) {
      if (typeof file !== 'string' || file === '') continue;
      const key = keyOf(file);
      if (!groups.has(key)) groups.set(key, new Map());
      const byWorktree = groups.get(key);
      if (!byWorktree.has(entry.id)) byWorktree.set(entry.id, file); // one spelling per worktree: the first it lists
    }
  }
  const found = [];
  for (const byWorktree of groups.values()) {
    if (byWorktree.size < 2) continue;
    const worktrees = [...byWorktree.keys()];
    const names = [...byWorktree.values()];
    found.push({ file: names[0], worktrees, names, exact: names.every((name) => name === names[0]) });
  }
  return found.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/** One summary for messages: counts and at most `limit` names of each kind, exact collisions first. */
function summarizeOverlaps(overlaps, limit = 5) {
  if (overlaps.length === 0) return 'No file is being changed in more than one worktree.';
  const list = (items) => {
    const shown = items.slice(0, limit).map((item) => item.file);
    return `${shown.join(', ')}${items.length > shown.length ? ` and ${items.length - shown.length} more` : ''}`;
  };
  const exact = overlaps.filter((item) => item.exact);
  const possible = overlaps.filter((item) => !item.exact);
  const parts = [];
  if (exact.length > 0) parts.push(`${exact.length} file${exact.length === 1 ? ' is' : 's are'} being changed in more than one worktree: ${list(exact)}.`);
  if (possible.length > 0) parts.push(`${possible.length} name${possible.length === 1 ? '' : 's'} differ${possible.length === 1 ? 's' : ''} only in letter case or Unicode form between worktrees and may be the same file on a case-insensitive or normalizing file system (not confirmed): ${list(possible)}.`);
  return parts.join(' ');
}

module.exports = { findOverlaps, summarizeOverlaps };
