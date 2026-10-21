import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { privateStorage } from '../../../src/storage/storageCommands';
import { DispatchStore } from '../../../src/dispatch/store';
import { discussForTests } from '../../../src/discuss/commands';
import { SessionManager } from '../../../src/sessions/manager';

type DeliveryState = { state: 'waiting' | 'working' | 'ended' | 'unknown'; reason: string; since: string | null };

/**
 * "Discuss with PM Agent" in a real Extension Host: a real file opened in the editor with a real selection, a real terminal whose
 * "CLI" is a synthetic program (a shell loop appending each received line to a file). POSIX only.
 */
export async function runDiscussWithPmChecks(workspace: string): Promise<void> {
  if (process.platform === 'win32') { console.log('host smoke: Discuss with PM Agent into a synthetic CLI is POSIX-only and was not run here'); return; }
  const opened = await privateStorage()?.use();
  assert.ok(opened?.ok);
  const store = opened.store as any;
  const records = new DispatchStore(store);
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mas-discuss-')));
  const log = path.join(root, 'received.txt');
  fs.writeFileSync(log, '');
  const manager = new SessionManager<vscode.Terminal>({
    terminals: { create: ({ name, cwd }) => vscode.window.createTerminal({ name, cwd, shellPath: '/bin/sh', shellArgs: ['-c', `while IFS= read -r line; do printf '%s\\n' "$line" >> '${log}'; done`] }) },
    providers: { claude: 'claude' },
    resolveProject: async () => ({ repoId: 'repo-discuss' }),
    directoryExists: (target) => fs.existsSync(target),
    detectShellType: () => 'posix'
  });
  const GROUP = 'discuss-pm-group';
  let role = 'pm';
  let state: DeliveryState = { state: 'waiting', reason: 'last-hook-event', since: new Date().toISOString() };
  const sessions: any = {
    list: () => manager.list().map((entry) => ({ ...entry, roleGroupId: GROUP, deliveryState: state })),
    sendPrompt: (id: string, prompt: string) => manager.sendPrompt(id, prompt)
  };
  // Only the role of the group is read by this command; the record is removed again at the end.
  const putGroup = () => assert.ok(store.transact((tx: any) => { tx.put('roleGroups', GROUP, { group: { id: GROUP, role } }); return true; }).ok);
  putGroup();
  const started = await manager.start({ provider: 'claude', name: 'PM Agent', cwd: workspace, attributionFile: path.join(root, 'attribution.json') });
  const lines = async (atLeast: number): Promise<string[]> => {
    const deadline = Date.now() + 15000;
    let got: string[] = [];
    while (Date.now() < deadline) {
      got = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
      if (got.length >= atLeast) return got;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return got;
  };
  assert.match((await lines(1))[0] ?? '', /^claude --settings /);

  const sample = path.join(workspace, 'discuss-sample.txt');
  const token = ['gh', 'p_', 'a'.repeat(36)].join('');
  fs.writeFileSync(sample, `alpha\n  beta()\ngamma\nconst key = '${token}';\n`);
  let question: string | undefined = 'What does this do?';
  let answer: (buttons: string[]) => string | undefined = () => undefined;
  const seen: Array<{ message: string; buttons: string[]; detail: string }> = [];
  const errors: string[] = [];
  const ui = vscode.window as any;
  const original = { input: ui.showInputBox, warning: ui.showWarningMessage, info: ui.showInformationMessage, error: ui.showErrorMessage };
  ui.showInputBox = async () => question;
  ui.showWarningMessage = async (message: string, options: { detail?: string }, ...buttons: string[]) => { seen.push({ message, buttons, detail: String(options?.detail ?? '') }); return answer(buttons); };
  ui.showInformationMessage = async (message: string, options?: { detail?: string }) => { seen.push({ message, buttons: [], detail: String(options?.detail ?? '') }); return undefined; };
  ui.showErrorMessage = async (message: string) => { errors.push(message); return undefined; };
  const select = async (startLine: number, endLine: number, endCharacter = 0): Promise<vscode.TextEditor> => {
    const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(sample));
    editor.selection = new vscode.Selection(new vscode.Position(startLine, 0), new vscode.Position(endLine, endCharacter));
    return editor;
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 600));
  const count = () => (records.list() as { items: unknown[] }).items.length;
  try {
    // A. A selection in a real file, the PM waiting: "Send Now" types one line with the path, the lines, the code and the question.
    answer = (buttons) => buttons.includes('Send Now') ? 'Send Now' : undefined;
    await discussForTests(sessions, await select(0, 2));
    const afterA = await lines(2);
    assert.ok(afterA[1]?.startsWith('[Code discussion from the administrator] About file «discuss-sample.txt», lines 1-2.'), afterA[1]);
    assert.ok(afterA[1].includes('Selected code: «alpha ⏎ beta() ⏎»') || afterA[1].includes('Selected code: «alpha ⏎ beta()»'), 'newlines are shown as marks, indentation collapsed');
    assert.ok(afterA[1].includes('Question: «What does this do?»'));
    assert.ok(!afterA[1].includes(workspace), 'no absolute path');
    assert.equal(count(), 1);
    const shown = seen.find((entry) => entry.message === 'Type this question into the PM agent?');
    assert.ok(shown && shown.detail.includes(afterA[1]) && shown.buttons.join() === 'Send Now', 'the person saw the whole prompt and only the default button');
    assert.equal((records.list() as { items: Array<{ kind: string; issueNumber: number | null }> }).items[0].kind, 'discussion');

    // B. The selection holds a token: refused before anything is asked of an agent, and the refusal repeats nothing.
    errors.length = 0;
    seen.length = 0;
    await discussForTests(sessions, await select(2, 4));
    await settle();
    assert.equal((await lines(0)).length, 2, 'nothing was typed');
    assert.ok(errors.some((message) => /looks like it contains something private \(credential\)/.test(message)));
    assert.ok(!errors.join(' ').includes(token));
    assert.equal(seen.some((entry) => entry.message === 'Type this question into the PM agent?'), false, 'no confirmation for what cannot be sent');

    // C. Dismissing the confirmation sends nothing; an empty selection and a missing question end quietly.
    answer = () => undefined;
    await discussForTests(sessions, await select(0, 1));
    await settle();
    assert.equal((await lines(0)).length, 2);
    const emptySelection = await select(0, 0);
    emptySelection.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));
    seen.length = 0;
    await discussForTests(sessions, emptySelection);
    assert.ok(seen.some((entry) => /Select the code you want to discuss first/.test(entry.message)));
    question = undefined;
    await discussForTests(sessions, await select(0, 1));
    question = 'What does this do?';
    await settle();
    assert.equal((await lines(0)).length, 2);

    // D. An agent that is not a PM does not receive it; a PM whose state is unknown needs the explicit button.
    role = 'worker';
    putGroup();
    seen.length = 0;
    answer = (buttons) => buttons[0];
    await discussForTests(sessions, await select(0, 1));
    assert.ok(seen.some((entry) => /No open session matches: Role group: pm/.test(entry.message)));
    await settle();
    assert.equal((await lines(0)).length, 2);
    role = 'pm';
    putGroup();
    state = { state: 'unknown', reason: 'no-hook-event', since: null };
    seen.length = 0;
    await discussForTests(sessions, await select(0, 1));
    assert.deepEqual(seen.find((entry) => entry.message === 'Type this question into the PM agent?')?.buttons, ['Send to Unknown Anyway']);
    await settle();
    assert.equal((await lines(0)).length, 2, 'dismissed: nothing typed');

    // E. An untrusted workspace: nothing is asked or typed.
    state = { state: 'waiting', reason: 'last-hook-event', since: new Date().toISOString() };
    seen.length = 0;
    await discussForTests(sessions, await select(0, 1), { trusted: false });
    await settle();
    assert.equal((await lines(0)).length, 2);
    assert.equal(seen.some((entry) => entry.message === 'Type this question into the PM agent?'), false);
    assert.ok(count() === 1, 'nothing was recorded');

    // F. Text that is not a project file has no project path: refused.
    seen.length = 0;
    const scratch = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'some text' });
    const scratchEditor = await vscode.window.showTextDocument(scratch);
    scratchEditor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 4));
    await discussForTests(sessions, scratchEditor);
    assert.ok(seen.some((entry) => /Open a file of this project/.test(entry.message)));
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  } finally {
    ui.showInputBox = original.input;
    ui.showWarningMessage = original.warning;
    ui.showInformationMessage = original.info;
    ui.showErrorMessage = original.error;
    try { manager.stop(started.id); } catch { /* already closed */ }
    store.transact((tx: any) => tx.delete('roleGroups', GROUP));
    fs.rmSync(sample, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('host smoke: Discuss with PM Agent types the selected code, its place and the question into the PM terminal only after the confirmation; private data, an empty selection, a non-PM agent and an untrusted workspace send nothing');
}
