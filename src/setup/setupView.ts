import * as path from 'node:path';
import * as vscode from 'vscode';
import { ManagedGh, Downloader, GhRelease, GhStatus } from './managedGh';
import { privateStorage } from '../storage/storageCommands';

const { executableAvailable } = require('../providers/executable') as { executableAvailable(name: string): boolean };

export const SETUP_VIEW = 'multiagentSystem.toolsSetupView';
export const SETUP_COMMANDS = {
  refresh: 'multiagentSystem.setup.refresh',
  retryGh: 'multiagentSystem.setup.retryGh'
} as const;

interface SetupOverrides { platform?: string; arch?: string; release?: GhRelease | null; download?: Downloader }
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
  private manager: ManagedGh;
  private preparing = false;
  private managedBin: string | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.manager = this.createManager();
    this.context.environmentVariableCollection.description = 'Verified tools prepared by Multiagent';
  }
  dispose(): void { this.changed.dispose(); }
  replaceManager(): void { this.manager = this.createManager(); this.syncPath({ state: 'missing', reason: 'manager-replaced' }); this.refresh(); }
  private createManager(): ManagedGh {
    return new ManagedGh({ root: path.join(this.context.globalStorageUri.fsPath, 'managed-tools', 'gh'), boundary: this.context.globalStorageUri.fsPath, ...overrides });
  }
  refresh(): void { this.changed.fire(undefined); }
  getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }

  private syncPath(status: GhStatus): void {
    this.context.environmentVariableCollection.delete('PATH');
    this.managedBin = status.state === 'ready' ? status.binDir : undefined;
    if (this.managedBin) this.context.environmentVariableCollection.prepend('PATH', `${this.managedBin}${path.delimiter}`);
  }

  private async storageAllowed(): Promise<boolean> {
    try { return (await privateStorage()?.use())?.ok === true; } catch { return false; }
  }

  async ghStatus(): Promise<GhStatus> {
    const status = await this.storageAllowed() ? await this.manager.status() : { state: 'missing', reason: 'private-storage-unavailable' } as GhStatus;
    this.syncPath(status);
    return status;
  }
  managedBinForTests(): string | undefined { return this.managedBin; }

  async getChildren(): Promise<vscode.TreeItem[]> {
    const gh = await this.ghStatus();
    const ghItem = gh.state === 'ready'
      ? new ToolItem('GitHub CLI (gh)', `Ready · ${gh.version}`, `Verified SHA-256 after extraction. Source: ${gh.source}\nChecked: ${gh.verifiedAt}`, 'verified-filled', 'multiagentSetupGh')
      : new ToolItem('GitHub CLI (gh)', this.preparing ? 'Preparing…' : gh.state === 'unsupported' ? 'Unavailable on this platform' : 'Needs setup', `Managed setup: ${gh.reason}. Retry downloads only the fixed official release and verifies its SHA-256 before use.`, this.preparing ? 'sync~spin' : 'warning', 'multiagentSetupGh');
    const observed = (name: string): string => executableAvailable(name) ? 'Found on PATH · not verified by setup' : 'Not prepared or verified';
    return [
      new ToolItem('Git', observed('git'), 'Required for worktrees. Managed deployment is still blocked by the macOS source gap and has not been implemented.', 'question'),
      ghItem,
      new ToolItem('Claude Code', observed('claude'), 'Provider tool. Direct asset and redistribution conditions are not verified, so setup does not download it.', 'question'),
      new ToolItem('Codex CLI', observed('codex'), 'Official assets and hashes are known; managed deployment is a later slice and is not claimed ready here.', 'question'),
      new ToolItem('agy', observed('agy'), 'Fixed official assets, integrity metadata and redistribution terms are unverified. Setup does not download it.', 'question')
    ];
  }

  async prepareGh(interactive: boolean): Promise<GhStatus> {
    if (this.preparing) return this.manager.status();
    this.preparing = true;
    this.refresh();
    try {
      if (!await this.storageAllowed()) {
        const refused: GhStatus = { state: 'missing', reason: 'private-storage-unavailable' };
        this.syncPath(refused);
        if (interactive) void vscode.window.showErrorMessage('Tool setup is unavailable because the extension storage folder could not be verified outside the project.');
        return refused;
      }
      const run = async (progress?: vscode.Progress<{ message?: string; increment?: number }>): Promise<GhStatus> => {
        let last = 0;
        return this.manager.prepare(({ received, total }) => {
          if (!progress || !total || total <= 0) return;
          const percent = Math.min(100, Math.floor(received / total * 100));
          progress.report({ increment: Math.max(0, percent - last), message: `${percent}% downloaded and awaiting verification` });
          last = percent;
        });
      };
      const result = interactive
        ? await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Preparing verified GitHub CLI', cancellable: false }, run)
        : await run();
      this.syncPath(result);
      if (interactive) {
        if (result.state === 'ready') void vscode.window.showInformationMessage(`GitHub CLI ${result.version} is verified and ready for new managed terminals.`);
        else void vscode.window.showErrorMessage('GitHub CLI setup did not complete. Open Tools Setup for the current status and retry.');
      }
      return result;
    } finally { this.preparing = false; this.refresh(); }
  }

  async autoPrepare(): Promise<void> {
    if (!await this.storageAllowed()) {
      this.syncPath({ state: 'missing', reason: 'private-storage-unavailable' });
      void vscode.window.showWarningMessage('First-use tool setup is unavailable because the extension storage folder could not be verified outside the project.');
      return;
    }
    const status = await this.ghStatus();
    if (status.state === 'ready' || status.state === 'unsupported') return;
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'First-use setup: preparing verified GitHub CLI', cancellable: false }, async (progress) => {
      let last = 0;
      this.preparing = true;
      this.refresh();
      try {
        return await this.manager.prepare(({ received, total }) => {
          if (!total || total <= 0) return;
          const percent = Math.min(100, Math.floor(received / total * 100));
          progress.report({ increment: Math.max(0, percent - last), message: `${percent}% downloaded and awaiting verification` });
          last = percent;
        });
      } finally { this.preparing = false; this.refresh(); }
    });
    this.syncPath(result);
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
    vscode.commands.registerCommand(SETUP_COMMANDS.retryGh, () => controller.prepareGh(true))
  );
  // Extension Host tests install a synthetic archive explicitly. Production activation performs
  // the first-use setup automatically; it never reads a URL or executable from the workspace.
  if (context.extensionMode !== vscode.ExtensionMode.Test) void controller.autoPrepare();
}
