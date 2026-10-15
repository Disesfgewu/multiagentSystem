import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { overviewTreeForTests, OVERVIEW_VIEW, OVERVIEW_REFRESH } from '../../../src/overview/overviewView';

interface Started { ok: boolean; session?: { id: string } }

// The overview in a real Extension Host with real native terminals. `launch: false` opens only the
// shell and types nothing, so no CLI starts on the machine running the test.
export async function runOverviewChecks(workspace: string): Promise<string> {
  const registered = await vscode.commands.getCommands(true);
  assert.ok(registered.includes(OVERVIEW_REFRESH), 'the overview refresh command is registered');
  const manifest = vscode.extensions.all.find((candidate) => candidate.packageJSON?.name === 'multiagentsystem')?.packageJSON;
  assert.ok(manifest, 'the manifest is readable');
  const container = manifest.contributes.viewsContainers.activitybar.find((entry: { id: string }) => entry.id === 'multiagentSystem');
  assert.equal(container?.title, 'Multiagent', 'the activity bar has its own Multiagent container');
  const ids = manifest.contributes.views.multiagentSystem.map((view: { id: string }) => view.id);
  assert.deepEqual(ids, [OVERVIEW_VIEW, 'multiagentSystem.githubView', 'multiagentSystem.accountsView', 'multiagentSystem.rolesView']);
  assert.equal(manifest.contributes.views.explorer, undefined, 'nothing is left in the Explorer');

  const tree = overviewTreeForTests();
  const before = (await tree.getChildren()) ?? [];
  assert.ok(before.length > 0, 'the overview is never blank: it shows the guide or a state');
  assert.equal(before.some((row) => String(row.label).startsWith('Session')), false);

  const started = await vscode.commands.executeCommand<Started>('multiagentSystem.sessions.start', { interactive: false, provider: 'claude', name: 'Overview Session', cwd: workspace, launch: false });
  assert.equal(started?.ok, true);
  try {
    const rows = (await tree.getChildren()) ?? [];
    const agent = rows.find((row) => row.label === 'Overview Session');
    assert.ok(agent, 'a started session is one row in the overview');
    const text = String(agent?.description ?? '');
    assert.match(text, /terminal open, CLI not started/, 'a shell alone is not described as an agent working');
    assert.match(text, /unknown/, 'role and account have no source yet and say so');
    assert.doesNotMatch(text, /working|running|%|progress/i);
    assert.equal(agent?.contextValue, 'multiagentOverviewAgentLive');
    assert.equal((agent?.command as { command?: string } | undefined)?.command, 'multiagentSystem.sessions.focus');
    const tooltip = String(agent?.tooltip ?? '');
    assert.match(tooltip, /Pull request: unknown/);
    assert.match(tooltip, /CI: unknown/);
    assert.ok(rows.some((row) => row.label === 'Agents'), 'the agents section is labelled');

    // the guide steps follow the real state: this session has no account assigned, so it is a record of
    // a terminal, not a running agent with an account, and the "start an agent" step is NOT ticked
    const step = rows.find((row) => row.label === 'Start an agent with an account');
    assert.ok(step, 'the guide is still shown');
    assert.notEqual(step?.description, 'done', 'a session without an account does not complete the step');
  } finally {
    for (const terminal of vscode.window.terminals.filter((candidate) => candidate.name === 'Multiagent: Overview Session')) terminal.dispose();
  }
  await vscode.commands.executeCommand(OVERVIEW_REFRESH);
  return 'host smoke: Multiagent activity bar container, overview rows (unknown shown, shell not "working"), guide steps from real state verified';
}
