import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import * as vscode from 'vscode';
import { privateStorage } from '../../../src/storage/storageCommands';
import * as os from 'node:os';
import { collectForTests } from '../../../src/memoryPanel/commands';

const { MemoryStore } = require('../../../src/memory/store') as { MemoryStore: new (options: Record<string, unknown>) => any };

/** The Shared Memory commands in a real Extension Host: windows answered by the test, the result read back from the memory store. */
export async function runMemoryPanelChecks(workspace: string): Promise<void> {
  const opened = await privateStorage()?.use();
  assert.ok(opened?.ok);
  const store = opened.store as any;
  const GROUP = 'memory-panel-group';
  assert.ok(store.transact((tx: any) => { tx.put('roleGroups', GROUP, { group: { id: GROUP, name: 'Memory Panel Role', role: 'worker' } }); return true; }).ok);
  const dir = nodePath.join(store.dir, 'memory');
  const ui = vscode.window as any;
  const original = { pick: ui.showQuickPick, input: ui.showInputBox, warning: ui.showWarningMessage, info: ui.showInformationMessage, error: ui.showErrorMessage };
  let confirm: string | undefined;
  let text: string | undefined = 'Always run the whole test suite before pushing.';
  let pickWhich: (items: any[], placeHolder: string) => any = (items) => items[0];
  const errors: string[] = [];
  ui.showQuickPick = async (items: any[], options: { placeHolder?: string }) => pickWhich(items, String(options?.placeHolder));
  ui.showInputBox = async () => text;
  ui.showWarningMessage = async (_m: string, _o: unknown, ...buttons: string[]) => (confirm && buttons.includes(confirm) ? confirm : undefined);
  ui.showInformationMessage = async () => undefined;
  ui.showErrorMessage = async (message: string) => { errors.push(message); return undefined; };
  const memory = () => new MemoryStore({ dir, repoRoot: workspace });
  const mine = () => (memory().list().items as any[]).filter((item) => item.roleGroupId === GROUP);
  try {
    pickWhich = (items, placeHolder) => (/role group/.test(placeHolder) ? items.find((item) => item.id === GROUP) : items[0]);
    // Dismissing the confirmation adds nothing; an argument changes nothing.
    confirm = undefined;
    await vscode.commands.executeCommand('multiagentSystem.memory.add', { content: 'injected through an argument' });
    assert.equal(mine().length, 0, 'no confirmation, no note');
    // A note that looks private is refused before anything is saved.
    confirm = 'Add';
    text = `use the key ${['gh', 'p_', 'a'.repeat(36)].join('')} here`;
    await vscode.commands.executeCommand('multiagentSystem.memory.add');
    assert.equal(mine().length, 0);
    assert.ok(errors.some((message) => /credential/.test(message)));
    // A good note is added and adopted in the named local user's name.
    text = 'Always run the whole test suite before pushing.';
    await vscode.commands.executeCommand('multiagentSystem.memory.add');
    let notes = mine();
    assert.equal(notes.length, 1);
    assert.deepEqual([notes[0].status, notes[0].approvedBy?.kind, notes[0].source.kind], ['adopted', 'human', 'user']);
    // Switching off keeps it but it is no longer readable; on restores it.
    pickWhich = (items) => items[0];
    confirm = 'Switch Off';
    await vscode.commands.executeCommand('multiagentSystem.memory.toggle');
    assert.equal(mine()[0].disabled, true);
    confirm = 'Switch On';
    await vscode.commands.executeCommand('multiagentSystem.memory.toggle');
    assert.equal(mine()[0].disabled === true, false);
    // Editing replaces the text; a refused new text keeps the old one.
    confirm = 'Replace';
    text = 'Always run the whole test suite and the host tests before pushing.';
    await vscode.commands.executeCommand('multiagentSystem.memory.edit');
    notes = mine();
    assert.deepEqual(notes.map((item) => item.content), [text]);
    text = `now with ${['gh', 'p_', 'b'.repeat(36)].join('')}`;
    await vscode.commands.executeCommand('multiagentSystem.memory.edit');
    assert.equal(mine().length, 1);
    assert.ok(mine()[0].content.includes('host tests'), 'the old note was kept');
    // A suggestion stays a candidate until reviewed; rejecting it never makes it readable.
    const suggested = memory().propose({ repoId: notes[0].repoId, roleGroupId: GROUP, privacyDomain: notes[0].privacyDomain, content: 'Agents should prefer small commits.', source: { kind: 'agent-suggestion', ref: 'session x' } });
    assert.ok(suggested.ok);
    assert.equal(mine().find((item) => item.id === suggested.id).status, 'candidate');
    pickWhich = (items) => items.find((item: any) => item.id === suggested.id) ?? items[0];
    confirm = undefined;
    await vscode.commands.executeCommand('multiagentSystem.memory.review');
    assert.equal(mine().find((item) => item.id === suggested.id).status, 'candidate', 'dismissed: still a candidate');
    confirm = 'Adopt';
    await vscode.commands.executeCommand('multiagentSystem.memory.review');
    assert.equal(mine().find((item) => item.id === suggested.id).status, 'adopted');
    // Suggestions an agent left in ITS OWN folder are collected as candidates only: a secret is refused, another folder is not read, nothing is adopted.
    const mineDir = fs.realpathSync.native(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'mas-collect-a-')));
    const otherDir = fs.realpathSync.native(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'mas-collect-b-')));
    try {
      const token = ['gh', 'p_', 'c'.repeat(36)].join('');
      fs.writeFileSync(nodePath.join(mineDir, '.multiagent-memory-suggestions.json'), JSON.stringify({ suggestions: [{ text: 'Agents should write the test first.' }, { text: `deploy with ${token}` }] }));
      fs.writeFileSync(nodePath.join(otherDir, '.multiagent-memory-suggestions.json'), JSON.stringify({ suggestions: [{ text: 'This belongs to a folder nobody runs in.' }] }));
      const fake: any = { list: () => [{ id: 'session-collect-1', terminalOpen: true, worktree: mineDir, roleGroupId: GROUP, accountProfileId: 'unassigned' }, { id: 'session-closed', terminalOpen: false, worktree: otherDir, roleGroupId: GROUP }] };
      await collectForTests(fake);
      const added = mine().filter((item) => item.source?.kind === 'agent-suggestion' && item.status === 'candidate');
      assert.deepEqual(added.map((item) => [item.content, item.status]), [['Agents should write the test first.', 'candidate']], 'one candidate; the secret and the closed session\'s folder gave nothing');
      assert.ok(!mine().some((item) => item.content.includes('nobody runs in') || item.content.includes(token)));
      assert.equal(memory().select({ repoId: added[0].repoId, roleGroupId: GROUP, privacyDomain: added[0].privacyDomain, all: true }).items.some((item: any) => item.id === added[0].id), false, 'a candidate is given to no agent');
      await collectForTests(fake);
      assert.equal(mine().filter((item) => item.source?.kind === 'agent-suggestion' && item.status === 'candidate').length, 1, 'collecting again adds nothing');
    } finally { fs.rmSync(mineDir, { recursive: true, force: true }); fs.rmSync(otherDir, { recursive: true, force: true }); }
    // Deleting needs the confirmation.
    pickWhich = (items) => items[0];
    confirm = undefined;
    await vscode.commands.executeCommand('multiagentSystem.memory.remove');
    assert.equal(mine().length, 3);
    confirm = 'Delete';
    await vscode.commands.executeCommand('multiagentSystem.memory.remove');
    assert.equal(mine().length, 2);
  } finally {
    for (const item of mine()) memory().remove(item.id);
    store.transact((tx: any) => tx.delete('roleGroups', GROUP));
    Object.assign(ui, { showQuickPick: original.pick, showInputBox: original.input, showWarningMessage: original.warning, showInformationMessage: original.info, showErrorMessage: original.error });
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) { /* leave the empty private folder */ }
  }
  console.log('host smoke: Shared Memory add/edit/switch/delete/review work only after their confirmations, refuse private-looking text, keep the old note when an edit is refused, and ignore arguments');
}
