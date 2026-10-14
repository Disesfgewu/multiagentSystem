import * as fs from 'node:fs';
import * as path from 'node:path';
import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { runGitHubChecks } from './github';

const COMMANDS = [
  'multiagentSystem.openTerminalGroup',
  'multiagentSystem.launchAgent',
  'multiagentSystem.sessions.list',
  'multiagentSystem.sessions.start',
  'multiagentSystem.sessions.focus',
  'multiagentSystem.sessions.stop',
  'multiagentSystem.sessions.reopen',
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

interface SessionOutcome {
  ok: boolean;
  code?: string;
  session?: { id: string; name: string; provider: string; state: string; terminalOpen: boolean; accountProfileId: string; worktree: string; stateLabel: string };
  sessions?: Array<{ id: string; name: string; state: string; terminalOpen: boolean }>;
}

// Session lifecycle against real native terminals. `launch: false` opens only the shell and types
// nothing, so no CLI is started on the machine running the test.
async function sessionFlow(workspace: string): Promise<void> {
  const command = (id: string, options: object): Thenable<SessionOutcome> =>
    vscode.commands.executeCommand<SessionOutcome>(id, { interactive: false, ...options });
  const sessions = async () => (await command('multiagentSystem.sessions.list', {})).sessions ?? [];
  const terminalNamed = (name: string) => vscode.window.terminals.find((terminal) => terminal.name === `Multiagent: ${name}`);

  const a = await command('multiagentSystem.sessions.start', { provider: 'claude', name: 'Session A', cwd: workspace, launch: false });
  const b = await command('multiagentSystem.sessions.start', { provider: 'codex', name: 'Session B', cwd: workspace, launch: false });
  assert.equal(a.ok && b.ok, true);
  assert.equal(a.session?.state, 'terminal-open', 'a shell alone is not reported as the CLI working');
  assert.equal(a.session?.accountProfileId, 'unassigned');
  assert.ok(terminalNamed('Session A') && terminalNamed('Session B'), 'two native terminals exist');
  assert.equal((await sessions()).filter((entry) => entry.terminalOpen).length, 2);

  // The user closes terminal A: the real close event must reach the registry; B is untouched.
  terminalNamed('Session A')?.dispose();
  const closed = await waitForAsync(async () => {
    const found = (await sessions()).find((entry) => entry.id === a.session?.id);
    return found?.state === 'terminal-closed' ? found : undefined;
  }, 10000);
  assert.equal(closed.terminalOpen, false);
  assert.equal((await sessions()).find((entry) => entry.id === b.session?.id)?.state, 'terminal-open');
  assert.equal((await command('multiagentSystem.sessions.focus', { id: a.session?.id })).code, 'terminal-not-open');

  // Reopen = a NEW session with the same provider, account and folder; the old one stays closed.
  assert.equal((await command('multiagentSystem.sessions.reopen', { id: b.session?.id, launch: false })).code, 'session-still-open');
  const again = await command('multiagentSystem.sessions.reopen', { id: a.session?.id, launch: false });
  assert.equal(again.ok, true);
  assert.notEqual(again.session?.id, a.session?.id);
  assert.equal(again.session?.provider, 'claude');
  assert.equal(again.session?.accountProfileId, a.session?.accountProfileId);
  assert.equal(again.session?.worktree, a.session?.worktree);
  assert.equal((await sessions()).find((entry) => entry.id === a.session?.id)?.state, 'terminal-closed');
  assert.ok(terminalNamed('Session A'), 'a fresh terminal was created');

  // Focus and stop B.
  assert.equal((await command('multiagentSystem.sessions.focus', { id: b.session?.id })).ok, true);
  const stopped = await command('multiagentSystem.sessions.stop', { id: b.session?.id });
  assert.equal(stopped.session?.state, 'terminal-closed');
  await waitForAsync(async () => (terminalNamed('Session B') ? undefined : true), 10000);
  assert.equal((await command('multiagentSystem.sessions.stop', { id: b.session?.id })).code, 'terminal-not-open');

  for (const terminal of vscode.window.terminals.filter((candidate) => candidate.name.startsWith('Multiagent: Session'))) terminal.dispose();
  console.log('host smoke: session start / close event / reopen as new session / focus / stop verified with real terminals');
}

async function waitForAsync<T>(probe: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for a session state');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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
  console.log(await runGitHubChecks(registered));

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

  await sessionFlow(workspace);

  const worktreeTarget = process.env.MULTIAGENT_TEST_WORKTREE;
  assert.ok(worktreeTarget, 'the worktree test folder is provided');
  await worktreeFlow(workspace, worktreeTarget);
}
