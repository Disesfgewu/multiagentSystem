import * as fs from 'node:fs';
import * as path from 'node:path';

// The package starts no agent that adds an author line of its own to what it publishes (issue #293). For Claude Code the
// switch is a settings file passed with `--settings <path>` (the CLI accepts a JSON string or a file path). A path, not the
// JSON itself: JSON typed into Windows PowerShell or cmd loses its quotes on the way to the program. The file lives in the
// extension's private storage, so no file of the person's is changed. Whether another provider has an equivalent setting is
// unknown, so nothing is claimed for it: see docs/PROVIDERS.md.
//
// Only one `--settings` is passed. Everything this extension hands to Claude Code through settings goes into that one document:
// the author-line switch above and, for a session with a role group, its permission rules (issue #310). The file is written for
// each session (its name carries the session id), because the permissions differ from one role group to the next, and it is
// removed again when the session ends.

const { claudeSettings } = require('../roles/tool-permissions') as { claudeSettings(input?: { toolPermissions?: Record<string, string> | null }): Record<string, unknown> };

export const CLAUDE_ATTRIBUTION_SETTINGS = '{"attribution":{"commit":"","pr":"","sessionUrl":false}}\n';
const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;
const fileNameFor = (sessionId: string): string => `claude-settings-${sessionId}.json`;
const unavailable = (): Error => Object.assign(new Error('attribution-settings-unavailable'), { code: 'attribution-settings-unavailable' });

/**
 * Writes this session's settings document under `dir` (created private, file 0600) and returns its absolute path. `toolPermissions` is
 * the role group's effective level for each tool, or null for a session without a role group (then there is no `permissions` key and
 * the CLI's own behaviour is untouched). Rewritten at every launch, so an edited copy never survives.
 */
export function writeClaudeSettings(dir: string, sessionId: string, toolPermissions?: Record<string, string> | null): string {
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw unavailable();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, fileNameFor(sessionId));
  fs.writeFileSync(file, `${JSON.stringify(claudeSettings({ toolPermissions: toolPermissions ?? null }), null, 2)}\n`, { mode: 0o600 });
  return file;
}

/** Removes a settings file this module wrote; a file that is already gone is not an error. */
export function removeClaudeSettings(file: string): void {
  try { if (typeof file === 'string' && path.isAbsolute(file) && /claude-settings-[A-Za-z0-9_-]{8,64}\.json$/.test(file)) fs.rmSync(file, { force: true }); } catch { /* nothing more can be done */ }
}

/**
 * The launch arguments that switch off the provider's own attribution, or none for a provider with no known switch.
 * For Claude Code a missing settings file is an error, never a launch without the switch.
 */
export function attributionArguments(provider: string, settingsFile?: string): string[] {
  if (provider !== 'claude') return [];
  if (typeof settingsFile !== 'string' || !path.isAbsolute(settingsFile)) throw unavailable();
  return ['--settings', settingsFile];
}
