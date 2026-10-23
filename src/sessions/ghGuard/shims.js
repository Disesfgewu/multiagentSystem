'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { SHIM_MARKER, realGhUsable } = require('./run');

/**
 * The per-session `gh` shims (issue #342): a folder that goes first on the agent terminal's PATH and holds
 *   - `gh`: a sh script, for macOS and Linux shells and for Git Bash on Windows (which is how Claude Code runs commands there);
 *   - `gh.ps1` on Windows: for PowerShell. The terminal is given `PSExecutionPolicyPreference=RemoteSigned`, which applies to that
 *     process only and changes no user or machine policy. If PowerShell still refuses the script, gh does not run at all.
 * There is no `gh.cmd`: cmd.exe would read the arguments again (`%*`), and text such as `a&calc` would run as a command. cmd.exe
 * itself is not wrapped; it only starts the CLI, whose own Git Bash or PowerShell finds these shims.
 *
 * Each shim runs `run.js` with the codename and the real gh written into it, so changing an environment variable in the terminal
 * does not change them. The extension's own runtime (`process.execPath` with ELECTRON_RUN_AS_NODE) runs it; nothing is installed.
 */

const CODENAME = /^(?:PM|[A-Z][a-z]{1,19})-[0-9]{2,4}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const fail = (reason) => ({ ok: false, reason });
// Paths are judged by the rules of the platform the shims are for.
const absolute = (value, platform) => (platform === 'win32' ? path.win32 : path.posix).isAbsolute(value);

const quoteSh = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
// PowerShell treats the typographic single quotes like the ASCII one, so all of them are doubled.
const quotePs = (value) => `'${String(value).replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&')}'`;
// Git Bash reads a Windows path with forward slashes as it is; backslashes would be escapes.
const forSh = (value, platform) => (platform === 'win32' ? String(value).replace(/\\/g, '/') : String(value));

/**
 * The first `gh` on `pathValue` that is a real program and not a shim, skipping the shim folder itself. Null when there is none:
 * the shim then refuses every call.
 */
function findRealGh({ pathValue, platform = process.platform, skip } = {}) {
  const name = platform === 'win32' ? 'gh.exe' : 'gh';
  const delimiter = platform === 'win32' ? ';' : ':';
  const skipped = skip ? path.resolve(skip) : null;
  for (const dir of String(pathValue ?? '').split(delimiter)) {
    if (!dir || !path.isAbsolute(dir) || CONTROL.test(dir)) continue;
    if (skipped && path.resolve(dir) === skipped) continue;
    const candidate = path.join(dir, name);
    if (realGhUsable(candidate)) return candidate;
  }
  return null;
}

/** The text of the shims, or why they cannot be written. `realGh` null makes shims that refuse everything. */
function shimTexts({ node, script, codename, realGh, platform = process.platform }) {
  const values = [node, script, ...(realGh ? [realGh] : [])];
  if (values.some((value) => typeof value !== 'string' || !absolute(value, platform) || CONTROL.test(value))) return fail('path-invalid');
  if (codename !== null && (typeof codename !== 'string' || !CODENAME.test(codename))) return fail('codename-invalid');
  const own = ['--mas-codename', codename ?? 'none', '--mas-real', realGh ?? 'none', '--'];
  const sh = [
    '#!/bin/sh',
    `# ${SHIM_MARKER} for one agent session (issue #342). Written by the extension; removed when the session ends.`,
    // No path conversion by Git Bash: the body text must reach gh exactly as typed.
    `MSYS2_ARG_CONV_EXCL='*' MSYS_NO_PATHCONV=1 ELECTRON_RUN_AS_NODE=1 exec ${quoteSh(forSh(node, platform))} ${quoteSh(forSh(script, platform))} ${own.map((part) => quoteSh(part === realGh ? forSh(part, platform) : part)).join(' ')} "$@"`,
    ''
  ].join('\n');
  const ps1 = [
    `# ${SHIM_MARKER} for one agent session (issue #342). Written by the extension; removed when the session ends.`,
    '$previous = $env:ELECTRON_RUN_AS_NODE',
    "$env:ELECTRON_RUN_AS_NODE = '1'",
    `try { & ${quotePs(node)} ${quotePs(script)} ${own.map(quotePs).join(' ')} @args } finally { $env:ELECTRON_RUN_AS_NODE = $previous }`,
    'exit $LASTEXITCODE',
    ''
  ].join('\r\n');
  return { ok: true, files: platform === 'win32' ? { gh: sh, 'gh.ps1': ps1 } : { gh: sh } };
}

/** Writes the shims into `dir` (made fresh, owner only). */
function writeShims({ dir, node, script, codename, realGh, platform = process.platform }) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || CONTROL.test(dir)) return fail('path-invalid');
  const texts = shimTexts({ node, script, codename, realGh, platform });
  if (!texts.ok) return texts;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const [name, text] of Object.entries(texts.files)) fs.writeFileSync(path.join(dir, name), text, { mode: name === 'gh' ? 0o700 : 0o600, flag: 'wx' });
  } catch { return fail('write-failed'); }
  return { ok: true, dir };
}

/**
 * What the agent's terminal is given at creation: on Windows the process-only script policy, nothing else. PATH is NOT set here:
 * a PATH in the terminal's options would replace the person's own `terminal.integrated.env.*` setting, and a login shell's profile
 * reorders it anyway. The shim folder is put first on PATH by the typed launch command instead (`formatPathPrefix`).
 */
function shimEnvironment({ platform = process.platform } = {}) {
  return platform === 'win32' ? { PSExecutionPolicyPreference: 'RemoteSigned' } : {};
}

function removeShims(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); return true; } catch { return false; }
}

module.exports = { findRealGh, shimTexts, writeShims, shimEnvironment, removeShims };
