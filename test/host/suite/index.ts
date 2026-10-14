import * as fs from 'node:fs';
import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';

const COMMANDS = ['multiagentSystem.openTerminalGroup', 'multiagentSystem.launchAgent'];
const EXPECTED_TITLES = ['PM', 'Worker 1', 'Worker 2', 'Worker 3'].map((name) => `Multiagent: ${name}`);

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for terminals');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function sameDirectory(actual: string, expected: string): boolean {
  const resolve = (value: string): string => fs.realpathSync.native(value);
  const fold = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value);
  return fold(resolve(actual)) === fold(resolve(expected));
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.all.find((candidate) => candidate.packageJSON?.name === 'multiagentsystem');
  assert.ok(extension, 'the built extension is loaded by the Extension Host');
  await extension.activate();
  assert.equal(extension.isActive, true);

  const registered = await vscode.commands.getCommands(true);
  for (const id of COMMANDS) assert.ok(registered.includes(id), `${id} is registered`);

  const workspace = process.env.MULTIAGENT_TEST_WORKSPACE;
  assert.ok(workspace, 'the test workspace path is provided');
  assert.equal(vscode.workspace.workspaceFolders?.length, 1);

  const before = new Set(vscode.window.terminals);
  await vscode.commands.executeCommand('multiagentSystem.openTerminalGroup');
  const created = await waitFor(() => {
    const added = vscode.window.terminals.filter((terminal) => !before.has(terminal));
    return added.length >= EXPECTED_TITLES.length ? added : undefined;
  }, 20000);

  try {
    assert.deepEqual(created.map((terminal) => terminal.name).sort(), [...EXPECTED_TITLES].sort());
    for (const terminal of created) {
      const options = terminal.creationOptions as vscode.TerminalOptions;
      const cwd = options.cwd instanceof vscode.Uri ? options.cwd.fsPath : options.cwd;
      assert.ok(cwd, `${terminal.name} has a working directory`);
      assert.ok(sameDirectory(cwd, workspace), `${terminal.name} starts in the project directory`);
      assert.equal('pty' in terminal.creationOptions, false, 'a native shell, not a custom pseudoterminal');
    }
    console.log(`host smoke: extension active, ${registered.filter((id) => COMMANDS.includes(id)).length} commands registered, ${created.length} native terminals created in the project directory`);
  } finally {
    for (const terminal of created) terminal.dispose();
  }
}
