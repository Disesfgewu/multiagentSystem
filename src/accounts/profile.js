'use strict';

const fs = require('node:fs');
const nodePath = require('node:path');
const os = require('node:os');

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

function pathFor(platform) {
  return platform === 'win32' ? nodePath.win32 : nodePath.posix;
}

// On Windows a path such as \temp\x is "rooted" but has no drive, so it resolves
// against whichever drive is current. Only drive-letter and UNC paths are stable.
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

// Resolve symlinks on the nearest existing ancestor so a not-yet-created
// config directory cannot hide a link that points back into the repository.
function canonicalize(target, p, realpath) {
  const resolved = p.resolve(target);
  const tail = [];
  let current = resolved;
  for (;;) {
    try {
      const real = realpath(current);
      return tail.length > 0 ? p.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = p.dirname(current);
      if (parent === current) return resolved;
      tail.push(p.basename(current));
      current = parent;
    }
  }
}

function defaultContext(context) {
  return {
    platform: process.platform,
    homeDir: os.homedir(),
    realpath: (value) => fs.realpathSync.native(value),
    ...context
  };
}

function sameDirectory(a, b, context) {
  const ctx = defaultContext(context);
  const p = pathFor(ctx.platform);
  const left = canonicalize(a, p, ctx.realpath);
  const right = canonicalize(b, p, ctx.realpath);
  return isSameOrInside(p, ctx.platform, left, right) &&
    isSameOrInside(p, ctx.platform, right, left);
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

  const dir = canonicalize(profile.configDir, p, ctx.realpath);
  const repo = canonicalize(ctx.repoRoot, p, ctx.realpath);
  const providerDefault = canonicalize(
    p.join(ctx.homeDir, PROVIDERS[profile.provider].defaultDirName),
    p,
    ctx.realpath
  );

  if (isSameOrInside(p, ctx.platform, dir, repo)) problems.push('config-dir-inside-repo');
  if (isSameOrInside(p, ctx.platform, repo, dir)) problems.push('config-dir-contains-repo');
  if (sameDirectory(dir, providerDefault, ctx)) problems.push('config-dir-is-provider-default');

  return { ok: problems.length === 0, problems };
}

// Two profiles must never read or write the same configuration tree.
function findConfigDirConflicts(profiles, context) {
  const ctx = defaultContext(context);
  const p = pathFor(ctx.platform);
  const dirs = profiles.map((profile) => ({
    id: profile.id,
    dir: canonicalize(profile.configDir, p, ctx.realpath)
  }));
  const conflicts = [];
  for (let i = 0; i < dirs.length; i += 1) {
    for (let j = i + 1; j < dirs.length; j += 1) {
      const a = dirs[i];
      const b = dirs[j];
      if (sameDirectory(a.dir, b.dir, ctx)) {
        conflicts.push({ a: a.id, b: b.id, kind: 'same' });
      } else if (isSameOrInside(p, ctx.platform, a.dir, b.dir) ||
                 isSameOrInside(p, ctx.platform, b.dir, a.dir)) {
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
  const spec = PROVIDERS[profile.provider];
  const env = { ...baseEnv };
  const blockers = [];

  for (const name of spec.credentialOverrideVars) {
    const key = findEnvKey(env, name, ctx.platform);
    if (key !== undefined && env[key] !== undefined && env[key] !== '') {
      blockers.push({ code: 'credential-override-inherited', variable: name });
    }
  }

  const existing = findEnvKey(env, spec.configEnvVar, ctx.platform);
  if (existing !== undefined && existing !== spec.configEnvVar) delete env[existing];
  env[spec.configEnvVar] = profile.configDir;

  return { env, blockers };
}

module.exports = {
  PROVIDERS,
  sameDirectory,
  validateProfile,
  findConfigDirConflicts,
  buildLaunchEnv
};
