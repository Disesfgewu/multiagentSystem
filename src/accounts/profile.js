'use strict';

const fs = require('node:fs');
const nodePath = require('node:path');
const os = require('node:os');
const { pathFor, isStableAbsolute, isSameOrInside, PathResolutionError, canonicalize } = require('../shared/paths');

// Variables that make a CLI use a credential other than the login stored in the
// profile's own config directory. Claude Code list follows the documented
// precedence; the `claude auth status` effect of most of them was observed.
const PROVIDERS = Object.freeze({
  claude: Object.freeze({
    configEnvVar: 'CLAUDE_CONFIG_DIR',
    defaultDirName: '.claude',
    credentialOverrideVars: Object.freeze([
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
      'ANTHROPIC_PROFILE',
      'ANTHROPIC_FEDERATION_RULE_ID',
      'ANTHROPIC_ORGANIZATION_ID'
    ])
  }),
  codex: Object.freeze({
    configEnvVar: 'CODEX_HOME',
    defaultDirName: '.codex',
    credentialOverrideVars: Object.freeze(['OPENAI_API_KEY', 'CODEX_API_KEY'])
  })
});

function defaultContext(context) {
  return {
    platform: process.platform,
    homeDir: os.homedir(),
    realpath: (value) => fs.realpathSync.native(value),
    isDirectory: (value) => fs.statSync(value).isDirectory(),
    lstat: (value) => fs.lstatSync(value),
    stat: (value) => fs.statSync(value),
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    ...context
  };
}

// `mode` is passed to isSameOrInside: conservative for "might these collide" checks that refuse a
// folder, nothing for "is this really that folder" identity checks.
function samePath(p, platform, left, right, mode) {
  return isSameOrInside(p, platform, left, right, mode) && isSameOrInside(p, platform, right, left, mode);
}

const CONSERVATIVE = Object.freeze({ conservative: true });

// true / false when both sides resolve, null when either cannot be resolved.
function sameDirectory(a, b, context) {
  const ctx = defaultContext(context);
  const p = pathFor(ctx.platform);
  try {
    return samePath(p, ctx.platform, canonicalize(a, p, ctx.realpath, ctx.isDirectory, ctx.lstat), canonicalize(b, p, ctx.realpath, ctx.isDirectory, ctx.lstat));
  } catch (error) {
    if (error instanceof PathResolutionError) return null;
    throw error;
  }
}

function tryCanonicalize(target, p, realpath, isDirectory, lstat) {
  try {
    return { value: canonicalize(target, p, realpath, isDirectory, lstat) };
  } catch (error) {
    if (error instanceof PathResolutionError) return { code: error.code };
    throw error;
  }
}

function canonicalProfileConfigDir(configDir, context) {
  const ctx = defaultContext(context);
  const p = pathFor(ctx.platform);
  return canonicalize(configDir, p, ctx.realpath, ctx.isDirectory, ctx.lstat);
}

function normalizeProfileConfigDir(configDir, context) {
  const ctx = defaultContext(context);
  const p = pathFor(ctx.platform);
  if (typeof configDir !== 'string' || configDir.split(ctx.platform === 'win32' ? /[\\/]/ : '/').includes('..')) {
    throw new PathResolutionError('EDOTDOT');
  }
  return p.resolve(configDir);
}

function existingConfigDirProblem(configDir, ctx) {
  try {
    ctx.lstat(configDir);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    return 'config-dir-unresolvable';
  }
  let stat;
  try {
    stat = ctx.stat(configDir);
  } catch {
    return 'config-dir-unresolvable';
  }
  if (!stat.isDirectory()) return 'config-dir-not-directory';
  if (ctx.platform !== 'win32' && Number.isInteger(ctx.uid) && stat.uid !== ctx.uid) return 'config-dir-owner-mismatch';
  return null;
}

function validateProfile(profile, context) {
  const ctx = defaultContext(context);
  const p = pathFor(ctx.platform);
  const problems = [];

  if (!profile || typeof profile.id !== 'string' || profile.id.trim() === '') {
    problems.push('profile-id-missing');
  }
  if (!profile || !Object.hasOwn(PROVIDERS, profile.provider)) {
    problems.push('provider-unsupported');
    return { ok: false, problems };
  }
  if (typeof profile.label !== 'string' || profile.label.trim() === '') {
    problems.push('label-missing');
  }
  if (typeof profile.configDir !== 'string' || !isStableAbsolute(p, ctx.platform, profile.configDir)) {
    problems.push('config-dir-not-absolute');
    return { ok: false, problems };
  }

  const dir = tryCanonicalize(profile.configDir, p, ctx.realpath, ctx.isDirectory, ctx.lstat);
  const repo = tryCanonicalize(ctx.repoRoot, p, ctx.realpath, ctx.isDirectory, ctx.lstat);
  const providerDefault = tryCanonicalize(
    p.join(ctx.homeDir, PROVIDERS[profile.provider].defaultDirName),
    p,
    ctx.realpath,
    ctx.isDirectory,
    ctx.lstat
  );
  if (dir.code) problems.push('config-dir-unresolvable');
  if (repo.code) problems.push('repo-root-unresolvable');
  if (providerDefault.code) problems.push('provider-default-unresolvable');
  if (dir.value) {
    const existing = existingConfigDirProblem(profile.configDir, ctx);
    if (existing) problems.push(existing);
  }

  if (dir.value && repo.value) {
    if (isSameOrInside(p, ctx.platform, dir.value, repo.value, CONSERVATIVE)) problems.push('config-dir-inside-repo');
    if (isSameOrInside(p, ctx.platform, repo.value, dir.value, CONSERVATIVE)) problems.push('config-dir-contains-repo');
  }
  // The default folder the tool uses outside this extension: not the folder itself, and not a folder
  // inside it (the unmanaged account's own tree would then hold this account). A folder that merely
  // contains it is the home folder or one of its parents, which have their own checks.
  if (dir.value && providerDefault.value && isSameOrInside(p, ctx.platform, dir.value, providerDefault.value, CONSERVATIVE)) {
    problems.push('config-dir-is-provider-default');
  }
  if (dir.value) {
    // The home folder holds everything a person owns; it is never an account folder.
    const home = tryCanonicalize(ctx.homeDir, p, ctx.realpath, ctx.isDirectory, ctx.lstat);
    if (home.value && samePath(p, ctx.platform, dir.value, home.value, CONSERVATIVE)) problems.push('config-dir-is-home');
  }

  return { ok: problems.length === 0, problems };
}

// Two profiles must never read or write the same configuration tree. A profile
// whose directory cannot be resolved is reported instead of being skipped.
function findConfigDirConflicts(profiles, context) {
  const ctx = defaultContext(context);
  const p = pathFor(ctx.platform);
  const conflicts = [];
  const dirs = [];
  for (const profile of profiles) {
    const resolved = tryCanonicalize(profile.configDir, p, ctx.realpath, ctx.isDirectory, ctx.lstat);
    if (resolved.code) conflicts.push({ a: profile.id, b: null, kind: 'unresolvable' });
    else dirs.push({ id: profile.id, dir: resolved.value });
  }
  for (let i = 0; i < dirs.length; i += 1) {
    for (let j = i + 1; j < dirs.length; j += 1) {
      const a = dirs[i];
      const b = dirs[j];
      if (samePath(p, ctx.platform, a.dir, b.dir, CONSERVATIVE)) {
        conflicts.push({ a: a.id, b: b.id, kind: 'same' });
      } else if (isSameOrInside(p, ctx.platform, a.dir, b.dir, CONSERVATIVE) ||
                 isSameOrInside(p, ctx.platform, b.dir, a.dir, CONSERVATIVE)) {
        conflicts.push({ a: a.id, b: b.id, kind: 'nested' });
      }
    }
  }
  return conflicts;
}

function findEnvKey(env, name, platform) {
  if (platform !== 'win32') return Object.hasOwn(env, name) ? name : undefined;
  const wanted = name.toUpperCase();
  return Object.keys(env).find((key) => key.toUpperCase() === wanted);
}

// Build the environment for a managed launch. Inherited credential overrides are
// reported as blockers (names only, never values) so the caller can refuse to
// start instead of silently running under a different account.
function buildLaunchEnv(profile, baseEnv, context) {
  const ctx = defaultContext(context);
  const env = { ...baseEnv };
  const blockers = [];
  const spec = profile && PROVIDERS[profile.provider];
  if (!spec) {
    return { env, blockers: [{ code: 'config-dir-rejected' }] };
  }
  let configDir;
  try {
    configDir = canonicalProfileConfigDir(profile.configDir, ctx);
  } catch (error) {
    if (!(error instanceof PathResolutionError)) throw error;
    return { env, blockers: [{ code: 'config-dir-rejected' }] };
  }
  if (!validateProfile(profile, ctx).ok) {
    return { env, blockers: [{ code: 'config-dir-rejected' }] };
  }

  for (const name of spec.credentialOverrideVars) {
    const key = findEnvKey(env, name, ctx.platform);
    if (key !== undefined && env[key] !== undefined && env[key] !== '') {
      blockers.push({ code: 'credential-override-inherited', variable: name });
    }
  }

  const existing = findEnvKey(env, spec.configEnvVar, ctx.platform);
  if (existing !== undefined && existing !== spec.configEnvVar) delete env[existing];
  env[spec.configEnvVar] = configDir;

  return { env, blockers };
}

module.exports = {
  PROVIDERS,
  sameDirectory,
  validateProfile,
  findConfigDirConflicts,
  buildLaunchEnv,
  canonicalProfileConfigDir,
  normalizeProfileConfigDir
};
