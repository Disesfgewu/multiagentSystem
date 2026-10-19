'use strict';

const fs = require('node:fs');
const path = require('node:path');

// A reopened session starts a terminal in the worktree saved with it. That value came from private
// storage, so it is checked again at the moment of reopening: after resolving links, it must still be
// one of the project's own folders (or inside one), or a git worktree of the same repository as one of
// them. Anything else (a relative path, a link that now points elsewhere, an unrelated directory) is refused.
const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

/**
 * @param {string} worktree the saved path
 * @param {string[]} folders the project's current workspace folders
 * @param {{ realpath?: (p: string) => Promise<string>, commonDir?: (dir: string) => Promise<string|null> }} [deps]
 */
async function worktreeInProject(worktree, folders, deps = {}) {
  const realpath = deps.realpath ?? fs.promises.realpath;
  if (typeof worktree !== 'string' || !path.isAbsolute(worktree) || !Array.isArray(folders) || folders.length === 0) return false;
  let real;
  try { real = await realpath(worktree); } catch { return false; }
  const realFolders = [];
  for (const folder of folders) {
    try { realFolders.push(await realpath(folder)); } catch { /* an unreadable folder cannot vouch for anything */ }
  }
  if (realFolders.some((folder) => inside(folder, real))) return true;
  if (typeof deps.commonDir !== 'function') return false;
  let mine;
  try { mine = await deps.commonDir(real); } catch { mine = null; }
  if (!mine) return false;
  for (const folder of realFolders) {
    let theirs;
    try { theirs = await deps.commonDir(folder); } catch { theirs = null; }
    if (theirs && theirs === mine) return true;
  }
  return false;
}

module.exports = { worktreeInProject };
