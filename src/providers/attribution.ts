import * as fs from 'node:fs';
import * as path from 'node:path';

// The package starts no agent that adds an author line of its own to what it publishes (issue #293). For Claude Code the
// switch is a settings file passed with `--settings <path>` (the CLI accepts a JSON string or a file path). A path, not the
// JSON itself: JSON typed into Windows PowerShell or cmd loses its quotes on the way to the program. The file lives in the
// extension's private storage, so no file of the person's is changed. Whether another provider has an equivalent setting is
// unknown, so nothing is claimed for it: see docs/PROVIDERS.md.
//
// Only one `--settings` is passed. If another feature ever needs to pass settings too, the two must be merged into this one
// file; two flags are not known to combine.

export const CLAUDE_ATTRIBUTION_SETTINGS = '{"attribution":{"commit":"","pr":"","sessionUrl":false}}\n';
const FILE_NAME = 'claude-attribution-settings.json';

/** Writes the settings file under `dir` (created private) and returns its absolute path. Rewritten on every launch, so an edited copy never survives. */
export function writeAttributionSettings(dir: string): string {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw Object.assign(new Error('attribution-settings-unavailable'), { code: 'attribution-settings-unavailable' });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, FILE_NAME);
  fs.writeFileSync(file, CLAUDE_ATTRIBUTION_SETTINGS, { mode: 0o600 });
  return file;
}

/**
 * The launch arguments that switch off the provider's own attribution, or none for a provider with no known switch.
 * For Claude Code a missing settings file is an error, never a launch without the switch.
 */
export function attributionArguments(provider: string, settingsFile?: string): string[] {
  if (provider !== 'claude') return [];
  if (typeof settingsFile !== 'string' || !path.isAbsolute(settingsFile)) throw Object.assign(new Error('attribution-settings-unavailable'), { code: 'attribution-settings-unavailable' });
  return ['--settings', settingsFile];
}
