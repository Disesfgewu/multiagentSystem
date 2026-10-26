import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { privateStorage } from '../storage/storageCommands';
import { SessionCommands } from '../sessions/sessionCommands';
import { isExtensionTestMode } from '../shared/testMode';
import { issueForDispatch, openIssuesForDispatch } from '../reports/reportsView';

const { buildTaskPrompt, planTask, targetLabel, branchNameFor, MAX_TEXT_CHARS } = require('./task') as {
  branchNameFor(number: number, title: string): string | null;
  buildTaskPrompt(input: unknown): { ok: true; prompt: string; kind: 'issue' | 'free'; issueNumber: number | null } | { ok: false; reason: string };
  planTask(input: { prompt: string; target: Target; sessions: unknown[]; roleOf: (session: any) => string | undefined }): { ok: true; prompt: string; recipients: Recipient[] } | { ok: false; reason: string };
  targetLabel(target: Target): string;
  MAX_TEXT_CHARS: number;
};
const { DispatchStore } = require('./store') as { DispatchStore: new (store: Store) => { record(raw: unknown): { ok: boolean; reason?: string }; list(): { ok: boolean; items?: Array<{ kind: string; issueNumber: number | null; at: string; results: Array<{ sessionId: string; outcome: string }> }>; reason?: string } } };
const { describePlan, reasonText } = require('../broadcast/deliver') as { describePlan(plan: unknown): string[]; reasonText(reason: string): string };
const { roleProviderChoices } = require('../roles/provider-choices') as { roleProviderChoices(): Array<{ id: string; label: string; detail: string }> };

export type Target = { scope: 'all' } | { scope: 'role'; role: string } | { scope: 'provider'; provider: string } | { scope: 'sessions'; ids: string[] };
type Recipient = { id: string; name: string; provider: string; decision: 'send' | 'unknown' | 'skip'; reason: string };
type Store = { get(collection: string, id: string): any; list(collection: string): any; transact(work: (tx: any) => unknown): any };
type Mode = 'issue' | 'free';

export const DISPATCH_COMMANDS = {
  assignIssue: 'multiagentSystem.dispatch.assignIssue',
  sendTask: 'multiagentSystem.dispatch.sendTask'
} as const;

const REFUSALS: Record<string, string> = {
  'hidden-characters': 'it contains hidden or direction-changing characters',
  'marker-forged': 'it contains the wording this extension uses to mark a task from the administrator',
  'injection-suspected': 'it contains text that tells an agent to ignore or change its rules',
  'content-scan-rejected': 'the content scan found something that looks private (a credential, a local path or similar)',
  'content-scan-failed': 'the content scan could not run',
  'task-empty': 'it is empty',
  'task-too-long': `it is longer than ${MAX_TEXT_CHARS} characters`,
  'task-invalid': 'it is not a valid task',
  'prompt-invalid': 'it cannot be typed as one safe line'
};
const refusal = (reason: string): string => REFUSALS[reason] ?? 'it cannot be sent';

/** The private store, or undefined with a message. */
export async function openStore(): Promise<Store | undefined> {
  const opened = await privateStorage()?.use();
  if (!opened?.ok) { void vscode.window.showErrorMessage(`Private storage is unavailable (${String(opened?.reason ?? 'unknown')}).`); return undefined; }
  return opened.store as Store;
}

/** Builds the task from what the person chose: an open Issue read again from GitHub, or the sentence they type. Takes nothing from a caller. */
async function composeTask(mode: Mode): Promise<{ ok: true; prompt: string; kind: Mode; issueNumber: number | null } | undefined> {
  if (mode === 'free') {
    const text = await vscode.window.showInputBox({ prompt: 'The task to type into the running agents (one line).', ignoreFocusOut: true, validateInput: (value) => (value.trim() === '' ? 'Enter the task.' : undefined) });
    if (!text) return undefined;
    const built = buildTaskPrompt({ text });
    if (!built.ok) { void vscode.window.showErrorMessage(`This task cannot be sent: ${refusal(built.reason)}.`); return undefined; }
    return built;
  }
  const issues = await openIssuesForDispatch();
  if (issues === null) { void vscode.window.showErrorMessage('The open Issues could not be read from GitHub. Nothing was sent.'); return undefined; }
  if (issues.length === 0) { void vscode.window.showInformationMessage('There are no open Issues to hand out.'); return undefined; }
  const picked = await vscode.window.showQuickPick(issues.map((issue) => ({ label: `#${issue.number} ${issue.title}`, number: issue.number })), { placeHolder: 'Which Issue should be handed to the agents?', ignoreFocusOut: true });
  if (!picked) return undefined;
  const issue = await issueForDispatch(picked.number);
  if (!issue || issue.state !== 'open') { void vscode.window.showErrorMessage(`Issue #${picked.number} could not be read as an open Issue. Nothing was sent.`); return undefined; }
  const built = buildTaskPrompt({ issue });
  if (!built.ok) { void vscode.window.showErrorMessage(`Issue #${picked.number} cannot be sent: ${refusal(built.reason)}.`); return undefined; }
  return built;
}

async function chooseTarget(sessions: SessionCommands, roleOf: (session: any) => string | undefined, offerNew = false): Promise<Target | { scope: 'new' } | undefined> {
  const open = sessions.list().filter((session) => session.terminalOpen);
  if (open.length === 0) { void vscode.window.showInformationMessage('No managed session has an open terminal.'); return undefined; }
  const scope = await vscode.window.showQuickPick([
    { label: 'Every open agent', detail: 'Each one that is waiting for input.', value: 'all' as const },
    { label: 'A role group', detail: 'Only agents with this role (for example worker or researcher).', value: 'role' as const },
    { label: 'A provider', detail: 'Only agents running this CLI.', value: 'provider' as const },
    { label: 'Chosen sessions', detail: 'Pick one or more open sessions.', value: 'sessions' as const },
    ...(offerNew ? [{ label: 'A new agent in a new worktree', detail: 'Create a worktree for this Issue and start an agent of a role group in it.', value: 'new' as const }] : [])
  ], { placeHolder: 'Who should receive this task?', ignoreFocusOut: true });
  if (!scope) return undefined;
  if (scope.value === 'new') return { scope: 'new' };
  if (scope.value === 'all') return { scope: 'all' };
  if (scope.value === 'role') {
    const roles = [...new Set(open.map(roleOf).filter((role): role is string => typeof role === 'string'))].sort();
    if (roles.length === 0) { void vscode.window.showInformationMessage('No open session was started from a role group.'); return undefined; }
    const role = await vscode.window.showQuickPick(roles, { placeHolder: 'Which role group?', ignoreFocusOut: true });
    return role ? { scope: 'role', role } : undefined;
  }
  if (scope.value === 'provider') {
    const provider = await vscode.window.showQuickPick(roleProviderChoices(), { placeHolder: 'Which provider?', ignoreFocusOut: true });
    return provider ? { scope: 'provider', provider: provider.id } : undefined;
  }
  const chosen = await vscode.window.showQuickPick(open.map((session) => ({ label: session.name, description: `${session.provider} · ${session.stateLabel}`, id: session.id })), { placeHolder: 'Which sessions?', canPickMany: true, ignoreFocusOut: true });
  return chosen && chosen.length > 0 ? { scope: 'sessions', ids: chosen.map((entry) => entry.id) } : undefined;
}

/**
 * "Assign Issue to Agents" / "Send Task to Agents" (issue #305). Neither takes an argument: the Issue or the sentence, the
 * recipients and the confirmation always come from this window, in this VS Code window, every time, so nothing a page, an agent
 * or a script passes can choose a task or skip the confirmation. A task is typed only into a session whose CLI is recorded as
 * waiting for input (the broadcast rule); a session of unknown state needs a second, explicit button. Everything else is listed
 * with a reason and left alone. "Typed" is not proof that the agent read it or will do it.
 */
type Run = (command: string, argument?: unknown) => Thenable<any>;
// The existing commands this flow uses (names repeated to keep the imports one-way): the worktree service's create and the role group's start.
const WORKTREE_CREATE = 'multiagentSystem.worktrees.create';
const ROLE_START = 'multiagentSystem.roles.start';
const START_WAIT_MS = 90_000;

/**
 * Nobody is running to take an Issue: offer to make a worktree for it and start an agent of a role group there, then hand the Issue to
 * that agent once its CLI says it is waiting. Every step is the existing flow with its own confirmations (the worktree's folder and
 * confirmation, the role group's account choice, the auto-mode window and the enforced-isolation check); nothing here skips one. The
 * task is typed only after the usual confirmation of the whole prompt. Returns after the task was typed or the reason it was not.
 */
async function startWorkerForIssue(sessions: SessionCommands, roleOf: (session: any) => string | undefined, opened: Store, task: { prompt: string; kind: 'issue' | 'free'; issueNumber: number | null }, run: Run, waitMs: number): Promise<void> {
  if (task.kind !== 'issue' || task.issueNumber === null) return;
  const issue = await issueForDispatch(task.issueNumber);
  const branch = issue ? branchNameFor(issue.number, issue.title) : null;
  if (!issue || issue.state !== 'open' || !branch) { void vscode.window.showErrorMessage(`Issue #${task.issueNumber} could not be read as an open Issue. Nothing was started.`); return; }
  const listed = opened.list('roleGroups');
  if (!listed?.ok) { void vscode.window.showErrorMessage('The role groups could not be read, so no agent was started.'); return; }
  const groups: Array<{ id: string; name: string; role: string }> = [];
  for (const entry of listed.items ?? []) { const group = entry?.value?.group; if (group && typeof group.id === 'string' && typeof group.name === 'string') groups.push({ id: group.id, name: group.name, role: String(group.role ?? '') }); }
  if (groups.length === 0) { void vscode.window.showInformationMessage('Create a role group first: an agent is started from a role group.'); return; }
  const picked = await vscode.window.showQuickPick(groups.map((group) => ({ label: group.name, description: group.role, id: group.id })), { placeHolder: `Which role group should work on Issue #${issue.number}?`, ignoreFocusOut: true });
  if (!picked) return;
  const go = await vscode.window.showWarningMessage(
    `Start an agent for Issue #${issue.number}?`,
    { modal: true, detail: `A new worktree on branch ${branch} will be created (you choose its folder and confirm it next), then an agent of role group "${picked.label}" is started in it (its own account choice and confirmations follow). When the agent is waiting for input, the Issue is typed into it after you confirm the whole prompt.` },
    'Continue'
  );
  if (go !== 'Continue') return;
  // `offerOpen: false`: the person is not asked to open the folder in a window (that notification would hold this flow until answered).
  const created = await run(WORKTREE_CREATE, { branch, offerOpen: false });
  if (!created || created.ok !== true || typeof created.worktree?.path !== 'string') { void vscode.window.showErrorMessage('The worktree was not created, so no agent was started.'); return; }
  const started = await run(ROLE_START, { id: picked.id, cwd: created.worktree.path, name: `Issue #${issue.number}` });
  const sessionId = started && started.ok === true && typeof started.session?.id === 'string' ? started.session.id : null;
  if (!sessionId) { void vscode.window.showErrorMessage('The agent was not started. The worktree was kept.'); return; }
  // The task goes in only when the CLI itself says it is waiting for input; otherwise the person is told and nothing is typed.
  const deadline = Date.now() + waitMs;
  const waiting = () => sessions.list().some((entry) => entry.id === sessionId && (entry as { deliveryState?: { state?: string } }).deliveryState?.state === 'waiting');
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Waiting for the new agent to be ready for input…' }, async () => {
    while (Date.now() < deadline && !waiting()) await new Promise((resolve) => setTimeout(resolve, 500));
  });
  if (!waiting()) { void vscode.window.showInformationMessage(`The agent was started but has not said it is waiting for input (some CLIs never say). Nothing was typed. When it is ready, run "Assign Issue to Agents" and choose it.`); return; }
  await confirmAndType({
    sessions, roleOf, task, target: { scope: 'sessions', ids: [sessionId] },
    recheck: async () => {
      const again = await issueForDispatch(issue.number);
      const rebuilt = again && again.state === 'open' ? buildTaskPrompt({ issue: again }) : undefined;
      return rebuilt && rebuilt.ok && rebuilt.prompt === task.prompt ? rebuilt.prompt : null;
    }
  });
}

async function dispatch(sessions: SessionCommands, mode: Mode, trusted: () => boolean = () => vscode.workspace.isTrusted, run: Run = (command, argument) => vscode.commands.executeCommand(command, argument), waitMs = START_WAIT_MS): Promise<void> {
  if (!trusted()) { void vscode.window.showWarningMessage('Trust this workspace before handing tasks to agents.'); return; }
  const opened = await openStore();
  if (!opened) return;
  const roleOf = (session: { roleGroupId?: string }): string | undefined => {
    if (!session.roleGroupId || session.roleGroupId === 'unassigned') return undefined;
    try { const loaded = opened.get('roleGroups', session.roleGroupId); return loaded?.ok && loaded.found ? loaded.value?.group?.role : undefined; } catch { return undefined; }
  };
  const task = await composeTask(mode);
  if (!task) return;
  // An Issue with nobody to take it: start someone (the person can also choose that while picking recipients).
  if (task.kind === 'issue' && sessions.list().filter((session) => session.terminalOpen).length === 0) {
    const choice = await vscode.window.showInformationMessage('No managed session has an open terminal.', { modal: true, detail: 'You can create a worktree for this Issue and start an agent in it.' }, 'Create Worktree and Start Agent');
    if (choice === 'Create Worktree and Start Agent') await startWorkerForIssue(sessions, roleOf, opened, task, run, waitMs);
    return;
  }
  const target = await chooseTarget(sessions, roleOf, task.kind === 'issue');
  if (!target) return;
  if (target.scope === 'new') { await startWorkerForIssue(sessions, roleOf, opened, task, run, waitMs); return; }
  await confirmAndType({
    sessions, roleOf, task, target,
    // The Issue is read again: if its text changed while the window was open, the person agreed to different text and nothing is typed.
    recheck: task.kind === 'issue' && task.issueNumber !== null ? async () => {
      const again = await issueForDispatch(task.issueNumber as number);
      const rebuilt = again && again.state === 'open' ? buildTaskPrompt({ issue: again }) : undefined;
      return rebuilt && rebuilt.ok && rebuilt.prompt === task.prompt ? rebuilt.prompt : null;
    } : undefined
  });
}

export type TypedTask = { prompt: string; kind: 'issue' | 'free' | 'discussion' | 'meeting' | 'talk'; issueNumber: number | null };

/**
 * The part every "type this into running agents" command shares: who can receive it now, one modal that shows the whole prompt and the
 * list, the explicit second button for agents whose state is unknown, a second look at fresh evidence after the confirmation (and, when
 * the caller gives one, a re-check that the text itself is still what was agreed to), the typing, and the record of what happened.
 */
export async function confirmAndType(input: { sessions: SessionCommands; roleOf: (session: any) => string | undefined; task: TypedTask; target: Target; recheck?: () => Promise<string | null>; title?: string }): Promise<Array<{ sessionId: string; provider: string; outcome: 'sent' | 'skipped'; reason: string }> | null> {
  const { sessions, roleOf, task, target } = input;
  const title = input.title ?? 'Type this task into the running agents?';
  const plan = planTask({ prompt: task.prompt, target, sessions: sessions.list(), roleOf });
  if (!plan.ok) { void vscode.window.showErrorMessage(`This task cannot be sent (${plan.reason}).`); return null; }
  if (plan.recipients.length === 0) { void vscode.window.showInformationMessage(`No open session matches: ${targetLabel(target)}.`); return null; }
  const waitingIds = new Set(plan.recipients.filter((entry) => entry.decision === 'send').map((entry) => entry.id));
  const unknownIds = new Set(plan.recipients.filter((entry) => entry.decision === 'unknown').map((entry) => entry.id));
  if (waitingIds.size === 0 && unknownIds.size === 0) { void vscode.window.showInformationMessage('No session can receive this task now.', { modal: true, detail: describePlan(plan).join('\n') }); return null; }
  const sendWaiting = 'Send Now';
  const sendUnknown = waitingIds.size > 0 ? 'Also Send to Unknown' : 'Send to Unknown Anyway';
  const confirmed = await vscode.window.showWarningMessage(
    title,
    { modal: true, detail: `Target: ${targetLabel(target)}\n\n${describePlan(plan).join('\n')}` },
    ...(waitingIds.size > 0 ? [sendWaiting] : []), ...(unknownIds.size > 0 ? [sendUnknown] : [])
  );
  if (confirmed !== sendWaiting && confirmed !== sendUnknown) return null;
  const includeUnknown = confirmed === sendUnknown;
  const allowedIds = new Set([...waitingIds, ...(includeUnknown ? unknownIds : [])]);

  // The text is checked again if the caller can: when it changed while the window was open, the person agreed to different text and nothing is typed.
  let prompt = task.prompt;
  let changed = false;
  if (input.recheck) {
    const again = await input.recheck();
    if (again === null) changed = true; else prompt = again;
  }
  const fresh = changed ? { ok: false as const, reason: 'task-changed' } : planTask({ prompt, target, sessions: sessions.list(), roleOf });
  if (!fresh.ok) { void vscode.window.showErrorMessage(`This task can no longer be sent (${fresh.reason}). Nothing was typed.`); return null; }
  const results: Array<{ sessionId: string; provider: string; outcome: 'sent' | 'skipped'; reason: string }> = [];
  for (const entry of fresh.recipients) {
    const allowed = allowedIds.has(entry.id) && (entry.decision === 'send' || (entry.decision === 'unknown' && includeUnknown));
    if (allowed) {
      try {
        sessions.sendPrompt(entry.id, fresh.prompt);
        results.push({ sessionId: entry.id, provider: entry.provider, outcome: 'sent', reason: entry.decision === 'unknown' ? 'sent-unknown-state' : entry.reason });
      } catch { results.push({ sessionId: entry.id, provider: entry.provider, outcome: 'skipped', reason: 'send-failed' }); }
    } else {
      results.push({ sessionId: entry.id, provider: entry.provider, outcome: 'skipped', reason: entry.decision === 'send' ? 'state-unknown' : entry.reason });
    }
  }
  const latest = await openStore();
  if (latest) {
    const recorded = new DispatchStore(latest).record({ id: randomUUID(), kind: task.kind, issueNumber: task.issueNumber, at: new Date().toISOString(), results });
    if (!recorded.ok) void vscode.window.showWarningMessage(`The task was typed but its record could not be saved (${recorded.reason ?? 'unknown'}).`);
  }
  const sent = results.filter((entry) => entry.outcome === 'sent').length;
  void vscode.window.showInformationMessage(`Typed into ${sent} of ${results.length} session${results.length === 1 ? '' : 's'}. "Typed" is not proof that the agent read it or will do it.`);
  return results;
}

/**
 * The Workbench's Broadcast tab (#357, #360 item 7): what would be typed and to whom, before anything is. The same task line the "Send
 * task" command builds (with its checks), and for each chosen session whether it can receive it now. Nothing is typed or stored.
 */
export function previewBroadcast(sessions: SessionCommands, input: { text: string; ids: string[] }): { ok: false; reason: string } | { ok: true; prompt: string; recipients: Array<{ id: string; decision: string; reason: string }> } {
  const built = buildTaskPrompt({ text: input.text });
  if (!built.ok) return { ok: false, reason: `This cannot be sent: ${refusal(built.reason)}.` };
  const plan = planTask({ prompt: built.prompt, target: { scope: 'sessions', ids: input.ids }, sessions: sessions.list(), roleOf: () => undefined });
  if (!plan.ok) return { ok: false, reason: `This cannot be sent (${plan.reason}).` };
  return { ok: true, prompt: built.prompt, recipients: plan.recipients.map((entry: Recipient) => ({ id: entry.id, decision: entry.decision, reason: reasonText(entry.reason) })) };
}

/**
 * Sends the Broadcast tab's text to the chosen sessions through the shared flow (`confirmAndType`): the one modal with the whole line
 * and the list, the second button for agents whose state is unknown, the fresh look after confirming, the typing and its record.
 * Returns what happened to each session, or null when it was not sent (declined, refused, untrusted).
 */
export async function sendBroadcast(sessions: SessionCommands, input: { text: string; ids: string[] }, trusted: () => boolean = () => vscode.workspace.isTrusted): Promise<Array<{ sessionId: string; outcome: 'sent' | 'skipped'; reason: string }> | null> {
  if (!trusted()) { void vscode.window.showWarningMessage('Trust this workspace before typing into agents.'); return null; }
  const built = buildTaskPrompt({ text: input.text });
  if (!built.ok) { void vscode.window.showErrorMessage(`This cannot be sent: ${refusal(built.reason)}.`); return null; }
  const opened = await openStore();
  if (!opened) return null;
  const results = await confirmAndType({ sessions, roleOf: () => undefined, task: built, target: { scope: 'sessions', ids: input.ids }, title: 'Type this into the chosen agents?' });
  return results ? results.map((entry) => ({ sessionId: entry.sessionId, outcome: entry.outcome, reason: entry.reason })) : null;
}

/** How many tasks were ever recorded as sent, for the Workbench's first steps (#357); null when the log cannot be read. */
export async function countTasksSent(): Promise<number | null> {
  try {
    const opened = await privateStorage()?.use();
    if (!opened?.ok) return null;
    const listed = new DispatchStore(opened.store as Store).list();
    return listed.ok ? (listed.items ?? []).length : null;
  } catch { return null; }
}

/** The latest Issue each session was handed, for the Command Center cards. An unreadable log is "no information", never a guess. */
export async function readAssignments(): Promise<Map<string, { issueNumber: number; at: string }>> {
  const { latestAssignments } = require('./task') as { latestAssignments(records: unknown[]): Map<string, { issueNumber: number; at: string }> };
  try {
    const opened = await privateStorage()?.use();
    if (!opened?.ok) return new Map();
    const listed = new DispatchStore(opened.store as Store).list();
    return listed.ok ? latestAssignments(listed.items ?? []) : new Map();
  } catch { return new Map(); }
}

/** The dispatch flow run against the given sessions: only in the extension's own host tests (a real terminal with a synthetic CLI). */
export function dispatchForTests(sessions: SessionCommands, mode: Mode, options: { trusted?: boolean; run?: Run; waitMs?: number } = {}): Promise<void> {
  if (!isExtensionTestMode()) throw new Error('This is only exposed in Extension Host tests.');
  return dispatch(sessions, mode, options.trusted === undefined ? undefined : () => options.trusted === true, options.run, options.waitMs);
}

export function registerDispatchCommands(context: vscode.ExtensionContext, sessions: SessionCommands): void {
  context.subscriptions.push(
    // Neither command takes an argument: nothing a caller passes can choose the task, the recipients or skip the confirmation.
    vscode.commands.registerCommand(DISPATCH_COMMANDS.assignIssue, () => dispatch(sessions, 'issue')),
    vscode.commands.registerCommand(DISPATCH_COMMANDS.sendTask, () => dispatch(sessions, 'free'))
  );
}
