import * as path from 'node:path';
import * as vscode from 'vscode';
import { ManagedGh, Downloader, GhRelease, GhStatus } from './managedGh';
import { ManagedCodex, CodexRelease, CodexStatus } from './managedCodex';
import { privateStorage } from '../storage/storageCommands';

const { executableAvailable } = require('../providers/executable') as { executableAvailable(name: string): boolean };

export const SETUP_VIEW = 'multiagentSystem.toolsSetupView';
export const SETUP_COMMANDS = {
  refresh: 'multiagentSystem.setup.refresh',
  retryGh: 'multiagentSystem.setup.retryGh',
  retryCodex: 'multiagentSystem.setup.retryCodex'
} as const;

interface SetupOverrides {
  platform?: string; arch?: string; release?: GhRelease | null; download?: Downloader;
  codexRelease?: CodexRelease | null; codexDownload?: Downloader;
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
  private preparingGh = false;
  private preparingCodex = false;
  private readonly managedBins = new Map<'gh' | 'codex', string>();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.ghManager = this.createGhManager();
    this.codexManager = this.createCodexManager();
    this.context.environmentVariableCollection.description = 'Verified tools prepared by Multiagent';
  }
  dispose(): void { this.changed.dispose(); }
  replaceManager(): void {
    this.ghManager = this.createGhManager();
    this.codexManager = this.createCodexManager();
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
  refresh(): void { this.changed.fire(undefined); }
  getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }

  private applyPath(): void {
    this.context.environmentVariableCollection.delete('PATH');
    const value = [...this.managedBins.values()].join(path.delimiter);
    if (value) this.context.environmentVariableCollection.prepend('PATH', `${value}${path.delimiter}`);
  }
  private syncPath(tool: 'gh' | 'codex', status: GhStatus | CodexStatus): void {
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
  managedBinForTests(): string | undefined { return [...this.managedBins.values()].join(path.delimiter) || undefined; }

  async getChildren(): Promise<vscode.TreeItem[]> {
    const [gh, codex] = await Promise.all([this.ghStatus(), this.codexStatus()]);
    const ghItem = gh.state === 'ready'
      ? new ToolItem('GitHub CLI (gh)', `Ready · ${gh.version}`, `Verified SHA-256 after extraction. Source: ${gh.source}\nChecked: ${gh.verifiedAt}`, 'verified-filled', 'multiagentSetupGh')
      : new ToolItem('GitHub CLI (gh)', this.preparingGh ? 'Preparing…' : gh.state === 'unsupported' ? 'Unavailable on this platform' : 'Needs setup', `Managed setup: ${gh.reason}. Retry downloads only the fixed official release and verifies its SHA-256 before use.`, this.preparingGh ? 'sync~spin' : 'warning', 'multiagentSetupGh');
    const codexItem = codex.state === 'ready'
      ? new ToolItem('Codex CLI', `Ready · ${codex.version}`, `Verified from the pinned OpenAI release asset. Source: ${codex.source}\nChecked: ${codex.verifiedAt}\nSign-in, identity, quota and rule injection are not implied.`, 'verified-filled', 'multiagentSetupCodex')
      : new ToolItem('Codex CLI', this.preparingCodex ? 'Preparing…' : codex.state === 'unsupported' ? 'Unavailable on this platform' : 'Needs setup', `Managed setup: ${codex.reason}. Retry uses only the pinned OpenAI release asset and verifies SHA-256 before use.`, this.preparingCodex ? 'sync~spin' : 'warning', 'multiagentSetupCodex');
    const observed = (name: string): string => executableAvailable(name) ? 'Found on PATH · not verified by setup' : 'Not prepared or verified';
    return [
      new ToolItem('Git', observed('git'), 'Required for worktrees. Managed deployment is still blocked by the macOS source gap and has not been implemented.', 'question'),
      ghItem,
      new ToolItem('Claude Code', observed('claude'), 'Provider tool. Direct asset and redistribution conditions are not verified, so setup does not download it.', 'question'),
      codexItem,
      new ToolItem('agy', observed('agy'), 'Fixed official assets, integrity metadata and redistribution terms are unverified. Setup does not download it.', 'question')
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

  async autoPrepare(): Promise<void> {
    if (!await this.storageAllowed()) {
      this.syncPath('gh', { state: 'missing', reason: 'private-storage-unavailable' });
      this.syncPath('codex', { state: 'missing', reason: 'private-storage-unavailable' });
      void vscode.window.showWarningMessage('First-use tool setup is unavailable because the extension storage folder could not be verified outside the project.');
      return;
    }
    const [gh] = await Promise.all([this.ghStatus(), this.codexStatus()]);
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
}

export function managedPathContributionForTests(): string | undefined { return active?.managedBinForTests(); }

export function setupTreeForTests(): vscode.TreeDataProvider<vscode.TreeItem> {
  if (!active) throw new Error('Tools Setup is not registered.');
  return active;
}

export function registerSetup(context: vscode.ExtensionContext): void {
  const controller = new SetupController(context);
  active = controller;
  context.subscriptions.push(
    controller,
    vscode.window.createTreeView(SETUP_VIEW, { treeDataProvider: controller }),
    vscode.commands.registerCommand(SETUP_COMMANDS.refresh, () => controller.refresh()),
    vscode.commands.registerCommand(SETUP_COMMANDS.retryGh, () => controller.prepareGh(true)),
    vscode.commands.registerCommand(SETUP_COMMANDS.retryCodex, () => controller.prepareCodex(true))
  );
  // Extension Host tests install a synthetic archive explicitly. Production activation performs
  // the first-use setup automatically; it never reads a URL or executable from the workspace.
  if (context.extensionMode !== vscode.ExtensionMode.Test) void controller.autoPrepare();
}
