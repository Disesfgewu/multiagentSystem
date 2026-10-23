'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

/**
 * Pre-trusting the folder an agent starts in (#362). Claude Code and Codex each ask once per folder whether to trust it, and
 * remember the answer in the account's own settings: Claude Code in `<CLAUDE_CONFIG_DIR>/.claude.json`
 * (`projects[<folder>].hasTrustDialogAccepted`), Codex in `<CODEX_HOME>/config.toml` (`[projects."<folder>"]` with
 * `trust_level = "trusted"`). Every agent gets a new worktree, so without this each start stops at that question.
 *
 * Only the one trust entry is written, in one rename of a temporary file, and only over the content it was computed from (see
 * `updateConfig`). Only the one trust entry is written. For Claude Code the file is read as JSON and written back with every other key as it was
 * (the order of keys is kept; the file is re-indented the way Claude Code writes it). For Codex the table is appended and the
 * existing text is not touched. Anything unexpected (a file that cannot be read or parsed, a link, an entry for that folder that
 * already says something else) writes nothing and says why: the CLI then asks as usual.
 *
 * The caller decides which folders may be trusted; this module only writes the record.
 */

const MAX_CONFIG_BYTES = 16 * 1024 * 1024;
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const refuse = (reason) => ({ ok: false, reason });

/** A regular file's text, `null` when it does not exist, or a refusal. Never follows a link. */
function readConfig(file) {
  let info;
  try { info = fs.lstatSync(file); } catch (error) { return error && error.code === 'ENOENT' ? { ok: true, text: null } : refuse('config-unreadable'); }
  if (info.isSymbolicLink() || !info.isFile()) return refuse('config-not-a-file');
  if (info.size > MAX_CONFIG_BYTES) return refuse('config-too-large');
  try { return { ok: true, text: fs.readFileSync(file, 'utf8'), mode: info.mode & 0o777 }; } catch { return refuse('config-unreadable'); }
}

const MAX_ATTEMPTS = 3;

/**
 * Changes a settings file the CLI itself may be writing at the same moment (a running Claude Code rewrites `.claude.json` often).
 * `change(text)` gives the new text, `true` when nothing needs writing, or a refusal. The new text goes to a temporary file in the
 * same folder and replaces the file in one rename, and only when the file still holds exactly what `change` was given: if it was
 * written in between, it is read again and changed again (at most MAX_ATTEMPTS times). After the rename the file is read once more
 * and `verify` must find the change in it; if the CLI wrote over it right away, that is said, never reported as done.
 * `hooks.beforeReplace` lets the tests write to the file at the worst moment.
 * @returns {{ ok: true, changed: boolean } | { ok: false, reason: string }}
 */
function updateConfig(file, change, verify, hooks = {}) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const read = readConfig(file);
    if (!read.ok) return read;
    const next = change(read.text);
    if (next === true) return { ok: true, changed: false };
    if (typeof next !== 'string') return next;
    const temp = `${file}.mas-${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, next, { mode: read.mode ?? 0o600, flag: 'wx' });
      if (read.mode !== undefined && process.platform !== 'win32') fs.chmodSync(temp, read.mode);
      if (typeof hooks.beforeReplace === 'function') hooks.beforeReplace(attempt);
      const now = readConfig(file);
      if (!now.ok) { fs.unlinkSync(temp); return now; }
      if (now.text !== read.text) { fs.unlinkSync(temp); continue; }
      fs.renameSync(temp, file);
    } catch {
      try { fs.unlinkSync(temp); } catch { /* never created or already moved */ }
      return refuse('config-not-written');
    }
    const after = readConfig(file);
    return after.ok && typeof after.text === 'string' && verify(after.text) ? { ok: true, changed: true } : refuse('config-overwritten');
  }
  return refuse('config-busy');
}

/**
 * Claude Code: `projects[folder].hasTrustDialogAccepted = true` in `<configDir>/.claude.json`.
 * @returns {{ ok: true, changed: boolean } | { ok: false, reason: string }}
 */
function trustClaudeFolder({ configDir, folder, hooks }) {
  if (typeof configDir !== 'string' || !path.isAbsolute(configDir)) return refuse('no-account-folder');
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) return refuse('folder-invalid');
  let dir;
  try { dir = fs.lstatSync(configDir); } catch { return refuse('no-account-folder'); }
  if (dir.isSymbolicLink() || !dir.isDirectory()) return refuse('no-account-folder');
  const parse = (text) => {
    if (text === null || text.trim() === '') return {};
    try { const parsed = JSON.parse(text); return isPlain(parsed) ? parsed : null; } catch { return null; }
  };
  const trusted = (config) => isPlain(config.projects) && Object.hasOwn(config.projects, folder) && isPlain(config.projects[folder]) && config.projects[folder].hasTrustDialogAccepted === true;
  return updateConfig(path.join(configDir, '.claude.json'), (text) => {
    const config = parse(text);
    if (!config) return refuse('config-not-json');
    if (config.projects !== undefined && !isPlain(config.projects)) return refuse('config-unexpected-shape');
    const projects = config.projects ?? {};
    const entry = Object.hasOwn(projects, folder) ? projects[folder] : undefined;
    if (entry !== undefined && !isPlain(entry)) return refuse('config-unexpected-shape');
    if (entry && entry.hasTrustDialogAccepted === true) return true;
    return `${JSON.stringify({ ...config, projects: { ...projects, [folder]: { ...(entry ?? {}), hasTrustDialogAccepted: true } } }, null, 2)}\n`;
  }, (text) => { const config = parse(text); return Boolean(config) && trusted(config); }, hooks);
}

/** A TOML basic string for a path: backslashes and quotes escaped, nothing else allowed that would need escaping. */
function tomlString(value) {
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Codex: a `[projects."<folder>"]` table with `trust_level = "trusted"` appended to `<codexHome>/config.toml`.
 * When the file already mentions the folder in any form, nothing is written: it is either trusted already (exactly this table
 * with that line) or the person decided something else, and a second table for the same folder would make the file invalid.
 * @returns {{ ok: true, changed: boolean } | { ok: false, reason: string }}
 */
function trustCodexFolder({ codexHome, folder, hooks }) {
  if (typeof codexHome !== 'string' || !path.isAbsolute(codexHome)) return refuse('no-account-folder');
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) return refuse('folder-invalid');
  const key = tomlString(folder);
  if (!key) return refuse('folder-invalid');
  let dir;
  try { dir = fs.lstatSync(codexHome); } catch { return refuse('no-account-folder'); }
  if (dir.isSymbolicLink() || !dir.isDirectory()) return refuse('no-account-folder');
  const header = `[projects.${key}]`;
  const trustedIn = (text) => {
    const lines = text.split(/\r?\n/);
    const at = lines.findIndex((line) => line.trim() === header);
    if (at < 0) return false;
    for (let index = at + 1; index < lines.length && !/^\s*\[/.test(lines[index]); index += 1) {
      if (/^\s*trust_level\s*=\s*"trusted"\s*(#.*)?$/.test(lines[index])) return true;
    }
    return false;
  };
  return updateConfig(path.join(codexHome, 'config.toml'), (current) => {
    const text = current ?? '';
    if (text.includes(folder) || text.includes(key.slice(1, -1))) return trustedIn(text) ? true : refuse('codex-entry-exists');
    const separator = text === '' || text.endsWith('\n') ? '' : '\n';
    return `${text}${separator}${text === '' ? '' : '\n'}${header}\ntrust_level = "trusted"\n`;
  }, trustedIn, hooks);
}

const REASONS = Object.freeze({
  'turned-off': 'pre-trusting worktrees is off in your settings (multiagentSystem.agents.preTrustManagedWorktrees)',
  'no-consent': 'you have not allowed pre-trusting this project\'s worktrees yet',
  'not-managed': 'the folder is not one of this project\'s managed worktrees',
  'no-account-folder': 'the session has no account folder of its own',
  'folder-invalid': 'the folder path cannot be written to the settings file',
  'config-unreadable': 'the account\'s settings file could not be read',
  'config-not-a-file': 'the account\'s settings file is a link or not a file',
  'config-too-large': 'the account\'s settings file is unusually large',
  'config-not-json': 'the account\'s .claude.json could not be parsed',
  'config-unexpected-shape': 'the account\'s .claude.json does not have the expected shape',
  'config-not-written': 'the account\'s settings file could not be written',
  'config-overwritten': 'the CLI rewrote its settings file right after, without the trust entry',
  'config-busy': 'the CLI kept rewriting its settings file, so it was left alone',
  'codex-entry-exists': 'config.toml already has an entry for this folder that does not say "trusted"'
});

/** The line for the session's details and card. */
function describeTrust(result, cliName) {
  if (!isPlain(result)) return null;
  if (result.ok) return `Folder trust: ${cliName} will not ask to trust this worktree (${result.changed ? 'trust written to the account settings' : 'already trusted'})`;
  return `Folder trust: not pre-written, so ${cliName} asks once (${REASONS[result.reason] ?? result.reason})`;
}

module.exports = { trustClaudeFolder, trustCodexFolder, describeTrust, REASONS, tomlString };
