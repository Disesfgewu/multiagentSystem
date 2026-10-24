import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { SessionCommands } from '../sessions/sessionCommands';
import { collectOverview, OVERVIEW_OPEN_PULL_REQUEST, OVERVIEW_OPEN_REPORT } from '../overview/overviewView';
import { decisionCountsSnapshot, pullRequestSummary } from '../reports/reportsView';
import { privateStorage } from '../storage/storageCommands';
import { accountService } from '../accounts/accountRuntime';
import { observationsFor, ACCOUNT_COMMANDS, accountEmail, onDidChangeAccounts } from '../accounts/accountCommands';
import { WORKBENCH_COMMAND } from '../sidebar/homeView';
import { quotaDetail } from '../accounts/quotaGateUi';
import { builtIn } from '../providers/registry';
import { TEAM_RULES_COMMANDS, teamRulesSummary } from '../teamRules/commands';
import { DISPATCH_COMMANDS, readAssignments } from '../dispatch/commands';

const model = require('./model') as {
  buildCards(input: Record<string, unknown>): { pm: any[]; agents: any[]; accounts: any[]; counts: { agents: number; pm: number } };
  describeDecisions(counts: unknown): { issues: unknown; pullRequests: unknown };
  normalizeLayout(raw: unknown): Layout;
  arrange(cards: any[], layout: Layout): any[];
  parseMessage(raw: unknown, known: Set<string>, accounts?: Set<string>): { ok: true; message: Message } | { ok: false; reason: string };
  buildAccountRows(input: Record<string, unknown>): { rows: any[]; alerts: string[] };
  applyLayoutMessage(layout: Layout, message: Message): Layout;
  TABS: readonly string[];
  TARGETS: Record<string, string>;
};
const { renderPage } = require('./page') as { renderPage(input: { nonce: string }): string };
const { createRefreshLoop } = require('./refreshLoop') as { createRefreshLoop(run: () => Promise<void>): { request(): Promise<void>; running(): boolean } };

export const COMMAND_CENTER_COMMAND = 'multiagentSystem.commandCenter.open';
export const COMMAND_CENTER_VIEW_TYPE = 'multiagentSystem.commandCenter';
const LAYOUT_KEY = 'commandCenter.layout';
// The export command lives in `export/commands.ts`, which reads this module's cards; the name is repeated here to keep the imports one-way.
const EXPORT_PROJECT_REPORT = 'multiagentSystem.export.projectReport';

type Layout = { mode: 'grid' | 'list'; order: string[]; collapsed: string[]; pinned: string[] };
type Message = { type: string; action?: string; id?: string; mode?: 'grid' | 'list'; order?: string[]; kind?: 'issue' | 'pullRequest'; target?: string };
export type CommandCenterResult = { ok: boolean; reason?: string; command?: string };

let panel: vscode.WebviewPanel | undefined;
let teamReader: (() => Promise<{ pm: any[]; agents: any[]; accounts: any[] } | null>) | undefined;
/** The cards and account rows the Command Center would show right now (read again), for the Markdown project report. `null` if they could not be built. */
export async function readTeamSnapshot(): Promise<{ pm: any[]; agents: any[]; accounts: any[] } | null> {
  try { return teamReader ? await teamReader() : null; } catch { return null; }
}
let controller: { handle(raw: unknown): Promise<CommandCenterResult>; state(): unknown; refresh(): Promise<void> } | undefined;
let controllerForTest: typeof controller;
export function commandCenterForTests(): NonNullable<typeof controller> {
  if (!controllerForTest) throw new Error('The Command Center is only exposed in Extension Host tests.');
  return controllerForTest;
}

async function roleGroups(): Promise<Record<string, { name?: string; role?: string }>> {
  const out: Record<string, { name?: string; role?: string }> = {};
  try {
    const opened = await privateStorage()?.use();
    if (!opened?.ok) return out;
    const listed = (opened.store as { list(collection: string): { ok: boolean; items?: Array<{ id: string; value: any }> } }).list('roleGroups');
    if (!listed.ok) return out;
    for (const entry of listed.items ?? []) {
      const group = entry?.value?.group;
      if (group && typeof group.id === 'string') out[group.id] = { name: typeof group.name === 'string' ? group.name : undefined, role: typeof group.role === 'string' ? group.role : undefined };
    }
  } catch { /* an unreadable store leaves every role unknown */ }
  return out;
}

const { describeAccounts } = require('../accounts/profile-view') as { describeAccounts(input: { profiles: any[]; observations?: Map<string, unknown>; context: { repoRoot: string } }): any[] };

/** Every account with what its sign-in checks said and its quota in detail (issue #304). A part that cannot be read is unknown. */
async function readAccounts(live: Array<Record<string, unknown>>): Promise<{ rows: any[]; alerts: string[] }> {
  try {
    const sessionUse = () => live as never;
    const accounts = await accountService(sessionUse);
    if (!accounts.ok) return { rows: [], alerts: [] };
    const loaded = accounts.service.list();
    if (!loaded.ok) return { rows: [], alerts: [] };
    const described = describeAccounts({ profiles: loaded.profiles, observations: observationsFor(loaded.profiles), context: { repoRoot: (accounts.store as { repoRoot: string }).repoRoot } });
    const details: Record<string, unknown> = {};
    await Promise.all(loaded.profiles.slice(0, 50).map(async (profile: { id: string }) => { try { details[profile.id] = await quotaDetail(profile.id, sessionUse); } catch { details[profile.id] = null; } }));
    const profiles = loaded.profiles.map((profile: { id: string; label: string; provider: string }, index: number) => ({
      id: profile.id, label: profile.label, provider: builtIn.get(profile.provider)?.label ?? profile.provider,
      health: described[index]?.health, identity: described[index]?.verifiedIdentity, issues: (described[index]?.issues ?? []).map((issue: { hint: string }) => issue.hint)
    }));
    return model.buildAccountRows({ accounts: profiles, details, sessions: live, now: new Date() });
  } catch { return { rows: [], alerts: [] }; }
}

/** The Command Center: a read-only team screen in the editor area (issue #309). Everything it shows comes from the existing services. */
export function registerCommandCenter(context: vscode.ExtensionContext, sessions: SessionCommands): void {
  let cached: { pm: any[]; agents: any[]; accounts: any[]; alerts: string[]; decisions: unknown; notes: string[] } | undefined;
  let layout: Layout = model.normalizeLayout(context.workspaceState.get(LAYOUT_KEY));
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The tab the Workbench was opened at, sent once the new page says it is ready.
  let pendingTab: string | undefined;

  const knownIds = (): Set<string> => new Set([...(cached?.pm ?? []), ...(cached?.agents ?? [])].map((card) => card.id as string));
  const knownAccountIds = (): Set<string> => new Set((cached?.accounts ?? []).map((row) => row.id as string));
  const payload = () => {
    if (!cached) return null;
    return { layout, pm: model.arrange(cached.pm, { ...layout, pinned: [] }), agents: model.arrange(cached.agents, layout), accounts: cached.accounts, alerts: cached.alerts, decisions: cached.decisions, notes: cached.notes };
  };
  const post = (): void => { const state = payload(); if (panel && state) void panel.webview.postMessage({ type: 'state', state }); };

  // What the slow parts last read, so the first step of a refresh shows the cards with them instead of blanks.
  let lastReports: Record<string, unknown> = {};
  let lastAssignments: Record<string, unknown> = {};
  const publish = (next: NonNullable<typeof cached>): void => { cached = next; post(); };
  // The e-mail address of each agent's account from this window's sign-in checks (#357): memory only, for the cards.
  const emailsOf = (live: Array<{ accountProfileId?: string }>): Record<string, string> => Object.fromEntries(live.map((entry) => entry.accountProfileId).filter((id): id is string => typeof id === 'string').map((id) => [id, accountEmail(id)]).filter((pair): pair is [string, string] => typeof pair[1] === 'string'));
  /**
   * One refresh, published in two steps (#368): first the cards from the sessions as they are now (with the pull request reports,
   * accounts and team rules last read), then again once the slower reads have answered. Nothing it worked out is thrown away.
   */
  const refreshOnce = async (): Promise<void> => {
    const live = sessions.list().map((entry) => ({ ...entry, providerLabel: builtIn.get(entry.provider)?.label }));
    const [snapshot, roles] = await Promise.all([collectOverview(sessions), roleGroups()]);
    const notesWith = (teamRules: string | undefined) => [...(teamRules ? [teamRules] : []), ...snapshot.notes.slice(0, 4)].map((note) => String(note).slice(0, 240));
    const first = model.buildCards({ sessions: live, agents: snapshot.agents, accounts: snapshot.accounts, roles, reports: lastReports, assignments: lastAssignments, emails: emailsOf(live) });
    publish({ pm: first.pm, agents: first.agents, accounts: cached?.accounts ?? [], alerts: cached?.alerts ?? [], decisions: model.describeDecisions(decisionCountsSnapshot()), notes: cached ? cached.notes : notesWith(undefined) });
    // The latest report of each agent's pull request: read a few at a time and kept for a minute by the report module.
    const numbers = [...new Set(snapshot.agents.map((agent) => agent.pullRequestNumber).filter((value): value is number => Number.isSafeInteger(value) && (value as number) > 0))].slice(0, 12);
    const reports: Record<string, unknown> = {};
    await Promise.all(numbers.map(async (number) => { reports[String(number)] = await pullRequestSummary(number); }));
    const assignments = Object.fromEntries(await readAssignments());
    lastReports = reports;
    lastAssignments = assignments;
    const built = model.buildCards({ sessions: live, agents: snapshot.agents, accounts: snapshot.accounts, roles, reports, assignments, emails: emailsOf(live) });
    const accountRows = await readAccounts(live);
    const teamRules = await teamRulesSummary();
    publish({ pm: built.pm, agents: built.agents, accounts: accountRows.rows, alerts: accountRows.alerts, decisions: model.describeDecisions(decisionCountsSnapshot()), notes: notesWith(teamRules) });
  };
  // At most one refresh at a time; a request meanwhile runs one more afterwards (#368).
  const loop = createRefreshLoop(refreshOnce);
  const refresh = (): Promise<void> => loop.request();
  const scheduleRefresh = (): void => {
    if (!panel) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; void refresh(); }, 300);
  };

  const handle = async (raw: unknown): Promise<CommandCenterResult> => {
    const parsed = model.parseMessage(raw, knownIds(), knownAccountIds());
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    const message = parsed.message;
    switch (message.type) {
      case 'ready':
        if (pendingTab && panel) { void panel.webview.postMessage({ type: 'showTab', tab: pendingTab }); pendingTab = undefined; }
        await refresh();
        return { ok: true, command: message.type };
      case 'refresh':
        await refresh();
        return { ok: true, command: message.type };
      case 'setLayout':
      case 'reorder':
      case 'toggleCollapse':
      case 'togglePin':
        layout = model.applyLayoutMessage(layout, message);
        await context.workspaceState.update(LAYOUT_KEY, layout);
        post();
        return { ok: true, command: message.type };
      case 'focus':
        await vscode.commands.executeCommand('multiagentSystem.sessions.focus', { id: message.id });
        return { ok: true, command: message.type };
      case 'openReport':
        await vscode.commands.executeCommand(OVERVIEW_OPEN_REPORT, { id: message.id });
        return { ok: true, command: message.type };
      case 'openPullRequest':
        await vscode.commands.executeCommand(OVERVIEW_OPEN_PULL_REQUEST, { id: message.id });
        return { ok: true, command: message.type };
      // Takes no content: the rule text and the confirmation come from the command's own windows.
      case 'editTeamRules':
        void vscode.commands.executeCommand(TEAM_RULES_COMMANDS.edit);
        return { ok: true, command: message.type };
      // The two commands take no argument and ask for everything in their own windows; the page only presses the button.
      case 'assignIssue':
        void vscode.commands.executeCommand(DISPATCH_COMMANDS.assignIssue);
        return { ok: true, command: message.type };
      // Takes no content: the topic, the agents and the confirmations come from the command's own windows.
      case 'startMeeting':
        void vscode.commands.executeCommand('multiagentSystem.meeting.start');
        return { ok: true, command: message.type };
      // Takes no content either: which Issue or PR, the message and both confirmations come from the command's own windows (#343).
      case 'talkToPm':
        void vscode.commands.executeCommand('multiagentSystem.talk.open');
        return { ok: true, command: message.type };
      case 'sendTask':
        void vscode.commands.executeCommand(DISPATCH_COMMANDS.sendTask);
        return { ok: true, command: message.type };
      case 'accountAction': {
        // Each action is an existing account command with the account's id and nothing else, so each keeps its own confirmation.
        const id = message.id;
        switch (message.action) {
          case 'create': await vscode.commands.executeCommand(ACCOUNT_COMMANDS.create); break;
          case 'login': await vscode.commands.executeCommand(ACCOUNT_COMMANDS.login, id); break;
          case 'check': await vscode.commands.executeCommand(ACCOUNT_COMMANDS.check, id); break;
          case 'limits': await vscode.commands.executeCommand(ACCOUNT_COMMANDS.limits, { id }); break;
          case 'usageLog': await vscode.commands.executeCommand('multiagentSystem.usage.showLog', { id }); break;
          case 'configureStatusLine': await vscode.commands.executeCommand(ACCOUNT_COMMANDS.configureStatusLine, { id }); break;
          case 'details': await vscode.commands.executeCommand(ACCOUNT_COMMANDS.details, id); break;
          default: return { ok: false, reason: 'unknown-command' };
        }
        scheduleRefresh();
        return { ok: true, command: `accountAction:${message.action}` };
      }
      // Takes no content: the report is built and opened by the command itself.
      case 'exportReport':
        void vscode.commands.executeCommand(EXPORT_PROJECT_REPORT);
        return { ok: true, command: message.type };
      case 'openReports': {
        // The report lists are classic views until the Work tab has them (#353): when they are hidden, the person is asked first.
        if (!vscode.workspace.getConfiguration('multiagentSystem').get<boolean>('showClassicViews')) {
          const answer = await vscode.window.showInformationMessage('The issue and pull request lists are in the classic side bar views for now.', { modal: true, detail: 'Show the classic views (Settings: multiagentSystem.showClassicViews) to open them? The Work tab gets its own lists in #353.' }, 'Show Classic Views');
          if (answer !== 'Show Classic Views') return { ok: false, reason: 'cancelled' };
          await vscode.workspace.getConfiguration('multiagentSystem').update('showClassicViews', true, vscode.ConfigurationTarget.Global);
        }
        await vscode.commands.executeCommand(message.kind === 'issue' ? 'multiagentSystem.issuesReportView.focus' : 'multiagentSystem.prsReportView.focus');
        return { ok: true, command: message.type };
      }
      // A next-step button of a tab (#357): a fixed name, mapped here to an existing command that is run with no argument.
      case 'open':
        void vscode.commands.executeCommand(model.TARGETS[message.target as string]);
        return { ok: true, command: message.type };
      case 'showClassicViews':
        await vscode.workspace.getConfiguration('multiagentSystem').update('showClassicViews', true, vscode.ConfigurationTarget.Global);
        void vscode.window.showInformationMessage('The classic views are shown under Multiagent in the side bar. Hide them again in Settings: multiagentSystem.showClassicViews.');
        return { ok: true, command: message.type };
      default:
        return { ok: false, reason: 'unknown-command' };
    }
  };
  teamReader = async () => { await refresh(); return cached ? { pm: cached.pm, agents: cached.agents, accounts: cached.accounts } : null; };
  controller = { handle, state: payload, refresh };
  controllerForTest = context.extensionMode === vscode.ExtensionMode.Test ? controller : undefined;

  // The Workbench (#357), at the tab asked for (a fixed list; anything else opens the Agents tab).
  const open = (value?: unknown): void => {
    const asked = value && typeof value === 'object' ? (value as { tab?: unknown }).tab : undefined;
    const tab = typeof asked === 'string' && (model.TABS as readonly string[]).includes(asked) ? asked : 'agents';
    const show = (): void => { void panel?.webview.postMessage({ type: 'showTab', tab }); };
    if (panel) { panel.reveal(vscode.ViewColumn.Active); show(); void refresh(); return; }
    panel = vscode.window.createWebviewPanel(COMMAND_CENTER_VIEW_TYPE, 'Workbench', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: false });
    pendingTab = tab;
    panel.webview.html = renderPage({ nonce: randomBytes(16).toString('base64url') });
    panel.webview.onDidReceiveMessage((raw: unknown) => { void handle(raw); });
    panel.onDidChangeViewState((event) => { if (event.webviewPanel.visible) scheduleRefresh(); });
    panel.onDidDispose(() => { panel = undefined; if (timer) clearTimeout(timer); timer = undefined; });
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_CENTER_COMMAND, () => open()),
    vscode.commands.registerCommand(WORKBENCH_COMMAND, (value?: unknown) => open(value)),
    sessions.onDidChange(() => scheduleRefresh()),
    onDidChangeAccounts(() => scheduleRefresh()),
    { dispose: () => { panel?.dispose(); if (timer) clearTimeout(timer); } }
  );
}

/** Whether the Command Center panel is open (Extension Host tests). */
export function commandCenterOpenForTests(): boolean { return panel !== undefined; }

/** The page the open panel shows (Extension Host tests). */
export function commandCenterHtmlForTests(): string | undefined { return panel?.webview.html; }
