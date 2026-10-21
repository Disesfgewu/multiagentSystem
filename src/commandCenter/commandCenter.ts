import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { SessionCommands } from '../sessions/sessionCommands';
import { collectOverview, OVERVIEW_OPEN_PULL_REQUEST, OVERVIEW_OPEN_REPORT } from '../overview/overviewView';
import { decisionCountsSnapshot, pullRequestSummary } from '../reports/reportsView';
import { privateStorage } from '../storage/storageCommands';
import { builtIn } from '../providers/registry';

const model = require('./model') as {
  buildCards(input: Record<string, unknown>): { pm: any[]; agents: any[]; accounts: any[]; counts: { agents: number; pm: number } };
  describeDecisions(counts: unknown): { issues: unknown; pullRequests: unknown };
  normalizeLayout(raw: unknown): Layout;
  arrange(cards: any[], layout: Layout): any[];
  parseMessage(raw: unknown, known: Set<string>): { ok: true; message: Message } | { ok: false; reason: string };
  applyLayoutMessage(layout: Layout, message: Message): Layout;
};
const { renderPage } = require('./page') as { renderPage(input: { nonce: string }): string };

export const COMMAND_CENTER_COMMAND = 'multiagentSystem.commandCenter.open';
export const COMMAND_CENTER_VIEW_TYPE = 'multiagentSystem.commandCenter';
const LAYOUT_KEY = 'commandCenter.layout';

type Layout = { mode: 'grid' | 'list'; order: string[]; collapsed: string[]; pinned: string[] };
type Message = { type: string; id?: string; mode?: 'grid' | 'list'; order?: string[]; kind?: 'issue' | 'pullRequest' };
export type CommandCenterResult = { ok: boolean; reason?: string; command?: string };

let panel: vscode.WebviewPanel | undefined;
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

/** The Command Center: a read-only team screen in the editor area (issue #309). Everything it shows comes from the existing services. */
export function registerCommandCenter(context: vscode.ExtensionContext, sessions: SessionCommands): void {
  let cached: { pm: any[]; agents: any[]; accounts: any[]; decisions: unknown; notes: string[] } | undefined;
  let layout: Layout = model.normalizeLayout(context.workspaceState.get(LAYOUT_KEY));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;

  const knownIds = (): Set<string> => new Set([...(cached?.pm ?? []), ...(cached?.agents ?? [])].map((card) => card.id as string));
  const payload = () => {
    if (!cached) return null;
    return { layout, pm: model.arrange(cached.pm, { ...layout, pinned: [] }), agents: model.arrange(cached.agents, layout), accounts: cached.accounts, decisions: cached.decisions, notes: cached.notes };
  };
  const post = (): void => { const state = payload(); if (panel && state) void panel.webview.postMessage({ type: 'state', state }); };

  const refresh = async (): Promise<void> => {
    const mine = ++generation;
    const live = sessions.list().map((entry) => ({ ...entry, providerLabel: builtIn.get(entry.provider)?.label }));
    const [snapshot, roles] = await Promise.all([collectOverview(sessions), roleGroups()]);
    // A newer refresh started while this one was reading: only the newest answer is shown.
    if (mine !== generation) return;
    // The latest report of each agent's pull request: read a few at a time and kept for a minute by the report module.
    const numbers = [...new Set(snapshot.agents.map((agent) => agent.pullRequestNumber).filter((value): value is number => Number.isSafeInteger(value) && (value as number) > 0))].slice(0, 12);
    const reports: Record<string, unknown> = {};
    await Promise.all(numbers.map(async (number) => { reports[String(number)] = await pullRequestSummary(number); }));
    if (mine !== generation) return;
    const built = model.buildCards({ sessions: live, agents: snapshot.agents, accounts: snapshot.accounts, roles, reports });
    cached = { pm: built.pm, agents: built.agents, accounts: built.accounts, decisions: model.describeDecisions(decisionCountsSnapshot()), notes: snapshot.notes.slice(0, 5).map((note) => String(note).slice(0, 200)) };
    post();
  };
  const scheduleRefresh = (): void => {
    if (!panel) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; void refresh(); }, 300);
  };

  const handle = async (raw: unknown): Promise<CommandCenterResult> => {
    const parsed = model.parseMessage(raw, knownIds());
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    const message = parsed.message;
    switch (message.type) {
      case 'ready':
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
      case 'openReports':
        await vscode.commands.executeCommand(message.kind === 'issue' ? 'multiagentSystem.issuesReportView.focus' : 'multiagentSystem.prsReportView.focus');
        return { ok: true, command: message.type };
      default:
        return { ok: false, reason: 'unknown-command' };
    }
  };
  controller = { handle, state: payload, refresh };
  controllerForTest = context.extensionMode === vscode.ExtensionMode.Test ? controller : undefined;

  const open = (): void => {
    if (panel) { panel.reveal(vscode.ViewColumn.Active); void refresh(); return; }
    panel = vscode.window.createWebviewPanel(COMMAND_CENTER_VIEW_TYPE, 'Command Center', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: false });
    panel.webview.html = renderPage({ nonce: randomBytes(16).toString('base64url') });
    panel.webview.onDidReceiveMessage((raw: unknown) => { void handle(raw); });
    panel.onDidChangeViewState((event) => { if (event.webviewPanel.visible) scheduleRefresh(); });
    panel.onDidDispose(() => { panel = undefined; if (timer) clearTimeout(timer); timer = undefined; });
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_CENTER_COMMAND, open),
    sessions.onDidChange(() => scheduleRefresh()),
    { dispose: () => { panel?.dispose(); if (timer) clearTimeout(timer); } }
  );
}

/** Whether the Command Center panel is open (Extension Host tests). */
export function commandCenterOpenForTests(): boolean { return panel !== undefined; }

/** The page the open panel shows (Extension Host tests). */
export function commandCenterHtmlForTests(): string | undefined { return panel?.webview.html; }
