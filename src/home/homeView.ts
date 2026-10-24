import * as vscode from 'vscode';
import { SessionCommands } from '../sessions/sessionCommands';
import { accountsAtAGlance } from '../accounts/accountCommands';

const { homeItems } = require('./model') as {
  homeItems(input: { agents?: { running: number; waiting: number } | null; accounts?: { total: number; signedIn: number; attention: number } | null }): Array<{ id: string; label: string; description: string; tooltip: string; tab: string; state: 'normal' | 'attention' | 'unknown' }>;
};

export const HOME_VIEW = 'multiagentSystem.homeView';
export const WORKBENCH_COMMAND = 'multiagentSystem.workbench.open';

// The colour says the state, and the words say it too (#357): green normal, yellow needs attention, grey unknown.
const ICONS = {
  normal: new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed')),
  attention: new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground')),
  unknown: new vscode.ThemeIcon('question', new vscode.ThemeColor('disabledForeground'))
};

class HomeTree implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  constructor(private readonly sessions: SessionCommands) {}
  refresh(): void { this.emitter.fire(); }
  getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }
  async getChildren(): Promise<vscode.TreeItem[]> {
    let agents: { running: number; waiting: number } | null = null;
    try {
      const live = this.sessions.list().filter((entry) => entry.terminalOpen);
      agents = { running: live.length, waiting: live.filter((entry) => (entry as { deliveryState?: { state?: string } }).deliveryState?.state === 'waiting').length };
    } catch { agents = null; }
    const glance = await accountsAtAGlance();
    const accounts = glance.ok ? { total: glance.total, signedIn: glance.signedIn, attention: glance.attention } : null;
    return homeItems({ agents, accounts }).map((entry) => {
      const item = new vscode.TreeItem(entry.label);
      item.id = `home:${entry.id}`;
      item.description = entry.description;
      item.tooltip = entry.tooltip;
      item.iconPath = entry.id === 'open' ? new vscode.ThemeIcon('layout') : ICONS[entry.state];
      item.command = { command: WORKBENCH_COMMAND, title: entry.label, arguments: [{ tab: entry.tab }] };
      item.accessibilityInformation = { label: `${entry.label}${entry.description ? `, ${entry.description}` : ''}`, role: 'button' };
      return item;
    });
  }
}

let current: HomeTree | undefined;
export function homeTreeForTests(): vscode.TreeDataProvider<vscode.TreeItem> {
  if (!current) throw new Error('The home view is not registered.');
  return current;
}

/** The side bar's one view (#357). The other views stay available behind the "Show classic views" setting. */
export function registerHomeView(context: vscode.ExtensionContext, sessions: SessionCommands): void {
  current = new HomeTree(sessions);
  const tree = current;
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(HOME_VIEW, tree),
    sessions.onDidChange(() => tree.refresh())
  );
}
