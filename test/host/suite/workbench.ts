import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { COMMAND_CENTER_VIEW_TYPE, commandCenterForTests } from '../../../src/commandCenter/commandCenter';
import { HOME_VIEW, WORKBENCH_COMMAND, homeTreeForTests } from '../../../src/home/homeView';

/**
 * #357 in a real Extension Host: the side bar's one view lists Open Workbench and one line each for agents, what needs the person
 * and accounts, each opening the Workbench at its tab; the Workbench opens in the editor area; a next step opens only a known
 * command; "Show classic views" turns the setting on.
 */
export async function runWorkbenchChecks(): Promise<void> {
  const settings = () => vscode.workspace.getConfiguration('multiagentSystem');
  assert.equal(settings().get('showClassicViews'), false, 'the classic views are hidden by default');
  const items = (await homeTreeForTests().getChildren()) ?? [];
  const labels = items.map((item) => String(item.label));
  assert.equal(labels[0], 'Open Workbench', `the first entry opens the Workbench: ${JSON.stringify(labels)}`);
  assert.ok(labels.some((label) => /^Agents: /.test(label)) && labels.some((label) => /^Needs you: /.test(label)) && labels.some((label) => /^Accounts: /.test(label)), JSON.stringify(labels));
  for (const item of items) assert.equal(item.command?.command, WORKBENCH_COMMAND, `${String(item.label)} opens the Workbench`);
  const accountsLine = items.find((item) => /^Accounts: /.test(String(item.label)));
  assert.deepEqual(accountsLine?.command?.arguments, [{ tab: 'accounts' }], 'the accounts line opens the Accounts tab');
  assert.ok(HOME_VIEW);

  const mine = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(COMMAND_CENTER_VIEW_TYPE));
  await vscode.commands.executeCommand(WORKBENCH_COMMAND, { tab: 'accounts' });
  const deadline = Date.now() + 10000;
  while (mine().length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(mine().length, 1);
  assert.equal(mine()[0].label, 'Workbench', 'the editor tab is called Workbench');
  await vscode.commands.executeCommand(WORKBENCH_COMMAND, { tab: 'not-a-tab' });
  assert.equal(mine().length, 1, 'opening it again shows the same tab');

  const center = commandCenterForTests();
  const ran: string[] = [];
  const original = vscode.commands.executeCommand;
  try {
    (vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }).executeCommand = (async (command: string, ...rest: unknown[]) => {
      if (command === 'multiagentSystem.setup.refresh') { ran.push(`${command}:${rest.length}`); return undefined; }
      return (original as (...args: unknown[]) => Thenable<unknown>)(command, ...rest);
    }) as typeof vscode.commands.executeCommand;
    assert.deepEqual(await center.handle({ type: 'open', target: 'setupRefresh' }), { ok: true, command: 'open' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(ran, ['multiagentSystem.setup.refresh:0'], 'a next step opens the mapped command with no argument');
    assert.deepEqual(await center.handle({ type: 'open', target: 'multiagentSystem.sessions.stop' }), { ok: false, reason: 'invalid-field' });
  } finally {
    (vscode.commands as { executeCommand: typeof vscode.commands.executeCommand }).executeCommand = original;
  }
  try {
    assert.deepEqual(await center.handle({ type: 'showClassicViews' }), { ok: true, command: 'showClassicViews' });
    assert.equal(settings().get('showClassicViews'), true, 'the classic views are shown after the button');
  } finally {
    await settings().update('showClassicViews', undefined, vscode.ConfigurationTarget.Global);
  }
  assert.equal(settings().get('showClassicViews'), false);
  console.log('host smoke: the side bar keeps one Multiagent view whose lines open the Workbench at their tab; the Workbench opens as one editor tab; a next step opens only a known command with no argument; Show classic views turns the setting on');
}
