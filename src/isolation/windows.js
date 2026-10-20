'use strict';

const path = require('node:path');
const childProcess = require('node:child_process');
const { scrubEnvironment } = require('./environment');

/**
 * The native Windows building blocks for the managed-isolation interface (issue #26; the shared interface is
 * `capabilities.js`). Nothing here isolates anything by itself: `runRestricted` starts one program under the restricted
 * copy of the user's token that the shipped script `resources/isolation/restricted-launch.ps1` makes, and says what
 * happened. The verification harness that tries the bypass channels (synthetic credentials, local stand-in endpoints)
 * is test code: `test/isolation/windows-harness.js`.
 *
 * What the restriction covers and does not cover is written in the script. In short: the user and Administrators SIDs
 * become deny-only, so places whose access list names only them can no longer be opened; the network is NOT blocked.
 * A harness result for a channel the token cannot close is therefore `open`, and the assessment stays advisory.
 *
 * Every failure to launch (no PowerShell, a Win32 error, a bad answer) is an error result, never a pass: the caller
 * treats it as "unknown".
 */

const SCRIPT_RELATIVE = ['resources', 'isolation', 'restricted-launch.ps1'];
const MAX_ARGS = 64;
const MAX_ARG_CHARS = 4096;
const MAX_ENV = 256;
const MAX_STDIN_CHARS = 65536;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 120000;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_()]{0,127}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const win32 = path.win32;

const refuse = (reason) => ({ ok: false, reason });
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Windows PowerShell at its fixed place under the system folder: never found through PATH, where a program could be planted. */
function powershellPath(env = process.env) {
  const root = env && typeof env.SystemRoot === 'string' ? env.SystemRoot : '';
  if (!win32.isAbsolute(root) || CONTROL.test(root) || /(^|[\\/])\.\.?([\\/]|$)/.test(root) || /["<>|*?]/.test(root)) return null;
  return win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** The shipped script, relative to the extension folder (or the repository folder in tests). */
function launchScriptPath(extensionPath) {
  return typeof extensionPath === 'string' && path.isAbsolute(extensionPath) ? path.join(extensionPath, ...SCRIPT_RELATIVE) : null;
}

/** The request the script reads, checked here first so the script only ever receives well-formed data. */
const RESTRICTION_KEYS = ['denyUser', 'denyAdmins', 'dropPrivileges', 'noWindow', 'useJob', 'breakawayOk', 'plainCopy', 'keepDefaultDacl', 'ownerUser', 'restrictingSids'];

function requestFor({ exe, args = [], cwd = '', env = [], stdin = '', timeoutMs = 15000, restriction } = {}) {
  if (typeof exe !== 'string' || !win32.isAbsolute(exe) || exe.length > 520 || CONTROL.test(exe)) return refuse('program-invalid');
  if (!Array.isArray(args) || args.length > MAX_ARGS || args.some((arg) => typeof arg !== 'string' || arg.length > MAX_ARG_CHARS || arg.includes('\u0000'))) return refuse('argument-invalid');
  if (typeof cwd !== 'string' || (cwd !== '' && (!win32.isAbsolute(cwd) || CONTROL.test(cwd)))) return refuse('cwd-invalid');
  if (!Array.isArray(env) || env.length > MAX_ENV) return refuse('environment-invalid');
  for (const pair of env) {
    const at = typeof pair === 'string' ? pair.indexOf('=') : -1;
    if (at < 1 || !ENV_NAME.test(pair.slice(0, at)) || pair.includes('\u0000')) return refuse('environment-invalid');
  }
  if (typeof stdin !== 'string' || stdin.length > MAX_STDIN_CHARS) return refuse('stdin-invalid');
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) return refuse('timeout-invalid');
  if (restriction !== undefined && (!isPlain(restriction) || Object.keys(restriction).some((key) => !RESTRICTION_KEYS.includes(key) || typeof restriction[key] !== 'boolean'))) return refuse('restriction-invalid');
  const json = JSON.stringify({ exe, args, cwd, env, stdin, timeoutMs, ...(restriction ? { restriction } : {}) });
  return { ok: true, encoded: Buffer.from(json, 'utf8').toString('base64') };
}

/** The environment of a restricted program, as `NAME=value` pairs, without anything `scrubEnvironment` removes. */
function environmentPairs(env) {
  return Object.entries(scrubEnvironment(env)).filter(([name, value]) => ENV_NAME.test(name) && !value.includes('\u0000')).map(([name, value]) => `${name}=${value}`);
}

/** Reads the script's one line of JSON. Anything else is an error. */
function parseReply(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length !== 1) return refuse('reply-invalid');
  let reply;
  try { reply = JSON.parse(lines[0]); } catch { return refuse('reply-invalid'); }
  if (!isPlain(reply)) return refuse('reply-invalid');
  if (reply.ok === false) return { ok: false, reason: typeof reply.reason === 'string' && /^[a-z0-9-]{1,64}$/.test(reply.reason) ? reply.reason : 'launch-failed', fromScript: true };
  if (reply.ok !== true || !Number.isSafeInteger(reply.exitCode) || typeof reply.timedOut !== 'boolean' || typeof reply.output !== 'string' || (reply.elevated !== undefined && typeof reply.elevated !== 'boolean')) return refuse('reply-invalid');
  let output;
  try { output = Buffer.from(reply.output, 'base64').toString('utf8'); } catch { return refuse('reply-invalid'); }
  return { ok: true, exitCode: reply.exitCode, timedOut: reply.timedOut, output, ...(reply.elevated === undefined ? {} : { elevated: reply.elevated }) };
}

/**
 * Starts `exe` with `args` under the restricted token and returns what it printed and how it ended.
 * @param {{ exe: string, args?: string[], cwd?: string, env?: string[], stdin?: string, timeoutMs?: number }} request
 * @param {{ script: string, powershell?: string | null, execFile?: Function, platform?: string, signal?: AbortSignal }} options
 * @returns {Promise<{ ok: true, exitCode: number, timedOut: boolean, output: string } | { ok: false, reason: string }>}
 */
function runRestricted(request, { script, powershell = powershellPath(), execFile = childProcess.execFile, platform = process.platform, signal } = {}) {
  if (platform !== 'win32') return Promise.resolve(refuse('platform-not-windows'));
  const made = requestFor(request);
  if (!made.ok) return Promise.resolve(made);
  if (typeof powershell !== 'string' || !win32.isAbsolute(powershell)) return Promise.resolve(refuse('powershell-unavailable'));
  if (typeof script !== 'string' || !win32.isAbsolute(script)) return Promise.resolve(refuse('script-unavailable'));
  return new Promise((resolve) => {
    // Policy for script files is set for this one process only; the script is the file shipped with the extension.
    const argv = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Request', made.encoded];
    const timeout = (request.timeoutMs ?? 15000) + 30000;
    try {
      const child = execFile(powershell, argv, { windowsHide: true, shell: false, timeout, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', signal }, (error, stdout) => {
        const reply = parseReply(stdout);
        // The script exits 3 with a reason on its own failures; a process that could not even start, or timed out, is an error too.
        if (error && reply.fromScript !== true) return resolve(refuse(error.killed ? 'powershell-timeout' : 'powershell-failed'));
        resolve(reply.fromScript === true ? refuse(reply.reason) : reply);
      });
      if (child && child.stdin) child.stdin.end();
    } catch { resolve(refuse('powershell-failed')); }
  });
}

/** Where a person's own GitHub and git credentials live under their user folder on Windows. */
const HOME_CREDENTIAL_PATHS = Object.freeze([
  '.git-credentials', '.config\\git\\credentials', '.config\\gh', 'AppData\\Roaming\\GitHub CLI', '.netrc', '_netrc', '.ssh',
  'AppData\\Local\\Microsoft\\Credentials', 'AppData\\Roaming\\Microsoft\\Credentials', 'AppData\\Local\\Microsoft\\Vault', 'AppData\\Roaming\\Microsoft\\Vault'
]);

function credentialLocations(home) {
  if (typeof home !== 'string' || !win32.isAbsolute(home) || CONTROL.test(home) || home.length > 260) return null;
  return HOME_CREDENTIAL_PATHS.map((relative) => win32.join(home, relative));
}

module.exports = { runRestricted, requestFor, parseReply, environmentPairs, powershellPath, launchScriptPath, credentialLocations, HOME_CREDENTIAL_PATHS, SCRIPT_RELATIVE };
