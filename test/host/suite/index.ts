import * as fs from 'node:fs';
import * as path from 'node:path';
import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { runGitHubChecks } from './github';
import { runStorageChecks } from './storage';
import { runOverviewChecks } from './overview';
import { ACCOUNT_COMMANDS, accountTreeForTests, openLoginTerminal } from '../../../src/accounts/accountCommands';
import { accountService, launchEnvironment } from '../../../src/accounts/accountRuntime';
import { ROLE_COMMANDS, roleTreeForTests, saveRoleRecord, previewUri, PREVIEW_SCHEME } from '../../../src/roles/roleCommands';

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
  'multiagentSystem.worktrees.remove',
  ACCOUNT_COMMANDS.refresh, ACCOUNT_COMMANDS.create, ACCOUNT_COMMANDS.details,
  ACCOUNT_COMMANDS.edit, ACCOUNT_COMMANDS.remove, ACCOUNT_COMMANDS.login, ACCOUNT_COMMANDS.launch,
  ROLE_COMMANDS.refresh, ROLE_COMMANDS.create, ROLE_COMMANDS.edit, ROLE_COMMANDS.preview, ROLE_COMMANDS.remove
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
  await waitFor(() => terminalNamed('Session A') && terminalNamed('Session B') ? true : undefined, 10000);
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

async function accountFlow(workspace: string): Promise<void> {
  const accountDir = path.join(path.dirname(workspace), 'synthetic-account-config');
  fs.mkdirSync(accountDir, { recursive: true });
  const accounts = await accountService(() => []);
  assert.equal(accounts.ok, true, 'account profiles use the extension private store');
  if (!accounts.ok) return;
  const created = accounts.service.create({ provider: 'claude', label: 'Host Work Account', configDir: accountDir });
  assert.equal(created.ok, true, JSON.stringify(created));
  if (!created.ok) return;

  const tree = accountTreeForTests();
  const entries = await tree.getChildren();
  assert.ok(entries);
  if (!entries) return;
  const item = entries.find((entry) => entry.label === 'Host Work Account');
  assert.ok(item, 'the persistent account view lists the created profile');
  assert.match(String(item?.description ?? ''), /Claude Code · identity unknown/);
  await vscode.commands.executeCommand(ACCOUNT_COMMANDS.details, created.profile.id);
  assert.match(vscode.window.activeTextEditor?.document.getText() ?? '', /Service identity: unknown/);
  assert.match(vscode.window.activeTextEditor?.document.getText() ?? '', /Account isolation: unverified/);

  const login = await launchEnvironment(created.profile.id, 'claude', () => []);
  assert.equal(login.ok, true, 'login uses the same current profile validation as a coding session');
  if (!login.ok) return;
  const loginTerminal = openLoginTerminal('claude', login.profile, login.env, false);
  assert.equal(loginTerminal.command, 'claude auth login');
  const loginOptions = loginTerminal.terminal.creationOptions as vscode.TerminalOptions;
  assert.ok(sameDirectory(typeof loginOptions.cwd === 'string' ? loginOptions.cwd : loginOptions.cwd?.fsPath ?? '', accountDir));
  assert.ok(sameDirectory(loginOptions.env?.CLAUDE_CONFIG_DIR ?? '', accountDir));
  loginTerminal.terminal.dispose();

  const wrongProvider = await vscode.commands.executeCommand<{ ok: boolean; code?: string }>('multiagentSystem.sessions.start', {
    interactive: false, provider: 'codex', name: 'Wrong Account Provider', cwd: workspace,
    accountProfileId: created.profile.id, launch: false
  });
  assert.deepEqual([wrongProvider.ok, wrongProvider.code], [false, 'provider-mismatch']);

  const started = await vscode.commands.executeCommand<{ ok: boolean; session?: { id: string; accountProfileId: string } }>('multiagentSystem.sessions.start', {
    interactive: false, provider: 'claude', name: 'Account Bound Session', cwd: workspace,
    accountProfileId: created.profile.id, launch: false
  });
  assert.equal(started.ok, true);
  assert.equal(started.session?.accountProfileId, created.profile.id);
  await vscode.commands.executeCommand('multiagentSystem.sessions.stop', { interactive: false, id: started.session?.id });

  // The sign-in check with no CLI available: the identity stays unknown, with a reason, and nothing is shown as ready.
  const emptyPath = fs.mkdtempSync(path.join(path.dirname(workspace), 'multiagent-empty-path-'));
  const savedPath = process.env.PATH;
  process.env.PATH = emptyPath;
  try {
    const checked = await vscode.commands.executeCommand<{ ok: boolean; state: string; reason: string; identity: unknown }>(ACCOUNT_COMMANDS.check, { id: created.profile.id, interactive: false });
    assert.deepEqual([checked.ok, checked.state, checked.reason, checked.identity], [false, 'unknown', process.platform === 'win32' ? 'windows-not-supported' : 'cli-not-found', null]);
  } finally {
    process.env.PATH = savedPath;
    fs.rmSync(emptyPath, { recursive: true, force: true });
  }
  const afterCheck = (await accountTreeForTests().getChildren()) ?? [];
  const checkedItem = afterCheck.find((entry) => entry.label === 'Host Work Account');
  assert.match(String(checkedItem?.description ?? ''), /identity unknown/);
  assert.doesNotMatch(String(checkedItem?.description ?? ''), /ready/);
  assert.match(String(checkedItem?.tooltip ?? ''), /could not confirm the sign-in/);
  await vscode.commands.executeCommand(ACCOUNT_COMMANDS.details, created.profile.id);
  const detailText = vscode.window.activeTextEditor?.document.getText() ?? '';
  assert.match(detailText, /Subscription plan: unknown/);
  assert.match(detailText, /Last check .* could not confirm the sign-in/);
  assert.match(detailText, /Configuration folder: passes the safety checks/);
  assert.match(detailText, /CLI confirmation of this folder: unverified/);
  assert.doesNotMatch(detailText, /Configuration folder: rejected/, 'a CLI that could not be started does not make the folder "rejected"');
  assert.doesNotMatch(detailText, /@/, 'no email-like text in the details');
  assert.equal(detailText.includes(accountDir), false, 'the details do not show the full folder path');
  console.log('host smoke: profile identity remains unknown; validated login terminal carries its config folder and exact command; provider mismatch is refused; new session keeps its selected profile');
}

async function roleFlow(): Promise<void> {
  const saved = await saveRoleRecord({
    group: {
      id: 'host-pm', name: 'Host PM', role: 'pm', provider: 'claude', version: 1,
      defaultAccountProfileId: null, allowedScope: { repositories: [], paths: [] },
      toolPermissions: { merge: 'allow' }, memoryScope: { mode: 'off' },
      rules: [{ id: 'host-review', type: 'instruction', text: 'Review the latest PR head.', version: 1 }]
    },
    layers: { platform: [{ id: 'host-no-merge', type: 'forbid', key: 'tool:merge', version: 2 }] }
  } as Parameters<typeof saveRoleRecord>[0]);
  assert.equal(saved.ok, true, saved.reason);
  const items = await roleTreeForTests().getChildren();
  assert.ok(items?.some((item) => item.label === 'Host PM' && String(item.description).includes('CLI not verified')));
  await vscode.commands.executeCommand(ROLE_COMMANDS.preview, 'host-pm');
  const text = vscode.window.activeTextEditor?.document.getText() ?? '';
  assert.match(text, /Rules in the CLI: Preview only: not sent to the CLI/);
  assert.match(text, /<NOT sent to the CLI>/, 'every rule says it was not sent');
  assert.match(text, /<told to the agent only, not enforced>/, 'every tool permission says it is not enforced');
  assert.match(text, /host-no-merge \(platform v2\)/);
  assert.match(text, /permission-relaxation-blocked/);
  assert.match(text, /PRIVATE/);
  assert.doesNotMatch(text, /applied|sent to the CLI \(evidence/i, 'nothing is claimed as applied');

  // The preview is a virtual document: it has no file behind it, so it cannot be saved into a repository.
  const shown = vscode.window.activeTextEditor?.document;
  assert.equal(shown?.uri.scheme, PREVIEW_SCHEME);
  assert.equal(shown?.isUntitled, false);
  await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(previewUri('host-pm'), Buffer.from('x'))), 'a virtual preview cannot be written');
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  assert.equal(fs.existsSync(path.join(workspaceRoot, 'effective-rules.txt')), false, 'no preview file appears in the project');

  // agy has no known way to receive rules: its preview must say they have to be given by hand.
  const agy = await saveRoleRecord({
    group: { id: 'host-agy', name: 'Host Agy', role: 'worker', provider: 'agy', version: 1, defaultAccountProfileId: null,
      allowedScope: { repositories: [], paths: [] }, toolPermissions: {}, memoryScope: { mode: 'off' }, rules: [{ id: 'host-agy-rule', type: 'instruction', text: 'Stay small.', version: 1 }] },
    layers: {}
  } as Parameters<typeof saveRoleRecord>[0]);
  assert.equal(agy.ok, true, agy.reason);
  const agyText = (await vscode.workspace.openTextDocument(previewUri('host-agy'))).getText();
  assert.match(agyText, /Not supported by this provider: give these rules to the agent by hand/);
  assert.match(agyText, /<not supported: give by hand>/);
  console.log('host smoke: private role group previews as a read-only virtual document with per-rule injection status (preview only; agy manual); it cannot be saved to the project');
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
  console.log(await runStorageChecks(registered, workspace));
  console.log(await runOverviewChecks(workspace));
  assert.equal(vscode.workspace.workspaceFolders?.length, 1);

  const visibleFile = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(workspace, 'file.txt')));
  await vscode.window.showTextDocument(visibleFile, vscode.ViewColumn.One);
  const before = new Set(vscode.window.terminals);
  await vscode.commands.executeCommand('multiagentSystem.openTerminalGroup');
  const created = await waitFor(() => {
    const added = vscode.window.terminals.filter((terminal) => !before.has(terminal));
    return added.length >= EXPECTED_TITLES.length ? added : undefined;
  }, 20000);

  try {
    assert.deepEqual(created.map((terminal) => terminal.name).sort(), [...EXPECTED_TITLES].sort());
    const columns = new Map<number, string>();
    for (const terminal of created) {
      const options = terminal.creationOptions as vscode.TerminalOptions;
      const cwd = options.cwd instanceof vscode.Uri ? options.cwd.fsPath : options.cwd;
      assert.ok(cwd, `${terminal.name} has a working directory`);
      assert.ok(sameDirectory(cwd, workspace), `${terminal.name} starts in the project directory`);
      assert.equal('pty' in terminal.creationOptions, false, 'a native shell, not a custom pseudoterminal');
      const location = options.location as vscode.TerminalEditorLocationOptions;
      columns.set(location.viewColumn, terminal.name);
    }
    assert.deepEqual([...columns.entries()].sort(([a], [b]) => a - b), EXPECTED_TITLES.map((title, index) => [index + 1, title]));
    const groups = await waitFor(() => {
      const current = vscode.window.tabGroups.all;
      return current.filter((group) => group.tabs.some((tab) => tab.input instanceof vscode.TabInputTerminal)).length === 4 ? current : undefined;
    }, 10000);
    const terminalGroups = groups.filter((group) => group.tabs.some((tab) => tab.input instanceof vscode.TabInputTerminal));
    assert.equal(terminalGroups.length, 4, 'the 2×2 layout has four editor groups with terminals');
    for (const group of terminalGroups) {
      const terminalTabs = group.tabs.filter((tab) => tab.input instanceof vscode.TabInputTerminal);
      assert.equal(terminalTabs.length, 1, `view column ${group.viewColumn} has one terminal tab`);
    }
    assert.ok(groups.some((group) => group.tabs.some((tab) => tab.label === 'file.txt')), 'the previously open project file remains in an editor group');

    const layoutBeforeRepeat = await vscode.commands.executeCommand<unknown>('vscode.getEditorLayout');
    await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 0, groups: [{}, {}] });
    const countBeforeRepeat = vscode.window.terminals.length;
    await vscode.commands.executeCommand('multiagentSystem.openTerminalGroup');
    assert.equal(vscode.window.terminals.length, countBeforeRepeat, 'rerunning focuses the existing terminals without duplicates');
    assert.notDeepEqual(await vscode.commands.executeCommand<unknown>('vscode.getEditorLayout'), layoutBeforeRepeat, 'rerunning preserves the user-adjusted layout');
    console.log(`host smoke: extension active, ${registered.filter((id) => COMMANDS.includes(id)).length} commands registered, ${created.length} native terminals created in the project directory`);
  } finally {
    for (const terminal of created) terminal.dispose();
  }

  await sessionFlow(workspace);
  await accountFlow(workspace);
  await roleFlow();

  const worktreeTarget = process.env.MULTIAGENT_TEST_WORKTREE;
  assert.ok(worktreeTarget, 'the worktree test folder is provided');
  await worktreeFlow(workspace, worktreeTarget);
}
