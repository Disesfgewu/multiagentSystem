import * as vscode from 'vscode';
import { SessionCommands } from '../sessions/sessionCommands';
import { isExtensionTestMode } from '../shared/testMode';
import { confirmAndType, openStore } from '../dispatch/commands';

const { buildMeetingPrompt } = require('./topic') as { buildMeetingPrompt(input: unknown): { ok: true; prompt: string; topic: string } | { ok: false; reason: string; categories?: string[] } };
const { buildMinutes } = require('./minutes') as { buildMinutes(input: unknown): { ok: true; markdown: string; withheld: number; replied: number; total: number } | { ok: false; reason: string } };

export const MEETING_COMMANDS = { start: 'multiagentSystem.meeting.start' } as const;

const REFUSALS: Record<string, string> = {
  'hidden-characters': 'it contains hidden or direction-changing characters',
  'marker-forged': 'it contains wording this extension uses to mark its own messages',
  'injection-suspected': 'it reads like an instruction to ignore or change the agents\' rules',
  'content-scan-rejected': 'it looks like it contains something private',
  'content-scan-failed': 'the privacy check could not run',
  'topic-empty': 'it is empty',
  'topic-too-long': 'it is too long',
  'topic-invalid': 'it is not text',
  'prompt-invalid': 'it cannot be typed as one safe line'
};
const MINUTES_REFUSALS: Record<string, string> = { 'scan-failed': 'the privacy check could not run', 'scan-incomplete': 'the privacy check could not look at everything', 'scan-rejected': 'the finished minutes looked private as a whole' };

type Seams = { trusted?: () => boolean; readClipboard?: () => Thenable<string> };

/**
 * "Start Meeting" (issue #308). It takes no argument: the topic, the agents and every confirmation come from these windows. The topic goes
 * to the chosen agents through the same confirmation and delivery rule as every other message typed into a terminal (only agents that are
 * waiting for input, unknown ones only by an explicit button, nothing typed if the topic changed). Replies are NOT collected by this
 * extension: it cannot read an agent's answer. When the agents have answered in their terminals the person copies each answer and
 * presses "Read Clipboard" for that agent and then confirms what it holds with "Record Reply"; whatever is not pasted is recorded as "no reply recorded". The minutes open in an unsaved editor.
 */
async function meeting(sessions: SessionCommands, seams: Seams = {}): Promise<void> {
  if (!(seams.trusted ?? (() => vscode.workspace.isTrusted))()) { void vscode.window.showWarningMessage('Trust this workspace before starting a meeting.'); return; }
  const open = sessions.list().filter((session) => session.terminalOpen);
  if (open.length < 2) { void vscode.window.showInformationMessage('A meeting needs at least two managed sessions with an open terminal.'); return; }
  const text = await vscode.window.showInputBox({ prompt: 'The meeting topic: one question or subject for every chosen agent (one line).', ignoreFocusOut: true, validateInput: (value) => (value.trim() === '' ? 'Enter the topic.' : undefined) });
  if (!text) return;
  const built = buildMeetingPrompt({ topic: text });
  if (!built.ok) { const kinds = built.categories && built.categories.length > 0 ? ` (${built.categories.join(', ')})` : ''; void vscode.window.showErrorMessage(`This topic cannot be sent: ${REFUSALS[built.reason] ?? built.reason}${kinds}. Nothing was sent.`); return; }
  const chosen = await vscode.window.showQuickPick(open.map((session) => ({ label: session.name, description: `${session.provider} · ${session.stateLabel}`, id: session.id })), { placeHolder: 'Which agents take part? (at least two)', canPickMany: true, ignoreFocusOut: true });
  if (!chosen || chosen.length < 2) { if (chosen) void vscode.window.showInformationMessage('Choose at least two agents.'); return; }
  const opened = await openStore();
  if (!opened) return;
  const roleOf = (session: { roleGroupId?: string }): string | undefined => {
    if (!session.roleGroupId || session.roleGroupId === 'unassigned') return undefined;
    try { const loaded = opened.get('roleGroups', session.roleGroupId); return loaded?.ok && loaded.found ? loaded.value?.group?.role : undefined; } catch { return undefined; }
  };
  const names = new Map(open.map((session) => [session.id, session.name]));
  const results = await confirmAndType({
    sessions, roleOf, task: { prompt: built.prompt, kind: 'meeting', issueNumber: null }, target: { scope: 'sessions', ids: chosen.map((entry) => entry.id) },
    title: 'Type this meeting topic into the chosen agents?'
  });
  if (!results) return;
  const participants: Array<{ name: string; provider: string; outcome: string; reason: string; reply: string | null }> = results.map((entry) => ({ name: names.get(entry.sessionId) ?? 'Agent', provider: entry.provider, outcome: entry.outcome === 'sent' && entry.reason === 'sent-unknown-state' ? 'sent-unknown-state' : entry.outcome, reason: entry.reason, reply: null }));
  const askers = participants.filter((entry) => entry.outcome !== 'skipped');
  if (askers.length > 0) {
    const next = await vscode.window.showInformationMessage('The topic was typed. Let the agents answer in their terminals.', { modal: true, detail: 'The extension cannot read their answers. When they have answered, choose Enter Replies: for each agent you copy its answer from its terminal, press Read Clipboard, then confirm with Record Reply. Anything you do not paste is recorded as "no reply recorded".' }, 'Enter Replies', 'Make Minutes Now');
    if (next === 'Enter Replies') {
      const readClipboard = seams.readClipboard ?? (() => vscode.env.clipboard.readText());
      const used = new Map<string, string>();
      for (const entry of askers) {
        // Step 1, NOT a modal: the person has to be able to go to the terminal and copy. Nothing is read yet. Closing it skips this agent only.
        const ready = await vscode.window.showInformationMessage(`Copy ${entry.name}'s answer from its terminal, then press Read Clipboard.`, 'Read Clipboard', 'No Reply');
        if (ready !== 'Read Clipboard') continue;
        // Step 2: only now is the clipboard read, and the person sees what will be recorded under this agent's name.
        const clip = await readClipboard();
        if (clip.trim() === '') { void vscode.window.showInformationMessage(`The clipboard is empty, so no reply was recorded for ${entry.name}.`); continue; }
        const preview = Array.from(clip.replace(/\s+/g, ' ').trim()).slice(0, 200).join('');
        const twin = used.get(clip.trim());
        // The same text already recorded for another agent means the clipboard was not changed: it is not taken without a second, explicit answer.
        const decision = await vscode.window.showWarningMessage(
          twin ? `This is the same text as the reply recorded for ${twin}.` : `Record this as ${entry.name}'s reply?`,
          { modal: true, detail: `${twin ? `The clipboard has not changed since ${twin}'s reply, so it is probably not ${entry.name}'s answer.\n\n` : ''}The clipboard holds (first 200 characters):\n${preview}` },
          twin ? 'Record It Anyway' : 'Record Reply'
        );
        // Anything but the button (Escape included) skips this agent only.
        if (decision === 'Record Reply' || decision === 'Record It Anyway') { entry.reply = clip; used.set(clip.trim(), entry.name); }
      }
    }
  }
  const minutes = buildMinutes({ topic: built.topic, at: new Date(), participants });
  if (!minutes.ok) { void vscode.window.showErrorMessage(`The minutes were not made: ${MINUTES_REFUSALS[minutes.reason] ?? minutes.reason}.`); return; }
  const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: minutes.markdown });
  await vscode.window.showTextDocument(document, { preview: false });
  void vscode.window.showInformationMessage(`Meeting minutes opened (not saved): ${minutes.replied} of ${minutes.total} replies recorded.${minutes.withheld > 0 ? ` ${minutes.withheld} piece${minutes.withheld === 1 ? '' : 's'} of text looked private and ${minutes.withheld === 1 ? 'was' : 'were'} withheld.` : ''}`);
}

/** The meeting run against the given sessions: only in the extension's own host tests. */
export function meetingForTests(sessions: SessionCommands, seams: Seams = {}): Promise<void> {
  if (!isExtensionTestMode()) throw new Error('This is only exposed in Extension Host tests.');
  return meeting(sessions, seams);
}

export function registerMeetingCommands(context: vscode.ExtensionContext, sessions: SessionCommands): void {
  // No argument is read: the topic, the agents and the confirmations always come from these windows.
  context.subscriptions.push(vscode.commands.registerCommand(MEETING_COMMANDS.start, () => meeting(sessions)));
}
