import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { askAgent, currentSelection, readAnswer } from '../../../src/ask/ask';
import { privateStorage } from '../../../src/storage/storageCommands';
import { removeTemp } from './tempCleanup';

/**
 * #357's Ask tab (#360 item 5) in a real Extension Host: the question goes with the code selected in a real editor, through the shared
 * confirmation that shows it whole, to the one agent asked; it tells the agent the file to write its answer to, in the agent's own
 * folder; and only that file is read back. agy, which has no folder of its own, is told why it cannot be asked. Declining asks nothing.
 */
export async function runAskTabChecks(workspace: string): Promise<void> {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mas-ask-host-')));
  const dir = path.join(root, 'sessions', 'ask-1', 'skills', '_answers');
  fs.mkdirSync(dir, { recursive: true });
  const since = new Date().toISOString();
  const typed: Array<{ id: string; prompt: string }> = [];
  const list = [
    { id: 'ask-1', name: 'Ask Me', provider: 'claude', terminalOpen: true, state: 'cli-observed', deliveryState: { state: 'waiting', reason: 'last-hook-event', since } },
    { id: 'ask-2', name: 'Other', provider: 'claude', terminalOpen: true, state: 'cli-observed', deliveryState: { state: 'waiting', reason: 'last-hook-event', since } },
    { id: 'ask-agy', name: 'Agy', provider: 'agy', terminalOpen: true, state: 'cli-observed', deliveryState: { state: 'waiting', reason: 'last-hook-event', since } }
  ];
  const sessions: any = {
    list: () => list,
    sendPrompt: (id: string, prompt: string) => { typed.push({ id, prompt }); },
    answerFolder: (id: string) => (id === 'agy' || id === 'ask-agy' ? null : { dir, root })
  };
  // A real editor with real code selected.
  const file = path.join(workspace, 'ask-sample.js');
  fs.writeFileSync(file, 'function add(a, b) {\n  return a + b;\n}\n');
  const editor = await vscode.window.showTextDocument(vscode.Uri.file(file));
  editor.selection = new vscode.Selection(0, 0, 2, 1);
  const selected = currentSelection();
  assert.deepEqual(selected.ok && [selected.file, selected.startLine, selected.endLine], ['ask-sample.js', 1, 3]);

  const opened = await privateStorage()?.use();
  assert.ok(opened?.ok);
  const store = opened.store as any;
  const before = new Set(((store.list('taskDispatches')?.items ?? []) as Array<{ id: string }>).map((item) => item.id));
  const ui = vscode.window as any;
  const original = { warning: ui.showWarningMessage, info: ui.showInformationMessage };
  const asked: string[] = [];
  let answer: string | undefined;
  ui.showWarningMessage = async (title: string, options: { detail?: string }, ...buttons: string[]) => { asked.push(`${title}\n${options?.detail ?? ''}`); return buttons.includes(answer ?? '') ? answer : undefined; };
  ui.showInformationMessage = async () => undefined;
  try {
    answer = undefined;
    assert.equal((await askAgent(sessions, { sessionId: 'ask-1', question: 'What does this do?', withSelection: true }, () => true)).ok, false);
    assert.equal(typed.length, 0, 'declining asks nothing');
    assert.match(asked.at(-1) ?? '', /Ask Ask Me this question\?[\s\S]*ask-sample\.js[\s\S]*function add\(a, b\)[\s\S]*What does this do\?/, 'the window shows the whole question, the code included');

    answer = 'Send Now';
    const result = await askAgent(sessions, { sessionId: 'ask-1', question: 'What does this do?', withSelection: true }, () => true);
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(path.dirname(result.file), dir, 'the answer goes to the agent\'s own answers folder');
    assert.match(path.basename(result.file), /^[a-f0-9]{16}\.md$/);
    assert.deepEqual(typed.map((entry) => entry.id), ['ask-1'], 'only the agent asked gets it');
    assert.ok(typed[0].prompt.includes(`Write your answer in Markdown to the file «${result.file}»`));
    assert.match(typed[0].prompt, /^\[Code discussion from the administrator\] About file «ask-sample\.js», lines 1-3\./);
    // Only the file named for this question is read; another file in the folder is not this answer.
    fs.writeFileSync(path.join(dir, 'aaaaaaaaaaaaaaaa.md'), 'someone else');
    assert.deepEqual(readAnswer({ file: result.file, root }), { state: 'waiting' });
    fs.writeFileSync(result.file, 'It adds `a` and `b`.\n');
    assert.deepEqual(readAnswer({ file: result.file, root }), { state: 'answered', text: 'It adds `a` and `b`.\n', bytes: 21 });

    // A question without code.
    const plain = await askAgent(sessions, { sessionId: 'ask-2', question: 'Which test covers add?', withSelection: false }, () => true);
    assert.equal(plain.ok, true);
    assert.match(typed.at(-1)!.prompt, /^\[Question from the administrator\] Question: «Which test covers add\?»/);

    const agy = await askAgent(sessions, { sessionId: 'ask-agy', question: 'q', withSelection: false }, () => true);
    assert.deepEqual(agy.ok ? null : [agy.code, /agy cannot be asked here/.test(agy.reason)], ['no-answer-folder', true]);
    const untrusted = await askAgent(sessions, { sessionId: 'ask-1', question: 'q', withSelection: false }, () => false);
    assert.equal(untrusted.ok ? null : untrusted.code, 'untrusted');
    assert.equal(typed.length, 2, 'nothing more was typed');
  } finally {
    store.transact((tx: any) => { for (const item of (store.list('taskDispatches')?.items ?? []) as Array<{ id: string }>) if (!before.has(item.id)) tx.delete('taskDispatches', item.id); return true; });
    ui.showWarningMessage = original.warning;
    ui.showInformationMessage = original.info;
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    fs.rmSync(file, { force: true });
    await removeTemp(root);
  }
  console.log('host smoke: the Ask tab sends the selected code and the question through the shared confirmation to the one agent asked, names the answer file in its own folder and reads only that file; agy is told why it cannot be asked');
}
