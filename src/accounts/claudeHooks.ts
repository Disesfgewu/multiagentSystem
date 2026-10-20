import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isSafePath, writeSettingsAtomic } from './claudeStatusLine';

/**
 * Opt-in bridge from Claude Code's own hooks to the session observation runtime.
 *
 * Claude Code runs the `command` hooks listed under `hooks` in a settings file
 * (https://code.claude.com/docs/en/hooks, "Configuration" and "Hook locations"). This module appends one
 * matcher group per event to the profile's `settings.json` (never a workspace `.claude/` folder and never
 * `settings.local.json`), records exactly what it appended, and removes only entries it can prove it added.
 * The hook-side script is `claudeHookBridge.js`; what it keeps and writes is described there.
 */

/** The hook events whose state the observation layer understands, in the order they are written. */
export const HOOK_BRIDGE_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd'] as const;
export type HookBridgeEvent = typeof HOOK_BRIDGE_EVENTS[number];

export const HOOK_OWNER_FILE_NAME = 'hooks-bridge-owner.json';
/** Seconds, as the documentation defines `timeout`. The script itself gives up on stdin after 3 s. */
const HOOK_TIMEOUT_SECONDS = 5;
const MAX_OWNER_FILE_BYTES = 64 * 1024;
const MAX_COMMAND_LENGTH = 4096;

type Json = Record<string, unknown>;
const isPlain = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Resolves the absolute path to the hook script (source, build output or installed extension). */
export function getHookBridgeScriptPath(extensionPath?: string): string {
  const name = 'claudeHookBridge.js';
  const candidates: string[] = [];
  if (extensionPath) candidates.push(path.join(extensionPath, 'out', 'src', 'accounts', name), path.join(extensionPath, 'src', 'accounts', name));
  candidates.push(path.join(__dirname, name), path.resolve(__dirname, '../../../src/accounts', name));
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? path.join(__dirname, name);
}

/** The shell command written into settings. Throws on a path that could change what the shell runs. */
export function buildHookCommand(scriptPath: string, isWindows: boolean = process.platform === 'win32'): string {
  if (!isSafePath(scriptPath, isWindows)) throw new Error('scriptPath contains unsafe shell characters');
  return isWindows ? `node "${scriptPath}"` : `node '${scriptPath}'`;
}

/**
 * The matcher group appended for one event: no `matcher` (the documentation: omitted matches every
 * occurrence), one `command` handler. SessionEnd carries no `timeout`: the documentation says the
 * session-end budget rises to the largest per-hook `timeout` in the settings files, and this bridge must not
 * change how long the user's own session-end hooks may run.
 */
export function buildHookGroup(event: HookBridgeEvent, command: string): Json {
  const handler: Json = { type: 'command', command };
  if (event !== 'SessionEnd') handler.timeout = HOOK_TIMEOUT_SECONDS;
  return { hooks: [handler] };
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  if (isPlain(left) && isPlain(right)) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
  }
  return false;
}

interface OwnedEntry { event: HookBridgeEvent; group: Json; eventCreated: boolean }
interface OwnerRecord { hooksKeyCreated: boolean; entries: OwnedEntry[] }
type OwnerRead = { state: 'absent' } | { state: 'invalid' } | { state: 'ok'; record: OwnerRecord };

/**
 * The record of what this extension added, kept beside the settings (never inside the user's file). A record
 * that is linked, oversized, unparseable or of another shape is no evidence: callers refuse instead of guessing.
 */
export function readHookOwnerRecord(configDir: string): OwnerRead {
  const file = path.join(configDir, HOOK_OWNER_FILE_NAME);
  let info: fs.Stats;
  try { info = fs.lstatSync(file); } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'absent' } : { state: 'invalid' };
  }
  try {
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_OWNER_FILE_BYTES) return { state: 'invalid' };
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isPlain(parsed) || parsed.schema !== 1 || typeof parsed.hooksKeyCreated !== 'boolean' || !Array.isArray(parsed.entries) || parsed.entries.length > 32) return { state: 'invalid' };
    const entries: OwnedEntry[] = [];
    for (const raw of parsed.entries) {
      if (!isPlain(raw) || !(HOOK_BRIDGE_EVENTS as readonly string[]).includes(raw.event as string) || !isPlain(raw.group) || typeof raw.eventCreated !== 'boolean') return { state: 'invalid' };
      const handlers = raw.group.hooks;
      if (!Array.isArray(handlers) || handlers.length !== 1 || !isPlain(handlers[0]) || typeof handlers[0].command !== 'string' || handlers[0].command.length > MAX_COMMAND_LENGTH) return { state: 'invalid' };
      entries.push({ event: raw.event as HookBridgeEvent, group: raw.group, eventCreated: raw.eventCreated });
    }
    return { state: 'ok', record: { hooksKeyCreated: parsed.hooksKeyCreated, entries } };
  } catch {
    return { state: 'invalid' };
  }
}

/** Writes the owner record atomically; false when it could not be written (an existing link or non-file is never replaced). */
function writeHookOwnerRecord(configDir: string, record: OwnerRecord | null): boolean {
  const file = path.join(configDir, HOOK_OWNER_FILE_NAME);
  let temp: string | undefined;
  try {
    try {
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
    if (record === null) { fs.rmSync(file, { force: true }); return true; }
    temp = `${file}.tmp.${randomUUID()}`;
    fs.writeFileSync(temp, JSON.stringify({ schema: 1, ...record }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
    temp = undefined;
    return true;
  } catch {
    return false;
  } finally {
    if (temp) { try { fs.unlinkSync(temp); } catch { /* already gone */ } }
  }
}

/** Every command string of every handler in a matcher group list. */
function commandsOf(groups: unknown[]): string[] {
  const commands: string[] = [];
  for (const group of groups) {
    if (!isPlain(group) || !Array.isArray(group.hooks)) continue;
    for (const handler of group.hooks) if (isPlain(handler) && typeof handler.command === 'string') commands.push(handler.command);
  }
  return commands;
}

interface LoadedSettings { settings: Json; content: string | null; indent: string | number; trailingNewline: boolean }

function detectIndent(content: string): string | number {
  const match = /^[ \t]+(?=")/m.exec(content);
  if (!match) return 2;
  return match[0].includes('\t') ? '\t' : Math.min(match[0].length, 8);
}

function loadSettings(settingsPath: string): LoadedSettings | { reason: string } {
  let content: string | null = null;
  try {
    const info = fs.statSync(settingsPath);
    if (!info.isFile()) return { reason: 'settings-not-a-file' };
    content = fs.readFileSync(settingsPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { reason: 'settings-unreadable' };
  }
  let settings: Json = {};
  if (content !== null && content.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(content);
      if (!isPlain(parsed)) return { reason: 'settings-invalid-json' };
      settings = parsed;
    } catch {
      return { reason: 'settings-parse-failed' };
    }
  }
  return { settings, content, indent: content ? detectIndent(content) : 2, trailingNewline: content === null || content.trim() === '' || content.endsWith('\n') };
}

const serialize = (loaded: LoadedSettings): string => JSON.stringify(loaded.settings, null, loaded.indent) + (loaded.trailingNewline ? '\n' : '');

/** The `hooks` value, or a reason it cannot be merged into (any other shape means we do not understand the file). */
function hooksOf(settings: Json): Json | undefined | { reason: string } {
  if (settings.hooks === undefined) return undefined;
  if (!isPlain(settings.hooks)) return { reason: 'settings-hooks-invalid' };
  for (const value of Object.values(settings.hooks)) if (!Array.isArray(value)) return { reason: 'settings-hooks-invalid' };
  return settings.hooks;
}

const lastIndexOfGroup = (groups: unknown[], wanted: Json): number => {
  for (let index = groups.length - 1; index >= 0; index -= 1) if (deepEqual(groups[index], wanted)) return index;
  return -1;
};

export interface HookInspection {
  status: 'disabled' | 'active' | 'partial' | 'unreadable';
  settingsPath: string;
  reason?: string;
}

/** `active`: every event has our recorded group for this script; `partial`: some do; `unreadable`: cannot be judged safely. */
export function inspectHookConfig(configDir: string, scriptPath?: string, isWindows: boolean = process.platform === 'win32'): HookInspection {
  const settingsPath = path.join(configDir, 'settings.json');
  const loaded = loadSettings(settingsPath);
  if ('reason' in loaded) return { status: 'unreadable', settingsPath, reason: loaded.reason };
  const hooks = hooksOf(loaded.settings);
  if (hooks && 'reason' in hooks) return { status: 'unreadable', settingsPath, reason: hooks.reason as string };
  const owner = readHookOwnerRecord(configDir);
  if (owner.state === 'invalid') return { status: 'unreadable', settingsPath, reason: 'owner-record-unreadable' };
  if (owner.state === 'absent' || !hooks) return { status: 'disabled', settingsPath };
  let command: string | null = null;
  try { command = buildHookCommand(scriptPath ?? getHookBridgeScriptPath(), isWindows); } catch { /* an unsafe path is never active */ }
  let present = 0;
  for (const event of HOOK_BRIDGE_EVENTS) {
    const entry = owner.record.entries.find((candidate) => candidate.event === event);
    const groups = hooks[event] as unknown[] | undefined;
    if (entry && groups && command !== null && deepEqual(entry.group, buildHookGroup(event, command)) && lastIndexOfGroup(groups, entry.group) >= 0) present += 1;
  }
  if (present === HOOK_BRIDGE_EVENTS.length) return { status: 'active', settingsPath };
  return { status: present > 0 ? 'partial' : 'disabled', settingsPath };
}

export interface HookResult { ok: boolean; reason?: string; changed?: boolean }

/**
 * Appends the bridge's hook entries to the profile's settings.json, leaving every other key and every
 * hook of the user's in place. Refuses (and writes nothing) when settings.json cannot be parsed or has an
 * unexpected `hooks` shape, when the ownership record is unreadable, or when an entry identical to ours is
 * already there without being recorded as ours (it cannot be proven whose it is, and a later removal could
 * take the user's). Entries recorded from an older install (the script has moved) are replaced.
 */
export function enableClaudeHooks(configDir: string, scriptPath: string, isWindows: boolean = process.platform === 'win32'): HookResult {
  try {
    if (!path.isAbsolute(configDir)) return { ok: false, reason: 'config-dir-not-absolute' };
    const settingsPath = path.join(configDir, 'settings.json');
    if (!isSafePath(scriptPath, isWindows) || !isSafePath(settingsPath, isWindows)) return { ok: false, reason: 'unsafe-path-characters' };
    const command = buildHookCommand(scriptPath, isWindows);

    const loaded = loadSettings(settingsPath);
    if ('reason' in loaded) return { ok: false, reason: loaded.reason };
    const existingHooks = hooksOf(loaded.settings);
    if (existingHooks && 'reason' in existingHooks) return { ok: false, reason: existingHooks.reason as string };
    const owner = readHookOwnerRecord(configDir);
    if (owner.state === 'invalid') return { ok: false, reason: 'owner-record-unreadable' };
    const previous: OwnerRecord = owner.state === 'ok' ? owner.record : { hooksKeyCreated: existingHooks === undefined, entries: [] };

    const nextHooks: Json = {};
    for (const [event, groups] of Object.entries(existingHooks ?? {})) nextHooks[event] = [...(groups as unknown[])];
    const entries: OwnedEntry[] = [];
    let changed = false;
    for (const event of HOOK_BRIDGE_EVENTS) {
      const wanted = buildHookGroup(event, command);
      const eventExisted = Object.hasOwn(nextHooks, event);
      let groups = (nextHooks[event] as unknown[] | undefined) ?? [];
      const recorded = previous.entries.find((entry) => entry.event === event);
      const recordedIndex = recorded ? lastIndexOfGroup(groups, recorded.group) : -1;
      if (recorded && recordedIndex >= 0 && deepEqual(recorded.group, wanted)) {
        entries.push(recorded);
        continue;
      }
      // An older recorded group is ours and out of date: it is replaced, not duplicated.
      if (recorded && recordedIndex >= 0) groups = groups.filter((_, index) => index !== recordedIndex);
      // Same command, but nothing proves we added it.
      if (commandsOf(groups).includes(command)) return { ok: false, reason: 'hook-lookalike-not-recorded' };
      nextHooks[event] = [...groups, wanted];
      entries.push({ event, group: wanted, eventCreated: recorded && recordedIndex >= 0 ? recorded.eventCreated : !eventExisted });
      changed = true;
    }
    if (!changed) return { ok: true, changed: false };

    const next: LoadedSettings = { ...loaded, settings: { ...loaded.settings, hooks: nextHooks } };
    // Record what is about to be written BEFORE writing it: a record with no matching entry is harmless,
    // an entry with no record could not be told apart from the user's own.
    if (!writeHookOwnerRecord(configDir, { hooksKeyCreated: previous.hooksKeyCreated, entries })) return { ok: false, reason: 'owner-record-unavailable' };
    fs.mkdirSync(configDir, { recursive: true });
    const written = writeSettingsAtomic(settingsPath, serialize(next), loaded.content);
    if (!written.ok) {
      writeHookOwnerRecord(configDir, owner.state === 'ok' ? owner.record : null);
      return written;
    }
    return { ok: true, changed: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'write-failed' };
  }
}

/**
 * Removes only the entries the ownership record lists, and only where the settings still hold exactly that
 * entry. Anything else, including an entry that merely looks the same, stays. Without a readable record
 * nothing is removed.
 */
export function disableClaudeHooks(configDir: string): HookResult {
  try {
    const settingsPath = path.join(configDir, 'settings.json');
    const owner = readHookOwnerRecord(configDir);
    if (owner.state === 'invalid') return { ok: false, reason: 'owner-record-unreadable' };
    if (owner.state === 'absent') return { ok: false, reason: 'hooks-not-ours' };
    const loaded = loadSettings(settingsPath);
    if ('reason' in loaded) return { ok: false, reason: loaded.reason };
    if (loaded.content === null) { writeHookOwnerRecord(configDir, null); return { ok: true, changed: false }; }
    const existingHooks = hooksOf(loaded.settings);
    if (existingHooks && 'reason' in existingHooks) return { ok: false, reason: existingHooks.reason as string };

    const nextHooks: Json = {};
    for (const [event, groups] of Object.entries(existingHooks ?? {})) nextHooks[event] = [...(groups as unknown[])];
    let removed = 0;
    for (const entry of owner.record.entries) {
      const groups = nextHooks[entry.event] as unknown[] | undefined;
      if (!groups) continue;
      const index = lastIndexOfGroup(groups, entry.group);
      if (index < 0) continue;
      groups.splice(index, 1);
      removed += 1;
      if (groups.length === 0 && entry.eventCreated) delete nextHooks[entry.event];
    }
    if (removed === 0) {
      // Nothing of ours is in the file any more (removed by hand): only the stale record is cleaned up.
      writeHookOwnerRecord(configDir, null);
      return { ok: true, changed: false };
    }
    const settings: Json = { ...loaded.settings };
    if (Object.keys(nextHooks).length === 0 && owner.record.hooksKeyCreated) delete settings.hooks;
    else settings.hooks = nextHooks;
    const written = writeSettingsAtomic(settingsPath, serialize({ ...loaded, settings }), loaded.content);
    if (!written.ok) return written;
    // The entries are gone, so the record of having added them no longer applies.
    writeHookOwnerRecord(configDir, null);
    return { ok: true, changed: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'disable-failed' };
  }
}

export interface HookUi {
  confirmEnable(label: string, settingsPath: string, command: string, events: readonly string[]): Promise<boolean>;
  promptActiveChoice(label: string): Promise<'keep' | 'disable' | undefined>;
  confirmDisable(label: string): Promise<boolean>;
  showInfo(message: string): void;
  showError(message: string): void;
}

export interface ConfigureHooksOptions {
  /** Only honoured by the caller in test mode; this function treats a missing UI as non-interactive. */
  consent?: boolean;
  action?: 'enable' | 'disable';
  extensionPath?: string;
  ui?: HookUi;
}

export interface ConfigureHooksResult { ok: boolean; status: 'enabled' | 'disabled' | 'cancelled' | 'unsupported' | 'failed'; message: string }

/** The wording shown before anything is written; the state comes from the CLI's hooks, not from terminal text. */
export function describeHookEnable(label: string): string {
  return `Multiagent will add hook commands to the Claude Code settings.json of “${label}”. Each command receives Claude Code's own hook event on stdin. It keeps only the CLI session id and the event name (UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop, SessionEnd) in a small local file for a Multiagent-managed terminal, and never stores prompts, tool input, the transcript path or the working directory. The Overview then shows working, waiting or ended while that evidence is fresh, and unknown otherwise. This state comes from the CLI's own hooks, not from reading terminal text. Your existing hooks and settings are kept; only the entries added here are removed when you disable this.`;
}

/**
 * Opt-in setup for the Claude hook bridge. Claude only. Without a UI it acts only with `consent: true`
 * (the command layer passes consent only in extension test mode).
 */
export async function configureHooksWizard(
  profile: { id: string; provider: string; label: string; configDir: string },
  options: ConfigureHooksOptions = {}
): Promise<ConfigureHooksResult> {
  if (profile.provider !== 'claude') {
    const message = `The hook bridge is only available for Claude Code accounts. ${profile.provider} has no verified hook event source here; its session state remains unknown.`;
    options.ui?.showInfo(message);
    return { ok: false, status: 'unsupported', message };
  }
  const scriptPath = getHookBridgeScriptPath(options.extensionPath);
  const inspection = inspectHookConfig(profile.configDir, scriptPath);
  if (inspection.status === 'unreadable') {
    const message = `Could not safely read the hook settings for “${profile.label}” (${inspection.reason}). Nothing was changed.`;
    options.ui?.showError(message);
    return { ok: false, status: 'failed', message };
  }
  let command: string;
  try { command = buildHookCommand(scriptPath); } catch {
    const message = 'Could not safely configure the hook bridge: the script path contains unsafe shell characters.';
    options.ui?.showError(message);
    return { ok: false, status: 'failed', message };
  }

  const ui = options.ui;
  if (!ui) {
    if (options.consent !== true) return { ok: false, status: 'cancelled', message: 'User consent was not granted.' };
    if (options.action === 'disable') {
      const outcome = disableClaudeHooks(profile.configDir);
      return outcome.ok ? { ok: true, status: 'disabled', message: `Hook bridge was removed from “${profile.label}”.` } : { ok: false, status: 'failed', message: outcome.reason ?? 'Failed to disable.' };
    }
    const outcome = enableClaudeHooks(profile.configDir, scriptPath);
    return outcome.ok ? { ok: true, status: 'enabled', message: `Hook bridge was enabled for “${profile.label}”.` } : { ok: false, status: 'failed', message: outcome.reason ?? 'Failed to enable.' };
  }

  if (inspection.status === 'active') {
    const choice = await ui.promptActiveChoice(profile.label);
    if (choice !== 'disable') return { ok: true, status: 'enabled', message: 'Hook bridge remains active.' };
    if (!(await ui.confirmDisable(profile.label))) return { ok: false, status: 'cancelled', message: 'Removal cancelled.' };
    const outcome = disableClaudeHooks(profile.configDir);
    if (outcome.ok) { ui.showInfo(`Hook bridge was removed from “${profile.label}”. Your own hooks were not touched.`); return { ok: true, status: 'disabled', message: 'Hook bridge removed.' }; }
    ui.showError(`Could not remove the hook bridge: ${outcome.reason}`);
    return { ok: false, status: 'failed', message: outcome.reason ?? 'Failed' };
  }

  if (!(await ui.confirmEnable(profile.label, inspection.settingsPath, command, HOOK_BRIDGE_EVENTS))) {
    ui.showInfo('Hook bridge setup was cancelled. No changes were made.');
    return { ok: false, status: 'cancelled', message: 'User cancelled.' };
  }
  const result = enableClaudeHooks(profile.configDir, scriptPath);
  if (result.ok) {
    ui.showInfo(`Hook bridge enabled for “${profile.label}”. Start a session from Multiagent to see its state.`);
    return { ok: true, status: 'enabled', message: 'Hook bridge enabled.' };
  }
  ui.showError(`Could not update settings.json: ${result.reason}`);
  return { ok: false, status: 'failed', message: result.reason ?? 'Failed' };
}
