import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { setIdeLockFoldersForTests } from '../../../src/sessions/sessionCommands';
import { removeTemp } from './tempCleanup';

const TOKEN = 'synthetic-ide-auth-token-354';

type Listed = { sessions: Array<{ id: string; ideLabel?: string }> };

/**
 * #354 in a real Extension Host: a Claude Code session started from this extension gets the port of this window's lock file as
 * CLAUDE_CODE_SSE_PORT in its terminal, and says so; with no lock it says why it is not connected; the lock's token is nowhere.
 */
export async function runIdeBridgeChecks(workspace: string): Promise<void> {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mas-ide-bridge-')));
  const ide = path.join(root, 'ide');
  fs.mkdirSync(ide);
  const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
  assert.ok(folders.length > 0, 'the host test window has a folder open');
  // One lock for another project, one for this window (its process is this Extension Host, so it is running).
  fs.writeFileSync(path.join(ide, '41001.lock'), JSON.stringify({ pid: process.pid, workspaceFolders: [path.join(root, 'elsewhere')], ideName: 'Visual Studio Code', transport: 'ws', authToken: TOKEN }));
  fs.writeFileSync(path.join(ide, '41002.lock'), JSON.stringify({ pid: process.pid, workspaceFolders: folders, ideName: 'Visual Studio Code', transport: 'ws', runningInWindows: process.platform === 'win32', authToken: TOKEN }));
  setIdeLockFoldersForTests([ide]);
  const started: string[] = [];
  const start = async (name: string) => {
    const result = await vscode.commands.executeCommand<{ ok: boolean; session?: { id: string } }>('multiagentSystem.sessions.start', { interactive: false, provider: 'claude', roleGroupId: 'host-pm', name, cwd: workspace, launch: false });
    assert.equal(result?.ok, true, JSON.stringify(result));
    started.push(result!.session!.id);
    const terminal = vscode.window.terminals.find((entry) => entry.name.includes(name));
    assert.ok(terminal, `the terminal of ${name} is open`);
    return { id: result!.session!.id, env: (terminal!.creationOptions as vscode.TerminalOptions).env ?? {} };
  };
  const label = async (id: string) => (await vscode.commands.executeCommand<Listed>('multiagentSystem.sessions.list', { interactive: false })).sessions.find((entry) => entry.id === id)?.ideLabel;
  try {
    const connected = await start('IDE Bridge Connected');
    assert.equal(connected.env.CLAUDE_CODE_SSE_PORT, '41002', 'the agent terminal carries this window\'s port');
    assert.equal(await label(connected.id), "VS Code: connected through this window's Claude Code port (41002)");
    assert.equal(JSON.stringify(connected.env).includes(TOKEN), false, 'the token is not in the terminal environment');
    const listed = await vscode.commands.executeCommand<Listed>('multiagentSystem.sessions.list', { interactive: false });
    assert.equal(JSON.stringify(listed).includes(TOKEN), false, 'the token is not in the session list');

    // No lock for this window: the session still starts, without a port, and says why and what to do.
    fs.rmSync(path.join(ide, '41002.lock'));
    const unconnected = await start('IDE Bridge Unconnected');
    assert.equal('CLAUDE_CODE_SSE_PORT' in unconnected.env, false, 'no port is guessed');
    assert.match(await label(unconnected.id) ?? '', /^VS Code: not connected \(no registered VS Code window has this project's folder open: open this project in VS Code/);
  } finally {
    setIdeLockFoldersForTests(undefined);
    for (const id of started) await vscode.commands.executeCommand('multiagentSystem.sessions.stop', { id, interactive: false });
    await removeTemp(root);
  }
  console.log('host smoke: a Claude Code session started here gets this window\'s lock port as CLAUDE_CODE_SSE_PORT and says it is connected; without a lock it says why; the lock\'s token is in neither');
}
