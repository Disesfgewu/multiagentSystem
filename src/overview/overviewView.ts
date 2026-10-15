import * as vscode from 'vscode';
import { SessionCommands } from '../sessions/sessionCommands';
import { builtIn } from '../providers/registry';
import { accountService } from '../accounts/accountRuntime';
import { privateStorage } from '../storage/storageCommands';

const { buildOverview } = require('./model') as { buildOverview(input: Record<string, unknown>): { rows: any[]; problems: number } };
const { presentAgent, onboardingSteps, guideVisible } = require('./presentation') as {
  presentAgent(row: any, session: any): { id: string; label: string; description: string; tooltip: string[]; terminalOpen: boolean };
  onboardingSteps(counts: { accounts: number | null; roleGroups: number | null; sessions: number | null }): Array<{ id: string; title: string; done: boolean | 'unknown' | 'not-tracked'; command: string; button: string; missing: string }>;
  guideVisible(steps: unknown[]): boolean;
};
const { describeAccounts } = require('../accounts/profile-view') as { describeAccounts(input: { profiles: any[]; context: { repoRoot: string } }): any[] };

export const OVERVIEW_VIEW = 'multiagentSystem.overviewView';
export const OVERVIEW_REFRESH = 'multiagentSystem.overview.refresh';

class Row extends vscode.TreeItem {
  constructor(label: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
  }
}

class StepRow extends Row {
  constructor(step: { title: string; done: boolean | 'unknown' | 'not-tracked'; command: string; button: string; missing: string }) {
    super(step.title);
    const icon = step.done === true ? 'pass' : step.done === 'unknown' ? 'question' : step.done === 'not-tracked' ? 'circle-outline' : 'circle-large-outline';
    this.iconPath = new vscode.ThemeIcon(icon);
    this.description = step.done === true ? 'done' : step.done === 'unknown' ? 'could not be checked' : step.done === 'not-tracked' ? 'open the list' : step.button;
    this.tooltip = step.done === true ? `${step.title}: done` : step.missing;
    this.contextValue = 'multiagentOverviewStep';
    this.command = step.done === true ? undefined : { command: step.command, title: step.button };
  }
}

class AgentRow extends Row {
  constructor(entry: { id: string; label: string; description: string; tooltip: string[]; terminalOpen: boolean }) {
    super(entry.label);
    this.id = entry.id;
    this.description = entry.description;
    this.tooltip = entry.tooltip.join('\n');
    this.iconPath = new vscode.ThemeIcon(entry.terminalOpen ? 'terminal' : 'debug-disconnect');
    this.contextValue = entry.terminalOpen ? 'multiagentOverviewAgentLive' : 'multiagentOverviewAgentClosed';
    this.command = { command: 'multiagentSystem.sessions.focus', title: 'Focus terminal', arguments: [{ id: entry.id }] };
  }
}

class Heading extends Row {
  constructor(text: string, description?: string) {
    super(text);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon('info');
  }
}

type Item = Row;

export interface OverviewSnapshot {
  steps: ReturnType<typeof onboardingSteps>;
  agents: Array<{ id: string; label: string; description: string; tooltip: string[]; terminalOpen: boolean }>;
  problems: number;
  notes: string[];
}

/** Reads the real state once. A part that cannot be read is reported as unknown, never as empty. */
export async function collectOverview(sessions: SessionCommands): Promise<OverviewSnapshot> {
  const live = sessions.list();
  const notes: string[] = [];
  let profiles: any[] | null = null;
  let described: any[] = [];
  let roleGroups: any[] | null = null;

  const accounts = await accountService(() => live);
  if (accounts.ok) {
    const loaded = accounts.service.list();
    if (loaded.ok) {
      profiles = loaded.profiles;
      described = describeAccounts({ profiles: loaded.profiles, context: { repoRoot: (accounts.store as { repoRoot: string }).repoRoot } });
    } else notes.push('Account profiles could not be read.');
  } else notes.push('Account profiles are not available yet: private storage is not ready.');

  const handle = privateStorage();
  const opened = handle ? await handle.use() : undefined;
  if (opened?.ok) {
    const listed = (opened.store as { list(collection: string): { ok: boolean; items?: Array<{ id: string; value: any }> } }).list('roleGroups');
    if (listed.ok) roleGroups = listed.items ?? [];
    else notes.push('Role groups could not be read.');
  } else notes.push('Role groups are not available yet: private storage is not ready.');

  const roleNames: Record<string, string> = {};
  for (const entry of roleGroups ?? []) {
    const group = entry?.value?.group;
    if (group && typeof group.name === 'string' && typeof group.id === 'string') roleNames[group.id] = group.name;
  }
  const overview = buildOverview({
    sessions: live,
    accounts: described,
    roleGroups: roleNames
  });
  const agents = overview.rows.map((row: any, index: number) => presentAgent(row, { name: live[index]?.name, providerLabel: builtIn.get(live[index]?.provider)?.label, terminalOpen: live[index]?.terminalOpen }));
  const steps = onboardingSteps({ accounts: profiles ? profiles.length : null, roleGroups: roleGroups ? roleGroups.length : null, sessions: live.length });
  return { steps, agents, problems: overview.problems, notes };
}

class OverviewTree implements vscode.TreeDataProvider<Item> {
  private readonly changed = new vscode.EventEmitter<Item | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  last: OverviewSnapshot | undefined;
  constructor(private readonly sessions: SessionCommands) {}
  refresh(): void { this.changed.fire(undefined); }
  getTreeItem(item: Item): vscode.TreeItem { return item; }

  async getChildren(item?: Item): Promise<Item[]> {
    if (item) return [];
    const snapshot = await collectOverview(this.sessions);
    this.last = snapshot;
    const rows: Item[] = [];
    if (guideVisible(snapshot.steps)) {
      rows.push(new Heading('Get started', 'follow the steps in order'));
      rows.push(...snapshot.steps.map((step) => new StepRow(step)));
    }
    for (const note of snapshot.notes) rows.push(new Heading(note));
    if (snapshot.agents.length > 0) {
      rows.push(new Heading('Agents', `${snapshot.agents.length} session${snapshot.agents.length === 1 ? '' : 's'}`));
      rows.push(...snapshot.agents.map((entry) => new AgentRow(entry)));
    } else if (!guideVisible(snapshot.steps)) {
      rows.push(new Heading('No agents are running', 'start one from an account'));
    }
    if (snapshot.problems > 0) rows.push(new Heading(`${snapshot.problems} item${snapshot.problems === 1 ? '' : 's'} could not be read`));
    return rows;
  }
}

let treeForTest: OverviewTree | undefined;
export function overviewTreeForTests(): vscode.TreeDataProvider<Item> {
  if (!treeForTest) throw new Error('The overview tree is available only in Extension Host tests.');
  return treeForTest;
}

export function registerOverview(context: vscode.ExtensionContext, sessions: SessionCommands): void {
  const tree = new OverviewTree(sessions);
  treeForTest = context.extensionMode === vscode.ExtensionMode.Test ? tree : undefined;
  const view = vscode.window.createTreeView(OVERVIEW_VIEW, { treeDataProvider: tree });
  context.subscriptions.push(
    view,
    sessions.onDidChange(() => tree.refresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => tree.refresh()),
    vscode.window.onDidChangeWindowState((state) => { if (state.focused) tree.refresh(); }),
    view.onDidChangeVisibility((event) => { if (event.visible) tree.refresh(); }),
    vscode.commands.registerCommand(OVERVIEW_REFRESH, () => tree.refresh())
  );
}
