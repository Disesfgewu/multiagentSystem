'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const { safeArgs } = require('./gitSafe');

class WorktreeError extends Error {
  constructor(code, cause) {
    super(code, { cause });
    this.name = 'WorktreeError';
    this.code = code;
  }
}

async function git(cwd, args) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const overrides = new Set(['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']);
  for (const key of Object.keys(env)) {
    if (overrides.has(key.toUpperCase())) delete env[key];
  }
  try {
    const { stdout } = await exec('git', args, { cwd, env, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch (cause) {
    throw new WorktreeError('git-command-failed', cause);
  }
}

const line = value => value.replace(/\r?\n$/, '');
const MAX_CHANGED_FILES = 5000;

function githubRepository(remote) {
  if (typeof remote !== 'string') return null;
  let ownerAndRepo;
  const scp = /^git@github\.com:([^\s]+)$/i.exec(remote);
  if (scp) {
    ownerAndRepo = scp[1];
  } else {
    try {
      const url = new URL(remote);
      if (url.hostname.toLowerCase() !== 'github.com' || !['https:', 'ssh:'].includes(url.protocol)) return null;
      ownerAndRepo = url.pathname.replace(/^\//, '');
    } catch { return null; }
  }
  const match = /^([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)$/.exec(ownerAndRepo.replace(/\.git$/, ''));
  return match ? `github.com/${match[1]}/${match[2]}`.toLowerCase() : null;
}

// -z preserves spaces, Unicode and literal newlines in worktree paths.
function parseWorktrees(output) {
  return output.split('\0\0').filter(Boolean).map(record => {
    const item = { path: null, headSha: null, branch: null, detached: false, bare: false, locked: false, prunable: false };
    for (const field of record.split('\0').filter(Boolean)) {
      const split = field.indexOf(' ');
      const key = split < 0 ? field : field.slice(0, split);
      const value = split < 0 ? '' : field.slice(split + 1);
      if (key === 'worktree') item.path = value;
      else if (key === 'HEAD') item.headSha = value;
      else if (key === 'branch') item.branch = value.replace(/^refs\/heads\//, '');
      else if (key === 'detached' || key === 'bare' || key === 'locked' || key === 'prunable') item[key] = true;
    }
    if (!item.path) throw new WorktreeError('worktree-output-invalid');
    return item;
  });
}

async function canonicalFuturePath(target) {
  if (typeof target !== 'string' || !path.isAbsolute(target) || target.includes('\0')) {
    throw new WorktreeError('path-must-be-absolute');
  }
  let cursor = path.resolve(target);
  const missing = [];
  for (;;) {
    try {
      const canonical = await fs.realpath(cursor);
      if (!(await fs.stat(canonical)).isDirectory()) throw new WorktreeError('path-unverifiable');
      return path.join(canonical, ...missing.reverse());
    }
    catch (cause) {
      if (cause.code !== 'ENOENT') throw new WorktreeError('path-unverifiable', cause);
      try {
        await fs.lstat(cursor);
        throw new WorktreeError('path-unverifiable'); // Existing dangling link cannot be resolved safely.
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new WorktreeError('path-unverifiable', cause);
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

function contains(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

class WorktreeService {
  constructor(root, commonDir, repository) {
    this.root = root;
    this.commonDir = commonDir;
    this.githubRepository = repository;
  }

  static async open(directory) {
    const cwd = await canonicalFuturePath(directory);
    const root = await fs.realpath(line(await git(cwd, ['rev-parse', '--show-toplevel'])));
    const common = line(await git(root, ['rev-parse', '--git-common-dir']));
    const commonDir = await fs.realpath(path.resolve(root, common));
    let repository = null;
    try { repository = githubRepository(line(await git(root, ['remote', 'get-url', 'origin']))); }
    catch (error) {
      // Missing origin is valid for a local project; other Git failures remain errors.
      if (error.cause?.code !== 2) throw error;
    }
    return new WorktreeService(root, commonDir, repository);
  }

  async list() {
    return parseWorktrees(await git(this.root, ['worktree', 'list', '--porcelain', '-z']));
  }

  /**
   * The files this worktree changes compared to where it branched from the primary worktree's checkout:
   * committed work, staged and unstaged edits of tracked files, and untracked files that are not ignored.
   * Read-only and non-interfering (no index lock, no configured file monitor). Repository-relative names
   * only. `truncated` means the list was cut at the limit, so the caller must not read it as complete.
   */
  async changedFiles(target, { limit = MAX_CHANGED_FILES } = {}) {
    const destination = await canonicalFuturePath(target);
    const worktrees = await this.list();
    const selected = [];
    for (const item of worktrees) {
      const existing = await canonicalFuturePath(item.path);
      if (contains(existing, destination) && contains(destination, existing)) selected.push(item);
    }
    if (selected.length !== 1) throw new WorktreeError('worktree-not-found');
    const safe = await safeArgs((probe) => git(selected[0].path, probe));
    // Compared with the project's integration branch, never with whatever the primary worktree happens to have
    // checked out (it may be on another branch, detached, or a bare repository without a checkout at all).
    const integration = await this.#integrationCommit(selected[0].path, safe);
    const base = line(await git(selected[0].path, [...safe, 'merge-base', integration, 'HEAD']));
    if (!/^[a-f0-9]{40,64}$/.test(base)) throw new WorktreeError('base-invalid');
    const tracked = await git(selected[0].path, [...safe, 'diff', '--name-only', '-z', '--no-renames', base, '--']);
    const untracked = await git(selected[0].path, [...safe, 'ls-files', '--others', '--exclude-standard', '-z']);
    const files = new Set([...tracked.split('\0'), ...untracked.split('\0')].filter(Boolean));
    const list = [...files].sort();
    return { files: list.slice(0, limit), truncated: list.length > limit };
  }

  /**
   * The commit of the integration branch: the remote's default branch if the repository knows it
   * (refs/remotes/origin/HEAD), otherwise a local `main`, otherwise `master`. If none of them exists there is no
   * stated integration branch and nothing is guessed: the caller gets `base-invalid` and reports the worktree as unread.
   */
  async #integrationCommit(cwd, safe) {
    const candidates = [];
    try {
      const ref = line(await git(cwd, [...safe, 'symbolic-ref', '-q', 'refs/remotes/origin/HEAD']));
      if (/^refs\/remotes\/origin\/[A-Za-z0-9._\/-]{1,200}$/.test(ref)) candidates.push(ref);
    } catch { /* no remote default branch is recorded */ }
    candidates.push('refs/heads/main', 'refs/heads/master');
    for (const ref of candidates) {
      try {
        const commit = line(await git(cwd, [...safe, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]));
        if (/^[a-f0-9]{40,64}$/.test(commit)) return commit;
      } catch { /* this candidate does not exist */ }
    }
    throw new WorktreeError('base-invalid');
  }

  async create({ branch, target, base = 'HEAD' }) {
    if (typeof branch !== 'string' || branch.startsWith('-') || /[\x00-\x1f]/.test(branch)) {
      throw new WorktreeError('branch-invalid');
    }
    await git(this.root, ['check-ref-format', `refs/heads/${branch}`]);
    if (typeof base !== 'string' || !base || base.startsWith('-') || /[\x00-\x1f]/.test(base)) {
      throw new WorktreeError('base-invalid');
    }
    const destination = await canonicalFuturePath(target);
    for (const worktree of await this.list()) {
      const existing = await canonicalFuturePath(worktree.path);
      if (contains(existing, destination) || contains(destination, existing)) {
        throw new WorktreeError('worktree-path-overlap');
      }
    }
    if (contains(this.commonDir, destination) || contains(destination, this.commonDir)) {
      throw new WorktreeError('worktree-path-overlap');
    }
    const commit = line(await git(this.root, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]));
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new WorktreeError('base-invalid');
    await git(this.root, ['worktree', 'add', '-b', branch, '--', destination, commit]);
    return (await this.list()).find(item => item.branch === branch);
  }

  async remove(target) {
    const destination = await canonicalFuturePath(target);
    const worktrees = await this.list();
    let selected;
    for (let i = 0; i < worktrees.length; i++) {
      const existing = await canonicalFuturePath(worktrees[i].path);
      if (contains(existing, destination) && contains(destination, existing)) {
        if (i === 0) throw new WorktreeError('primary-worktree-protected');
        selected = worktrees[i];
        break;
      }
    }
    if (!selected) throw new WorktreeError('worktree-not-found');
    if (contains(this.root, destination) && contains(destination, this.root)) {
      throw new WorktreeError('current-worktree-protected');
    }
    if (selected.locked) throw new WorktreeError('worktree-locked');
    if (selected.prunable) throw new WorktreeError('worktree-unavailable');
    const safe = await safeArgs((probe) => git(selected.path, probe));
    const status = await git(selected.path, [...safe, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching']);
    if (status !== '') throw new WorktreeError('worktree-has-local-files');
    // Git checks tracked/untracked changes again. Never use --force, clean or reset.
    await git(this.root, ['worktree', 'remove', '--', selected.path]);
    return { removed: true, branch: selected.branch };
  }
}

module.exports = { WorktreeService, WorktreeError, githubRepository, parseWorktrees };
