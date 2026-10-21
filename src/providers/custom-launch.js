'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { scrubEnvironment } = require('../isolation/environment');

/**
 * Starting a custom provider's program in a native terminal (issue #59). What runs is decided in three steps that do not
 * trust the repository: the program NAME comes from the person's own user settings (`custom-providers.js`), the name is
 * turned into an absolute path here, and the person confirms that exact path and its arguments the first time.
 *
 * The real path comes from the operating system's own canonical form (`realpathSync.native`), which on Windows also expands
 * short 8.3 names and fixes the case of the drive letter and folders.
 *
 * Resolving the name:
 *   - only absolute PATH entries count (an empty or relative entry can mean the current folder);
 *   - a PATH entry, or a resolved file, inside an open workspace folder or the working folder is never used, so a
 *     repository cannot supply a same-named program. BOTH sides are compared in both spellings: each forbidden folder as
 *     given and after `realpath`, each PATH folder as given and after `realpath`, and each program after `realpath`. A
 *     workspace opened through a link (or under `/tmp`, which is `/private/tmp` on macOS, or by a short Windows name) is
 *     the same folder as its real one, and a program reached through a link is the program it points at;
 *   - on Windows only `.exe` and `.com` are accepted: a `.cmd` or `.bat` file is read by a command interpreter, whose
 *     rules for quoting arguments are not the ones used here.
 *
 * Nothing here starts anything: `planCustomLaunch` returns what would be started and what the person must be asked.
 * Every refusal is a short code.
 */

const WINDOWS_EXTENSIONS = Object.freeze(['.exe', '.com']);
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const refuse = (reason) => ({ ok: false, reason });

const fold = (value, platform) => (platform === 'win32' ? value.toLowerCase() : value);

/** Whether `target` is `folder` itself or inside it. Both must already be absolute. */
function isInside(target, folder, platform) {
  const flavour = platform === 'win32' ? path.win32 : path.posix;
  const relative = flavour.relative(fold(folder, platform), fold(target, platform));
  return relative === '' || (!relative.startsWith('..') && !flavour.isAbsolute(relative));
}

/**
 * @param {string} name a plain program name
 * @param {{ env?: object, platform?: string, forbiddenFolders?: string[], realpath?: Function, stat?: Function, access?: Function }} [options]
 *   `forbiddenFolders`: absolute folders no program may come from (the open workspace folders and the working folder).
 * @returns {{ ok: true, executable: string } | { ok: false, reason: string }}
 */
function resolveCustomExecutable(name, { env = process.env, platform = process.platform, forbiddenFolders = [], realpath = fs.realpathSync.native, stat = fs.statSync, access = fs.accessSync } = {}) {
  if (typeof name !== 'string' || !NAME.test(name)) return refuse('executable-name-invalid');
  const flavour = platform === 'win32' ? path.win32 : path.posix;
  const pathKey = env && typeof env === 'object' ? Object.keys(env).find((key) => key.toLowerCase() === 'path') : undefined;
  const rawPath = pathKey === undefined ? undefined : env[pathKey];
  if (typeof rawPath !== 'string') return refuse('path-unavailable');
  // Each forbidden folder as it was given and as it really is; a folder that cannot be resolved is only compared as given.
  const forbidden = [];
  for (const folder of Array.isArray(forbiddenFolders) ? forbiddenFolders : []) {
    if (typeof folder !== 'string' || !flavour.isAbsolute(folder)) continue;
    forbidden.push(folder);
    try { const real = realpath(folder); if (typeof real === 'string' && flavour.isAbsolute(real)) forbidden.push(real); } catch { /* compared as given */ }
  }
  const insideForbiddenFolder = (target) => forbidden.some((folder) => isInside(target, folder, platform));
  const spellings = (directory) => {
    const list = [directory];
    try { const real = realpath(directory); if (typeof real === 'string' && flavour.isAbsolute(real)) list.push(real); } catch { /* as given only */ }
    return list;
  };
  const suffixes = platform === 'win32' ? WINDOWS_EXTENSIONS : [''];
  let scriptSeen = false;
  let insideForbidden = false;
  for (const directory of rawPath.split(flavour.delimiter)) {
    if (!flavour.isAbsolute(directory)) continue;
    if (spellings(directory).some(insideForbiddenFolder)) {
      // Skipped. It only matters to the answer if the program really is there, so the person is told why it was not used.
      for (const suffix of suffixes) { try { if (stat(flavour.join(directory, `${name}${suffix}`)).isFile()) insideForbidden = true; } catch { /* not here */ } }
      continue;
    }
    for (const suffix of suffixes) {
      const candidate = flavour.join(directory, `${name}${suffix}`);
      let real;
      try {
        if (!stat(candidate).isFile()) continue;
        access(candidate, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
        real = realpath(candidate);
      } catch { continue; }
      if (typeof real !== 'string' || !flavour.isAbsolute(real)) continue;
      // A link out of a system folder into the repository is the same as a program in the repository.
      if (insideForbiddenFolder(real)) { insideForbidden = true; continue; }
      return { ok: true, executable: real };
    }
    if (platform === 'win32') {
      for (const script of ['.cmd', '.bat']) {
        try { if (stat(flavour.join(directory, `${name}${script}`)).isFile()) scriptSeen = true; } catch { /* none here */ }
      }
    }
  }
  if (scriptSeen) return refuse('script-not-supported');
  return refuse(insideForbidden ? 'executable-only-in-workspace' : 'executable-not-found');
}

/** A short fingerprint of what a confirmation covered: the provider id, the program as resolved, and the arguments. */
function confirmationKey({ id, executable, args }) {
  return createHash('sha256').update(JSON.stringify([String(id), String(executable), Array.isArray(args) ? args.map(String) : []])).digest('hex').slice(0, 32);
}

/** `env` for the editor's terminal: every variable `scrubEnvironment` would remove is set to null (unset), nothing else is changed. */
function terminalEnvironment(parentEnv = process.env) {
  const kept = scrubEnvironment(parentEnv);
  const env = {};
  for (const name of Object.keys(parentEnv ?? {})) if (typeof parentEnv[name] === 'string' && !Object.hasOwn(kept, name)) env[name] = null;
  return env;
}

/**
 * What starting provider `id` would do, and what the person has to be asked first.
 * @param {{ providers: Array<{ id: string, label: string, executable: string, args: string[] }>, id: unknown, trusted: boolean, cwd: unknown, folders?: string[], confirmed?: string[] }} input
 * @param {object} [options] passed to `resolveCustomExecutable` (`env`, `platform`, …)
 * @returns {{ ok: true, label: string, key: string, needsConfirmation: boolean, detail: string, launch: { shellPath: string, shellArgs: string[], cwd: string, env: object } } | { ok: false, reason: string }}
 */
function planCustomLaunch({ providers, id, trusted, cwd, folders = [], confirmed = [] }, options = {}) {
  // Nothing starts in a workspace the person has not trusted: a repository chooses what that workspace contains.
  if (trusted !== true) return refuse('workspace-untrusted');
  const provider = Array.isArray(providers) ? providers.find((entry) => entry && entry.id === id) : undefined;
  if (!provider || typeof id !== 'string') return refuse('provider-not-found');
  const platform = options.platform ?? process.platform;
  const flavour = platform === 'win32' ? path.win32 : path.posix;
  if (typeof cwd !== 'string' || !flavour.isAbsolute(cwd)) return refuse('folder-required');
  const resolved = resolveCustomExecutable(provider.executable, { ...options, forbiddenFolders: [cwd, ...(Array.isArray(folders) ? folders : [])] });
  if (!resolved.ok) return resolved;
  const key = confirmationKey({ id: provider.id, executable: resolved.executable, args: provider.args });
  const detail = [
    `Program: ${resolved.executable}`,
    `Arguments: ${JSON.stringify(provider.args)}`,
    `Folder: ${cwd}`,
    'This provider is one you listed in your own user settings. Nothing about it is verified: not its sign-in, usage, model or what it does with its rules; it only gets a terminal.',
    'GitHub credentials are removed from its environment.'
  ].join('\n');
  return {
    ok: true,
    label: provider.label,
    key,
    needsConfirmation: !(Array.isArray(confirmed) && confirmed.includes(key)),
    detail,
    launch: { shellPath: resolved.executable, shellArgs: [...provider.args], cwd, env: terminalEnvironment(options.env ?? process.env) }
  };
}

module.exports = { resolveCustomExecutable, planCustomLaunch, confirmationKey, terminalEnvironment, isInside, WINDOWS_EXTENSIONS };
