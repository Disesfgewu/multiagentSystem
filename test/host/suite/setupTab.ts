import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { commandCenterForTests } from '../../../src/commandCenter/commandCenter';

type Setup = { type: string; tools: { known: boolean; rows: Array<{ id: string; state: string; text: string; action: string | null }> }; modes: Array<{ key: string; value: string }> };

/**
 * #357's Setup tab in a real Extension Host: its tools are the Tools Setup view's own reads (nothing is prepared or downloaded by
 * reading them), its modes are the user settings in plain words, and only those three settings can be opened from it.
 */
export async function runSetupTabChecks(): Promise<void> {
  await vscode.commands.executeCommand('multiagentSystem.workbench.open', { tab: 'setup' });
  const center = commandCenterForTests();
  assert.deepEqual(await center.handle({ type: 'loadSetup' }), { ok: true, command: 'loadSetup' });
  const setup = center.setup() as Setup;
  assert.equal(setup.tools.known, true, 'the Tools Setup view was read');
  assert.deepEqual(setup.tools.rows.map((row) => row.id), ['git', 'gh', 'claude', 'codex', 'agy']);
  for (const row of setup.tools.rows) {
    assert.ok(['ready', 'attention', 'unknown'].includes(row.state), JSON.stringify(row));
    assert.notEqual(row.text, 'Setting up…', `${row.id}: reading it set nothing up`);
    if (row.state === 'ready') assert.equal(row.action, null, `${row.id}: nothing to set up when it is ready`);
  }
  assert.deepEqual(setup.modes.map((mode) => mode.key), ['multiagentSystem.agents.autoMode', 'multiagentSystem.isolation.mode', 'multiagentSystem.agents.preTrustManagedWorktrees']);
  // The host's own user settings decide the words; a workspace value would not.
  const auto = vscode.workspace.getConfiguration().inspect('multiagentSystem.agents.autoMode');
  assert.match(setup.modes[0].value, auto?.globalValue === 'off' ? /^off: / : /^on: /);

  assert.equal((await center.handle({ type: 'openSetting', key: 'workbench.colorTheme' })).ok, false, 'only the three mode settings');
  assert.deepEqual(await center.handle({ type: 'openSetting', key: 'multiagentSystem.isolation.mode' }), { ok: true, command: 'openSetting' });
  await new Promise((resolve) => setTimeout(resolve, 500));
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  console.log('host smoke: the Setup tab shows the Tools Setup view\'s own reads without preparing anything, the modes from the user settings, and opens only those three settings');
}
