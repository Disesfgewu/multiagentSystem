'use strict';

const fs = require('node:fs');
const nodePath = require('node:path');

function pathFor(platform) {
  return platform === 'win32' ? nodePath.win32 : nodePath.posix;
}

// A path without a drive letter or UNC prefix is "rooted" on Windows but still
// resolves against the current drive, so it is not a stable location.
function isStableAbsolute(p, platform, value) {
  if (!p.isAbsolute(value)) return false;
  if (platform !== 'win32') return true;
  return /^([A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.test(value);
}

function isSameOrInside(p, platform, candidate, parent) {
  const fold = (value) => (platform === 'win32' ? value.toLowerCase() : value);
  const rel = p.relative(fold(parent), fold(candidate));
  if (rel === '') return true;
  if (rel === '..' || rel.startsWith(`..${p.sep}`)) return false;
  return !p.isAbsolute(rel);
}

// Raised when a path cannot be resolved for a reason other than "does not exist
// yet". Only the error code is kept, never the path.
class PathResolutionError extends Error {
  constructor(code) {
    super(`path-unresolvable:${code}`);
    this.code = code;
  }
}

// Follow links through the nearest existing ancestor so a directory that does
// not exist yet cannot hide a link pointing back into the repository. Only
// ENOENT means "not created yet"; every other failure fails closed.
function canonicalize(target, p, realpath) {
  const resolved = p.resolve(target);
  const tail = [];
  let current = resolved;
  for (;;) {
    try {
      const real = realpath(current);
      return tail.length > 0 ? p.join(real, ...tail.reverse()) : real;
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        throw new PathResolutionError(error && error.code ? error.code : 'unknown');
      }
      const parent = p.dirname(current);
      if (parent === current) return resolved;
      tail.push(p.basename(current));
      current = parent;
    }
  }
}

function contextOf(context = {}) {
  return {
    platform: context.platform || process.platform,
    realpath: context.realpath || ((value) => fs.realpathSync.native(value))
  };
}

// Private rules and memory must live outside the repository working tree.
function checkPrivateRoot(dir, repoRoot, context) {
  const { platform, realpath } = contextOf(context);
  const p = pathFor(platform);
  if (typeof dir !== 'string' || !isStableAbsolute(p, platform, dir)) {
    return { ok: false, problems: ['private-root-not-absolute'] };
  }
  const problems = [];
  let target;
  let repo;
  try {
    target = canonicalize(dir, p, realpath);
  } catch (error) {
    if (!(error instanceof PathResolutionError)) throw error;
    problems.push('private-root-unresolvable');
  }
  try {
    repo = canonicalize(repoRoot, p, realpath);
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

module.exports = {
  PathResolutionError,
  canonicalize,
  checkPrivateRoot,
  contextOf,
  isSameOrInside,
  pathFor
};
