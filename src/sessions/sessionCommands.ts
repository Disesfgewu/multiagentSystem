import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { resolveRoleForLaunch, pickRoleForLaunch } from '../roles/roleLaunch';
import { PROVIDERS, errorMessage, terminalTitle } from '../agents';
import { WorktreeService } from '../projects/worktrees';
import { isInsideAllowedRoots, managedWorktreeRoot } from '../projects/worktreeController';
import { SessionManager, SessionView, cleanName } from './manager';
import { accountService, launchEnvironment } from '../accounts/accountRuntime';
import { builtIn } from '../providers/registry';
import { normalizeRequestedModel, supportsModelSelection, knownModelsForProvider } from '../providers/modelSelection';
import { PrivateSessionSnapshot, sessionWorkspaceKey } from './privateSnapshot';
import { privateStorage } from '../storage/storageCommands';
import { prepareInstructionSnapshot, isSnapshotStale, cleanupSessionPlan } from './managedInstructions';

const { executableAvailable } = require('../providers/executable') as { executableAvailable(name: string): boolean };
const { SessionObservationRuntime } = require('../observations/runtime') as {
  SessionObservationRuntime: new () => {
    prepare(input: { sessionId: string; provider: string; accountProfileId: string; env?: Record<string, string | null> }): { env?: Record<string, string | null>; active: boolean };
    enrich(sessions: SessionView[]): SessionView[];
    release(sessionId: string): void;
    onDidChange(listener: (sessionId: string) => void): { dispose(): void };
    dispose(): void;
  };
};
const { selectRoleProfiles } = require('../roles/account-choices') as {
  selectRoleProfiles(profiles: unknown, provider: string): { ok: boolean; reason?: string; profiles?: Array<{ id: string; label: string }> };
};
import { gateAccountLaunch, recordCodexSessionReading } from '../accounts/quotaGateUi';
import { detectShellType, shellFileName } from '../terminals/shellDetect';
import { isExtensionTestMode, requireInteractive } from '../shared/testMode';
import { isOwnUiItem } from '../shared/uiOrigin';
const { recordReading } = require('../accounts/usage-log') as {
  recordReading(input: { snapshot: unknown; openStore: () => Promise<unknown> }): Promise<{ recorded: boolean; reason: string }>;
};
import { prepareIsolationForStart } from '../isolation/enforcedStart';
import { writeClaudeSettings, removeClaudeSettings } from '../providers/attribution';
const { codexArguments } = require('../roles/tool-permissions') as { codexArguments(toolPermissions: Record<string, string> | null | undefined): { args: string[] } };
const { resolveAutoMode, describeAutoMode } = require('../providers/auto-mode') as {
  resolveAutoMode(input: { provider: string; setting?: unknown; overrides?: unknown }): { state: 'on' | 'off' | 'unknown'; args: string[]; label: string };
  describeAutoMode(auto: { state: string; args: string[]; label: string }, isolation: 'enforced' | 'advisory'): string[];
};
const { readUserLevel } = require('../settings/user-level') as { readUserLevel(inspected: unknown): { value: unknown; ignoredScopes: string[] } };
import { callerArgumentNeedsConfirmation } from '../shared/callerConfirm';
const { worktreeInProject } = require('./reopenScope') as { worktreeInProject(worktree: string, folders: string[], deps?: { realpath?: (p: string) => Promise<string>; commonDir?: (dir: string) => Promise<string | null> }): Promise<boolean> };

export const SESSION_COMMANDS = {
  list: 'multiagentSystem.sessions.list',
  start: 'multiagentSystem.sessions.start',
  focus: 'multiagentSystem.sessions.focus',
  stop: 'multiagentSystem.sessions.stop',
  reopen: 'multiagentSystem.sessions.reopen',
  rename: 'multiagentSystem.sessions.rename'
} as const;

const { REASONS: ROLE_REASONS } = require('../roles/launch-role') as { REASONS: Record<string, string> };
interface CodenameRequest { repoId: string; sessionId: string; prefix: string; from?: string }
type CodenameAnswer = { ok: true; codename: string } | { ok: false; reason: string };
const { CodenameStore, prefixForRole, withCodename } = require('./codenames') as {
  CodenameStore: new (store: unknown) => { get(repoId: string, sessionId: string): { ok: true; codename: string | null } | { ok: false; reason: string }; preview(request: CodenameRequest): CodenameAnswer; assign(request: CodenameRequest & { expect?: string }): CodenameAnswer; revert(request: { repoId: string; sessionId: string; from?: string }): { ok: boolean } };
  prefixForRole(role: unknown): string;
  withCodename(name: string, codename: unknown): string;
};

const MESSAGES: Record<string, string> = {
  ...ROLE_REASONS,
  'provider-unsupported': 'That CLI provider is not supported.',
  'model-selection-unsupported': 'This provider has no documented model selection flag in this extension yet.',
  'invalid-model': 'Enter a model ID of 1–128 letters, digits, dots, underscores, colons, slashes or hyphens, starting with a letter or digit.',
  'executable-not-found': 'This CLI could not be found. Install it from the official provider or add its executable to PATH, then retry.',
  'account-isolation-unknown': '此 provider 的帳號隔離未驗證，無法指派獨立帳號。請使用 CLI 預設登入，或先選擇已支援的 provider。',
  'invalid-account-list': 'Account profiles could not be validated. Refresh the accounts view and try again.',
  'invalid-name': 'Enter a session name of 1–80 characters without control, line-break or direction-changing characters.',
  'persist-failed': 'The new name could not be saved, so the session keeps its old name. Try again.',
  'session-not-found': 'That session no longer exists.',
  'terminal-not-open': 'The session has no open terminal in this window.',
  'session-still-open': 'The session still has an open terminal. Stop it first, or focus it.',
  'worktree-missing': 'The folder does not exist, so no terminal was started there.',
  'worktree-outside-project': 'The saved folder is no longer part of this project (or is a link that now points elsewhere), so no terminal was started there. Start a new session instead.',
  'invalid-snapshot': 'Saved sessions could not be read. They were left untouched and nothing will be saved in this window.',
  'store-unavailable': 'Saved sessions could not be loaded. They were left untouched and nothing will be saved in this window.',
  'attribution-settings-unavailable': 'Claude Code was not started: the settings that keep it from adding an author line to your commits could not be prepared (the extension\'s private storage is unavailable).',
  'confirm-unknown-reopen': 'This session\'s earlier terminal may still be running in that folder. Confirm to open a new one anyway.'
};

export interface SessionCommandOptions {
  interactive?: boolean;
  id?: string;
  provider?: string;
  name?: string;
  cwd?: string;
  /** false opens only the shell and types nothing (used by the Extension Host smoke test). */
  launch?: boolean;
  /** Needed to reopen a session whose earlier terminal this window cannot see. */
  acknowledgeUnknown?: boolean;
  accountProfileId?: string;
  /** A role group to assign to the new session. It is checked against the provider and never changed afterwards. */
  roleGroupId?: string;
  /** null uses the CLI default. This requests a model; it does not confirm the model actually used. */
  requestedModel?: string | null;
}

export type SessionOutcome =
  | { ok: true; session?: SessionView; sessions?: SessionView[] }
  | { ok: false; code: string; message: string };

export interface SessionCommands {
  launch(options: SessionCommandOptions): Promise<SessionOutcome>;
  launchWithAccount(options: SessionCommandOptions): Promise<SessionOutcome>;
  list(): SessionView[];
  /** Types one prompt line into a running session's terminal (administrator broadcast delivery). Not a VS Code command: only code in this extension can call it. */
  sendPrompt(id: string, prompt: string): void;
  onDidChange(listener: () => void): vscode.Disposable;
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

// The repo identity is a private local value. It never goes to GitHub.
export async function resolveProject(cwd: string): Promise<{ repoId: string }> {
  try {
    const service = await WorktreeService.open(cwd);
    return { repoId: service.githubRepository ?? `local:${digest(service.commonDir)}` };
  } catch {
    return { repoId: `folder:${digest(cwd)}` };
  }
}

function unsupportedShellMessage(shell: string | undefined): string {
  const found = shellFileName(shell);
  return `${found ? `The terminal shell "${found}"` : 'The terminal shell (it could not be identified)'} is not one this extension can type a command into safely, so nothing was started. Set the VS Code default terminal profile to bash, zsh, sh, PowerShell or Command Prompt, then retry.`;
}

function failure(error: unknown, interactive: boolean): SessionOutcome {
  const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'unexpected-error';
  const message = code === 'unsupported-shell' ? unsupportedShellMessage(vscode.env.shell) : code === 'quota-gate' ? errorMessage(error) : MESSAGES[code] ?? `Unexpected error: ${errorMessage(error)}`;
  if (interactive) void vscode.window.showErrorMessage(message);
  return { ok: false, code, message };
}

function workspaceFolder(): string | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders.length === 1 ? folders[0].uri.fsPath : undefined;
}

/**
 * Advice mode (the default) changes nothing. Enforced mode is the person's own user setting; every launch of an agent CLI
 * (a new session and a reopened one alike) comes through here, and when enforced cannot be provided it is refused, never
 * run without it.
 */
async function isolationForLaunch(interactive: boolean, launch: boolean | undefined, cwd: string, openedStorage: { ok?: boolean; store?: unknown } | undefined, provider: string) {
  const settings = vscode.workspace.getConfiguration('multiagentSystem');
  return prepareIsolationForStart({
    // A shell opened without launching a CLI has nothing to isolate (and types nothing).
    mode: launch === false ? undefined : readUserLevel(settings.inspect('isolation.mode')).value,
    allowedDomains: readUserLevel(settings.inspect('isolation.allowedDomains')).value,
    interactive,
    // The enforced confirmation also says what auto mode means inside the sandbox (issue #296).
    extraLines: autoModeFor(provider, launch, 'enforced').lines,
    storageDir: openedStorage?.ok ? path.join((openedStorage.store as any).dir, 'isolation') : undefined,
    home: os.homedir(),
    cwd,
    createHarness: (harnessOptions) => (require('../isolation/macos-harness') as { createMacosModule(options: object): unknown }).createMacosModule(harnessOptions),
    ui: {
      progress: (work) => Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Checking enforced isolation on this machine…' }, work)),
      confirm: async (lines) => await vscode.window.showWarningMessage('Start with enforced isolation?', { modal: true, detail: lines.join('\n') }, 'Start') === 'Start'
    }
  });
}

/**
 * Claude Code's settings file for this session, written in the extension's private storage: the switch that turns off its own
 * attribution (issue #293) and the role group's permission rules (issue #310), in one document. Without it Claude Code is not
 * started: neither the switch nor the permissions are optional.
 */
function attributionFileFor(provider: string, launch: boolean | undefined, openedStorage: { ok?: boolean; store?: unknown } | undefined, sessionId: string, toolPermissions: Record<string, string> | null | undefined): string | undefined {
  if (provider !== 'claude' || launch === false) return undefined;
  try {
    if (!openedStorage?.ok) throw new Error('no storage');
    return writeClaudeSettings(path.join((openedStorage.store as { dir: string }).dir, 'attribution'), sessionId, toolPermissions ?? null);
  } catch {
    throw Object.assign(new Error('attribution-settings-unavailable'), { code: 'attribution-settings-unavailable' });
  }
}

/**
 * Auto mode for this launch (issue #296), from the person's own user settings only. Not applicable to a shell opened without
 * a CLI. The lines say what the CLI will not stop to ask, and how that sits with the isolation of this session.
 */
function autoModeFor(provider: string, launch: boolean | undefined, isolationKind: string) {
  if (launch === false) return { auto: undefined, lines: [] as string[] };
  const settings = vscode.workspace.getConfiguration('multiagentSystem');
  const auto = resolveAutoMode({
    provider,
    setting: readUserLevel(settings.inspect('agents.autoMode')).value,
    overrides: readUserLevel(settings.inspect('agents.autoModeOverrides')).value
  });
  return { auto: { args: auto.args, label: auto.label, state: auto.state }, lines: describeAutoMode(auto, isolationKind === 'enforced' ? 'enforced' : 'advisory') as string[] };
}

const AUTO_MODE_ACKNOWLEDGED_KEY = 'multiagentSystem.autoModeAcknowledged';
const CONFIRMED_INSTRUCTIONS_KEY = 'multiagentSystem.confirmedInstructionDigests';
const { confirmationKey, alreadyConfirmed, remember } = require('./confirmedInstructions') as {
  confirmationKey(provider: unknown, roleGroupId: unknown): string | null;
  alreadyConfirmed(map: unknown, key: string | null, digest: unknown): boolean;
  remember(map: unknown, key: string | null, digest: unknown): Record<string, string>;
};
/** Whether the person already confirmed exactly these instructions for this provider and role group (#362). */
function instructionsConfirmed(context: vscode.ExtensionContext, provider: string, roleGroupId: string | undefined, digest: string): boolean {
  return alreadyConfirmed(context.globalState.get(CONFIRMED_INSTRUCTIONS_KEY), confirmationKey(provider, roleGroupId), digest);
}
/** Remembers a confirmation the person gave in the dialog. Best effort: a failure only means the next start asks again. */
async function rememberInstructions(context: vscode.ExtensionContext, provider: string, roleGroupId: string | undefined, digest: string): Promise<void> {
  try { await context.globalState.update(CONFIRMED_INSTRUCTIONS_KEY, remember(context.globalState.get(CONFIRMED_INSTRUCTIONS_KEY), confirmationKey(provider, roleGroupId), digest)); } catch { /* asked again next time */ }
}
const SAME_INSTRUCTIONS = (digest: string) => `Starting with the same instructions you confirmed before (${digest.slice(0, 16)}...). You are asked again when they change.`;

/**
 * The first time an agent is started with auto mode on, a window the person must answer says what it means; the answer is remembered
 * for this user (not per workspace), so it is asked once. Declining starts nothing. Auto mode off, a shell without a CLI and a provider
 * with no documented flag need no such window. Only the person's own window can answer it: an argument cannot.
 */
export async function confirmAutoModeOnce(context: vscode.ExtensionContext, autoMode: { auto?: { state: string }; lines: string[] }): Promise<boolean> {
  if (!autoMode.auto || autoMode.auto.state !== 'on') return true;
  if (context.globalState.get<boolean>(AUTO_MODE_ACKNOWLEDGED_KEY) === true) return true;
  const answer = await vscode.window.showWarningMessage(
    'Agents start in auto mode by default',
    { modal: true, detail: `${autoMode.lines.join('\n')}\n\nThis is the default you get unless you set multiagentSystem.agents.autoMode to "off" in your user settings (or per provider). You will not be asked again.` },
    'I Understand, Continue'
  );
  if (answer !== 'I Understand, Continue') return false;
  await context.globalState.update(AUTO_MODE_ACKNOWLEDGED_KEY, true);
  return true;
}

export const INSTRUCTION_PREVIEW_SCHEME = 'multiagent-session-instructions';
const NOTICES_UNREADABLE_WARNING = 'Private storage is unavailable, so administrator notices could not be checked. This agent starts without any live notice, and without a codename: it is not told how to sign its GitHub posts.';

/** What to ask the codename store for a session (issue #342): the prefix comes from the role group's role, `Agent` without one. */
function codenameRequest(store: any, repoId: string, sessionId: string, roleGroupId: string | undefined, from?: string): CodenameRequest {
  let role: unknown;
  if (roleGroupId && roleGroupId !== 'unassigned') {
    const loaded = store.get('roleGroups', roleGroupId);
    role = loaded?.ok && loaded.found ? loaded.value?.group?.role : undefined;
  }
  // A session id the store cannot hold never held a codename, so there is nothing to move from it.
  return { repoId, sessionId, prefix: prefixForRole(role), ...(from && /^[A-Za-z0-9_-]{8,64}$/.test(from) ? { from } : {}) };
}
const { findRealGh, writeShims, shimEnvironment, removeShims } = require('./ghGuard/shims') as {
  findRealGh(input: { pathValue?: string; skip?: string }): string | null;
  writeShims(input: { dir: string; node: string; script: string; codename: string | null; realGh: string | null }): { ok: true; dir: string } | { ok: false; reason: string };
  shimEnvironment(input?: { platform?: string }): Record<string, string>;
  removeShims(dir: string): boolean;
};

/**
 * The session's own `gh` wrapper (issue #342): shims in the private folder, first on the terminal's PATH, that sign what the agent
 * posts with its codename and refuse impersonation. The typed launch command puts the folder first on PATH for the CLI. Without a real gh on PATH the shims refuse every call. A wrapper that cannot be
 * written stops the launch: an agent with a codename is not started without it.
 */
function prepareGhWrapper(privateDir: string, sessionId: string, codename: string, env: Record<string, string | null> | undefined): { ok: true; dir: string; env: Record<string, string | null> } | { ok: false; message: string } {
  const dir = path.join(privateDir, 'gh-wrapper', sessionId);
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const [name, value] of Object.entries(env ?? {})) { if (typeof value === 'string') base[name] = value; else delete base[name]; }
  const pathKey = Object.keys(base).find((name) => name.toLowerCase() === 'path');
  const realGh = findRealGh({ pathValue: pathKey ? base[pathKey] : undefined, skip: dir });
  const written = writeShims({ dir, node: process.execPath, script: path.join(__dirname, 'ghGuard', 'run.js'), codename, realGh });
  if (!written.ok) return { ok: false, message: `The gh wrapper for this agent could not be prepared (${written.reason}). The agent was not started.` };
  return { ok: true, dir, env: { ...(env ?? {}), ...shimEnvironment() } };
}

const { findIdePort, lockFolders, describeIde } = require('./ideBridge') as {
  findIdePort(input: { folders: string[]; workspaceFolders: string[] }): { ok: true; port: number } | { ok: false; reason: string; text: string };
  lockFolders(input: { configDir?: string }): string[];
  describeIde(result: unknown): string;
};
// What each Claude Code session was given to reach this VS Code window (#354): shown on its card and in its details.
const ideStatus = new Map<string, string>();
// Where the lock files are read from; only the extension's own host tests point it at a temporary folder (never the real ~/.claude).
let ideFolders = (configDir?: string): string[] => lockFolders({ configDir });
export function setIdeLockFoldersForTests(folders: string[] | undefined): void {
  if (!isExtensionTestMode()) throw new Error('This is only exposed in Extension Host tests.');
  ideFolders = folders ? () => folders : (configDir?: string) => lockFolders({ configDir });
}
const withIdeLabels = <T extends { id: string }>(entries: T[]): Array<T & { ideLabel?: string; trustLabel?: string }> => entries.map((entry) => ({
  ...entry,
  ...(ideStatus.has(entry.id) ? { ideLabel: ideStatus.get(entry.id) } : {}),
  ...(trustStatus.has(entry.id) ? { trustLabel: trustStatus.get(entry.id) } : {})
}));

const { trustClaudeFolder, trustCodexFolder, describeTrust, usableManagedRoots } = require('./folderTrust') as {
  usableManagedRoots(roots: string[]): string[];
  trustClaudeFolder(input: { configDir: string | undefined; folder: string }): { ok: true; changed: boolean } | { ok: false; reason: string };
  trustCodexFolder(input: { codexHome: string | undefined; folder: string }): { ok: true; changed: boolean } | { ok: false; reason: string };
  describeTrust(result: unknown, cliName: string): string | null;
};
// Whether the CLI will stop to ask to trust the agent's worktree (#362): shown on its card and in its details.
const trustStatus = new Map<string, string>();
const TRUST_SETTING = 'agents.preTrustManagedWorktrees';
const TRUST_CLI: Record<string, string> = Object.freeze({ claude: 'Claude Code', codex: 'Codex' });

/** The managed worktree folders of this window's projects: `<repo>-worktrees` next to each open folder (#362). */
function managedRootsOfWindow(): string[] {
  return usableManagedRoots((vscode.workspace.workspaceFolders ?? []).map((folder) => managedWorktreeRoot(folder.uri.fsPath)));
}

/**
 * Before an agent starts in one of this project's managed worktrees, its trust is written into the account's own CLI settings, so the
 * CLI does not stop to ask whether to trust the folder (#362). Only for a folder inside `<repo>-worktrees` of an open folder (the
 * folder the extension creates worktrees in), only for an account folder of its own (Claude Code's `~/.claude.json` is never
 * touched), and only once the person agreed: the user setting multiagentSystem.agents.preTrustManagedWorktrees is "on", or is "ask"
 * and they answered once (the answer is saved there). A start that cannot pre-trust still starts; the CLI then asks as usual.
 */
async function preTrustWorktree(provider: string, sessionId: string, cwd: string, env: Record<string, string | null> | undefined, interactive: boolean): Promise<void> {
  trustStatus.delete(sessionId);
  const cliName = TRUST_CLI[provider];
  if (!cliName || !isInsideAllowedRoots(cwd, managedRootsOfWindow())) return;
  const settings = vscode.workspace.getConfiguration('multiagentSystem');
  let choice = readUserLevel(settings.inspect(TRUST_SETTING)).value ?? 'ask';
  if (choice === 'ask' && interactive) {
    const answer = await vscode.window.showWarningMessage(
      `Let ${cliName} start in this project's worktrees without asking to trust each one?`,
      { modal: true, detail: `Each agent works in a new worktree under ${path.dirname(cwd)}, and ${cliName} asks once per folder whether to trust it, which stops the agent until you answer. If you agree, the extension writes the trust for each new managed worktree into that account's own ${provider === 'claude' ? '.claude.json' : 'config.toml'} (nothing else in the file changes). Only worktrees in this folder are trusted. You can change this later in the setting multiagentSystem.agents.preTrustManagedWorktrees.` },
      'Trust Managed Worktrees',
      'Never'
    );
    if (answer === 'Trust Managed Worktrees' || answer === 'Never') {
      choice = answer === 'Never' ? 'off' : 'on';
      try { await settings.update(TRUST_SETTING, choice, vscode.ConfigurationTarget.Global); } catch { /* used for this start either way */ }
    }
  }
  if (choice !== 'on') {
    trustStatus.set(sessionId, describeTrust({ ok: false, reason: choice === 'off' ? 'turned-off' : 'no-consent' }, cliName) ?? '');
    return;
  }
  // The CLI may key the folder by the path as given or by its real path: both are written when they differ.
  let real = cwd;
  try { real = fs.realpathSync.native(cwd); } catch { /* the given path is used */ }
  let result: ReturnType<typeof trustClaudeFolder> = { ok: false, reason: 'folder-invalid' };
  for (const folder of [...new Set([path.resolve(cwd), real])]) {
    result = provider === 'claude'
      ? trustClaudeFolder({ configDir: typeof env?.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR : undefined, folder })
      : trustCodexFolder({ codexHome: typeof env?.CODEX_HOME === 'string' ? env.CODEX_HOME : undefined, folder });
    if (!result.ok) break;
  }
  trustStatus.set(sessionId, describeTrust(result, cliName) ?? '');
}

/**
 * Claude Code's connection to this window (#354): the port of this window's lock file, set as CLAUDE_CODE_SSE_PORT for the agent's
 * terminal, because its worktree is usually not one of the window's folders. Only the port is passed on, never the lock's token.
 * A launch that finds no port still starts; the reason is shown with the session.
 */
function withIdePort(provider: string, sessionId: string, env: Record<string, string | null> | undefined): Record<string, string | null> | undefined {
  if (provider !== 'claude') return env;
  const configDir = typeof env?.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR : undefined;
  let found: ReturnType<typeof findIdePort>;
  try { found = findIdePort({ folders: ideFolders(configDir), workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath) }); } catch { found = { ok: false, reason: 'no-lock', text: 'the lock files could not be read' }; }
  ideStatus.set(sessionId, describeIde(found));
  return found.ok ? { ...(env ?? {}), CLAUDE_CODE_SSE_PORT: String(found.port) } : env;
}

const { launchNote } = require('./launchNote') as { launchNote(provider: string, codename: string | undefined): string };

const codenameFailure = (reason: string) => Object.assign(new Error(reason === 'codename-changed'
  ? 'The session codename was taken by another window during review. Please start again.'
  : `The session codename could not be prepared (${reason}). The agent was not started.`), { code: reason === 'codename-changed' ? 'stale-instructions' : 'codename-unavailable' });

class InstructionPreviewProvider implements vscode.TextDocumentContentProvider {
  private readonly docs = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  set(id: string, content: string): vscode.Uri {
    this.docs.set(id, content);
    const uri = vscode.Uri.from({ scheme: INSTRUCTION_PREVIEW_SCHEME, path: '/instructions.txt', query: id });
    this.emitter.fire(uri);
    return uri;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.query) ?? 'No instructions available or session closed.\n';
  }
}

export function registerSessionCommands(context: vscode.ExtensionContext): SessionCommands {
  const changed = new vscode.EventEmitter<void>();
  context.subscriptions.push(changed);
  const previewProvider = new InstructionPreviewProvider();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(INSTRUCTION_PREVIEW_SCHEME, previewProvider));
  // One quota-dispatch reservation per account-bound session, including those with no limits, released
  // exactly once when that session stops or its terminal closes. A session this map has no entry for
  // either has no account assigned, is still awaiting handoff, or was already released.
  const reservations = new Map<string, () => Promise<void>>();
  // Enforced isolation is per session: its proxy, profile and fixture folder go when the session stops or its terminal closes.
  const isolations = new Map<string, () => Promise<void>>();
  const releaseReservation = async (id: string): Promise<void> => {
    const release = reservations.get(id);
    reservations.delete(id);
    const dispose = isolations.get(id);
    isolations.delete(id);
    try { await dispose?.(); } finally { await release?.(); }
  };
  const observations = new SessionObservationRuntime();
  // New or aged-out provider evidence refreshes the same views a session change does (the Overview reads
  // the evidence when it renders). The runtime has no timer unless a session is bound.
  // Every reading a provider really reports is kept in the token usage log (issue #294), per account, in private storage.
  // Best effort: a reading that cannot be kept never disturbs the session.
  const recordUsage = async (sessionId: string): Promise<void> => {
    const view = manager.get(sessionId);
    if (!view) return;
    // A Codex session has no usage in its own observation; its account's session log is read whenever the session's observation changes.
    if (view.provider === 'codex' && typeof view.accountProfileId === 'string' && view.accountProfileId !== 'unassigned') await recordCodexSessionReading(view.accountProfileId, () => manager.list());
    await recordReading({ snapshot: observations.enrich([view])[0]?.providerObservation, openStore: async () => { const opened = await privateStorage()?.use(); return opened?.ok ? opened.store : null; } });
  };
  context.subscriptions.push(observations.onDidChange((sessionId) => { changed.fire(); void recordUsage(sessionId); }), { dispose: () => observations.dispose() });
  const manager = new SessionManager<vscode.Terminal>({
    store: new PrivateSessionSnapshot({
      workspaceKey: () => sessionWorkspaceKey((vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.toString()), vscode.workspace.workspaceFile?.toString()),
      use: async () => await privateStorage()?.use() ?? { ok: false }
    }),
    terminals: {
      create: ({ name, cwd, env }) => vscode.window.createTerminal({ name, cwd, env, location: vscode.TerminalLocation.Editor })
    },
    providers: Object.fromEntries(PROVIDERS.map((provider) => [provider.executable, provider.executable])),
    executableAvailable,
    resolveProject,
    directoryExists: (target) => {
      try {
        return fs.statSync(target).isDirectory();
      } catch {
        return false;
      }
    },
    terminalTitle,
    detectShellType: () => detectShellType(vscode.env.shell, process.platform),
    onPersistError: () => void vscode.window.showWarningMessage('Session records could not be saved. Existing saved records were left untouched. These sessions remain in this window only; reload the workspace before trying to save again.'),
    onPersistenceBlocked: () =>
      void vscode.window.showWarningMessage('Saved sessions could not be read, so sessions are not being saved in this window. The saved data was left untouched.')
  });

  const options = (value: unknown): SessionCommandOptions =>
    value && typeof value === 'object' ? (value as SessionCommandOptions) : {};
  // `acknowledgeUnknown` answers the "a terminal from before may still be running" warning for the
  // caller; only the extension's own tests may do that through a command argument.
  const withoutAcknowledge = (input: SessionCommandOptions): SessionCommandOptions =>
    input.acknowledgeUnknown === true && !isExtensionTestMode() ? { ...input, acknowledgeUnknown: undefined } : input;

  async function launch(input: SessionCommandOptions): Promise<SessionOutcome> {
    const interactive = input.interactive !== false;
    try {
      const cwd = input.cwd ?? workspaceFolder();
      if (!cwd) throw Object.assign(new Error('no folder'), { code: 'no-folder' });
      let accountProfileId = input.accountProfileId;
      const provider = input.provider ?? '';
      if (!accountProfileId && interactive && builtIn.has(provider)) {
        const isolation = builtIn.capability(provider, 'accountIsolation');
        if (isolation === 'unknown' || isolation === 'unsupported') {
          const answer = await vscode.window.showWarningMessage(
            '此 provider 的帳號隔離未驗證；擴充套件無法為它指派獨立帳號。',
            { modal: true, detail: '此 CLI 將使用自己的預設登入；身份核實與額度資訊也維持未知。' }, 'Use CLI Default');
          if (answer !== 'Use CLI Default') return { ok: false, code: 'cancelled', message: 'Cancelled.' };
        } else {
          const available = await accountService(() => manager.list());
          if (!available.ok) return failure(Object.assign(new Error(available.message), { code: available.code }), true);
          const listed = available.service.list();
          if (!listed.ok) return failure(Object.assign(new Error(listed.message), { code: listed.code }), true);
          const selected = selectRoleProfiles(listed.profiles, provider);
          if (!selected.ok || !Array.isArray(selected.profiles)) return failure(Object.assign(new Error('invalid-account-list'), { code: 'invalid-account-list' }), true);
          const choice = await vscode.window.showQuickPick([
            { label: 'Use the CLI default account', description: 'Not isolated or verified by this extension', id: 'unassigned' },
            ...selected.profiles.map((profile) => ({ label: profile.label, description: 'Account identity: unknown until observed', id: profile.id }))
          ], { placeHolder: 'Choose an account for this new session' });
          if (!choice) return { ok: false, code: 'cancelled', message: 'Cancelled.' };
          accountProfileId = choice.id === 'unassigned' ? undefined : choice.id;
        }
      }
      let roleGroupId = input.roleGroupId;
      if (roleGroupId === undefined && interactive && builtIn.has(provider)) {
        const picked = await pickRoleForLaunch(provider);
        if (picked === undefined) return { ok: false, code: 'cancelled', message: 'Cancelled.' };
        roleGroupId = picked === 'none' ? undefined : picked;
      }
      return await startWithAccount({ ...input, provider, cwd, accountProfileId, roleGroupId });
    } catch (error) {
      if ((error as { code?: string })?.code === 'no-folder') {
        const message = 'Open a single project folder first.';
        if (interactive) void vscode.window.showErrorMessage(message);
        return { ok: false, code: 'no-folder', message };
      }
      return failure(error, interactive);
    }
  }

  async function startWithAccount(input: SessionCommandOptions): Promise<SessionOutcome> {
    const interactive = input.interactive !== false;
    // Set once a quota-gate reservation is taken; released on every exit path below except the one
    // success path, which instead hands it off to this new session's own lifetime.
    let release: (() => Promise<void>) | undefined;
    let isolationDispose: (() => Promise<void>) | undefined;
    let targetSessionId: string | undefined;
    // Set once a codename is written for this session; undone if the session then does not start.
    let revertCodename: (() => void) | undefined;
    let codename: string | undefined;
    let ghWrapperDir: string | undefined;
    try {
      const cwd = input.cwd ?? workspaceFolder();
      if (!cwd) throw Object.assign(new Error('no folder'), { code: 'no-folder' });
      const provider = input.provider ?? '';
      let env: Record<string, string | null> | undefined;
      let requestedModel = input.requestedModel;
      if (requestedModel === undefined && interactive && supportsModelSelection(provider)) {
        const known = knownModelsForProvider(provider);
        interface ModelPickItem extends vscode.QuickPickItem {
          modelId: string | null;
          custom?: boolean;
        }
        const items: ModelPickItem[] = [
          {
            label: 'Use CLI default model',
            modelId: null,
            description: 'The actual model remains unknown until the CLI reports it'
          },
          ...known.map((m) => ({
            label: m.label,
            modelId: m.id,
            description: m.description,
            detail: m.detail
          })),
          {
            label: 'Enter custom model ID…',
            modelId: '__custom__',
            custom: true,
            description: 'Enter another provider model ID or alias; account availability is not checked'
          }
        ];
        const choice = await vscode.window.showQuickPick(items, {
          placeHolder: `Select a model for ${provider} CLI session`
        });
        if (!choice) return { ok: false, code: 'cancelled', message: 'Cancelled.' };
        if (choice.custom) {
          const entered = await vscode.window.showInputBox({
            prompt: 'Model ID or alias for this new session. The CLI decides whether your account can use it.',
            placeHolder: provider === 'claude' ? 'claude-3-7-sonnet-20250219' : 'o3-mini',
            ignoreFocusOut: true,
            validateInput: (value) => { try { normalizeRequestedModel(provider, value); return undefined; } catch { return MESSAGES['invalid-model']; } }
          });
          if (entered === undefined) return { ok: false, code: 'cancelled', message: 'Cancelled.' };
          requestedModel = entered;
        } else {
          requestedModel = choice.modelId;
        }
      }
      requestedModel = normalizeRequestedModel(provider, requestedModel);
      if (input.accountProfileId && !['verified', 'unverified'].includes(builtIn.capability(provider, 'accountIsolation'))) {
        return failure(Object.assign(new Error('account-isolation-unknown'), { code: 'account-isolation-unknown' }), interactive);
      }
      if (input.roleGroupId !== undefined) {
        const role = await resolveRoleForLaunch(input.roleGroupId, provider);
        if (!role.ok) return failure(Object.assign(new Error(role.message), { code: role.code }), interactive);
      }
      if (input.accountProfileId) {
        const gate = await gateAccountLaunch(input.accountProfileId, interactive, () => manager.list());
        if (!gate.ok) return gate.code === 'cancelled' ? { ok: false, code: 'cancelled', message: 'Cancelled.' } : failure(Object.assign(new Error(gate.message), { code: gate.code }), interactive);
        release = gate.release;
        const prepared = await launchEnvironment(input.accountProfileId, provider, () => manager.list());
        if (!prepared.ok) return failure(Object.assign(new Error(prepared.message), { code: prepared.code }), interactive);
        if (interactive) {
          const answer = await vscode.window.showWarningMessage(
            'Account isolation is not verified for this CLI on this machine.',
            { modal: true, detail: 'The extension sets the provider configuration directory for this new terminal and removes inherited credential overrides. Confirm the CLI uses that directory before entering sensitive work.' },
            'Continue'
          );
          if (answer !== 'Continue') return { ok: false, code: 'cancelled', message: 'Cancelled.' };
        }
        env = prepared.env;
      }
      let instructions: any;
      targetSessionId = randomUUID();
      const openedStorage = await privateStorage()?.use();
      const isolation = await isolationForLaunch(interactive, input.launch, cwd, openedStorage, provider);
      if (isolation.kind === 'refused') {
        if (interactive && isolation.code !== 'cancelled') void vscode.window.showErrorMessage(isolation.message);
        return { ok: false, code: isolation.code, message: isolation.message };
      }
      if (isolation.kind === 'enforced') isolationDispose = isolation.dispose;
      if (isolation.kind === 'enforced') env = { ...(env ?? {}), ...isolation.env };
      const autoMode = autoModeFor(provider, input.launch, isolation.kind);
      let autoModeShown = false;
      if (interactive && !(await confirmAutoModeOnce(context, autoMode))) return { ok: false, code: 'cancelled', message: 'Cancelled.' };
      if (!openedStorage?.ok) {
        if (input.roleGroupId && input.roleGroupId !== 'unassigned') {
          const reason = openedStorage?.reason ?? 'storage-unavailable';
          if (release) { await release(); release = undefined; }
          return failure(Object.assign(new Error(`Private storage is unavailable (${reason}). Cannot prepare effective instructions.`), { code: 'storage-unavailable' }), interactive);
        }
        // No role group means nothing to protect, so the agent still starts, but live administrator
        // notices live in the same private storage and could not be read: say so instead of skipping them.
        if (interactive) void vscode.window.showWarningMessage(NOTICES_UNREADABLE_WARNING);
      } else {
        const store = openedStorage.store as any;
        const privateDir = store.dir;
        const codexHome = provider === 'codex' ? (env?.CODEX_HOME ?? path.join(privateDir, 'codex-home')) : undefined;
        if (codexHome && !env?.CODEX_HOME) env = { ...(env ?? {}), CODEX_HOME: codexHome };
        const project = await resolveProject(cwd);
        // The codename is worked out before the instructions (they tell it to the agent) but written only once they are confirmed.
        const codenames = new CodenameStore(store);
        const codenameAsk = codenameRequest(store, project.repoId, targetSessionId, input.roleGroupId);
        const previewed = codenames.preview(codenameAsk);
        if (!previewed.ok) {
          if (release) { await release(); release = undefined; }
          return failure(codenameFailure(previewed.reason), interactive);
        }
        codename = previewed.codename;
        const prep = await prepareInstructionSnapshot({
          store,
          repoRoot: cwd,
          repoId: project.repoId,
          provider,
          roleGroupId: input.roleGroupId,
          accountProfileId: input.accountProfileId,
          requestedModel,
          targetSessionId,
          privateDir,
          codexHome,
          codename
        });
        if (!prep.ok) {
          if (release) { await release(); release = undefined; }
          return failure(Object.assign(new Error(prep.message), { code: prep.code }), interactive);
        }
        if (interactive && prep.digest && prep.reviewDigest && instructionsConfirmed(context, provider, input.roleGroupId, prep.reviewDigest)) {
          void vscode.window.showInformationMessage(SAME_INSTRUCTIONS(prep.digest));
        } else if (interactive && prep.digest) {
          autoModeShown = true;
          const answer = await vscode.window.showInformationMessage(
            `Effective agent instructions prepared (${prep.digest.slice(0, 16)}...).`,
            { modal: true, detail: `Delivery method: ${prep.injectionStatusLabel}\nThe instructions are written to a private file outside the workspace (for Codex, inside the account's Codex home); they are removed when the session ends. Whether the CLI reads them is not verified.${autoMode.lines.length > 0 ? `\n\n${autoMode.lines.join('\n')}` : ''}` },
            'Start Agent',
            'View Instructions'
          );
          if (!answer) {
            cleanupSessionPlan(prep.plan);
            if (release) { await release(); release = undefined; }
            return { ok: false, code: 'cancelled', message: 'Cancelled.' };
          }
          if (answer === 'View Instructions') {
            const uri = previewProvider.set(targetSessionId, prep.summaryText);
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, { preview: true });
            const proceed = await vscode.window.showInformationMessage(
              'Confirm launching agent terminal with these effective instructions?',
              { modal: true },
              'Start Agent'
            );
            if (proceed !== 'Start Agent') {
              cleanupSessionPlan(prep.plan);
              if (release) { await release(); release = undefined; }
              return { ok: false, code: 'cancelled', message: 'Cancelled.' };
            }
          }
          // The person agreed to these instructions in the dialog: the next agent of this role group with the same ones is not asked.
          if (prep.reviewDigest) await rememberInstructions(context, provider, input.roleGroupId, prep.reviewDigest);
        }
        const staleCheck = await isSnapshotStale(prep.snapshot, { store, repoRoot: cwd });
        if (staleCheck.stale) {
          cleanupSessionPlan(prep.plan);
          if (release) { await release(); release = undefined; }
          const msg = `Instructions changed or expired during review (${staleCheck.reason}). Please start again.`;
          if (interactive) void vscode.window.showErrorMessage(msg);
          return { ok: false, code: 'stale-instructions', message: msg };
        }
        const committed = codenames.assign({ ...codenameAsk, expect: codename });
        if (!committed.ok) {
          cleanupSessionPlan(prep.plan);
          if (release) { await release(); release = undefined; }
          return failure(codenameFailure(committed.reason), interactive);
        }
        revertCodename = () => { codenames.revert({ repoId: codenameAsk.repoId, sessionId: codenameAsk.sessionId }); };
        const wrapper = prepareGhWrapper(privateDir, targetSessionId, codename, env);
        if (!wrapper.ok) {
          cleanupSessionPlan(prep.plan);
          if (release) { await release(); release = undefined; }
          revertCodename();
          revertCodename = undefined;
          return failure(Object.assign(new Error(wrapper.message), { code: 'gh-wrapper-unavailable' }), interactive);
        }
        env = wrapper.env;
        ghWrapperDir = wrapper.dir;
        { const dir = wrapper.dir; const previous = isolationDispose; isolationDispose = async () => { try { await previous?.(); } finally { removeShims(dir); } }; }
        instructions = prep;
      }
      // The settings file needs the role group's permissions, so it is written once the instructions are prepared. If it cannot be,
      // nothing starts and the prepared instruction files are removed again.
      let attributionFile: string | undefined;
      try {
        attributionFile = attributionFileFor(provider, input.launch, openedStorage, targetSessionId, instructions?.toolPermissions);
      } catch (error) {
        if (instructions?.plan) cleanupSessionPlan(instructions.plan);
        throw error;
      }
      if (attributionFile) { const file = attributionFile; const previous = isolationDispose; isolationDispose = async () => { try { await previous?.(); } finally { removeClaudeSettings(file); } }; }
      await preTrustWorktree(provider, targetSessionId, cwd, env, interactive);
      const session = await manager.start({
        id: targetSessionId,
        provider,
        name: input.name ?? '',
        cwd,
        accountProfileId: input.accountProfileId,
        roleGroupId: input.roleGroupId,
        requestedModel,
        env: observations.prepare({
          sessionId: targetSessionId,
          provider,
          accountProfileId: input.accountProfileId ?? 'unassigned',
          env: withIdePort(provider, targetSessionId, env)
        }).env,
        launch: input.launch,
        instructions,
        ...(isolation.kind === 'enforced' ? { wrap: isolation.wrap } : {}),
        ...(attributionFile ? { attributionFile } : {}),
        ...(provider === 'codex' && input.launch !== false ? { permissionArgs: codexArguments(instructions?.toolPermissions).args } : {}),
        ...(autoMode.auto ? { autoMode: autoMode.auto } : {}),
        ...(codename !== undefined && revertCodename ? { codename } : {}),
        ...(ghWrapperDir ? { pathPrefix: ghWrapperDir } : {}),
        launchNote: launchNote(provider, codename)
      });
      revertCodename = undefined;
      // No confirmation window was shown for this launch: say it on screen anyway, so nobody is surprised that the agent does not stop to ask.
      if (interactive && autoMode.auto && autoMode.auto.state !== 'off' && !autoModeShown) void vscode.window.showInformationMessage(autoMode.lines.join(' '));
      if (isolationDispose && manager.get(session.id)?.terminalOpen) { isolations.set(session.id, isolationDispose); isolationDispose = undefined; }
      if (release && manager.get(session.id)?.terminalOpen) { reservations.set(session.id, release); release = undefined; }
      changed.fire();
      return { ok: true, session };
    } catch (error) {
      if (typeof targetSessionId !== 'undefined') observations.release(targetSessionId);
      try { revertCodename?.(); } catch { /* the number stays used either way */ }
      return failure(error, interactive);
    } finally {
      // Release if creation failed/cancelled, or if its terminal closed before snapshot saving
      // finished and the reservation could be handed off. A successful handoff clears release.
      await release?.();
      // Not handed to a session (the start failed or was cancelled): nothing of it may outlive this call.
      await isolationDispose?.();
    }
  }

  async function pickSession(placeholder: string, filter: (session: SessionView) => boolean): Promise<SessionView | undefined> {
    const sessions = withIdeLabels(manager.list()).filter(filter);
    if (sessions.length === 0) {
      void vscode.window.showInformationMessage('No matching sessions.');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      sessions.map((session) => ({
        label: withCodename(session.name, session.codename),
        description: `${session.provider} · ${session.stateLabel}`,
        detail: `account: ${session.accountProfileId} · requested model: ${session.requestedModel ?? 'CLI default'} · instructions: ${session.instructionStatusLabel ?? 'unknown'}${session.ideLabel ? ` · ${session.ideLabel}` : ''}${session.trustLabel ? ` · ${session.trustLabel}` : ''} · ${session.worktree}`,
        session
      })),
      { placeHolder: placeholder, matchOnDescription: true, matchOnDetail: true }
    );
    return picked?.session;
  }

  async function act(action: 'focus' | 'stop' | 'reopen', value: unknown, fromOwnUi = false): Promise<SessionOutcome> {
    const input = options(value);
    const interactive = input.interactive !== false;
    // Set only on the 'reopen' path, exactly like startWithAccount's own reservation handling below.
    let release: (() => Promise<void>) | undefined;
    let isolationDispose: (() => Promise<void>) | undefined;
    try {
      let id = input.id;
      // A caller that names the session skips the picker, so outside the extension's own tests the
      // person confirms which session is stopped. The overview's own Stop button passes its row and
      // the picker below is itself the person's choice: neither asks a second time (Refs #192).
      if (action === 'stop' && callerArgumentNeedsConfirmation({ supplied: typeof id === 'string' && id.length > 0, fromOwnUi, testMode: isExtensionTestMode() })) {
        const target = manager.get(id as string);
        if (!target) throw Object.assign(new Error('session-not-found'), { code: 'session-not-found' });
        if (target.terminalOpen) {
          const answer = await vscode.window.showWarningMessage(
            `Stop session "${target.name}"?`,
            { modal: true, detail: 'A command asked to stop this session. Stopping closes its terminal and ends the agent running in it.' },
            'Stop Session'
          );
          if (answer !== 'Stop Session') return { ok: false, code: 'cancelled', message: 'Cancelled.' };
        }
      }
      if (!id) {
        if (!interactive) throw Object.assign(new Error('id'), { code: 'session-not-found' });
        const wantsOpen = action !== 'reopen';
        const picked = await pickSession(`Choose a session to ${action}`, (session) => session.terminalOpen === wantsOpen);
        if (!picked) return { ok: false, code: 'cancelled', message: 'Cancelled.' };
        id = picked.id;
      }
      let session: SessionView;
      if (action === 'focus') {
        try {
          session = manager.focus(id);
        } catch (error) {
          if (interactive && (error as { code?: string })?.code === 'terminal-not-open') {
            const target = manager.get(id);
            const detail = target?.state === 'unknown'
              ? 'This session was restored from an earlier window and has no attached terminal in this window.'
              : 'Its terminal was closed.';
            const answer = await vscode.window.showWarningMessage(
              `${MESSAGES['terminal-not-open']} ${detail}`,
              'Reopen as New Session'
            );
            if (answer === 'Reopen as New Session') {
              return await act('reopen', { id, interactive: true, launch: input.launch, acknowledgeUnknown: input.acknowledgeUnknown });
            }
            return { ok: false, code: 'terminal-not-open', message: MESSAGES['terminal-not-open'] };
          }
          throw error;
        }
      } else if (action === 'stop') {
        session = manager.stop(id);
        await releaseReservation(id);
        observations.release(id);
        ideStatus.delete(id);
        trustStatus.delete(id);
      } else {
        let prior = manager.get(id) ?? undefined;
        if (!prior) throw Object.assign(new Error('session-not-found'), { code: 'session-not-found' });

        // If the session still has an open terminal:
        // - In interactive mode, if the CLI exited (`cli-exited`), offer to stop the remaining shell and reopen as a new session.
        // - Otherwise fail fast before taking an account quota reservation or writing instruction files.
        if (prior.terminalOpen) {
          if (interactive && prior.state === 'cli-exited') {
            const answer = await vscode.window.showWarningMessage(
              'The CLI in this session has exited, but its shell terminal is still open.',
              { modal: true, detail: 'Stop the old shell terminal and reopen as a new session with the same project, role group, provider, and account?' },
              'Stop & Reopen'
            );
            if (answer !== 'Stop & Reopen') return { ok: false, code: 'cancelled', message: 'Cancelled.' };
            prior = manager.stop(id);
            ideStatus.delete(id);
            trustStatus.delete(id);
            await releaseReservation(id);
            observations.release(id);
            changed.fire();
          } else {
            throw Object.assign(new Error('session-still-open'), { code: 'session-still-open' });
          }
        }

        // After a restart a terminal from before may still be running a CLI in this folder, and this
        // window cannot see it. Ask for confirmation BEFORE taking account reservations or writing instruction files.
        let acknowledgeUnknown = input.acknowledgeUnknown === true;
        if (prior.state === 'unknown' && !acknowledgeUnknown) {
          if (!interactive) throw Object.assign(new Error('confirm-unknown-reopen'), { code: 'confirm-unknown-reopen' });
          const answer = await vscode.window.showWarningMessage(
            'A terminal from before this window started may still be running in the same folder.',
            { modal: true, detail: 'Opening another one could mean two agents writing to the same files. Check the terminals first.' },
            'Open Anyway'
          );
          if (answer !== 'Open Anyway') return { ok: false, code: 'cancelled', message: 'Cancelled.' };
          acknowledgeUnknown = true;
        }

        if (!fs.existsSync(prior.worktree) || !fs.statSync(prior.worktree).isDirectory()) {
          throw Object.assign(new Error('worktree-missing'), { code: 'worktree-missing' });
        }
        // The saved path came from private storage: before it becomes a terminal's cwd, confirm it is
        // still this project's own folder or a worktree of the same repository.
        const projectFolders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
        if (!await worktreeInProject(prior.worktree, projectFolders, { commonDir: async (dir: string) => { try { return (await WorktreeService.open(dir)).commonDir as string; } catch { return null; } } })) {
          throw Object.assign(new Error('worktree-outside-project'), { code: 'worktree-outside-project' });
        }

        let env: Record<string, string | null> | undefined;
        if (prior.accountProfileId !== 'unassigned') {
          // A reopened session is a new launch on the same account and must clear the same
          // concurrency limit as a fresh start; otherwise reopen could bypass it entirely.
          const gate = await gateAccountLaunch(prior.accountProfileId, interactive, () => manager.list());
          if (!gate.ok) return gate.code === 'cancelled' ? { ok: false, code: 'cancelled', message: 'Cancelled.' } : failure(Object.assign(new Error(gate.message), { code: gate.code }), interactive);
          release = gate.release;
          const prepared = await launchEnvironment(prior.accountProfileId, prior.provider, () => manager.list());
          if (!prepared.ok) return failure(Object.assign(new Error(prepared.message), { code: prepared.code }), interactive);
          if (interactive) {
            const answer = await vscode.window.showWarningMessage(
              'Account isolation is not verified for this CLI on this machine.',
              { modal: true, detail: 'The profile will be revalidated and its configuration directory applied to the new terminal.' },
              'Continue'
            );
            if (answer !== 'Continue') return { ok: false, code: 'cancelled', message: 'Cancelled.' };
          }
          env = prepared.env;
        }

        let instructions: any;
        const newSessionId = randomUUID();
        let codenames: InstanceType<typeof CodenameStore> | undefined;
        let codenameAsk: CodenameRequest | undefined;
        let codename: string | undefined;
        let revertCodename: (() => void) | undefined;
        let ghWrapperDir: string | undefined;
        const openedStorage = await privateStorage()?.use();
        const isolation = await isolationForLaunch(interactive, input.launch, prior.worktree, openedStorage, prior.provider);
        if (isolation.kind === 'refused') {
          if (release) { await release(); release = undefined; }
          if (interactive && isolation.code !== 'cancelled') void vscode.window.showErrorMessage(isolation.message);
          return { ok: false, code: isolation.code, message: isolation.message };
        }
        if (isolation.kind === 'enforced') { isolationDispose = isolation.dispose; env = { ...(env ?? {}), ...isolation.env }; }
        const autoMode = autoModeFor(prior.provider, input.launch, isolation.kind);
        let autoModeShown = false;
        if (interactive && !(await confirmAutoModeOnce(context, autoMode))) { if (release) { await release(); release = undefined; } return { ok: false, code: 'cancelled', message: 'Cancelled.' }; }
        if (!openedStorage?.ok) {
          if (prior.roleGroupId !== 'unassigned') {
            const reason = openedStorage?.reason ?? 'storage-unavailable';
            if (release) { await release(); release = undefined; }
            return failure(Object.assign(new Error(`Private storage is unavailable (${reason}). Cannot prepare effective instructions.`), { code: 'storage-unavailable' }), interactive);
          }
          if (interactive) void vscode.window.showWarningMessage(NOTICES_UNREADABLE_WARNING);
        } else {
          const store = openedStorage.store as any;
          const privateDir = store.dir;
          const codexHome = prior.provider === 'codex' ? (env?.CODEX_HOME ?? path.join(privateDir, 'codex-home')) : undefined;
          if (codexHome && !env?.CODEX_HOME) env = { ...(env ?? {}), CODEX_HOME: codexHome };
          const project = await resolveProject(prior.worktree);
          // The reopened session takes over the old one's codename (issue #342); written only once the instructions are confirmed.
          codenames = new CodenameStore(store);
          codenameAsk = codenameRequest(store, project.repoId, newSessionId, prior.roleGroupId, id);
          const previewed = codenames.preview(codenameAsk);
          if (!previewed.ok) {
            if (release) { await release(); release = undefined; }
            return failure(codenameFailure(previewed.reason), interactive);
          }
          codename = previewed.codename;
          const prep = await prepareInstructionSnapshot({
            store,
            repoRoot: prior.worktree,
            repoId: project.repoId,
            provider: prior.provider,
            roleGroupId: prior.roleGroupId !== 'unassigned' ? prior.roleGroupId : undefined,
            accountProfileId: prior.accountProfileId !== 'unassigned' ? prior.accountProfileId : undefined,
            requestedModel: prior.requestedModel,
            targetSessionId: newSessionId,
            privateDir,
            codexHome,
            codename
          });
          if (!prep.ok) {
            if (release) { await release(); release = undefined; }
            return failure(Object.assign(new Error(prep.message), { code: prep.code }), interactive);
          }
          const priorRole = prior.roleGroupId !== 'unassigned' ? prior.roleGroupId : undefined;
          if (interactive && prep.digest && prep.reviewDigest && instructionsConfirmed(context, prior.provider, priorRole, prep.reviewDigest)) {
            void vscode.window.showInformationMessage(SAME_INSTRUCTIONS(prep.digest));
          } else if (interactive && prep.digest) {
            autoModeShown = true;
            const answer = await vscode.window.showInformationMessage(
              `Reopening session with effective instructions (${prep.digest.slice(0, 16)}...).`,
              { modal: true, detail: `Delivery method: ${prep.injectionStatusLabel}${autoMode.lines.length > 0 ? `\n\n${autoMode.lines.join('\n')}` : ''}` },
              'Reopen Session',
              'View Instructions'
            );
            if (!answer) {
              cleanupSessionPlan(prep.plan);
              if (release) { await release(); release = undefined; }
              return { ok: false, code: 'cancelled', message: 'Cancelled.' };
            }
            if (answer === 'View Instructions') {
              const uri = previewProvider.set(newSessionId, prep.summaryText);
              const doc = await vscode.workspace.openTextDocument(uri);
              await vscode.window.showTextDocument(doc, { preview: true });
              const proceed = await vscode.window.showInformationMessage(
                'Confirm reopening agent terminal with these effective instructions?',
                { modal: true },
                'Reopen Session'
              );
              if (proceed !== 'Reopen Session') {
                cleanupSessionPlan(prep.plan);
                if (release) { await release(); release = undefined; }
                return { ok: false, code: 'cancelled', message: 'Cancelled.' };
              }
            }
            if (prep.reviewDigest) await rememberInstructions(context, prior.provider, priorRole, prep.reviewDigest);
          }
          const staleCheck = await isSnapshotStale(prep.snapshot, { store, repoRoot: prior.worktree });
          if (staleCheck.stale) {
            cleanupSessionPlan(prep.plan);
            if (release) { await release(); release = undefined; }
            const msg = `Instructions changed or expired during review (${staleCheck.reason}). Please reopen again.`;
            if (interactive) void vscode.window.showErrorMessage(msg);
            return { ok: false, code: 'stale-instructions', message: msg };
          }
          const committed = codenames.assign({ ...codenameAsk, expect: codename });
          if (!committed.ok) {
            cleanupSessionPlan(prep.plan);
            if (release) { await release(); release = undefined; }
            return failure(codenameFailure(committed.reason), interactive);
          }
          const ask = codenameAsk;
          const store2 = codenames;
          revertCodename = () => { store2.revert({ repoId: ask.repoId, sessionId: ask.sessionId, ...(ask.from ? { from: ask.from } : {}) }); };
          const wrapper = prepareGhWrapper(privateDir, newSessionId, codename, env);
          if (!wrapper.ok) {
            cleanupSessionPlan(prep.plan);
            if (release) { await release(); release = undefined; }
            revertCodename();
            revertCodename = undefined;
            return failure(Object.assign(new Error(wrapper.message), { code: 'gh-wrapper-unavailable' }), interactive);
          }
          env = wrapper.env;
          ghWrapperDir = wrapper.dir;
          { const dir = wrapper.dir; const previous = isolationDispose; isolationDispose = async () => { try { await previous?.(); } finally { removeShims(dir); } }; }
          instructions = prep;
        }

        await preTrustWorktree(prior.provider, newSessionId, prior.worktree, env, interactive);
        const observedLaunch = observations.prepare({
          sessionId: newSessionId,
          provider: prior.provider,
          accountProfileId: prior.accountProfileId,
          env: withIdePort(prior.provider, newSessionId, env)
        });
        let attributionFile: string | undefined;
        try {
          attributionFile = attributionFileFor(prior.provider, input.launch, openedStorage, newSessionId, instructions?.toolPermissions);
        } catch (error) {
          try { revertCodename?.(); } catch { /* the number stays used either way */ }
          if (instructions?.plan) cleanupSessionPlan(instructions.plan);
          observations.release(newSessionId);
          throw error;
        }
        if (attributionFile) { const file = attributionFile; const previous = isolationDispose; isolationDispose = async () => { try { await previous?.(); } finally { removeClaudeSettings(file); } }; }
        try {
          session = await manager.reopen(id, { newId: newSessionId, launch: input.launch, acknowledgeUnknown, env: observedLaunch.env, instructions, ...(isolation.kind === 'enforced' ? { wrap: isolation.wrap } : {}), ...(attributionFile ? { attributionFile } : {}), ...(prior.provider === 'codex' && input.launch !== false ? { permissionArgs: codexArguments(instructions?.toolPermissions).args } : {}), ...(autoMode.auto ? { autoMode: autoMode.auto } : {}), ...(codename !== undefined && revertCodename ? { codename } : {}), ...(ghWrapperDir ? { pathPrefix: ghWrapperDir } : {}), launchNote: launchNote(prior.provider, codename) });
          revertCodename = undefined;
          if (interactive && autoMode.auto && autoMode.auto.state !== 'off' && !autoModeShown) void vscode.window.showInformationMessage(autoMode.lines.join(' '));
        } catch (error) {
          observations.release(newSessionId);
          try { revertCodename?.(); } catch { /* the number stays used either way */ }
          throw error;
        }
        if (isolationDispose && manager.get(session.id)?.terminalOpen) { isolations.set(session.id, isolationDispose); isolationDispose = undefined; }
        if (release && manager.get(session.id)?.terminalOpen) { reservations.set(session.id, release); release = undefined; }
      }
      changed.fire();
      return { ok: true, session };
    } catch (error) {
      return failure(error, interactive);
    } finally {
      await release?.();
      // Not handed to a session (the reopen failed or was cancelled): nothing of it may outlive this call.
      await isolationDispose?.();
    }
  }

  // Always interactive: the person types the name. A caller can name the session (the overview row does),
  // but nothing a command argument carries can supply or skip the name prompt, in any mode.
  async function rename(value: unknown): Promise<SessionOutcome> {
    try {
      const input = options(value);
      let id = typeof input.id === 'string' && input.id ? input.id : undefined;
      if (!id) {
        const picked = await pickSession('Choose a session to rename', () => true);
        if (!picked) return { ok: false, code: 'cancelled', message: 'Cancelled.' };
        id = picked.id;
      }
      const target = manager.get(id);
      if (!target) throw Object.assign(new Error('session-not-found'), { code: 'session-not-found' });
      const typed = await vscode.window.showInputBox({
        title: 'Rename session',
        prompt: 'The new name is shown in the overview and saved with the session. An open terminal keeps the title it has.',
        value: target.name,
        validateInput: (text) => (cleanName(text) ? undefined : MESSAGES['invalid-name'])
      });
      if (typed === undefined) return { ok: false, code: 'cancelled', message: 'Cancelled.' };
      const session = await manager.rename(id, typed);
      changed.fire();
      return { ok: true, session };
    } catch (error) {
      return failure(error, true);
    }
  }

  async function list(value: unknown): Promise<SessionOutcome> {
    const input = options(value);
    if (input.interactive === false) return { ok: true, sessions: withIdeLabels(observations.enrich(manager.list())) };
    const picked = await pickSession('Sessions in this window (state is shown only when there is evidence)', () => true);
    if (!picked) return { ok: true, sessions: manager.list() };
    const actions = picked.terminalOpen
      ? picked.state === 'cli-exited'
        ? ['Focus Terminal', 'Stop & Reopen as New Session', 'Stop Terminal', 'View Effective Instructions']
        : ['Focus Terminal', 'Stop Terminal', 'View Effective Instructions']
      : ['Reopen as New Session', 'View Effective Instructions'];
    const choice = await vscode.window.showQuickPick(actions, { placeHolder: `${picked.name}: ${picked.stateLabel}` });
    if (choice === 'Focus Terminal') await act('focus', { id: picked.id });
    else if (choice === 'Stop Terminal') await act('stop', { id: picked.id });
    else if (choice === 'Stop & Reopen as New Session' || choice === 'Reopen as New Session') await act('reopen', { id: picked.id });
    else if (choice === 'View Effective Instructions') {
      const text = [
        'PRIVATE — local session instructions snapshot. Do not publish this document.',
        `Session ID: ${picked.id}`,
        `Provider: ${picked.provider}`,
        `Role group: ${picked.roleGroupId}`,
        `Account: ${picked.accountProfileId}`,
        `Requested model: ${picked.requestedModel ?? 'CLI default'}`,
        `Instruction delivery: ${picked.instructionStatusLabel ?? 'unknown'}`,
        `Instruction digest: ${picked.instructionDigest ?? 'none'}`,
        `Method: ${picked.instructionMethod ?? 'none'}`
      ].join('\n');
      const uri = previewProvider.set(picked.id, text);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: true });
    }
    return { ok: true, sessions: observations.enrich(manager.list()) };
  }

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      const closedId = manager.handleTerminalClosed(terminal);
      if (closedId) {
        void releaseReservation(closedId);
        observations.release(closedId);
      }
      changed.fire();
    }),
    // list with `interactive: false` only returns the in-memory session list and opens no picker.
    vscode.commands.registerCommand(SESSION_COMMANDS.list, (value?: unknown) => list(value)),
    // start, stop and reopen launch or end terminals and take account quota: outside test mode they
    // always run interactively, and reopen's `acknowledgeUnknown` cannot skip its warning.
    vscode.commands.registerCommand(SESSION_COMMANDS.start, (value?: unknown) => launch(requireInteractive(options(value)))),
    // focus only brings an existing terminal forward; offering a reopen happens only interactively.
    vscode.commands.registerCommand(SESSION_COMMANDS.focus, (value?: unknown) => act('focus', value)),
    // A caller-supplied id asks the person first (see act); the overview row's own Stop action does not.
    vscode.commands.registerCommand(SESSION_COMMANDS.stop, (value?: unknown) => act('stop', requireInteractive(options(value)), isOwnUiItem(value))),
    vscode.commands.registerCommand(SESSION_COMMANDS.rename, (value?: unknown) => rename(value)),
    vscode.commands.registerCommand(SESSION_COMMANDS.reopen, (value?: unknown) => act('reopen', withoutAcknowledge(requireInteractive(options(value)))))
  );

  void manager.initialize().then(async () => {
    // The codename store is the authority: a saved session whose codename it no longer lists stops showing one (issue #342).
    const opened = await privateStorage()?.use();
    if (opened?.ok) {
      const codenames = new CodenameStore(opened.store);
      await manager.reconcileCodenames((repoId, sessionId) => { const held = codenames.get(repoId, sessionId); return held.ok ? held.codename : undefined; });
    }
    changed.fire();
  }).catch((error) => failure(error, true));
  return { launch, launchWithAccount: startWithAccount, list: () => withIdeLabels(observations.enrich(manager.list())), sendPrompt: (id, prompt) => manager.sendPrompt(id, prompt), onDidChange: (listener) => changed.event(listener) };
}
