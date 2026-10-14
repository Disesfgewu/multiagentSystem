import * as fs from 'node:fs';
import * as path from 'node:path';
import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';

const COMMANDS = [
  'multiagentSystem.openTerminalGroup',
  'multiagentSystem.launchAgent',
  'multiagentSystem.worktrees.list',
  'multiagentSystem.worktrees.create',
  'multiagentSystem.worktrees.remove'
];
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

interface Outcome {
  ok: boolean;
  code?: string;
  message?: string;
  worktree?: { path: string; branch: string | null };
  worktrees?: Array<{ path: string; branch: string | null; primary: boolean; current: boolean }>;
  branch?: string | null;
}

// Drives the worktree commands in non-interactive form against the real Git workspace.
async function worktreeFlow(workspace: string, target: string): Promise<void> {
  const command = (id: string, options: object): Thenable<Outcome> =>
    vscode.commands.executeCommand<Outcome>(id, { interactive: false, ...options });

  const created = await command('multiagentSystem.worktrees.create', { branch: 'feature/host-smoke', target });
  assert.equal(created.ok, true, created.message);
  assert.ok(created.worktree && sameDirectory(created.worktree.path, target), 'created in the requested folder');
  assert.equal(created.worktree?.branch, 'feature/host-smoke');
  assert.equal(fs.statSync(path.join(target, '.git')).isFile(), true, 'a linked worktree has a .git pointer file');

  const listed = await command('multiagentSystem.worktrees.list', {});
  assert.equal(listed.ok, true);
  const entries = listed.worktrees ?? [];
  assert.equal(entries.length, 2);
  assert.ok(entries.find((entry) => entry.primary && entry.current && sameDirectory(entry.path, workspace)), 'primary worktree is this window');
  assert.ok(entries.find((entry) => !entry.primary && !entry.current && entry.branch === 'feature/host-smoke'));

  // Local files make the release refuse, whatever the caller says.
  const keep = path.join(target, 'local-note.txt');
  fs.writeFileSync(keep, 'keep me');
  const refused = await command('multiagentSystem.worktrees.remove', { path: target, confirmed: true });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'worktree-has-local-files');
  assert.equal(fs.readFileSync(keep, 'utf8'), 'keep me', 'the local file survives a refused release');

  // Without the caller's explicit confirmation nothing is released, even for a clean worktree.
  fs.rmSync(keep);
  const unconfirmed = await command('multiagentSystem.worktrees.remove', { path: target });
  assert.equal(unconfirmed.code, 'cancelled');
  assert.ok(fs.existsSync(target));

  const primary = await command('multiagentSystem.worktrees.remove', { path: workspace, confirmed: true });
  assert.equal(primary.code, 'primary-worktree-protected');

  const released = await command('multiagentSystem.worktrees.remove', { path: target, confirmed: true });
  assert.equal(released.ok, true, released.message);
  assert.equal(released.branch, 'feature/host-smoke');
  assert.equal(fs.existsSync(target), false);
  assert.equal(((await command('multiagentSystem.worktrees.list', {})).worktrees ?? []).length, 1);
  console.log('host smoke: worktree create / list / refuse-with-local-files / release verified against real Git');
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

  const worktreeTarget = process.env.MULTIAGENT_TEST_WORKTREE;
  assert.ok(worktreeTarget, 'the worktree test folder is provided');
  await worktreeFlow(workspace, worktreeTarget);
}
