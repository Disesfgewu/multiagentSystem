'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Connecting an agent's Claude Code to this VS Code window (#354). Claude Code finds its IDE through lock files
 * (`~/.claude/ide/<port>.lock`, and `<CLAUDE_CONFIG_DIR>/ide/<port>.lock` when that is set): a lock counts when the terminal's
 * `CLAUDE_CODE_SSE_PORT` is its port, or when the CLI's folder is one of the lock's `workspaceFolders`. An agent runs in a worktree
 * that is usually not one of the window's folders, so only the port can connect it, and the port the VS Code Claude Code extension
 * gives its own terminals does not reach the terminals this extension starts. This module picks the port of THIS window's lock.
 *
 * From a lock file only two things are taken: the port (its file name) and `workspaceFolders`. The `authToken` it holds is never
 * returned, logged, shown or passed on; the CLI reads it from the file itself. A lock whose process is gone is left out (a VS Code
 * that crashed leaves its lock behind). When no single lock belongs to this window, the reason is given and no port is guessed.
 */

const LOCK = /^([1-9][0-9]{0,4})\.lock$/;
const MAX_LOCK_BYTES = 64 * 1024;
const MAX_LOCKS = 64;
const REASONS = Object.freeze({
  'no-ide-folder': 'no VS Code window has registered with Claude Code (no ide lock folder): install or enable the Claude Code extension for VS Code, then reopen the session',
  'no-lock': 'no VS Code window has registered with Claude Code (no lock file): install or enable the Claude Code extension for VS Code, then reopen the session',
  'no-match': 'no registered VS Code window has this project\'s folder open: open this project in VS Code with the Claude Code extension enabled, then reopen the session',
  ambiguous: 'more than one running VS Code window has this project\'s folder open, so which one to connect to cannot be told: close the other windows, then reopen the session',
  'no-workspace': 'this window has no folder open, so its lock cannot be found'
});

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The folders a path is compared by: resolved, without a trailing separator, without case where the file system ignores it. */
function folderKey(value, platform) {
  if (typeof value !== 'string' || value === '') return null;
  const resolved = path.resolve(value).replace(/[\\/]+$/, '');
  return platform === 'win32' || platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return Boolean(error && error.code === 'EPERM'); }
}

/** What one lock file says, reduced to its port, folders and process; null when it cannot be read. */
function readLock(file, { readFile = fs.readFileSync, statFile = fs.statSync } = {}) {
  const match = LOCK.exec(path.basename(file));
  if (!match || Number(match[1]) > 65535) return null;
  try {
    const stat = statFile(file);
    if (!stat.isFile() || stat.size > MAX_LOCK_BYTES) return null;
    const parsed = JSON.parse(readFile(file, 'utf8'));
    if (!isPlain(parsed) || !Array.isArray(parsed.workspaceFolders)) return null;
    // Only these leave this function: the port, the folders and the process id. Nothing else of the parsed lock is kept.
    return { port: Number(match[1]), workspaceFolders: parsed.workspaceFolders.filter((folder) => typeof folder === 'string').slice(0, 50), pid: Number.isSafeInteger(parsed.pid) ? parsed.pid : null };
  } catch { return null; }
}

/** The lock folders Claude Code itself reads for an account folder (`configDir`, may be absent). */
function lockFolders({ configDir, home = os.homedir() } = {}) {
  const folders = [path.join(home, '.claude', 'ide')];
  if (typeof configDir === 'string' && configDir !== '') folders.push(path.join(configDir, 'ide'));
  return [...new Set(folders.map((folder) => path.resolve(folder)))];
}

/**
 * The port of this window's lock.
 * @param {{ folders: string[], workspaceFolders: string[], platform?: string, alive?: (pid: number) => boolean, readDir?: Function, readFile?: Function, statFile?: Function }} input
 * @returns {{ ok: true, port: number } | { ok: false, reason: string, text: string }}
 */
function findIdePort({ folders, workspaceFolders, platform = process.platform, alive = processAlive, readDir = fs.readdirSync, readFile, statFile } = {}) {
  const refuse = (reason) => ({ ok: false, reason, text: REASONS[reason] });
  const mine = new Set((Array.isArray(workspaceFolders) ? workspaceFolders : []).map((folder) => folderKey(folder, platform)).filter(Boolean));
  if (mine.size === 0) return refuse('no-workspace');
  let sawFolder = false;
  const locks = [];
  for (const folder of Array.isArray(folders) ? folders : []) {
    let names;
    try { names = readDir(folder); sawFolder = true; } catch { continue; }
    // Only lock files count towards the limit, so other files in the folder cannot push this window's lock out.
    for (const name of names.map(String).filter((entry) => LOCK.test(entry)).slice(0, MAX_LOCKS)) {
      const lock = readLock(path.join(folder, String(name)), { ...(readFile ? { readFile } : {}), ...(statFile ? { statFile } : {}) });
      if (lock) locks.push(lock);
    }
  }
  if (!sawFolder) return refuse('no-ide-folder');
  if (locks.length === 0) return refuse('no-lock');
  const matching = locks.filter((lock) => lock.workspaceFolders.some((folder) => mine.has(folderKey(folder, platform))));
  // A lock whose VS Code is gone says nothing about this window.
  const running = matching.filter((lock) => lock.pid === null || alive(lock.pid));
  const ports = [...new Set(running.map((lock) => lock.port))];
  if (ports.length === 0) return refuse('no-match');
  if (ports.length > 1) return refuse('ambiguous');
  return { ok: true, port: ports[0] };
}

/** The line for the session's details and card. */
function describeIde(result) {
  if (!isPlain(result)) return 'VS Code: not connected (not checked for this session)';
  return result.ok ? `VS Code: connected through this window's Claude Code port (${result.port})` : `VS Code: not connected (${result.text ?? result.reason})`;
}

module.exports = { findIdePort, lockFolders, readLock, describeIde, REASONS };
