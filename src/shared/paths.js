'use strict';

const fs = require('node:fs');
const nodePath = require('node:path');

const pathFor = (platform) => (platform === 'win32' ? nodePath.win32 : nodePath.posix);

// A path without a drive letter or UNC prefix is "rooted" on Windows but still
// resolves against the current drive, so it is not a stable location.
function isStableAbsolute(p, platform, value) {
  if (!p.isAbsolute(value)) return false;
  if (platform !== 'win32') return true;
  return /^([A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.test(value);
}

// Windows and macOS volumes are case-insensitive by default, so two spellings that differ only in case
// are the same folder (and cannot be told apart by realpath while neither exists yet). A case-sensitive
// macOS volume would be treated as having fewer distinct folders: a false conflict, which is the safe way to be wrong.
const foldsCase = (platform) => platform === 'win32' || platform === 'darwin';

function isSameOrInside(p, platform, candidate, parent) {
  const fold = (value) => (foldsCase(platform) ? value.toLowerCase() : value);
  const rel = p.relative(fold(parent), fold(candidate));
  if (rel === '') return true;
  if (rel === '..' || rel.startsWith(`..${p.sep}`)) return false;
  return !p.isAbsolute(rel);
}

// Raised for any resolution failure other than "does not exist yet". Only the
// error code is kept, never the path.
class PathResolutionError extends Error {
  constructor(code) {
    super(`path-unresolvable:${code}`);
    this.code = code;
  }
}

// Follow links through the nearest existing ancestor so a directory that does
// not exist yet cannot hide a link pointing back into the repository. Only
// ENOENT means "not created yet"; every other failure fails closed, and so does
// a walk that reaches the filesystem root without anything existing (for
// example a drive letter that is not mounted), because nothing was verified.
// The nearest existing ancestor must be a directory: Windows reports ENOENT
// for a path below a regular file, which must not pass as "not created yet".
//
// A `..` segment is refused before anything is resolved. `p.resolve` removes it as text, but
// the operating system applies it after following links: `link/..` is the parent of the link's
// target. The check would then see one place while any I/O on the original string lands in
// another, possibly inside the repository.
function canonicalize(target, p, realpath, isDirectory, lstat = (value) => fs.lstatSync(value)) {
  if (typeof target === 'string' && target.split(p === nodePath.win32 ? /[\\/]/ : '/').includes('..')) {
    throw new PathResolutionError('EDOTDOT');
  }
  const resolved = p.resolve(target);
  const tail = [];
  let current = resolved;
  let retriedExisting = false;
  for (;;) {
    try {
      const real = realpath(current);
      if (tail.length > 0) {
        let directory;
        try {
          directory = isDirectory(real);
        } catch (error) {
          throw new PathResolutionError(error && error.code ? error.code : 'unknown');
        }
        if (!directory) throw new PathResolutionError('ENOTDIR');
      }
      return tail.length > 0 ? p.join(real, ...tail.reverse()) : real;
    } catch (error) {
      if (error instanceof PathResolutionError) throw error;
      if (!error || error.code !== 'ENOENT') {
        throw new PathResolutionError(error && error.code ? error.code : 'unknown');
      }
      // A broken link also makes realpath report ENOENT. A regular path can appear
      // between realpath and lstat when another process creates the directory.
      // Retry that case once; keep links and persistent resolution failures closed.
      try {
        const entry = lstat(current);
        if (retriedExisting || !entry || typeof entry.isSymbolicLink !== 'function' || entry.isSymbolicLink()) {
          throw new PathResolutionError('EUNRESOLVED');
        }
        retriedExisting = true;
        continue;
      } catch (probeError) {
        if (probeError instanceof PathResolutionError) throw probeError;
        if (!probeError || probeError.code !== 'ENOENT') {
          throw new PathResolutionError(probeError && probeError.code ? probeError.code : 'unknown');
        }
      }
      const parent = p.dirname(current);
      if (parent === current) throw new PathResolutionError('ENOROOT');
      tail.push(p.basename(current));
      current = parent;
      retriedExisting = false;
    }
  }
}

function resolvers(context = {}) {
  return {
    platform: context.platform || process.platform,
    realpath: context.realpath || ((value) => fs.realpathSync.native(value)),
    isDirectory: context.isDirectory || ((value) => fs.statSync(value).isDirectory()),
    lstat: context.lstat || ((value) => fs.lstatSync(value))
  };
}

// Private data must live outside the repository working tree, and the repository
// must not live inside the data directory.
function checkPrivateRoot(dir, repoRoot, context) {
  const { platform, realpath, isDirectory, lstat } = resolvers(context);
  const p = pathFor(platform);
  if (typeof dir !== 'string' || !isStableAbsolute(p, platform, dir)) {
    return { ok: false, problems: ['private-root-not-absolute'] };
  }
  if (typeof repoRoot !== 'string' || repoRoot === '') {
    return { ok: false, problems: ['repo-root-missing'] };
  }
  const problems = [];
  let target;
  let repo;
  try {
    target = canonicalize(dir, p, realpath, isDirectory, lstat);
  } catch (error) {
    if (!(error instanceof PathResolutionError)) throw error;
    problems.push('private-root-unresolvable');
  }
  try {
    repo = canonicalize(repoRoot, p, realpath, isDirectory, lstat);
  } catch (error) {
    if (!(error instanceof PathResolutionError)) throw error;
    problems.push('repo-root-unresolvable');
  }
  if (target && repo) {
    if (isSameOrInside(p, platform, target, repo)) problems.push('private-root-inside-repo');
    if (isSameOrInside(p, platform, repo, target)) problems.push('private-root-contains-repo');
  }
  return { ok: problems.length === 0, problems };
}

module.exports = { PathResolutionError, canonicalize, checkPrivateRoot, isSameOrInside, isStableAbsolute, pathFor, resolvers };
