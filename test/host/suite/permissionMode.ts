import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { accountService } from '../../../src/accounts/accountRuntime';
import { COMMAND_CENTER_COMMAND, commandCenterForTests } from '../../../src/commandCenter/commandCenter';
import { removeTemp } from './tempCleanup';

type Card = { id: string; permission: { text: string; attention: boolean } | null };

/**
 * #362 in a real Extension Host: what Claude Code reports as its permission mode in its own hook events (here a synthetic hook
 * input fed to the real hook bridge script, with the terminal's own environment) reaches the session list and the agent's card.
 */
export async function runPermissionModeChecks(workspace: string): Promise<void> {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mas-permission-mode-')));
  const accounts = await accountService(() => []);
  assert.ok(accounts.ok);
  if (!accounts.ok) return;
  const account = accounts.service.create({ provider: 'claude', label: 'Permission Mode Account', configDir: root });
  assert.ok(account.ok, JSON.stringify(account));
  if (!account.ok) return;
  let sessionId: string | undefined;
  try {
    const started = await vscode.commands.executeCommand<{ ok: boolean; session?: { id: string } }>('multiagentSystem.sessions.start', { interactive: false, provider: 'claude', name: 'Permission Mode Subject', cwd: workspace, accountProfileId: account.profile.id, launch: false });
    assert.equal(started?.ok, true, JSON.stringify(started));
    sessionId = started!.session!.id;
    // The newest read of the panel is the one kept, and the page starts reads of its own: wait until this session's card shows `want`.
    const card = async (want: string) => {
      const center = commandCenterForTests();
      let found: Card | undefined;
      const deadline = Date.now() + 15000;
      do {
        await center.refresh();
        found = ((center.state() as { agents: Card[] } | undefined)?.agents ?? []).find((entry) => entry.id === sessionId);
        if (found?.permission?.text === want) return found;
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      return found;
    };
    await vscode.commands.executeCommand(COMMAND_CENTER_COMMAND);
    const before = 'Permission mode: not reported yet (Claude Code reports it with its first action)';
    const first = await card(before);
    assert.ok(first, 'a card for the session');
    assert.equal(first?.permission?.text, before);

    const terminal = vscode.window.terminals.find((entry) => entry.name.includes('Permission Mode Subject'));
    const env = (terminal?.creationOptions as vscode.TerminalOptions | undefined)?.env ?? {};
    assert.equal(typeof env.MULTIAGENT_CLAUDE_SESSION_ID, 'string', 'the terminal is bound to the hook bridge');
    const bridge = path.resolve(__dirname, '../../../../src/accounts/claudeHookBridge.js');
    const input = JSON.stringify({ session_id: 'synthetic-claude-session', hook_event_name: 'PreToolUse', permission_mode: 'default', cwd: workspace, tool_name: 'Bash', tool_input: { command: 'npm test' } });
    const ran = spawnSync(process.execPath, [bridge], { input, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CLAUDE_CONFIG_DIR: String(env.CLAUDE_CONFIG_DIR), MULTIAGENT_CLAUDE_SESSION_ID: String(env.MULTIAGENT_CLAUDE_SESSION_ID) }, encoding: 'utf8' });
    assert.equal(ran.status, 0, ran.stderr);

    const listed = await vscode.commands.executeCommand<{ sessions: Array<{ id: string; reportedPermissionMode?: { mode: string } | null }> }>('multiagentSystem.sessions.list', { interactive: false });
    assert.equal(listed.sessions.find((entry) => entry.id === sessionId)?.reportedPermissionMode?.mode, 'default');
    const want = 'Permission mode: default (asks before actions), reported by Claude Code';
    const shown = await card(want);
    assert.equal(shown?.permission?.text, want);
    assert.equal(shown?.permission?.attention, false, 'no auto mode was asked for (a shell only), so nothing fell back');
  } finally {
    if (sessionId) await vscode.commands.executeCommand('multiagentSystem.sessions.stop', { id: sessionId, interactive: false });
    await accounts.service.remove(account.profile.id);
    await removeTemp(root);
  }
  console.log('host smoke: the permission mode Claude Code reports in its hook events reaches the session list and the agent card');
}
