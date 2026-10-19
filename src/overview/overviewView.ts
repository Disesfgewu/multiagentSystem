import * as vscode from 'vscode';
import { SessionCommands } from '../sessions/sessionCommands';
import { builtIn } from '../providers/registry';
import { accountService } from '../accounts/accountRuntime';
import { observationsFor } from '../accounts/accountCommands';
import { limitLines, currentGateState, CurrentGate } from '../accounts/quotaGateUi';
import { privateStorage } from '../storage/storageCommands';
import { githubReaderFor } from '../github/githubCommands';
import { collectGitHub, worktreeInfoFor, JoinDeps } from './githubJoin';
import { isGitHubWebUrl } from '../github/controller';
import { markOwnUiItem } from '../shared/uiOrigin';

const { buildOverview } = require('./model') as { buildOverview(input: Record<string, unknown>): { rows: any[]; problems: number } };
const { cleanTitle } = require('./model') as { cleanTitle(value: unknown): string };
const { presentAgent, presentAccount, onboardingSteps, guideVisible, countRunningAgents } = require('./presentation') as {
  countRunningAgents(sessions: unknown): number;
  presentAgent(row: any, session: any): { id: string; label: string; description: string; tooltip: string[]; terminalOpen: boolean; pullRequestUrl: string | null; pullRequestNumber: number | null; issueNumber: number | null };
  presentAccount(entry: any): { id: string; label: string; description: string; tooltip: string[]; icon: string; contextValue: string; gateAction: string; blockedReason: string | null };
  onboardingSteps(counts: { accounts: number | null; roleGroups: number | null; sessions: number | null }): Array<{ id: string; title: string; done: boolean | 'unknown' | 'not-tracked'; command: string; button: string; missing: string }>;
  guideVisible(steps: unknown[]): boolean;
};
const { describeAccounts } = require('../accounts/profile-view') as { describeAccounts(input: { profiles: any[]; observations?: Map<string, unknown>; context: { repoRoot: string } }): any[] };

export const OVERVIEW_VIEW = 'multiagentSystem.overviewView';
export const OVERVIEW_REFRESH = 'multiagentSystem.overview.refresh';
export const OVERVIEW_OPEN_PULL_REQUEST = 'multiagentSystem.overview.openPullRequest';
export const OVERVIEW_OPEN_REPORT = 'multiagentSystem.overview.openReport';
export const OVERVIEW_SHOW_DIFF = 'multiagentSystem.overview.showDiff';

// The pull request address of each row, built by the model from the repository and the number. It is
// the only address the open action can use, and it is checked again before it is opened.
const pullRequestUrls = new Map<string, string>();
const pullRequestNumbers = new Map<string, number>();

let joinDeps: JoinDeps | undefined;
/** Replaces how branches and pull requests are found. Only the Extension Host test does this. */
export function setJoinDepsForTests(next: JoinDeps | undefined): void { joinDeps = next; }

const realJoinDeps: JoinDeps = {
  now: () => new Date(),
  readerFor: (repository) => githubReaderFor(repository) as unknown as ReturnType<JoinDeps['readerFor']>,
  worktreeInfo: worktreeInfoFor
};

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
  constructor(entry: { id: string; label: string; description: string; tooltip: string[]; terminalOpen: boolean; pullRequestUrl: string | null }) {
    super(entry.label);
    this.id = entry.id;
    this.description = entry.description;
    this.tooltip = entry.tooltip.join('\n');
    this.iconPath = new vscode.ThemeIcon(entry.terminalOpen ? 'terminal' : 'debug-disconnect');
    this.contextValue = `${entry.terminalOpen ? 'multiagentOverviewAgentLive' : 'multiagentOverviewAgentClosed'}${entry.pullRequestUrl ? 'Pr' : ''}`;
    this.command = { command: 'multiagentSystem.sessions.focus', title: 'Focus terminal', arguments: [{ id: entry.id }] };
    // The inline Stop action passes this row; marking it lets sessions.stop skip the caller confirmation.
    markOwnUiItem(this);
  }
}

class AccountRow extends Row {
  constructor(entry: { id: string; label: string; provider: string; policy: string; usage: string[]; gate?: CurrentGate | null }) {
    const presented = presentAccount(entry);
    super(presented.label);
    this.id = presented.id;
    this.description = presented.description;
    this.tooltip = presented.tooltip.join('\n');
    this.iconPath = new vscode.ThemeIcon(presented.icon);
    this.contextValue = presented.contextValue;
    this.command = { command: 'multiagentSystem.accounts.details', title: 'Account details', arguments: [entry.id] };
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
  accounts: Array<{ id: string; label: string; provider: string; policy: string; usage: string[]; gate?: CurrentGate | null }>;
  agents: Array<{ id: string; label: string; description: string; tooltip: string[]; terminalOpen: boolean; pullRequestUrl: string | null; pullRequestNumber?: number | null; issueNumber?: number | null }>;
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
      described = describeAccounts({
        profiles: loaded.profiles,
        observations: observationsFor(loaded.profiles),
        context: { repoRoot: (accounts.store as { repoRoot: string }).repoRoot }
      });
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
  const join = await collectGitHub(live.map((entry) => ({ id: entry.id, worktree: entry.worktree })), joinDeps ?? realJoinDeps);
  const rowsById = new Map<string, any>();
  let problems = 0;
  const build = (subset: typeof live, extra: Record<string, unknown>) => {
    const built = buildOverview({ sessions: subset, accounts: described, roleGroups: roleNames, branches: join.branches, ...extra });
    problems += built.problems;
    for (const row of built.rows) if (row.sessionId) rowsById.set(row.sessionId, row);
  };
  const grouped = new Set<string>();
  for (const group of join.groups) {
    const members = live.filter((entry) => group.sessionIds.includes(entry.id));
    members.forEach((entry) => grouped.add(entry.id));
    build(members, { repository: group.repository, github: group.github });
  }
  const rest = live.filter((entry) => !grouped.has(entry.id));
  if (rest.length > 0) build(rest, {});
  const agents = live.map((entry) => presentAgent(rowsById.get(entry.id) ?? buildOverview({ sessions: [entry], accounts: described, roleGroups: roleNames }).rows[0], { name: entry.name, providerLabel: builtIn.get(entry.provider)?.label, terminalOpen: entry.terminalOpen, requestedModel: entry.requestedModel, providerObservation: entry.providerObservation, lifecycleState: entry.stateLabel }));
  const accountRows = profiles ? await Promise.all(profiles.map(async (profile, index) => {
    const [policy, ...usage] = await limitLines(profile.id, () => sessions.list());
    const gate = await currentGateState(profile.id, () => sessions.list());
    return {
      id: profile.id,
      label: cleanTitle(profile.label) || 'Account',
      provider: builtIn.get(profile.provider)?.label ?? 'Provider unknown',
      policy: policy ?? 'Limits: could not be read.',
      usage,
      gate,
      duplicateOf: described[index]?.duplicateOf ?? []
    };
  })) : [];
  pullRequestUrls.clear();
  pullRequestNumbers.clear();
  for (const agent of agents) {
    if (agent.pullRequestUrl) pullRequestUrls.set(agent.id, agent.pullRequestUrl);
    if (agent.pullRequestNumber) pullRequestNumbers.set(agent.id, agent.pullRequestNumber);
  }
  const steps = onboardingSteps({ accounts: profiles ? profiles.length : null, roleGroups: roleGroups ? roleGroups.length : null, sessions: countRunningAgents(live) });
  return { steps, accounts: accountRows, agents, problems, notes };
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
    if (snapshot.accounts.length > 0) {
      rows.push(new Heading('Accounts', `${snapshot.accounts.length} profile${snapshot.accounts.length === 1 ? '' : 's'}`));
      rows.push(...snapshot.accounts.map((entry) => new AccountRow(entry)));
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
    vscode.commands.registerCommand(OVERVIEW_REFRESH, () => tree.refresh()),
    vscode.commands.registerCommand(OVERVIEW_OPEN_PULL_REQUEST, async (value?: unknown) => {
      const id = typeof value === 'string' ? value : value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' ? (value as { id: string }).id : undefined;
      const url = id ? pullRequestUrls.get(id) : undefined;
      if (!url || !isGitHubWebUrl(url)) return { ok: false, code: 'no-pull-request', message: 'There is no verified pull request for this agent.' };
      const opened = await vscode.env.openExternal(vscode.Uri.parse(url, true));
      return { ok: true, url, opened };
    }),
    vscode.commands.registerCommand(OVERVIEW_OPEN_REPORT, async (value?: unknown) => {
      const id = typeof value === 'string' ? value : value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' ? (value as { id: string }).id : undefined;
      const number = id ? pullRequestNumbers.get(id) : undefined;
      if (!number) return { ok: false, code: 'no-pull-request', message: 'There is no verified pull request for this agent.' };
      return vscode.commands.executeCommand('multiagentSystem.reports.open', { kind: 'pullRequest', number });
    }),
    vscode.commands.registerCommand(OVERVIEW_SHOW_DIFF, async (value?: unknown) => {
      const id = typeof value === 'string' ? value : value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' ? (value as { id: string }).id : undefined;
      const number = id ? pullRequestNumbers.get(id) : undefined;
      if (!number) return { ok: false, code: 'no-pull-request', message: 'There is no verified pull request for this agent.' };
      const opened = await vscode.commands.executeCommand<{ ok: boolean; code?: string }>('multiagentSystem.reports.open', { kind: 'pullRequest', number });
      if (!opened?.ok) return opened ?? { ok: false, code: 'open-failed' };
      return vscode.commands.executeCommand<{ ok: boolean; code?: string }>('multiagentSystem.reports.showDiff');
    })
  );
}
