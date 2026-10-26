import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { SessionCommands } from '../sessions/sessionCommands';
import { collectOverview, OVERVIEW_OPEN_PULL_REQUEST, OVERVIEW_OPEN_REPORT } from '../overview/overviewView';
import { askAgent, currentSelection, readAnswer } from '../ask/ask';
import { boardData, decisionCountsSnapshot, pullRequestSummary, REPORT_COMMANDS } from '../reports/reportsView';
const { buildBoard } = require('./board') as { buildBoard(input: unknown): { state: string; reason?: string; columns: Array<{ cards: Array<{ kind: string; number: number }> }>; notes?: string[] } };
import { privateStorage } from '../storage/storageCommands';
import { accountService } from '../accounts/accountRuntime';
import { observationsFor, ACCOUNT_COMMANDS, accountEmail, accountPlan, onDidChangeAccounts } from '../accounts/accountCommands';
import { WORKBENCH_COMMAND } from '../sidebar/homeView';
import { quotaDetail } from '../accounts/quotaGateUi';
import { builtIn } from '../providers/registry';
import { TEAM_RULES_COMMANDS, teamRulesSummary } from '../teamRules/commands';
import { onDidChangeSkillLibrary, skillLibrarySummary } from '../skills/libraryCommands';
import { DISPATCH_COMMANDS, countTasksSent, readAssignments, previewBroadcast, sendBroadcast } from '../dispatch/commands';
import { onDidOpenPullRequestPage } from '../reports/githubPage';
import { readToolsSummary } from '../setup/setupView';
const { readUserLevel } = require('../settings/user-level') as { readUserLevel(inspected: unknown): { value: unknown } };

const model = require('./model') as {
  buildCards(input: Record<string, unknown>): { pm: any[]; agents: any[]; accounts: any[]; counts: { agents: number; pm: number } };
  describeDecisions(counts: unknown): { issues: unknown; pullRequests: unknown };
  normalizeLayout(raw: unknown): Layout;
  arrange(cards: any[], layout: Layout): any[];
  parseMessage(raw: unknown, known: Set<string>, accounts?: Set<string>, skills?: Set<string>, boardItems?: Set<string>, groups?: Set<string>): { ok: true; message: Message } | { ok: false; reason: string };
  buildSkills(summary: unknown): { known: boolean; text: string; items: Array<{ name: string }> };
  describeTools(raw: unknown): { known: boolean; rows: unknown[] };
  describeModes(read: Record<string, unknown>): unknown[];
  buildGettingStarted(read: { accounts: number | null; roleGroups: number | null; agents: number | null; tasks: number | null; reviewed: boolean | null }): { steps: unknown[]; done: number; next: string | null; complete: boolean };
  SKILL_ACTIONS: Record<string, string>;
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
// The first steps (#357): whether a pull request page was opened in this workspace, and whether the person hid the steps.
const GUIDE_REVIEWED_KEY = 'commandCenter.guide.reviewed';
const GUIDE_HIDDEN_KEY = 'commandCenter.guide.hidden';
const FIRST_OPEN_KEY = 'workbench.openedOnce';
// The export command lives in `export/commands.ts`, which reads this module's cards; the name is repeated here to keep the imports one-way.
const EXPORT_PROJECT_REPORT = 'multiagentSystem.export.projectReport';

type Layout = { mode: 'grid' | 'list'; order: string[]; collapsed: string[]; pinned: string[] };
type Message = { type: string; action?: string; id?: string; name?: string; mode?: 'grid' | 'list'; order?: string[]; kind?: 'issue' | 'pullRequest'; target?: string; number?: number; text?: string; group?: string; ids?: string[]; question?: string; withSelection?: boolean; key?: string };
export type CommandCenterResult = { ok: boolean; reason?: string; command?: string };

let panel: vscode.WebviewPanel | undefined;
let teamReader: (() => Promise<{ pm: any[]; agents: any[]; accounts: any[] } | null>) | undefined;
/** The cards and account rows the Command Center would show right now (read again), for the Markdown project report. `null` if they could not be built. */
export async function readTeamSnapshot(): Promise<{ pm: any[]; agents: any[]; accounts: any[] } | null> {
  try { return teamReader ? await teamReader() : null; } catch { return null; }
}
let controller: { handle(raw: unknown): Promise<CommandCenterResult>; state(): unknown; refresh(): Promise<void>; board(): unknown; broadcast(): unknown; ask(): unknown; say(): unknown; forgetReviewed(): Thenable<void>; setup(): unknown } | undefined;
let controllerForTest: typeof controller;
export function commandCenterForTests(): NonNullable<typeof controller> {
  if (!controllerForTest) throw new Error('The Command Center is only exposed in Extension Host tests.');
  return controllerForTest;
}

/** How many accounts and role groups there are, for the first steps (#357); null when it cannot be read, never 0 by a guess. */
async function guideCounts(live: Array<Record<string, unknown>>): Promise<{ accounts: number | null; roleGroups: number | null }> {
  let accounts: number | null = null;
  let groups: number | null = null;
  try {
    const service = await accountService(() => live as never);
    const loaded = service.ok ? service.service.list() : null;
    if (loaded && loaded.ok) accounts = loaded.profiles.length;
  } catch { /* unknown */ }
  try {
    const opened = await privateStorage()?.use();
    const listed = opened?.ok ? (opened.store as { list(collection: string): { ok: boolean; items?: unknown[] } }).list('roleGroups') : null;
    if (listed && listed.ok) groups = (listed.items ?? []).length;
  } catch { /* unknown */ }
  return { accounts, roleGroups: groups };
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
    await Promise.all(loaded.profiles.slice(0, 50).map(async (profile: { id: string }) => {
      try {
        const detail = await quotaDetail(profile.id, sessionUse);
        // The plan of a Claude Code account comes from its sign-in check (#352); Codex reads its own from its session log.
        details[profile.id] = detail && !detail.plan ? { ...detail, plan: accountPlan(profile.id) } : detail;
      } catch { details[profile.id] = null; }
    }));
    const profiles = loaded.profiles.map((profile: { id: string; label: string; provider: string }, index: number) => ({
      id: profile.id, label: profile.label, email: accountEmail(profile.id), provider: builtIn.get(profile.provider)?.label ?? profile.provider,
      health: described[index]?.health, identity: described[index]?.verifiedIdentity, issues: (described[index]?.issues ?? []).map((issue: { hint: string }) => issue.hint)
    }));
    return model.buildAccountRows({ accounts: profiles, details, sessions: live, now: new Date() });
  } catch { return { rows: [], alerts: [] }; }
}

const ASK_WAIT_MS = 10 * 60 * 1000;
const { parseMarkdown } = require('../reports/markdown') as { parseMarkdown(text: string, options: { links: string[] }): { blocks: unknown[]; truncated: boolean } };
const { reasonText: broadcastReason } = require('../broadcast/deliver') as { reasonText(reason: string): string };
type SayPlan = { ok: true; kind: 'ask'; id: string; question: string; withSelection: boolean } | { ok: true; kind: 'task' | 'broadcast'; ids: string[]; text: string; to: string } | { ok: false; reason: string };
const { interpret } = require('./intent') as { interpret(text: string, context: { cards: unknown[] }): SayPlan };

/** The Command Center: a read-only team screen in the editor area (issue #309). Everything it shows comes from the existing services. */
export function registerCommandCenter(context: vscode.ExtensionContext, sessions: SessionCommands): void {
  let cached: { pm: any[]; agents: any[]; accounts: any[]; alerts: string[]; decisions: unknown; notes: string[]; skills?: ReturnType<typeof model.buildSkills> } | undefined;
  let layout: Layout = model.normalizeLayout(context.workspaceState.get(LAYOUT_KEY));
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The tab the Workbench was opened at, sent once the new page says it is ready.
  let pendingTab: string | undefined;

  const knownIds = (): Set<string> => new Set([...(cached?.pm ?? []), ...(cached?.agents ?? [])].map((card) => card.id as string));
  const knownAccountIds = (): Set<string> => new Set((cached?.accounts ?? []).map((row) => row.id as string));
  const knownSkills = (): Set<string> => new Set((cached?.skills?.items ?? []).map((skill) => skill.name));
  // The items the board last showed (#397): only these can be opened from it.
  let boardItems = new Set<string>();
  let lastBoard: unknown = null;
  let boardReading: Promise<void> | null = null;
  const loadBoard = (): Promise<void> => {
    if (boardReading) return boardReading;
    boardReading = (async () => {
      try {
        const read = await boardData();
        const board = read.ok
          ? buildBoard({ repository: read.repository, issues: read.issues, pullRequests: read.pullRequests, merged: read.merged, details: read.details, ownerPosts: read.ownerPosts, agents: [...(cached?.pm ?? []), ...(cached?.agents ?? [])] })
          : { state: 'unavailable', reason: read.text, columns: [] };
        boardItems = new Set(board.columns.flatMap((column) => column.cards.map((card) => `${card.kind}:${card.number}`)));
        lastBoard = board;
        if (panel) void panel.webview.postMessage({ type: 'board', board, readAt: new Date().toISOString() });
      } finally { boardReading = null; }
    })();
    return boardReading;
  };
  // The Broadcast tab (#357): the role groups of the agents on the screen, and who a target names.
  const shownCards = (): any[] => [...(cached?.pm ?? []), ...(cached?.agents ?? [])];
  const knownGroups = (): Set<string> => new Set(shownCards().map((card) => card.roleGroupId).filter((id): id is string => typeof id === 'string'));
  const idsOf = (message: Message): string[] => (typeof message.group === 'string' ? shownCards().filter((card) => card.roleGroupId === message.group).map((card) => card.id as string) : message.ids ?? []);
  const labelOf = (id: string): string => { const card = shownCards().find((entry) => entry.id === id); return card ? `${card.codename ? `${card.codename} · ` : ''}${card.name}` : `session ${id.slice(0, 8)}`; };
  let lastBroadcast: unknown = null;
  // The Ask tab (#357): one question at a time; its answer file is looked at until it is there, or for ten minutes at most.
  let lastAsk: unknown = null;
  let askTimer: ReturnType<typeof setInterval> | undefined;
  const tellAsk = (message: Record<string, unknown>): void => { lastAsk = { type: 'askState', ...message }; if (panel) void panel.webview.postMessage(lastAsk); };
  const watchAnswer = (asked: { file: string; root: string }, label: string): void => {
    if (askTimer) clearInterval(askTimer);
    const started = Date.now();
    const look = (): void => {
      const read = readAnswer(asked);
      if (read.state === 'answered') {
        clearInterval(askTimer); askTimer = undefined;
        const tree = parseMarkdown(read.text, { links: [] });
        tellAsk({ state: 'answered', from: label, blocks: tree.blocks, truncated: tree.truncated, file: asked.file });
      } else if (read.state === 'invalid') {
        clearInterval(askTimer); askTimer = undefined;
        tellAsk({ state: 'invalid', from: label, reason: read.reason, file: asked.file });
      } else if (Date.now() - started > ASK_WAIT_MS) {
        clearInterval(askTimer); askTimer = undefined;
        tellAsk({ state: 'timeout', from: label, reason: `No answer was written in ${ASK_WAIT_MS / 60000} minutes. Look at the agent's terminal; it may still be working on it, or have answered there.`, file: asked.file });
      }
    };
    askTimer = setInterval(look, 1500);
    context.subscriptions.push({ dispose: () => { if (askTimer) clearInterval(askTimer); } });
    look();
  };
  const tellPage = (message: unknown): void => { lastBroadcast = message; if (panel) void panel.webview.postMessage(message); };
  // The "say it" box (#357, #360 guideline 3): the plan last previewed, and only that plan, for that same text, can be carried out.
  let lastSay: unknown = null;
  let previewed: { text: string; plan: SayPlan } | null = null;
  const tellSay = (message: Record<string, unknown>): void => { lastSay = { type: 'sayState', ...message }; if (panel) void panel.webview.postMessage(lastSay); };
  const sayCards = (): unknown[] => [...(cached?.pm ?? []).map((card) => ({ ...card, pm: true })), ...(cached?.agents ?? []).map((card) => ({ ...card, pm: false }))]
    .map((card) => ({ id: card.id, codename: card.codename, name: card.name, roleGroupId: card.roleGroupId, roleName: card.roleName, pm: card.pm }));
  const samePlan = (a: SayPlan, b: SayPlan): boolean => a.ok && b.ok && a.kind === b.kind && (a.kind === 'ask' ? b.kind === 'ask' && a.id === b.id && a.withSelection === b.withSelection : b.kind !== 'ask' && a.ids.join(',') === b.ids.join(','));
  const payload = () => {
    if (!cached) return null;
    return { layout, pm: model.arrange(cached.pm, { ...layout, pinned: [] }), agents: model.arrange(cached.agents, layout), accounts: cached.accounts, alerts: cached.alerts, decisions: cached.decisions, notes: cached.notes, skills: cached.skills ?? model.buildSkills(null), guide: { ...model.buildGettingStarted(guideRead), hidden: context.workspaceState.get(GUIDE_HIDDEN_KEY) === true } };
  };
  const post = (): void => { const state = payload(); if (panel && state) void panel.webview.postMessage({ type: 'state', state }); };

  // What the slow parts last read, so the first step of a refresh shows the cards with them instead of blanks.
  let lastReports: Record<string, unknown> = {};
  let lastAssignments: Record<string, unknown> = {};
  const publish = (next: NonNullable<typeof cached>): void => { cached = next; post(); };
  // What the first steps were last read from; unknown until the first refresh has read it.
  let lastSetup: unknown = null;
  let guideRead: { accounts: number | null; roleGroups: number | null; agents: number | null; tasks: number | null; reviewed: boolean | null } = { accounts: null, roleGroups: null, agents: null, tasks: null, reviewed: null };
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
    publish({ pm: first.pm, agents: first.agents, accounts: cached?.accounts ?? [], alerts: cached?.alerts ?? [], decisions: model.describeDecisions(decisionCountsSnapshot()), notes: cached ? cached.notes : notesWith(undefined), skills: cached?.skills });
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
    const skills = model.buildSkills(await skillLibrarySummary());
    const counts = await guideCounts(live);
    guideRead = { ...counts, agents: live.length, tasks: await countTasksSent(), reviewed: context.workspaceState.get(GUIDE_REVIEWED_KEY) === true };
    publish({ pm: built.pm, agents: built.agents, accounts: accountRows.rows, alerts: accountRows.alerts, decisions: model.describeDecisions(decisionCountsSnapshot()), notes: notesWith(teamRules), skills });
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
    const parsed = model.parseMessage(raw, knownIds(), knownAccountIds(), knownSkills(), boardItems, knownGroups());
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
      // The Work tab's board (#397): read when the tab is shown and on its Refresh; only read, never written.
      case 'loadBoard':
        await loadBoard();
        return { ok: true, command: message.type };
      // An item of the board opens on its own page (#353), as from the Open Issue or pull request list.
      case 'openWorkItem':
        await vscode.commands.executeCommand(REPORT_COMMANDS.openPage, { kind: message.kind, number: message.number });
        return { ok: true, command: message.type };
      // The Ask tab (#357, #360 item 5): which code would go with the question, in words.
      case 'askContext': {
        const selection = currentSelection();
        tellAsk({ state: 'context', selection: selection.ok ? { file: selection.file, startLine: selection.startLine, endLine: selection.endLine } : null, reason: selection.ok ? null : selection.reason });
        return { ok: true, command: message.type };
      }
      // Asked through the shared confirmation; the answer is read only from the file named for this question.
      case 'askSend': {
        const card = shownCards().find((entry) => entry.id === message.id);
        const label = card ? `${card.codename ? `${card.codename} · ` : ''}${card.name}` : 'the agent';
        const asked = await askAgent(sessions, { sessionId: message.id as string, question: message.question ?? '', withSelection: message.withSelection === true });
        if (!asked.ok) { tellAsk({ state: 'refused', from: label, reason: asked.reason }); return { ok: true, command: message.type }; }
        tellAsk({ state: 'waiting', from: label, file: asked.file });
        watchAnswer(asked, label);
        return { ok: true, command: message.type };
      }
      // The "say it" box: what the line means, said back with exactly what would be typed and to whom; nothing is typed.
      case 'sayPreview': {
        previewed = null;
        const plan = interpret(message.text ?? '', { cards: sayCards() });
        if (!plan.ok) { tellSay({ state: 'refused', reason: plan.reason }); return { ok: true, command: message.type }; }
        if (plan.kind === 'ask') {
          const selection = plan.withSelection ? currentSelection() : null;
          if (selection && !selection.ok) { tellSay({ state: 'refused', reason: `${selection.reason} Select the code in the editor first, or ask without "this code".` }); return { ok: true, command: message.type }; }
          previewed = { text: message.text ?? '', plan };
          tellSay({ state: 'preview', kind: 'ask', to: labelOf(plan.id), question: plan.question, selection: selection && selection.ok ? { file: selection.file, startLine: selection.startLine, endLine: selection.endLine } : null });
          return { ok: true, command: message.type };
        }
        const preview = previewBroadcast(sessions, { text: plan.text, ids: plan.ids });
        if (!preview.ok) { tellSay({ state: 'refused', reason: preview.reason }); return { ok: true, command: message.type }; }
        previewed = { text: message.text ?? '', plan };
        tellSay({ state: 'preview', kind: plan.kind, to: plan.to, prompt: preview.prompt, recipients: preview.recipients.map((entry) => ({ label: labelOf(entry.id), decision: entry.decision, reason: entry.reason })) });
        return { ok: true, command: message.type };
      }
      // Carried out only as previewed: the same text, meaning the same thing to the same agents now, through the flow's own confirmation.
      case 'sayRun': {
        const before = previewed;
        previewed = null;
        if (!before || before.text !== message.text) { tellSay({ state: 'refused', reason: 'Preview it first: the text changed since the preview.' }); return { ok: true, command: message.type }; }
        const plan = interpret(message.text ?? '', { cards: sayCards() });
        if (!plan.ok || !samePlan(plan, before.plan)) { tellSay({ state: 'refused', reason: 'The agents on the screen changed since the preview. Preview it again.' }); return { ok: true, command: message.type }; }
        if (plan.kind === 'ask') {
          const label = labelOf(plan.id);
          tellSay({ state: 'running' });
          const asked = await askAgent(sessions, { sessionId: plan.id, question: plan.question, withSelection: plan.withSelection });
          if (!asked.ok) { tellSay({ state: 'refused', reason: asked.reason }); return { ok: true, command: message.type }; }
          tellSay({ state: 'asked', to: label });
          tellAsk({ state: 'waiting', from: label, file: asked.file });
          watchAnswer(asked, label);
          if (panel) void panel.webview.postMessage({ type: 'showTab', tab: 'ask' });
          return { ok: true, command: message.type };
        }
        tellSay({ state: 'running' });
        const results = await sendBroadcast(sessions, { text: plan.text, ids: plan.ids });
        tellSay(results
          ? { state: 'results', sent: true, results: results.map((entry) => ({ label: labelOf(entry.sessionId), outcome: entry.outcome, reason: broadcastReason(entry.reason) })) }
          : { state: 'results', sent: false, results: [] });
        void refresh();
        return { ok: true, command: message.type };
      }
      // The Broadcast tab (#357, #360 item 7): what would be typed and to whom; nothing is typed.
      case 'broadcastPreview': {
        const ids = idsOf(message);
        const preview = previewBroadcast(sessions, { text: message.text ?? '', ids });
        tellPage(preview.ok
          ? { type: 'broadcastPreview', ok: true, prompt: preview.prompt, recipients: preview.recipients.map((entry) => ({ label: labelOf(entry.id), decision: entry.decision, reason: entry.reason })) }
          : { type: 'broadcastPreview', ok: false, reason: preview.reason });
        return { ok: true, command: message.type };
      }
      // Sent through the shared flow: its own modal shows the whole line and the list, and nothing is typed until it is confirmed.
      case 'broadcastSend': {
        const results = await sendBroadcast(sessions, { text: message.text ?? '', ids: idsOf(message) });
        tellPage(results
          ? { type: 'broadcastResults', sent: true, results: results.map((entry) => ({ label: labelOf(entry.sessionId), outcome: entry.outcome, reason: broadcastReason(entry.reason) })) }
          : { type: 'broadcastResults', sent: false, results: [] });
        void refresh();
        return { ok: true, command: message.type };
      }
      case 'setLayout':
      case 'reorder':
      case 'toggleCollapse':
      case 'togglePin':
        layout = model.applyLayoutMessage(layout, message);
        await context.workspaceState.update(LAYOUT_KEY, layout);
        post();
        return { ok: true, command: message.type };
      // The card's "Switch account…" (#352): the session command picks the account and asks before it stops anything.
      case 'switchAccount':
        void vscode.commands.executeCommand('multiagentSystem.sessions.restartWithAccount', { id: message.id });
        return { ok: true, command: message.type };
      // The card's Stop… and Restart… (#357): the session commands' own confirmations say what stops and what starts again.
      case 'stopAgent':
        void vscode.commands.executeCommand('multiagentSystem.sessions.stop', { id: message.id });
        return { ok: true, command: message.type };
      case 'restartAgent':
        void vscode.commands.executeCommand('multiagentSystem.sessions.restart', { id: message.id });
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
          case 'addClaude': await vscode.commands.executeCommand(ACCOUNT_COMMANDS.addClaude); break;
          case 'addCodex': await vscode.commands.executeCommand(ACCOUNT_COMMANDS.addCodex); break;
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
      // One skill of the Knowledge tab (#359): the command's own windows ask everything; the page names only which skill.
      case 'skillAction':
        void vscode.commands.executeCommand(model.SKILL_ACTIONS[message.action as string], { name: message.name });
        return { ok: true, command: `skillAction:${message.action}` };
      // The Setup tab (#357): what the tools and modes are now. Reading changes and downloads nothing.
      case 'loadSetup': {
        const setting = (key: string): unknown => readUserLevel(vscode.workspace.getConfiguration().inspect(key)).value;
        const tools = model.describeTools(await readToolsSummary());
        const modes = model.describeModes({ autoMode: setting('multiagentSystem.agents.autoMode'), overrides: setting('multiagentSystem.agents.autoModeOverrides'), isolation: setting('multiagentSystem.isolation.mode'), preTrust: setting('multiagentSystem.agents.preTrustManagedWorktrees') });
        lastSetup = { type: 'setup', tools, modes };
        if (panel) void panel.webview.postMessage(lastSetup);
        return { ok: true, command: message.type };
      }
      // VS Code's Settings at that one setting (a key from a fixed list): the person changes it there.
      case 'openSetting':
        void vscode.commands.executeCommand('workbench.action.openSettings', message.key);
        return { ok: true, command: message.type };
      case 'guideHide':
      case 'guideShow':
        await context.workspaceState.update(GUIDE_HIDDEN_KEY, message.type === 'guideHide');
        post();
        return { ok: true, command: message.type };
      case 'showClassicViews': {
        // A change to the person's own settings: said first, and made only when they agree (#357).
        const answer = await vscode.window.showInformationMessage('Show the classic views in the side bar?', { modal: true, detail: 'This turns on the setting multiagentSystem.showClassicViews in your user settings: the nine views (Overview, Issues Report, PRs Report, GitHub, Accounts and Sessions, Role Groups and Rules, Administrator Broadcasts, Shared Memory, Tools Setup) appear under Multiagent. Turn it off there to hide them again.' }, 'Show Classic Views');
        if (answer !== 'Show Classic Views') return { ok: false, reason: 'cancelled' };
        await vscode.workspace.getConfiguration('multiagentSystem').update('showClassicViews', true, vscode.ConfigurationTarget.Global);
        void vscode.window.showInformationMessage('The classic views are shown under Multiagent in the side bar. Hide them again in Settings: multiagentSystem.showClassicViews.');
        return { ok: true, command: message.type };
      }
      default:
        return { ok: false, reason: 'unknown-command' };
    }
  };
  teamReader = async () => { await refresh(); return cached ? { pm: cached.pm, agents: cached.agents, accounts: cached.accounts } : null; };
  controller = { handle, state: payload, refresh, board: () => lastBoard, broadcast: () => lastBroadcast, ask: () => lastAsk, say: () => lastSay, forgetReviewed: () => context.workspaceState.update(GUIDE_REVIEWED_KEY, undefined), setup: () => lastSetup };
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
    onDidChangeSkillLibrary(() => scheduleRefresh()),
    onDidOpenPullRequestPage(() => { void context.workspaceState.update(GUIDE_REVIEWED_KEY, true).then(() => scheduleRefresh()); }),
    { dispose: () => { panel?.dispose(); if (timer) clearTimeout(timer); } }
  );
  // The first time the extension starts (#357 acceptance 3; it starts when the side bar or one of its commands is first used, not with
  // every window): the Workbench opens by itself, at the Agents tab and its first steps. Once per user, and never in the extension's own
  // tests, which open it themselves.
  if (context.extensionMode !== vscode.ExtensionMode.Test && context.globalState.get(FIRST_OPEN_KEY) !== true) {
    void context.globalState.update(FIRST_OPEN_KEY, true).then(() => open({ tab: 'agents' }));
  }
}

/** Whether the Command Center panel is open (Extension Host tests). */
export function commandCenterOpenForTests(): boolean { return panel !== undefined; }

/** The page the open panel shows (Extension Host tests). */
export function commandCenterHtmlForTests(): string | undefined { return panel?.webview.html; }
