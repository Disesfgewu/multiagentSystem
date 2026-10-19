import * as fs from 'node:fs';
import * as path from 'node:path';

const { claudeQuotaFromStatusLine } = require('./observation') as {
  claudeQuotaFromStatusLine(payload: unknown, options: { profileId: string; observedAt: Date | string }): {
    profileId: string;
    observations: unknown[];
  };
};

export const STATUSLINE_QUOTA_FILE_NAME = 'statusline-quota.json';

/**
 * Resolves the absolute path to the bridge script.
 * Supports running from source (`src/`), build output (`out/src/`), or an installed extension path.
 */
export function getBridgeScriptPath(extensionPath?: string): string {
  if (extensionPath) {
    const candidateOut = path.join(extensionPath, 'out', 'src', 'accounts', 'claudeStatusLineBridge.js');
    if (fs.existsSync(candidateOut)) return candidateOut;
    const candidateSrc = path.join(extensionPath, 'src', 'accounts', 'claudeStatusLineBridge.js');
    if (fs.existsSync(candidateSrc)) return candidateSrc;
  }
  const localBridge = path.join(__dirname, 'claudeStatusLineBridge.js');
  if (fs.existsSync(localBridge)) return localBridge;
  const srcBridge = path.resolve(__dirname, '../../../src/accounts/claudeStatusLineBridge.js');
  if (fs.existsSync(srcBridge)) return srcBridge;
  return localBridge;
}

/**
 * Checks whether a path contains only safe characters, preventing shell command injection.
 * Disallows quotes, backticks, dollar signs, shell operators, and control characters.
 */
export function isSafePath(p: string, isWindows: boolean = process.platform === 'win32'): boolean {
  if (typeof p !== 'string' || p.trim().length === 0) return false;
  const unsafe = isWindows
    ? /["'`$()&;<>|*?%!\n\r\t\x00-\x1f\x7f]/
    : /["'`$()&;<>|*?%!\n\r\t\x00-\x1f\x7f\\]/;
  return !unsafe.test(p);
}

/**
 * Builds the shell command string to execute the bridge script via Node.
 * Uses single quotes on POSIX and double quotes on Windows.
 * Throws an Error if either path contains unsafe shell characters.
 */
export function buildBridgeCommand(bridgeScriptPath: string, quotaFilePath: string, isWindows: boolean = process.platform === 'win32'): string {
  if (!isSafePath(bridgeScriptPath, isWindows)) {
    throw new Error('bridgeScriptPath contains unsafe shell characters');
  }
  if (!isSafePath(quotaFilePath, isWindows)) {
    throw new Error('quotaFilePath contains unsafe shell characters');
  }
  if (isWindows) {
    return `node "${bridgeScriptPath}" "${quotaFilePath}"`;
  }
  return `node '${bridgeScriptPath}' '${quotaFilePath}'`;
}

/**
 * Checks whether a statusLine setting belongs to our bridge script.
 */
export function isBridgeCommand(statusLine: unknown, bridgeScriptPath?: string, quotaPath?: string): boolean {
  let command: string | undefined;
  if (typeof statusLine === 'string') {
    command = statusLine;
  } else if (statusLine && typeof statusLine === 'object' && 'command' in statusLine && typeof (statusLine as { command: unknown }).command === 'string') {
    command = (statusLine as { command: string }).command;
  }
  if (!command) return false;
  if (!quotaPath) return false;
  try {
    return command === buildBridgeCommand(bridgeScriptPath ?? getBridgeScriptPath(), quotaPath);
  } catch { return false; }
}

/**
 * Writes `text` to a settings file without replacing a symlink, without losing a concurrent edit and
 * without widening its permissions. A symlinked file (dotfiles managers do this) is updated at its
 * target. `expected` is the content the caller read and based its change on (null when there was no
 * file); if the file now differs, nothing is written, because the change was computed from stale data
 * and would silently discard someone else's edit.
 */
export function writeSettingsAtomic(settingsPath: string, text: string, expected: string | null): { ok: boolean; reason?: string } {
  let temp: string | undefined;
  try {
    let target = settingsPath;
    let link: fs.Stats | undefined;
    try { link = fs.lstatSync(settingsPath); } catch { link = undefined; }
    if (link?.isSymbolicLink()) {
      try { target = fs.realpathSync(settingsPath); } catch { return { ok: false, reason: 'settings-symlink-unresolvable' }; }
    }
    let current: string | null = null;
    try {
      const stat = fs.statSync(target);
      if (!stat.isFile()) return { ok: false, reason: 'settings-not-a-file' };
      current = fs.readFileSync(target, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (current !== expected) return { ok: false, reason: 'settings-changed' };
    temp = `${target}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, target);
    temp = undefined;
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'write-failed' };
  } finally {
    if (temp) { try { fs.unlinkSync(temp); } catch { /* already gone */ } }
  }
}

const OWNER_FILE_NAME = 'statusline-bridge-owner.json';
const MAX_OWNED_COMMANDS = 10;
const MAX_OWNER_FILE_BYTES = 64 * 1024;

/**
 * The exact statusLine commands this extension has written into this profile's settings, kept in a small
 * file beside the quota file (never in the user's settings). A command's shape cannot prove who wrote it:
 * a user's own script may share the file name and the quota destination. Only a command this extension is
 * recorded as having written counts as its own after the script has moved. An unreadable, oversized, linked
 * or malformed record is no evidence at all.
 */
export function readOwnedBridgeCommands(configDir: string): Set<string> {
  const owned = new Set<string>();
  try {
    const file = path.join(configDir, OWNER_FILE_NAME);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_OWNER_FILE_BYTES) return owned;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || parsed.schema !== 1 || !Array.isArray(parsed.commands)) return owned;
    for (const command of parsed.commands.slice(-MAX_OWNED_COMMANDS)) {
      if (typeof command === 'string' && command.length > 0 && command.length <= 4096) owned.add(command);
    }
  } catch { /* no usable record: no evidence */ }
  return owned;
}

function recordOwnedBridgeCommand(configDir: string, command: string): boolean {
  let temp: string | undefined;
  try {
    const file = path.join(configDir, OWNER_FILE_NAME);
    let existing: string[] = [];
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
      existing = [...readOwnedBridgeCommands(configDir)];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
    const commands = [...existing.filter((entry) => entry !== command), command].slice(-MAX_OWNED_COMMANDS);
    temp = `${file}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(temp, JSON.stringify({ schema: 1, commands }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
    temp = undefined;
    return true;
  } catch {
    return false;
  } finally {
    if (temp) { try { fs.unlinkSync(temp); } catch { /* already gone */ } }
  }
}

/**
 * True only for a bridge command this extension is recorded as having written earlier and whose script
 * has since moved (an extension upgrade installs into a new versioned folder). The record is the proof;
 * the shape check on top only confirms it still points at this profile's own quota file.
 */
export function isStaleBridgeCommand(statusLine: unknown, quotaPath: string, isWindows: boolean = process.platform === 'win32', owned: ReadonlySet<string> = new Set()): boolean {
  let command: string | undefined;
  if (typeof statusLine === 'string') command = statusLine;
  else if (statusLine && typeof statusLine === 'object' && typeof (statusLine as { command?: unknown }).command === 'string') command = (statusLine as { command: string }).command;
  if (!command || !owned.has(command) || !isSafePath(quotaPath, isWindows)) return false;
  const quote = isWindows ? '"' : "'";
  const prefix = `node ${quote}`;
  const suffix = `${quote} ${quote}${quotaPath}${quote}`;
  if (!command.startsWith(prefix) || !command.endsWith(suffix)) return false;
  const script = command.slice(prefix.length, command.length - suffix.length);
  if (!isSafePath(script, isWindows)) return false;
  return /(^|[\\/])claudeStatusLineBridge\.js$/.test(script);
}

export interface StatusLineInspection {
  status: 'disabled' | 'active' | 'custom' | 'unreadable';
  currentCommand?: string;
  settingsPath: string;
  existingSettings?: Record<string, unknown>;
  quotaPath: string;
  hasQuotaFile: boolean;
}

/**
 * Inspects a Claude profile configuration directory for existing `settings.json` and statusLine configuration.
 */
export function inspectStatusLineConfig(configDir: string, bridgeScriptPath?: string): StatusLineInspection {
  const settingsPath = path.join(configDir, 'settings.json');
  const quotaPath = path.join(configDir, STATUSLINE_QUOTA_FILE_NAME);
  const hasQuotaFile = fs.existsSync(quotaPath);

  if (!fs.existsSync(settingsPath)) {
    return {
      status: 'disabled',
      settingsPath,
      existingSettings: {},
      quotaPath,
      hasQuotaFile
    };
  }

  let content: string;
  try {
    content = fs.readFileSync(settingsPath, 'utf8');
  } catch {
    return {
      status: 'unreadable',
      settingsPath,
      quotaPath,
      hasQuotaFile
    };
  }

  if (!content.trim()) {
    return {
      status: 'disabled',
      settingsPath,
      existingSettings: {},
      quotaPath,
      hasQuotaFile
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { status: 'unreadable', settingsPath, quotaPath, hasQuotaFile };
    }
  } catch {
    return { status: 'unreadable', settingsPath, quotaPath, hasQuotaFile };
  }

  const statusLine = parsed.statusLine;
  if (!statusLine) {
    return {
      status: 'disabled',
      settingsPath,
      existingSettings: parsed,
      quotaPath,
      hasQuotaFile
    };
  }

  let command: string | undefined;
  if (typeof statusLine === 'string') {
    command = statusLine;
  } else if (typeof statusLine === 'object' && statusLine !== null && 'command' in statusLine && typeof (statusLine as { command: unknown }).command === 'string') {
    command = (statusLine as { command: string }).command;
  }

  const isActive = isBridgeCommand(statusLine, bridgeScriptPath, quotaPath);

  return {
    status: isActive ? 'active' : 'custom',
    currentCommand: command,
    settingsPath,
    existingSettings: parsed,
    quotaPath,
    hasQuotaFile
  };
}

/**
 * Enables the status line bridge in `settings.json` for a Claude profile directory.
 * Preserves all other user settings in `settings.json`.
 * Backs up any existing custom statusLine so it can be restored when the bridge is disabled.
 */
export function enableStatusLineBridge(configDir: string, bridgeScriptPath: string, isWindows: boolean = process.platform === 'win32'): { ok: boolean; reason?: string } {
  try {
    const quotaPath = path.join(configDir, STATUSLINE_QUOTA_FILE_NAME);
    if (!isSafePath(bridgeScriptPath, isWindows) || !isSafePath(quotaPath, isWindows)) {
      return { ok: false, reason: 'unsafe-path-characters' };
    }

    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    const settingsPath = path.join(configDir, 'settings.json');
    let settings: Record<string, unknown> = {};
    let originalContent: string | null = null;

    if (fs.existsSync(settingsPath)) {
      const content = fs.readFileSync(settingsPath, 'utf8');
      originalContent = content;
      if (content.trim()) {
        try {
          const parsed = JSON.parse(content);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            settings = parsed;
          } else {
            return { ok: false, reason: 'settings-invalid-json' };
          }
        } catch {
          return { ok: false, reason: 'settings-parse-failed' };
        }
      }
    }

    const command = buildBridgeCommand(bridgeScriptPath, quotaPath, isWindows);

    // If an existing statusLine is present and not our bridge, back it up so disable can restore it
    // A bridge command left by an older install is ours, not the user's: backing it up would replace the
    // real original with a dead command and lose it for good.
    const owned = readOwnedBridgeCommands(configDir);
    if (settings.statusLine !== undefined
      && !isBridgeCommand(settings.statusLine, bridgeScriptPath, quotaPath)
      && !isStaleBridgeCommand(settings.statusLine, quotaPath, isWindows, owned)) {
      // Not provably ours, so it is the user's own and must be kept. An earlier backup is never replaced:
      // overwriting it would destroy the only copy of the user's original command.
      if (settings._multiagentStatusLineBackup !== undefined) return { ok: false, reason: 'statusline-backup-exists' };
      settings._multiagentStatusLineBackup = settings.statusLine;
    }

    settings.statusLine = {
      type: 'command',
      command
    };

    // Record what is about to be written BEFORE writing it: a record with no matching setting is harmless,
    // a setting with no record could not be recognised as ours after an upgrade.
    if (!recordOwnedBridgeCommand(configDir, command)) return { ok: false, reason: 'owner-record-unavailable' };
    return writeSettingsAtomic(settingsPath, JSON.stringify(settings, null, 2), originalContent);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'write-failed' };
  }
}

/**
 * Disables the status line bridge by removing or restoring `statusLine` in `settings.json`.
 * Only touches `settings.json` if `statusLine` is verified to be our bridge script.
 * Restores any previous custom statusLine backup. Also deletes the local quota file if present.
 */
export function disableStatusLineBridge(configDir: string, bridgeScriptPath?: string): { ok: boolean; reason?: string } {
  try {
    const settingsPath = path.join(configDir, 'settings.json');
    if (!fs.existsSync(settingsPath)) {
      return { ok: false, reason: 'statusline-not-our-bridge' };
    }
    const content = fs.readFileSync(settingsPath, 'utf8');
    if (!content.trim()) {
      return { ok: false, reason: 'statusline-not-our-bridge' };
    }
    let settings: Record<string, unknown>;
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        settings = parsed;
      } else {
        return { ok: false, reason: 'settings-invalid-json' };
      }
    } catch {
      return { ok: false, reason: 'settings-parse-failed' };
    }

    // Refuse to touch settings if statusLine is not our bridge command
    const ownQuotaPath = path.join(configDir, STATUSLINE_QUOTA_FILE_NAME);
    if (!isBridgeCommand(settings.statusLine, bridgeScriptPath, ownQuotaPath) && !isStaleBridgeCommand(settings.statusLine, ownQuotaPath, process.platform === 'win32', readOwnedBridgeCommands(configDir))) {
      return { ok: false, reason: 'statusline-not-our-bridge' };
    }

    if (settings._multiagentStatusLineBackup !== undefined) {
      settings.statusLine = settings._multiagentStatusLineBackup;
      delete settings._multiagentStatusLineBackup;
    } else {
      delete settings.statusLine;
    }

    const written = writeSettingsAtomic(settingsPath, JSON.stringify(settings, null, 2), content);
    if (!written.ok) return written;

    // The bridge is gone from the settings, so the record of what was written no longer applies.
    try { fs.unlinkSync(path.join(configDir, OWNER_FILE_NAME)); } catch { /* absent or already gone */ }

    const quotaPath = path.join(configDir, STATUSLINE_QUOTA_FILE_NAME);
    if (fs.existsSync(quotaPath)) {
      try {
        fs.unlinkSync(quotaPath);
      } catch {
        // Ignored
      }
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'disable-failed' };
  }
}

/**
 * Reads raw quota JSON payload written by the bridge script.
 */
export function readClaudeQuotaFile(configDir: string): { observedAt?: string; rate_limits?: unknown; model?: string } | null {
  try {
    const quotaPath = path.join(configDir, STATUSLINE_QUOTA_FILE_NAME);
    if (!fs.existsSync(quotaPath)) return null;
    const content = fs.readFileSync(quotaPath, 'utf8');
    if (!content.trim()) return null;
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Reads quota observations for a Claude account profile.
 * - If no file exists: returns [] (observations unknown).
 * - If rate_limits is null (non Pro/Max or no session response): returns observations with value null and honest reason.
 * - If valid rate_limits: returns observations with actual percent and reset time.
 */
export function readClaudeQuotaObservations(profileId: string, configDir: string, now: Date = new Date()): unknown[] {
  const fileData = readClaudeQuotaFile(configDir);
  if (!fileData) return [];

  // A missing or malformed timestamp cannot turn an old file into a fresh reading.
  if (typeof fileData.observedAt !== 'string') return [];
  const observedAt = new Date(fileData.observedAt);
  if (!Number.isFinite(observedAt.getTime()) || observedAt.getTime() > now.getTime()) return [];

  const result = claudeQuotaFromStatusLine({ rate_limits: fileData.rate_limits }, {
    profileId,
    observedAt
  });
  return result.observations;
}

const profileInfoCache = new Map<string, { provider: string; configDir: string }>();

/** Caches profile provider and configDir for quota observation lookups. */
export function registerProfileForQuota(profile: { id: string; provider: string; configDir: string }): void {
  profileInfoCache.set(profile.id, { provider: profile.provider, configDir: profile.configDir });
}

/**
 * Usage readings for an account. Connects to real Claude status line bridge when configured;
 * remains strictly unknown (empty array) for Codex and other providers (no official mechanism exists).
 */
export function quotaObservations(accountProfileId: string, profile?: { provider: string; configDir: string }, now?: Date): unknown[] {
  const target = profile ?? profileInfoCache.get(accountProfileId);
  if (!target || target.provider !== 'claude') {
    return [];
  }
  return readClaudeQuotaObservations(accountProfileId, target.configDir, now);
}

export interface StatusLineUi {
  confirmEnable(label: string, settingsPath: string, bridgeCommand: string): Promise<boolean>;
  confirmOverwrite(label: string, currentCommand: string, bridgeCommand: string): Promise<boolean>;
  promptActiveChoice(label: string): Promise<'keep' | 'disable' | undefined>;
  confirmDisable(label: string): Promise<boolean>;
  showInfo(message: string): void;
  showError(message: string): void;
}

export interface ConfigureWizardOptions {
  interactive?: boolean;
  consent?: boolean;
  action?: 'enable' | 'disable';
  extensionPath?: string;
  ui?: StatusLineUi;
}

export interface ConfigureWizardResult {
  ok: boolean;
  status: 'enabled' | 'disabled' | 'cancelled' | 'unsupported' | 'failed';
  message: string;
}

/**
 * Opt-in setup wizard for the Claude status line bridge.
 *
 * Enforces:
 * 1. Only supported for `claude` provider. Codex/agy remain strictly unsupported and unknown.
 * 2. Requires explicit user consent before writing or overwriting `settings.json`'s `statusLine`.
 * 3. Informs the user of the claude.ai Pro/Max requirement for live rate_limits.
 */
export async function configureStatusLineWizard(
  profile: { id: string; provider: string; label: string; configDir: string },
  options: ConfigureWizardOptions = {}
): Promise<ConfigureWizardResult> {
  const interactive = options.interactive !== false && Boolean(options.ui);

  // Rule: Codex / agy and other providers must remain unknown with no mechanism applied.
  if (profile.provider !== 'claude') {
    const msg = `Status line quota bridge is only supported for Claude Code accounts. ${profile.provider} has no official statusLine mechanism; its quota remains unknown.`;
    if (options.ui) options.ui.showInfo(msg);
    return { ok: false, status: 'unsupported', message: msg };
  }

  const bridgeScriptPath = getBridgeScriptPath(options.extensionPath);
  const inspection = inspectStatusLineConfig(profile.configDir, bridgeScriptPath);

  if (inspection.status === 'unreadable') {
    const msg = `Could not safely read settings.json for “${profile.label}”. Please check the file for syntax errors.`;
    if (options.ui) options.ui.showError(msg);
    return { ok: false, status: 'failed', message: msg };
  }

  const quotaPath = path.join(profile.configDir, STATUSLINE_QUOTA_FILE_NAME);
  if (!isSafePath(bridgeScriptPath) || !isSafePath(quotaPath)) {
    const msg = `Could not safely configure status line bridge: path contains unsafe shell characters.`;
    if (options.ui) options.ui.showError(msg);
    return { ok: false, status: 'failed', message: msg };
  }

  const bridgeCommand = buildBridgeCommand(bridgeScriptPath, quotaPath);

  // Programmatic / non-interactive path
  if (!interactive) {
    if (options.consent !== true) {
      return { ok: false, status: 'cancelled', message: 'User consent was not granted.' };
    }
    if (options.action === 'disable') {
      if (inspection.status !== 'active') {
        return { ok: false, status: 'failed', message: 'Status line bridge is not active on this profile.' };
      }
      const disabled = disableStatusLineBridge(profile.configDir, bridgeScriptPath);
      return disabled.ok
        ? { ok: true, status: 'disabled', message: `Status line bridge was disabled for “${profile.label}”.` }
        : { ok: false, status: 'failed', message: disabled.reason ?? 'Failed to disable.' };
    }
    const enabled = enableStatusLineBridge(profile.configDir, bridgeScriptPath);
    return enabled.ok
      ? { ok: true, status: 'enabled', message: `Status line bridge was enabled for “${profile.label}”.` }
      : { ok: false, status: 'failed', message: enabled.reason ?? 'Failed to enable.' };
  }

  const ui = options.ui!;

  // Interactive flow with provided UI:
  if (inspection.status === 'active') {
    const choice = await ui.promptActiveChoice(profile.label);
    if (!choice || choice === 'keep') {
      return { ok: true, status: 'enabled', message: 'Status line bridge remains active.' };
    }

    if (choice === 'disable') {
      const confirmed = await ui.confirmDisable(profile.label);
      if (!confirmed) {
        return { ok: false, status: 'cancelled', message: 'Removal cancelled.' };
      }
      const outcome = disableStatusLineBridge(profile.configDir, bridgeScriptPath);
      if (outcome.ok) {
        ui.showInfo(`Status line bridge was removed from “${profile.label}”.`);
        return { ok: true, status: 'disabled', message: 'Bridge removed.' };
      }
      ui.showError(`Failed to remove status line bridge: ${outcome.reason}`);
      return { ok: false, status: 'failed', message: outcome.reason ?? 'Failed' };
    }
  }

  // Prompt for explicit consent:
  if (inspection.status === 'custom') {
    const confirmed = await ui.confirmOverwrite(profile.label, inspection.currentCommand ?? '(unspecified)', bridgeCommand);
    if (!confirmed) {
      ui.showInfo('Status line bridge setup was cancelled. Existing settings were not changed.');
      return { ok: false, status: 'cancelled', message: 'User declined overwrite.' };
    }
  } else {
    // Disabled / fresh setup
    const confirmed = await ui.confirmEnable(profile.label, inspection.settingsPath, bridgeCommand);
    if (!confirmed) {
      ui.showInfo('Status line bridge setup was cancelled. No changes were made.');
      return { ok: false, status: 'cancelled', message: 'User cancelled.' };
    }
  }

  const result = enableStatusLineBridge(profile.configDir, bridgeScriptPath);
  if (result.ok) {
    ui.showInfo(`Status line bridge enabled for “${profile.label}”. Start a Claude Code session to begin capturing real quota.`);
    return { ok: true, status: 'enabled', message: 'Status line bridge enabled.' };
  }
  ui.showError(`Could not update settings.json: ${result.reason}`);
  return { ok: false, status: 'failed', message: result.reason ?? 'Failed' };
}
