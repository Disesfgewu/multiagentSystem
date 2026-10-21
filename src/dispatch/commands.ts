import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { privateStorage } from '../storage/storageCommands';
import { SessionCommands } from '../sessions/sessionCommands';
import { isExtensionTestMode } from '../shared/testMode';
import { issueForDispatch, openIssuesForDispatch } from '../reports/reportsView';

const { buildTaskPrompt, planTask, targetLabel, MAX_TEXT_CHARS } = require('./task') as {
  buildTaskPrompt(input: unknown): { ok: true; prompt: string; kind: 'issue' | 'free'; issueNumber: number | null } | { ok: false; reason: string };
  planTask(input: { prompt: string; target: Target; sessions: unknown[]; roleOf: (session: any) => string | undefined }): { ok: true; prompt: string; recipients: Recipient[] } | { ok: false; reason: string };
  targetLabel(target: Target): string;
  MAX_TEXT_CHARS: number;
};
const { DispatchStore } = require('./store') as { DispatchStore: new (store: Store) => { record(raw: unknown): { ok: boolean; reason?: string }; list(): { ok: boolean; items?: Array<{ kind: string; issueNumber: number | null; at: string; results: Array<{ sessionId: string; outcome: string }> }>; reason?: string } } };
const { describePlan } = require('../broadcast/deliver') as { describePlan(plan: unknown): string[] };
const { roleProviderChoices } = require('../roles/provider-choices') as { roleProviderChoices(): Array<{ id: string; label: string; detail: string }> };

type Target = { scope: 'all' } | { scope: 'role'; role: string } | { scope: 'provider'; provider: string } | { scope: 'sessions'; ids: string[] };
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
async function openStore(): Promise<Store | undefined> {
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

async function chooseTarget(sessions: SessionCommands, roleOf: (session: any) => string | undefined): Promise<Target | undefined> {
  const open = sessions.list().filter((session) => session.terminalOpen);
  if (open.length === 0) { void vscode.window.showInformationMessage('No managed session has an open terminal.'); return undefined; }
  const scope = await vscode.window.showQuickPick([
    { label: 'Every open agent', detail: 'Each one that is waiting for input.', value: 'all' as const },
    { label: 'A role group', detail: 'Only agents with this role (for example worker or researcher).', value: 'role' as const },
    { label: 'A provider', detail: 'Only agents running this CLI.', value: 'provider' as const },
    { label: 'Chosen sessions', detail: 'Pick one or more open sessions.', value: 'sessions' as const }
  ], { placeHolder: 'Who should receive this task?', ignoreFocusOut: true });
  if (!scope) return undefined;
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
async function dispatch(sessions: SessionCommands, mode: Mode, trusted: () => boolean = () => vscode.workspace.isTrusted): Promise<void> {
  if (!trusted()) { void vscode.window.showWarningMessage('Trust this workspace before handing tasks to agents.'); return; }
  const opened = await openStore();
  if (!opened) return;
  const roleOf = (session: { roleGroupId?: string }): string | undefined => {
    if (!session.roleGroupId || session.roleGroupId === 'unassigned') return undefined;
    try { const loaded = opened.get('roleGroups', session.roleGroupId); return loaded?.ok && loaded.found ? loaded.value?.group?.role : undefined; } catch { return undefined; }
  };
  const task = await composeTask(mode);
  if (!task) return;
  const target = await chooseTarget(sessions, roleOf);
  if (!target) return;
  const plan = planTask({ prompt: task.prompt, target, sessions: sessions.list(), roleOf });
  if (!plan.ok) { void vscode.window.showErrorMessage(`This task cannot be sent (${plan.reason}).`); return; }
  if (plan.recipients.length === 0) { void vscode.window.showInformationMessage(`No open session matches: ${targetLabel(target)}.`); return; }
  const waitingIds = new Set(plan.recipients.filter((entry) => entry.decision === 'send').map((entry) => entry.id));
  const unknownIds = new Set(plan.recipients.filter((entry) => entry.decision === 'unknown').map((entry) => entry.id));
  if (waitingIds.size === 0 && unknownIds.size === 0) { void vscode.window.showInformationMessage('No session can receive this task now.', { modal: true, detail: describePlan(plan).join('\n') }); return; }
  const sendWaiting = 'Send Now';
  const sendUnknown = waitingIds.size > 0 ? 'Also Send to Unknown' : 'Send to Unknown Anyway';
  const confirmed = await vscode.window.showWarningMessage(
    'Type this task into the running agents?',
    { modal: true, detail: `Target: ${targetLabel(target)}\n\n${describePlan(plan).join('\n')}` },
    ...(waitingIds.size > 0 ? [sendWaiting] : []), ...(unknownIds.size > 0 ? [sendUnknown] : [])
  );
  if (confirmed !== sendWaiting && confirmed !== sendUnknown) return;
  const includeUnknown = confirmed === sendUnknown;
  const allowedIds = new Set([...waitingIds, ...(includeUnknown ? unknownIds : [])]);

  // The Issue is read again: if its text changed while the window was open, the person agreed to different text and nothing is typed.
  let prompt = task.prompt;
  let changed = false;
  if (task.kind === 'issue' && task.issueNumber !== null) {
    const again = await issueForDispatch(task.issueNumber);
    const rebuilt = again && again.state === 'open' ? buildTaskPrompt({ issue: again }) : undefined;
    if (!rebuilt || !rebuilt.ok || rebuilt.prompt !== task.prompt) changed = true; else prompt = rebuilt.prompt;
  }
  const fresh = changed ? { ok: false as const, reason: 'task-changed' } : planTask({ prompt, target, sessions: sessions.list(), roleOf });
  if (!fresh.ok) { void vscode.window.showErrorMessage(`This task can no longer be sent (${fresh.reason}). Nothing was typed.`); return; }
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
export function dispatchForTests(sessions: SessionCommands, mode: Mode, options: { trusted?: boolean } = {}): Promise<void> {
  if (!isExtensionTestMode()) throw new Error('This is only exposed in Extension Host tests.');
  return dispatch(sessions, mode, options.trusted === undefined ? undefined : () => options.trusted === true);
}

export function registerDispatchCommands(context: vscode.ExtensionContext, sessions: SessionCommands): void {
  context.subscriptions.push(
    // Neither command takes an argument: nothing a caller passes can choose the task, the recipients or skip the confirmation.
    vscode.commands.registerCommand(DISPATCH_COMMANDS.assignIssue, () => dispatch(sessions, 'issue')),
    vscode.commands.registerCommand(DISPATCH_COMMANDS.sendTask, () => dispatch(sessions, 'free'))
  );
}
