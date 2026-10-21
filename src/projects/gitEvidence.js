'use strict';

const path = require('node:path');
const { safeArgs } = require('./gitSafe');
const { execFile } = require('node:child_process');

const TIMEOUT_MS = 5000;
const MAX_BUFFER = 2 * 1024 * 1024;
const MAX_COUNT = 1_000_000;
const SHA = /^[a-f0-9]{7,64}$/;

/**
 * What local Git says about one working folder: uncommitted work and how far its branch is from its
 * upstream. Read-only and non-interfering: it never takes an index lock another Git command in the same
 * folder could be waiting for (`--no-optional-locks`), never runs a repository-configured file monitor,
 * and its answer carries counts, a short HEAD id and a branch name only: no path, no file name, no commit
 * text and no remote address. Anything it cannot read is unknown with a reason, never zero or clean.
 */

function execGit(cwd, args) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  for (const key of Object.keys(env)) {
    if (['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'].includes(key.toUpperCase())) delete env[key];
  }
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

// Every call carries the arguments that switch off what a repository's own configuration could run.
async function runGit(cwd, args) {
  return execGit(cwd, [...(await safeArgs((probe) => execGit(cwd, probe))), ...args]);
}

/** Counts from `git status --porcelain=v1 -z`. */
function parseStatus(output) {
  let changed = 0;
  let untracked = 0;
  const fields = output.split('\0');
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field.length < 3) continue;
    const code = field.slice(0, 2);
    if (code === '??') { untracked += 1; continue; }
    if (code === '!!') continue;
    changed += 1;
    // A rename or copy is followed by its original name as a separate field.
    if (code[0] === 'R' || code[0] === 'C' || code[1] === 'R' || code[1] === 'C') index += 1;
  }
  return { changed, untracked };
}

const count = (text) => {
  if (!/^\d{1,9}$/.test(text)) return null;
  const value = Number(text);
  return value <= MAX_COUNT ? value : null;
};

/** `git rev-list --left-right --count @{upstream}...HEAD` prints "<behind>\t<ahead>". */
function parseDivergence(output) {
  const match = /^(\d+)\s+(\d+)\s*$/.exec(output);
  if (!match) return null;
  const behind = count(match[1]);
  const ahead = count(match[2]);
  return behind === null || ahead === null ? null : { ahead, behind };
}

const unknown = (reason) => ({ state: 'unknown', reason });

/**
 * @param {string} folder absolute path of the working folder
 * @param {{ git?: (cwd: string, args: string[]) => Promise<string> }} [options]
 */
async function inspectWorktree(folder, { git = runGit } = {}) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) return unknown('no-folder');
  let status;
  try {
    status = parseStatus(await git(folder, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']));
  } catch {
    return unknown('not-readable');
  }
  let head = null;
  try {
    const text = (await git(folder, ['rev-parse', '--short=12', 'HEAD'])).trim();
    head = SHA.test(text) ? text : null;
  } catch { head = null; }
  let branch = null;
  try {
    const text = (await git(folder, ['symbolic-ref', '--short', '-q', 'HEAD'])).trim();
    branch = /^[^\x00-\x1f\x7f]{1,200}$/.test(text) ? text : null;
  } catch { branch = null; }
  let divergence = null;
  try { divergence = parseDivergence(await git(folder, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'])); } catch { divergence = null; }
  return {
    state: 'known',
    source: 'local git',
    changed: status.changed,
    untracked: status.untracked,
    dirty: status.changed + status.untracked > 0,
    head,
    branch,
    upstream: divergence ? { ahead: divergence.ahead, behind: divergence.behind } : null
  };
}

/** One line for a tooltip. Facts only: counts, with unknown spelled out. */
function describeEvidence(evidence) {
  if (!evidence || evidence.state !== 'known') {
    const why = evidence && evidence.state === 'unknown' ? ({ 'no-folder': 'this session has no working folder', 'not-readable': 'Git could not read the working folder' })[evidence.reason] : null;
    return `Git: unknown${why ? ` (${why})` : ''}`;
  }
  const work = evidence.dirty
    ? `${evidence.changed} changed, ${evidence.untracked} untracked`
    : 'no uncommitted changes';
  const remote = evidence.upstream
    ? `${evidence.upstream.ahead} ahead, ${evidence.upstream.behind} behind its upstream`
    : 'upstream unknown (none set or not readable)';
  return `Git (local, read just now): ${work}; ${remote}${evidence.head ? `; at ${evidence.head}` : ''}`;
}

/**
 * The commit `origin/main` points at in this folder's repository, as LAST FETCHED (this does not contact the remote). A short id only.
 * @returns {Promise<{ state: 'known', head: string } | { state: 'unknown', reason: 'no-folder'|'not-readable' }>}
 */
async function readMainHead(folder, { git = runGit } = {}) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) return unknown('no-folder');
  try {
    const head = String(await git(folder, ['rev-parse', '--verify', '--quiet', '--short=12', 'refs/remotes/origin/main^{commit}'])).trim();
    return SHA.test(head) ? { state: 'known', head } : unknown('not-readable');
  } catch { return unknown('not-readable'); }
}

module.exports = { inspectWorktree, describeEvidence, readMainHead, parseStatus, parseDivergence, TIMEOUT_MS };
