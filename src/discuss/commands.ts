import * as nodePath from 'node:path';
import * as vscode from 'vscode';
import { SessionCommands } from '../sessions/sessionCommands';
import { isExtensionTestMode } from '../shared/testMode';
import { DIFF_SCHEME } from '../reports/reportsView';
import { confirmAndType, openStore } from '../dispatch/commands';

const { buildDiscussionPrompt, MAX_READ_CHARS } = require('./prompt') as {
  buildDiscussionPrompt(input: unknown): { ok: true; prompt: string; cut: number } | { ok: false; reason: string; categories?: string[] };
  MAX_READ_CHARS: number;
};

export const DISCUSS_COMMANDS = { withPm: 'multiagentSystem.discuss.withPm' } as const;

const REFUSALS: Record<string, string> = {
  'hidden-characters': 'it contains hidden or direction-changing characters',
  'marker-forged': 'it contains the wording this extension uses to mark its own messages',
  'content-scan-rejected': 'it looks like it contains something private',
  'content-scan-failed': 'the privacy check could not run',
  'selection-too-large': `the selection is longer than ${MAX_READ_CHARS} characters`,
  'code-empty': 'the selection is empty',
  'question-empty': 'the question is empty',
  'question-too-long': 'the question is too long',
  'path-invalid': 'the file is not a path inside the project',
  'lines-invalid': 'the line numbers are not valid',
  'prompt-invalid': 'it cannot be typed as one safe line'
};

/** Where the selected text is, in words the PM agent can use: a repository-relative path, or the file of a pull request patch. Null if it is neither. */
function locate(document: vscode.TextDocument): { file: string; kind: 'file' | 'patch' } | { problem: string } {
  if (document.uri.scheme === DIFF_SCHEME) {
    const file = new URLSearchParams(document.uri.query).get('file');
    return file ? { file, kind: 'patch' } : { problem: 'This patch view does not say which file it shows.' };
  }
  if (document.uri.scheme !== 'file') return { problem: 'Open a file of this project (or a pull request patch) and select code in it.' };
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!folder) return { problem: 'This file is not inside an open project folder, so it has no project path to send.' };
  const relative = nodePath.relative(folder.uri.fsPath, document.uri.fsPath).split(nodePath.sep).join('/');
  return relative === '' || relative.startsWith('..') ? { problem: 'This file is not inside an open project folder, so it has no project path to send.' } : { file: relative, kind: 'file' };
}

/**
 * "Discuss with PM Agent" (issue #308). It takes no argument: the selection is whatever is selected in the active editor right now, the
 * question is typed in a box, and the PM agent receives it only after one modal that shows the whole prompt, and only if its CLI is
 * recorded as waiting for input (or the person presses the explicit second button). The code is checked for private data first and
 * nothing is sent if any is found. "Typed" is not proof that the agent read it.
 */
async function discuss(sessions: SessionCommands, editor: vscode.TextEditor | undefined, trusted: () => boolean = () => vscode.workspace.isTrusted): Promise<void> {
  if (!trusted()) { void vscode.window.showWarningMessage('Trust this workspace before sending code to an agent.'); return; }
  if (!editor || editor.selection.isEmpty) { void vscode.window.showInformationMessage('Select the code you want to discuss first.'); return; }
  const document = editor.document;
  const range = new vscode.Range(editor.selection.start, editor.selection.end);
  const where = locate(document);
  if ('problem' in where) { void vscode.window.showInformationMessage(where.problem); return; }
  // A selection that ends at the very start of a line does not include that line.
  const endLine = range.end.character === 0 && range.end.line > range.start.line ? range.end.line : range.end.line + 1;
  const startLine = range.start.line + 1;
  const code = document.getText(range);
  const question = await vscode.window.showInputBox({ prompt: 'Your question for the PM agent about the selected code', ignoreFocusOut: true, validateInput: (value) => (value.trim() === '' ? 'Enter your question.' : undefined) });
  if (!question) return;
  const build = (text: string) => buildDiscussionPrompt({ file: where.file, kind: where.kind, startLine, endLine, code: text, question });
  const built = build(code);
  if (!built.ok) {
    const kinds = built.categories && built.categories.length > 0 ? ` (${built.categories.join(', ')})` : '';
    void vscode.window.showErrorMessage(`This cannot be sent: ${REFUSALS[built.reason] ?? built.reason}${kinds}. Nothing was sent.`);
    return;
  }
  const opened = await openStore();
  if (!opened) return;
  const roleOf = (session: { roleGroupId?: string }): string | undefined => {
    if (!session.roleGroupId || session.roleGroupId === 'unassigned') return undefined;
    try { const loaded = opened.get('roleGroups', session.roleGroupId); return loaded?.ok && loaded.found ? loaded.value?.group?.role : undefined; } catch { return undefined; }
  };
  await confirmAndType({
    sessions, roleOf, task: { prompt: built.prompt, kind: 'discussion', issueNumber: null }, target: { scope: 'role', role: 'pm' },
    title: 'Type this question into the PM agent?',
    // If the selected text changed while the window was open, the person agreed to different text: nothing is typed.
    recheck: async () => {
      const again = build(document.getText(range));
      return again.ok && again.prompt === built.prompt ? again.prompt : null;
    }
  });
}

/** The discussion run against the given editor and sessions: only in the extension's own host tests. */
export function discussForTests(sessions: SessionCommands, editor: vscode.TextEditor | undefined, options: { trusted?: boolean } = {}): Promise<void> {
  if (!isExtensionTestMode()) throw new Error('This is only exposed in Extension Host tests.');
  return discuss(sessions, editor, options.trusted === undefined ? undefined : () => options.trusted === true);
}

export function registerDiscussCommands(context: vscode.ExtensionContext, sessions: SessionCommands): void {
  // No argument is read: the selection, the question and the confirmation always come from this window.
  context.subscriptions.push(vscode.commands.registerCommand(DISCUSS_COMMANDS.withPm, () => discuss(sessions, vscode.window.activeTextEditor)));
}
