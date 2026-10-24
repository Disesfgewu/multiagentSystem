import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { accountService } from '../../../src/accounts/accountRuntime';
import { outsideTestMode } from './nonInteractiveGate';
import { removeTemp } from './tempCleanup';

type Listed = { sessions: Array<{ id: string; name: string; state: string; terminalOpen: boolean; accountProfileId: string }> };
type Item = { label: string; id?: string };

/**
 * #352 in a real Extension Host: "Switch account…" on an agent's card (Restart Session with Another Account) lists only the other
 * accounts, asks in a modal before anything stops, and on "Restart with This Account" stops the agent and starts it again in the
 * same folder with the same name and the chosen account. Dismissing the modal changes nothing, also outside test mode.
 */
export async function runSwitchAccountChecks(workspace: string): Promise<void> {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mas-switch-')));
  const accounts = await accountService(() => []);
  assert.ok(accounts.ok);
  if (!accounts.ok) return;
  const made = ['Switch From', 'Switch To'].map((label) => {
    const dir = path.join(root, label.replace(' ', '-').toLowerCase());
    fs.mkdirSync(dir);
    const created = accounts.service.create({ provider: 'claude', label, configDir: dir });
    assert.ok(created.ok, JSON.stringify(created));
    return created.ok ? created.profile.id : '';
  });
  const [from, to] = made;
  const list = async () => (await vscode.commands.executeCommand<Listed>('multiagentSystem.sessions.list', { interactive: false })).sessions;
  const started = await vscode.commands.executeCommand<{ ok: boolean; session?: { id: string } }>('multiagentSystem.sessions.start', { interactive: false, launch: false, provider: 'claude', name: 'Switch Account Agent', cwd: workspace, accountProfileId: from });
  assert.equal(started?.ok, true, JSON.stringify(started));
  const id = started!.session!.id;

  // The windows of the restart, answered as a person would: the list records what it offered, the modal its message.
  const ui = vscode.window as unknown as Record<string, unknown>;
  const original = { pick: ui.showQuickPick, warn: ui.showWarningMessage, info: ui.showInformationMessage };
  const offered: string[][] = [];
  const asked: string[] = [];
  let restart = false;
  ui.showQuickPick = async (items: Item[] | Thenable<Item[]>) => {
    const listed = await items;
    offered.push(listed.map((item) => item.label));
    return listed.find((item) => item.id === to) ?? listed[0];
  };
  const button = async (message: string, options: unknown, ...buttons: string[]) => {
    asked.push(message);
    if (/^Restart “Switch Account Agent” with the account/.test(message)) return restart ? 'Restart with This Account' : undefined;
    return typeof options === 'object' && options !== null && (options as { modal?: boolean }).modal ? buttons[0] : undefined;
  };
  ui.showWarningMessage = button;
  ui.showInformationMessage = button;
  try {
    // Dismissed: nothing stops, nothing starts.
    const dismissed = await vscode.commands.executeCommand<{ ok: boolean; code?: string }>('multiagentSystem.sessions.restartWithAccount', { id, launch: false });
    assert.equal(dismissed?.code, 'cancelled');
    assert.deepEqual(offered[0].filter((label) => /^Switch /.test(label)), ['Switch To'], 'only the other account is offered');
    assert.ok(asked.some((message) => message === 'Restart “Switch Account Agent” with the account “Switch To”?'), asked.join(' | '));
    const still = (await list()).filter((entry) => entry.name === 'Switch Account Agent');
    assert.deepEqual(still.map((entry) => [entry.id, entry.accountProfileId]), [[id, from]]);

    // Confirmed: the agent stops and starts again with the chosen account, same name, same folder.
    restart = true;
    const switched = await vscode.commands.executeCommand<{ ok: boolean; session?: { id: string; accountProfileId: string; worktree: string } }>('multiagentSystem.sessions.restartWithAccount', { id, launch: false });
    assert.equal(switched?.ok, true, JSON.stringify(switched));
    assert.notEqual(switched!.session!.id, id);
    assert.equal(switched!.session!.accountProfileId, to);
    const after = await list();
    assert.equal(after.some((entry) => entry.id === id), false, 'the stopped session is no longer listed: the agent shows once');
    assert.deepEqual(after.filter((entry) => entry.name === 'Switch Account Agent' && entry.terminalOpen).map((entry) => [entry.id, entry.accountProfileId]), [[switched!.session!.id, to]]);
    await vscode.commands.executeCommand('multiagentSystem.sessions.stop', { id: switched!.session!.id, interactive: false });
  } finally {
    ui.showQuickPick = original.pick;
    ui.showWarningMessage = original.warn;
    ui.showInformationMessage = original.info;
  }

  // Outside test mode a caller cannot skip the modal: dismissed, the running agent is untouched.
  const again = await vscode.commands.executeCommand<{ ok: boolean; session?: { id: string } }>('multiagentSystem.sessions.start', { interactive: false, launch: false, provider: 'claude', name: 'Switch Account Guard', cwd: workspace, accountProfileId: from });
  assert.equal(again?.ok, true);
  const guarded = await outsideTestMode(() => Promise.resolve(vscode.commands.executeCommand<{ ok: boolean; code?: string }>('multiagentSystem.sessions.restartWithAccount', { id: again!.session!.id, launch: false })));
  assert.equal(guarded.result?.ok, false);
  assert.ok(guarded.prompts.some((prompt) => /with which account/.test(prompt)), guarded.prompts.join(' | '));
  assert.equal((await list()).find((entry) => entry.id === again!.session!.id)?.accountProfileId, from);
  await vscode.commands.executeCommand('multiagentSystem.sessions.stop', { id: again!.session!.id, interactive: false });
  await removeTemp(root);
}
