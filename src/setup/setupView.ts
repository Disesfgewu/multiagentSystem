import * as path from 'node:path';
import * as vscode from 'vscode';
import { ManagedGh, Downloader, GhRelease, GhStatus } from './managedGh';
import { ManagedCodex, CodexRelease, CodexStatus } from './managedCodex';
import { ManagedClaude, ClaudeRelease, ClaudeStatus } from './managedClaude';
import { privateStorage } from '../storage/storageCommands';
import { describeStorage } from '../storage/extensionStorage';
import { CONFIRM_CLEAR } from '../storage/private-store';
import { CONFIRM_RECOVER } from '../shared/lock';

export const RECOVER_LOCK_LABEL = 'Recover Lock';
import { observationsFor } from '../accounts/accountCommands';
import { isExtensionTestMode, requireInteractive } from '../shared/testMode';

const { executableAvailable } = require('../providers/executable') as { executableAvailable(name: string): boolean };
const { diagnose, formatDiagnosticReport } = require('./diagnostics') as {
  diagnose(input: Record<string, unknown>): Record<string, any>;
  formatDiagnosticReport(report: Record<string, any>): string;
};
const { listResearchTools } = require('../research/installer') as {
  listResearchTools(deps: { store?: any; root?: string }): any[];
};

export const SETUP_VIEW = 'multiagentSystem.toolsSetupView';
export const DIAGNOSTICS_SCHEME = 'multiagent-diagnostics';
export const SETUP_COMMANDS = {
  refresh: 'multiagentSystem.setup.refresh',
  retryGh: 'multiagentSystem.setup.retryGh',
  retryCodex: 'multiagentSystem.setup.retryCodex',
  retryClaude: 'multiagentSystem.setup.retryClaude',
  diagnose: 'multiagentSystem.setup.diagnose',
  migrateStorage: 'multiagentSystem.setup.migrateStorage',
  recoverStorageLock: 'multiagentSystem.setup.recoverStorageLock',
  clearStorage: 'multiagentSystem.setup.clearStorage'
} as const;

interface SetupOverrides {
  platform?: string; arch?: string; release?: GhRelease | null; download?: Downloader;
  codexRelease?: CodexRelease | null; codexDownload?: Downloader;
  claudeRelease?: ClaudeRelease | null; claudeDownload?: Downloader;
}
let overrides: SetupOverrides = {};
let active: SetupController | undefined;

/** Test-only dependency replacement. Production never reads download locations from settings or command arguments. */
export function setSetupDepsForTests(next?: SetupOverrides): void {
  overrides = next ?? {};
  active?.replaceManager();
}

class ToolItem extends vscode.TreeItem {
  constructor(label: string, description: string, tooltip: string, icon: string, contextValue?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.tooltip = tooltip;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = contextValue;
  }
}

class SetupController implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changed = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private ghManager: ManagedGh;
  private codexManager: ManagedCodex;
  private claudeManager: ManagedClaude;
  private preparingGh = false;
  private preparingCodex = false;
  private preparingClaude = false;
  private readonly managedBins = new Map<'gh' | 'codex' | 'claude', string>();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.ghManager = this.createGhManager();
    this.codexManager = this.createCodexManager();
    this.claudeManager = this.createClaudeManager();
    this.context.environmentVariableCollection.description = 'Verified tools prepared by Multiagent';
  }
  dispose(): void { this.changed.dispose(); }
  replaceManager(): void {
    this.ghManager = this.createGhManager();
    this.codexManager = this.createCodexManager();
    this.claudeManager = this.createClaudeManager();
    this.managedBins.clear();
    this.applyPath();
    this.refresh();
  }
  private createGhManager(): ManagedGh {
    return new ManagedGh({ root: path.join(this.context.globalStorageUri.fsPath, 'managed-tools', 'gh'), boundary: this.context.globalStorageUri.fsPath, ...overrides });
  }
  private createCodexManager(): ManagedCodex {
    return new ManagedCodex({
      root: path.join(this.context.globalStorageUri.fsPath, 'managed-tools', 'codex'), boundary: this.context.globalStorageUri.fsPath,
      platform: overrides.platform, arch: overrides.arch, release: overrides.codexRelease, download: overrides.codexDownload
    });
  }
  private createClaudeManager(): ManagedClaude {
    return new ManagedClaude({
      root: path.join(this.context.globalStorageUri.fsPath, 'managed-tools', 'claude'), boundary: this.context.globalStorageUri.fsPath,
      platform: overrides.platform, arch: overrides.arch, release: overrides.claudeRelease, download: overrides.claudeDownload
    });
  }
  refresh(): void { this.changed.fire(undefined); }
  getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }

  private applyPath(): void {
    this.context.environmentVariableCollection.delete('PATH');
    const value = [...this.managedBins.values()].join(path.delimiter);
    if (value) this.context.environmentVariableCollection.prepend('PATH', `${value}${path.delimiter}`);
  }
  private syncPath(tool: 'gh' | 'codex' | 'claude', status: GhStatus | CodexStatus | ClaudeStatus): void {
    if (status.state === 'ready') this.managedBins.set(tool, status.binDir);
    else this.managedBins.delete(tool);
    this.applyPath();
  }

  private async storageAllowed(): Promise<boolean> {
    try { return (await privateStorage()?.use())?.ok === true; } catch { return false; }
  }

  async ghStatus(): Promise<GhStatus> {
    const status = await this.storageAllowed() ? await this.ghManager.status() : { state: 'missing', reason: 'private-storage-unavailable' } as GhStatus;
    this.syncPath('gh', status);
    return status;
  }
  async codexStatus(): Promise<CodexStatus> {
    const status = await this.storageAllowed() ? await this.codexManager.status() : { state: 'missing', reason: 'private-storage-unavailable' } as CodexStatus;
    this.syncPath('codex', status);
    return status;
  }
  async claudeStatus(): Promise<ClaudeStatus> {
    const status = await this.storageAllowed() ? await this.claudeManager.status() : { state: 'missing', reason: 'private-storage-unavailable' } as ClaudeStatus;
    this.syncPath('claude', status);
    return status;
  }
  managedBinForTests(): string | undefined { return [...this.managedBins.values()].join(path.delimiter) || undefined; }

  async getChildren(): Promise<vscode.TreeItem[]> {
    const [gh, codex, claude] = await Promise.all([this.ghStatus(), this.codexStatus(), this.claudeStatus()]);
    const ghItem = gh.state === 'ready'
      ? new ToolItem('GitHub CLI (gh)', `Ready · ${gh.version}`, `Verified SHA-256 after extraction. Source: ${gh.source}\nChecked: ${gh.verifiedAt}`, 'verified-filled', 'multiagentSetupGh')
      : new ToolItem('GitHub CLI (gh)', this.preparingGh ? 'Preparing…' : gh.state === 'unsupported' ? 'Unavailable on this platform' : 'Needs setup', `Managed setup: ${gh.reason}. Retry downloads only the fixed official release and verifies its SHA-256 before use.`, this.preparingGh ? 'sync~spin' : 'warning', 'multiagentSetupGh');
    const claudeItem = claude.state === 'ready'
      ? new ToolItem('Claude Code', `Ready · ${claude.version}`, `Verified from the pinned Anthropic release asset. Source: ${claude.source}\nChecked: ${claude.verifiedAt}\nSign-in, identity, quota and rule injection are not implied.`, 'verified-filled', 'multiagentSetupClaude')
      : new ToolItem('Claude Code', this.preparingClaude ? 'Preparing…' : claude.state === 'unsupported' ? 'Unavailable on this platform' : 'Needs setup', `Managed setup: ${claude.reason}. Retry uses only the pinned Anthropic release asset and verifies SHA-256 before use.`, this.preparingClaude ? 'sync~spin' : 'warning', 'multiagentSetupClaude');
    const codexItem = codex.state === 'ready'
      ? new ToolItem('Codex CLI', `Ready · ${codex.version}`, `Verified from the pinned OpenAI release asset. Source: ${codex.source}\nChecked: ${codex.verifiedAt}\nSign-in, identity, quota and rule injection are not implied.`, 'verified-filled', 'multiagentSetupCodex')
      : new ToolItem('Codex CLI', this.preparingCodex ? 'Preparing…' : codex.state === 'unsupported' ? 'Unavailable on this platform' : 'Needs setup', `Managed setup: ${codex.reason}. Retry uses only the pinned OpenAI release asset and verifies SHA-256 before use.`, this.preparingCodex ? 'sync~spin' : 'warning', 'multiagentSetupCodex');
    const observed = (name: string): string => executableAvailable(name) ? 'Found on PATH · not verified by setup' : 'Not prepared or verified';
    let researchItems: vscode.TreeItem[] = [];
    try {
      const opened = await privateStorage()?.use();
      const store = opened && opened.ok ? opened.store : undefined;
      const researchRoot = path.join(this.context.globalStorageUri.fsPath, 'managed-tools', 'research');
      const researchTools = listResearchTools({ store, root: researchRoot });
      researchItems = researchTools.map((t: any) => {
        const icon = t.consentStatus === 'consented' ? (t.installStatus === 'ready' ? 'verified-filled' : 'shield') : 'beaker';
        const tooltip = [
          `Research MCP Tool: ${t.name} (${t.serverId})`,
          `Version: ${t.version}`,
          `Source: ${t.source}`,
          `License: ${t.license}`,
          `Permissions: ${t.permissions.join(', ') || 'None (pure local computation)'}`,
          `Status: ${t.statusLabel}`,
          '',
          'Right-click or use inline actions to Review & Consent or Inspect Manifest.'
        ].join('\n');
        return new ToolItem(
          t.name,
          `${t.version} · ${t.statusLabel}`,
          tooltip,
          icon,
          `multiagentResearchTool_${t.serverId}`
        );
      });
    } catch {
      // Best-effort research tools display in setup view
    }

    return [
      new ToolItem('Git', observed('git'), 'Required for worktrees. Managed deployment is still blocked by the macOS source gap and has not been implemented.', 'question'),
      ghItem,
      claudeItem,
      codexItem,
      new ToolItem(
        'agy',
        executableAvailable('agy') ? 'Found on PATH · not verified by setup' : 'Unverified · auto-deployment unsupported',
        executableAvailable('agy')
          ? 'Found on PATH. Fixed official binary assets, SHA-256 verification and redistribution terms are unverified (Refs #73, #94, docs/AGY_INVESTIGATION.md); managed automatic deployment is unsupported. Sign-in, identity, quota and rule injection are not implied.'
          : 'Fixed official release binaries, integrity digests, and redistribution terms are unverified (Refs #73, #94, docs/AGY_INVESTIGATION.md). Automatic deployment is unsupported; install the official agy CLI manually on PATH.',
        'question'
      ),
      ...researchItems
    ];
  }

  async prepareGh(interactive: boolean): Promise<GhStatus> {
    if (this.preparingGh) return this.ghManager.status();
    this.preparingGh = true;
    this.refresh();
    try {
      if (!await this.storageAllowed()) {
        const refused: GhStatus = { state: 'missing', reason: 'private-storage-unavailable' };
        this.syncPath('gh', refused);
        if (interactive) void vscode.window.showErrorMessage('Tool setup is unavailable because the extension storage folder could not be verified outside the project.');
        return refused;
      }
      const run = async (progress?: vscode.Progress<{ message?: string; increment?: number }>): Promise<GhStatus> => {
        let last = 0;
        return this.ghManager.prepare(({ received, total }) => {
          if (!progress || !total || total <= 0) return;
          const percent = Math.min(100, Math.floor(received / total * 100));
          progress.report({ increment: Math.max(0, percent - last), message: `${percent}% downloaded and awaiting verification` });
          last = percent;
        });
      };
      const result = interactive
        ? await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Preparing verified GitHub CLI', cancellable: false }, run)
        : await run();
      this.syncPath('gh', result);
      if (interactive) {
        if (result.state === 'ready') void vscode.window.showInformationMessage(`GitHub CLI ${result.version} is verified and ready for new managed terminals.`);
        else void vscode.window.showErrorMessage('GitHub CLI setup did not complete. Open Tools Setup for the current status and retry.');
      }
      return result;
    } finally { this.preparingGh = false; this.refresh(); }
  }

  async prepareCodex(interactive: boolean): Promise<CodexStatus> {
    if (this.preparingCodex) return this.codexManager.status();
    this.preparingCodex = true;
    this.refresh();
    try {
      if (!await this.storageAllowed()) {
        const refused: CodexStatus = { state: 'missing', reason: 'private-storage-unavailable' };
        this.syncPath('codex', refused);
        if (interactive) void vscode.window.showErrorMessage('Tool setup is unavailable because the extension storage folder could not be verified outside the project.');
        return refused;
      }
      const run = async (progress?: vscode.Progress<{ message?: string; increment?: number }>): Promise<CodexStatus> => {
        let last = 0;
        return this.codexManager.prepare(({ received, total }) => {
          if (!progress || !total || total <= 0) return;
          const percent = Math.min(100, Math.floor(received / total * 100));
          progress.report({ increment: Math.max(0, percent - last), message: `${percent}% downloaded and awaiting verification` });
          last = percent;
        });
      };
      const result = interactive
        ? await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Preparing verified Codex CLI', cancellable: false }, run)
        : await run();
      this.syncPath('codex', result);
      if (interactive) {
        if (result.state === 'ready') void vscode.window.showInformationMessage(`Codex CLI ${result.version} is verified and ready for new managed terminals. Sign-in is still required.`);
        else void vscode.window.showErrorMessage('Codex CLI setup did not complete. Open Tools Setup for the current status and retry.');
      }
      return result;
    } finally { this.preparingCodex = false; this.refresh(); }
  }

  async prepareClaude(interactive: boolean): Promise<ClaudeStatus> {
    if (this.preparingClaude) return this.claudeManager.status();
    this.preparingClaude = true;
    this.refresh();
    try {
      if (!await this.storageAllowed()) {
        const refused: ClaudeStatus = { state: 'missing', reason: 'private-storage-unavailable' };
        this.syncPath('claude', refused);
        if (interactive) void vscode.window.showErrorMessage('Tool setup is unavailable because the extension storage folder could not be verified outside the project.');
        return refused;
      }
      const run = async (progress?: vscode.Progress<{ message?: string; increment?: number }>): Promise<ClaudeStatus> => {
        let last = 0;
        return this.claudeManager.prepare(({ received, total }) => {
          if (!progress || !total || total <= 0) return;
          const percent = Math.min(100, Math.floor(received / total * 100));
          progress.report({ increment: Math.max(0, percent - last), message: `${percent}% downloaded and awaiting verification` });
          last = percent;
        });
      };
      const result = interactive
        ? await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Preparing verified Claude Code CLI', cancellable: false }, run)
        : await run();
      this.syncPath('claude', result);
      if (interactive) {
        if (result.state === 'ready') void vscode.window.showInformationMessage(`Claude Code CLI ${result.version} is verified and ready for new managed terminals. Sign-in is still required.`);
        else void vscode.window.showErrorMessage('Claude Code CLI setup did not complete. Open Tools Setup for the current status and retry.');
      }
      return result;
    } finally { this.preparingClaude = false; this.refresh(); }
  }

  async autoPrepare(): Promise<void> {
    if (!await this.storageAllowed()) {
      this.syncPath('gh', { state: 'missing', reason: 'private-storage-unavailable' });
      this.syncPath('codex', { state: 'missing', reason: 'private-storage-unavailable' });
      this.syncPath('claude', { state: 'missing', reason: 'private-storage-unavailable' });
      void vscode.window.showWarningMessage('First-use tool setup is unavailable because the extension storage folder could not be verified outside the project.');
      return;
    }
    const [gh] = await Promise.all([this.ghStatus(), this.codexStatus(), this.claudeStatus()]);
    // gh is required by #73 and keeps the automatic first-use path. Codex is an optional provider
    // and its official asset is large, so it is prepared only after the user invokes its visible
    // Tools Setup action. A CLI download is never treated as consent to sign in or enable a provider.
    if (gh.state === 'ready' || gh.state === 'unsupported') return;
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'First-use setup: preparing verified GitHub CLI', cancellable: false }, async (progress) => {
      let last = 0;
      this.preparingGh = true;
      this.refresh();
      try {
        return await this.ghManager.prepare(({ received, total }) => {
          if (!total || total <= 0) return;
          const percent = Math.min(100, Math.floor(received / total * 100));
          progress.report({ increment: Math.max(0, percent - last), message: `${percent}% downloaded and awaiting verification` });
          last = percent;
        });
      } finally { this.preparingGh = false; this.refresh(); }
    });
    this.syncPath('gh', result);
    if (result.state !== 'ready') void vscode.window.showWarningMessage('First-use tool setup needs attention. Open Multiagent → Tools Setup to see the unverified or missing item.');
  }

  async runDiagnostics(options?: { interactive?: boolean; probeSecrets?: boolean }): Promise<{ ok: true; report: Record<string, any>; text: string; uri: string }> {
    const interactive = options?.interactive !== false;
    const probeSecrets = options?.probeSecrets === true;
    const handle = privateStorage();
    const storageStatus = handle ? await describeStorage(handle, { probeSecrets }) : null;
    const used = handle ? await handle.use() : { ok: false as const, reason: 'context-incomplete', problems: ['storage-handle-missing'] };

    let storeStatus: Record<string, unknown> | null = null;
    let lockStatus: Record<string, unknown> | null = null;
    let maskedExport: Record<string, unknown> | null = null;
    let profiles: Array<{ id: string; [key: string]: unknown }> = [];
    let repoRoot: string | null = null;

    if (used.ok) {
      storeStatus = used.store.status() as Record<string, unknown>;
      lockStatus = used.store.inspectLock() as Record<string, unknown>;
      maskedExport = used.store.exportMasked() as Record<string, unknown>;
      repoRoot = (used.store as unknown as { repoRoot?: string }).repoRoot ?? null;
      const listed = used.store.list('profiles') as { ok: boolean; items?: Array<{ id: string; value: Record<string, unknown> }> };
      if (listed.ok && Array.isArray(listed.items)) {
        profiles = listed.items.map((entry) => ({ id: entry.id, ...entry.value }));
      }
    }

    const [gh, codex, claude] = await Promise.all([this.ghStatus(), this.codexStatus(), this.claudeStatus()]);
    const executables = {
      git: executableAvailable('git'),
      gh: executableAvailable('gh'),
      claude: executableAvailable('claude'),
      codex: executableAvailable('codex'),
      agy: executableAvailable('agy')
    };

    const report = diagnose({
      vscodeVersion: vscode.version,
      nodeVersion: process.versions.node,
      storageStatus,
      storeStatus,
      lockStatus,
      maskedExport,
      profiles,
      observations: observationsFor(profiles),
      repoRoot,
      executables,
      managedTools: { gh, codex, claude }
    });
    const text = formatDiagnosticReport(report);
    const uri = vscode.Uri.parse(`${DIAGNOSTICS_SCHEME}:/setup-and-storage.md`);
    latestDiagnosticsText = text;
    diagnosticsEmitter.fire(uri);

    if (interactive) {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
    }
    return { ok: true, report, text, uri: uri.toString() };
  }

  async migrateStorage(options?: { interactive?: boolean }): Promise<Record<string, unknown>> {
    const interactive = options?.interactive !== false;
    const handle = privateStorage();
    const used = handle ? await handle.use() : { ok: false as const, reason: 'context-incomplete', problems: ['storage-handle-missing'] };
    if (!used.ok) {
      if (interactive) void vscode.window.showErrorMessage(`Private storage cannot be migrated because storage is unavailable (${used.reason}).`);
      return { ok: false, reason: used.reason, problems: used.problems };
    }
    const outcome = used.store.migrate() as { ok: boolean; onDiskVersion?: number | null; reason?: string; detail?: string | null };
    this.refresh();
    if (interactive) {
      if (outcome.ok) {
        void vscode.window.showInformationMessage(`Private storage schema is up to date (v${outcome.onDiskVersion ?? 'unknown'}).`);
      } else {
        void vscode.window.showErrorMessage(`Private storage migration failed (${outcome.reason ?? 'unknown'}).`);
      }
    }
    return outcome;
  }

  async recoverStorageLock(options?: { interactive?: boolean; force?: boolean; confirm?: string }): Promise<Record<string, unknown>> {
    const interactive = options?.interactive !== false;
    const handle = privateStorage();
    const used = handle ? await handle.use() : { ok: false as const, reason: 'context-incomplete', problems: ['storage-handle-missing'] };
    if (!used.ok) {
      if (interactive) void vscode.window.showErrorMessage(`Cannot inspect or recover lock because private storage is unavailable (${used.reason}).`);
      return { ok: false, reason: used.reason, problems: used.problems };
    }
    const inspected = used.store.inspectLock() as { ok: boolean; held?: boolean; stale?: boolean; reason?: string };
    if (!inspected.ok) {
      if (interactive) void vscode.window.showErrorMessage(`Could not inspect storage lock (${inspected.reason ?? 'unknown'}).`);
      return inspected;
    }
    if (!inspected.held) {
      if (interactive) void vscode.window.showInformationMessage('No private storage lock is currently held.');
      return { ok: true, recovered: false, reason: 'not-locked' };
    }
    // Recovery removes the lock file, so the store requires CONFIRM_RECOVER. It is passed only after the
    // person answers the dialog; before #192 it was never passed, so this command always failed with
    // `confirmation-required`. A `confirm` (or `force`) argument reaches here only in extension test mode.
    let force = Boolean(options?.force);
    let confirm = options?.confirm;
    if (interactive && confirm !== CONFIRM_RECOVER) {
      const choice = await vscode.window.showWarningMessage(
        inspected.stale
          ? 'The private storage single-writer lock is stale. Recover it only if no other VS Code window is writing.'
          : 'The private storage single-writer lock is held. Recover it only if no other VS Code window is writing.',
        { modal: true, detail: 'Recovering removes the lock file. A lock whose owner may still be running is refused.' },
        RECOVER_LOCK_LABEL
      );
      if (choice !== RECOVER_LOCK_LABEL) return { ok: false, recovered: false, reason: 'cancelled' };
      confirm = CONFIRM_RECOVER;
      if (options?.force === undefined) force = inspected.stale === true;
    }
    const outcome = used.store.recoverLock({ force, confirm }) as { ok: boolean; recovered?: boolean; reason?: string };
    this.refresh();
    if (interactive) {
      if (outcome.ok && outcome.recovered) {
        void vscode.window.showInformationMessage('Recovered the stale private storage lock.');
      } else {
        void vscode.window.showWarningMessage(`Could not recover private storage lock (${outcome.reason ?? 'lock-active'}).`);
      }
    }
    return outcome;
  }

  async clearStorage(options?: { interactive?: boolean; confirm?: string; includeBackups?: boolean }): Promise<Record<string, unknown>> {
    const interactive = options?.interactive !== false;
    const handle = privateStorage();
    const used = handle ? await handle.use() : { ok: false as const, reason: 'context-incomplete', problems: ['storage-handle-missing'] };
    if (!used.ok) {
      if (interactive) void vscode.window.showErrorMessage(`Cannot clear private storage because the storage folder could not be verified (${used.reason}).`);
      return { ok: false, reason: used.reason, problems: used.problems };
    }
    let confirmToken = options?.confirm;
    if (interactive) {
      const choice = await vscode.window.showWarningMessage(
        'Clear all Multiagent private storage files owned by this extension? Unrecognized backup files are preserved.',
        { modal: true },
        'Clear Private Storage'
      );
      if (choice !== 'Clear Private Storage') return { ok: false, reason: 'cancelled' };
      confirmToken = CONFIRM_CLEAR;
    }
    const outcome = used.store.clear({
      confirm: confirmToken,
      includeBackups: options?.includeBackups ?? true
    } as never) as { ok: boolean; reason?: string; removed?: { store: boolean; backups: number; temps: number; kept: Record<string, number> } };
    this.refresh();
    if (interactive) {
      if (outcome.ok) {
        void vscode.window.showInformationMessage('Cleared private storage files owned by this extension.');
      } else {
        void vscode.window.showErrorMessage(`Could not clear private storage (${outcome.reason ?? 'unknown'}).`);
      }
    }
    return outcome;
  }
}

let latestDiagnosticsText = '# Multiagent Masked Setup & Storage Diagnostics\n\nRun `Multiagent: Open Masked Setup and Storage Diagnostics` to generate a report.\n';
const diagnosticsEmitter = new vscode.EventEmitter<vscode.Uri>();

export function managedPathContributionForTests(): string | undefined { return active?.managedBinForTests(); }

export function setupTreeForTests(): vscode.TreeDataProvider<vscode.TreeItem> {
  if (!active) throw new Error('Tools Setup is not registered.');
  return active;
}

/** `force` and `confirm` decide a lock recovery without the dialog; only the extension's own tests may pass them. */
function withoutForce<T extends { force?: boolean; confirm?: string }>(options: T): T {
  return (options.force !== undefined || options.confirm !== undefined) && !isExtensionTestMode() ? { ...options, force: undefined, confirm: undefined } : options;
}

export function registerSetup(context: vscode.ExtensionContext): void {
  const controller = new SetupController(context);
  active = controller;
  const diagnosticsProvider: vscode.TextDocumentContentProvider = {
    onDidChange: diagnosticsEmitter.event,
    provideTextDocumentContent: () => latestDiagnosticsText
  };
  context.subscriptions.push(
    controller,
    vscode.workspace.registerTextDocumentContentProvider(DIAGNOSTICS_SCHEME, diagnosticsProvider),
    vscode.window.createTreeView(SETUP_VIEW, { treeDataProvider: controller }),
    vscode.commands.registerCommand(SETUP_COMMANDS.refresh, () => controller.refresh()),
    vscode.commands.registerCommand(SETUP_COMMANDS.retryGh, () => controller.prepareGh(true)),
    vscode.commands.registerCommand(SETUP_COMMANDS.retryCodex, () => controller.prepareCodex(true)),
    vscode.commands.registerCommand(SETUP_COMMANDS.retryClaude, () => controller.prepareClaude(true)),
    // diagnose only reads and returns a masked report; `interactive: false` just skips opening it.
    vscode.commands.registerCommand(SETUP_COMMANDS.diagnose, (arg?: unknown) =>
      controller.runDiagnostics(arg && typeof arg === 'object' ? (arg as { interactive?: boolean; probeSecrets?: boolean }) : undefined)),
    // migrate, recover-lock and clear write or delete private storage: outside test mode they always run
    // interactively, so `confirm` (clear) and `force` (recover-lock) cannot answer the dialog for the person.
    vscode.commands.registerCommand(SETUP_COMMANDS.migrateStorage, (arg?: unknown) =>
      controller.migrateStorage(arg && typeof arg === 'object' ? requireInteractive(arg as { interactive?: boolean }) : undefined)),
    vscode.commands.registerCommand(SETUP_COMMANDS.recoverStorageLock, (arg?: unknown) =>
      controller.recoverStorageLock(arg && typeof arg === 'object' ? withoutForce(requireInteractive(arg as { interactive?: boolean; force?: boolean; confirm?: string })) : undefined)),
    vscode.commands.registerCommand(SETUP_COMMANDS.clearStorage, (arg?: unknown) =>
      controller.clearStorage(arg && typeof arg === 'object' ? requireInteractive(arg as { interactive?: boolean; confirm?: string; includeBackups?: boolean }) : undefined))
  );
  // Extension Host tests install a synthetic archive explicitly. Production activation performs
  // the first-use setup automatically; it never reads a URL or executable from the workspace.
  if (context.extensionMode !== vscode.ExtensionMode.Test) void controller.autoPrepare();
}
