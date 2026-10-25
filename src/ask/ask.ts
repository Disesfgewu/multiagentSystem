import * as vscode from 'vscode';
import { SessionCommands } from '../sessions/sessionCommands';
import { confirmAndType } from '../dispatch/commands';
import { locate } from '../discuss/commands';

const { buildDiscussionPrompt, buildQuestionPrompt } = require('../discuss/prompt') as {
  buildDiscussionPrompt(input: unknown): { ok: true; prompt: string } | { ok: false; reason: string };
  buildQuestionPrompt(input: unknown): { ok: true; prompt: string } | { ok: false; reason: string };
};
const { readAnswer, answerFile, newQuestionId } = require('./answer') as {
  readAnswer(where: { file: string; root: string }): { state: 'waiting' } | { state: 'answered'; text: string; bytes: number } | { state: 'invalid'; reason: string };
  answerFile(dir: string, id: string): string | null;
  newQuestionId(): string;
};

const REFUSALS: Record<string, string> = {
  'hidden-characters': 'it contains hidden or direction-changing characters',
  'marker-forged': 'it contains the wording this extension uses to mark its own messages',
  'content-scan-rejected': 'it looks like it contains something private',
  'content-scan-failed': 'the privacy check could not run',
  'selection-too-large': 'the selection is too long',
  'code-empty': 'the selection is empty',
  'question-empty': 'the question is empty',
  'question-too-long': 'the question is longer than 500 characters',
  'path-invalid': 'the file is not a path inside the project',
  'lines-invalid': 'the line numbers are not valid',
  'answer-path-invalid': 'the answer folder of this agent cannot be named safely',
  'prompt-invalid': 'it cannot be typed as one safe line'
};

// The text editor the person last worked in: the Workbench takes the focus, so "the selection" is the one left in that editor.
let lastEditor: vscode.TextEditor | undefined;
export function trackAskSelection(context: vscode.ExtensionContext): void {
  lastEditor = vscode.window.activeTextEditor;
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((editor) => { if (editor) lastEditor = editor; }));
}

/** What would be sent with "Include the selected code": where it is, in words, or why there is nothing. */
export function currentSelection(): { ok: true; file: string; startLine: number; endLine: number; kind: 'file' | 'patch'; code: string } | { ok: false; reason: string } {
  // The last editor keeps its selection while the Workbench is in front of it (it is then not visible); a closed document has none.
  const editor = lastEditor && !lastEditor.document.isClosed ? lastEditor : vscode.window.visibleTextEditors.find((entry) => !entry.selection.isEmpty);
  if (!editor || editor.selection.isEmpty) return { ok: false, reason: 'No code is selected in an editor.' };
  const where = locate(editor.document);
  if ('problem' in where) return { ok: false, reason: where.problem };
  const range = new vscode.Range(editor.selection.start, editor.selection.end);
  const endLine = range.end.character === 0 && range.end.line > range.start.line ? range.end.line : range.end.line + 1;
  return { ok: true, file: where.file, kind: where.kind, startLine: range.start.line + 1, endLine, code: editor.document.getText(range) };
}

export type AskResult = { ok: true; questionId: string; file: string; root: string } | { ok: false; code: string; reason: string };

/**
 * Asks one agent a question (#357, #360 item 5) and tells it where to write the answer: a file the extension names in the agent's own
 * private folder. Sent through the shared flow (`confirmAndType`): its window shows the whole question, the code included, and nothing is
 * typed until it is confirmed and only when the agent is waiting (or the person says to anyway). Nothing is read from the terminal.
 */
export async function askAgent(sessions: SessionCommands, input: { sessionId: string; question: string; withSelection: boolean }, trusted: () => boolean = () => vscode.workspace.isTrusted): Promise<AskResult> {
  if (!trusted()) return { ok: false, code: 'untrusted', reason: 'Trust this workspace before asking an agent.' };
  const session = sessions.list().find((entry) => entry.id === input.sessionId);
  if (!session) return { ok: false, code: 'session-not-found', reason: 'That agent is no longer running.' };
  const folder = sessions.answerFolder(session.id);
  if (!folder) {
    const reason = session.provider === 'agy'
      ? 'agy cannot be asked here: it has no folder of its own that this extension prepares, so there is nowhere for it to write the answer. Ask it in its terminal.'
      : 'This agent has no answer folder (it was started before this window, or its instructions are pasted by hand). Restart it to ask it here.';
    return { ok: false, code: 'no-answer-folder', reason };
  }
  const questionId = newQuestionId();
  const file = answerFile(folder.dir, questionId);
  if (!file) return { ok: false, code: 'answer-path-invalid', reason: REFUSALS['answer-path-invalid'] };
  let built: { ok: true; prompt: string } | { ok: false; reason: string };
  if (input.withSelection) {
    const selection = currentSelection();
    if (!selection.ok) return { ok: false, code: 'no-selection', reason: selection.reason };
    built = buildDiscussionPrompt({ file: selection.file, startLine: selection.startLine, endLine: selection.endLine, code: selection.code, kind: selection.kind, question: input.question, answerTo: file });
  } else {
    built = buildQuestionPrompt({ question: input.question, answerTo: file });
  }
  if (!built.ok) return { ok: false, code: built.reason, reason: `This cannot be asked: ${REFUSALS[built.reason] ?? 'it cannot be sent'}.` };
  const results = await confirmAndType({ sessions, roleOf: () => undefined, task: { prompt: built.prompt, kind: 'discussion', issueNumber: null }, target: { scope: 'sessions', ids: [session.id] }, title: `Ask ${session.name} this question?` });
  if (!results) return { ok: false, code: 'cancelled', reason: 'Nothing was asked.' };
  const sent = results.find((entry) => entry.sessionId === session.id && entry.outcome === 'sent');
  if (!sent) return { ok: false, code: 'not-sent', reason: 'The question was not typed into the agent (it was not waiting for input).' };
  return { ok: true, questionId, file, root: folder.root };
}

export { readAnswer };
