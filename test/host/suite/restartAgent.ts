import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { accountService } from '../../../src/accounts/accountRuntime';
import { outsideTestMode } from './nonInteractiveGate';
import { removeTemp } from './tempCleanup';

type Listed = { sessions: Array<{ id: string; name: string; terminalOpen: boolean; accountProfileId: string; worktree: string; codename?: string | null }> };

/**
 * #357 in a real Extension Host: a card's "Restart…" asks in a modal before anything stops; confirmed, the agent stops and starts
 * again in the same folder with the same name, account and codename, and shows once. A card whose terminal already closed restarts
 * too. Dismissing changes nothing, also outside test mode.
 */
export async function runRestartAgentChecks(workspace: string): Promise<void> {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mas-restart-')));
  const accounts = await accountService(() => []);
  assert.ok(accounts.ok);
  if (!accounts.ok) return;
  const dir = path.join(root, 'restart-account');
  fs.mkdirSync(dir);
  const created = accounts.service.create({ provider: 'claude', label: 'Restart Account', configDir: dir });
  assert.ok(created.ok, JSON.stringify(created));
  if (!created.ok) return;
  const account = created.profile.id;
  const list = async () => (await vscode.commands.executeCommand<Listed>('multiagentSystem.sessions.list', { interactive: false })).sessions;
  const started = await vscode.commands.executeCommand<{ ok: boolean; session?: { id: string } }>('multiagentSystem.sessions.start', { interactive: false, launch: false, provider: 'claude', name: 'Restart Me', cwd: workspace, accountProfileId: account });
  assert.equal(started?.ok, true, JSON.stringify(started));
  const id = started!.session!.id;
  const before = (await list()).find((entry) => entry.id === id)!;
  assert.ok(before.codename, 'the agent has a codename to keep');

  const ui = vscode.window as unknown as Record<string, unknown>;
  const original = { warn: ui.showWarningMessage, info: ui.showInformationMessage };
  const asked: string[] = [];
  let confirm = false;
  ui.showWarningMessage = async (message: string, options: unknown, ...buttons: string[]) => {
    asked.push(`${message} ${(options as { detail?: string })?.detail ?? ''}`);
    if (/^Restart “Restart Me”\?/.test(message)) return confirm ? 'Restart Agent' : undefined;
    return typeof options === 'object' && options !== null && (options as { modal?: boolean }).modal ? buttons[0] : undefined;
  };
  ui.showInformationMessage = async () => undefined;
  try {
    // Dismissed: nothing stops, nothing starts.
    const dismissed = await vscode.commands.executeCommand<{ ok: boolean; code?: string }>('multiagentSystem.sessions.restart', { id, launch: false });
    assert.equal(dismissed?.code, 'cancelled');
    assert.ok(asked.some((message) => /^Restart “Restart Me”\? Its terminal closes and the agent in it stops\. It starts again in the same folder .* same role group, name, account and model, and a new conversation\./.test(message)), asked.join(' | '));
    assert.equal((await list()).find((entry) => entry.id === id)?.terminalOpen, true, 'still running');

    // Confirmed: the same agent again, with the same account and codename, shown once.
    confirm = true;
    const restarted = await vscode.commands.executeCommand<{ ok: boolean; session?: { id: string; accountProfileId: string; worktree: string } }>('multiagentSystem.sessions.restart', { id, launch: false });
    assert.equal(restarted?.ok, true, JSON.stringify(restarted));
    assert.notEqual(restarted!.session!.id, id);
    const after = await list();
    assert.equal(after.some((entry) => entry.id === id), false, 'the stopped session is no longer listed');
    const again = after.find((entry) => entry.id === restarted!.session!.id)!;
    assert.deepEqual([again.name, again.accountProfileId, again.worktree, again.codename], ['Restart Me', account, before.worktree, before.codename]);

    // A card whose terminal already closed restarts too: nothing to stop, the rest as above.
    await vscode.commands.executeCommand('multiagentSystem.sessions.stop', { id: again.id, interactive: false });
    const fromClosed = await vscode.commands.executeCommand<{ ok: boolean; session?: { id: string } }>('multiagentSystem.sessions.restart', { id: again.id, launch: false });
    assert.equal(fromClosed?.ok, true, JSON.stringify(fromClosed));
    assert.ok(asked.some((message) => /^Restart “Restart Me”\? It starts again/.test(message)), 'a closed card is not said to stop');
    assert.equal((await list()).find((entry) => entry.id === fromClosed!.session!.id)?.codename, before.codename);
    await vscode.commands.executeCommand('multiagentSystem.sessions.stop', { id: fromClosed!.session!.id, interactive: false });
    assert.deepEqual(await vscode.commands.executeCommand('multiagentSystem.sessions.restart', { id: 'no-such-session', launch: false }).then((value: any) => value?.code), 'session-not-found');
  } finally {
    ui.showWarningMessage = original.warn;
    ui.showInformationMessage = original.info;
  }

  // Outside test mode a caller cannot skip the modal: dismissed, the running agent is untouched.
  const guard = await vscode.commands.executeCommand<{ ok: boolean; session?: { id: string } }>('multiagentSystem.sessions.start', { interactive: false, launch: false, provider: 'claude', name: 'Restart Guard', cwd: workspace, accountProfileId: account });
  assert.equal(guard?.ok, true);
  const guarded = await outsideTestMode(() => Promise.resolve(vscode.commands.executeCommand<{ ok: boolean; code?: string }>('multiagentSystem.sessions.restart', { id: guard!.session!.id, launch: false })));
  assert.equal(guarded.result?.ok, false);
  assert.ok(guarded.prompts.some((prompt) => /Restart “Restart Guard”\?/.test(prompt)), guarded.prompts.join(' | '));
  assert.equal((await list()).find((entry) => entry.id === guard!.session!.id)?.terminalOpen, true);
  await vscode.commands.executeCommand('multiagentSystem.sessions.stop', { id: guard!.session!.id, interactive: false });
  await removeTemp(root);
  console.log('host smoke: a card\'s Restart… asks first; confirmed, the agent starts again in the same folder with the same account and codename and shows once; dismissed or outside test mode, nothing changes');
}
