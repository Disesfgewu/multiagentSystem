import * as fs from 'node:fs';
import * as path from 'node:path';
import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { runGitHubChecks } from './github';
import { runStorageChecks } from './storage';
import { runOverviewChecks } from './overview';
import { runPlanChecks } from './plan';
import { runReportChecks } from './reports';
import { ACCOUNT_COMMANDS, accountTreeForTests, openLoginTerminal } from '../../../src/accounts/accountCommands';
import { accountService, launchEnvironment } from '../../../src/accounts/accountRuntime';
import { overviewTreeForTests } from '../../../src/overview/overviewView';
import { ROLE_COMMANDS, roleTreeForTests, saveRoleRecord, previewUri, previewText, PREVIEW_SCHEME } from '../../../src/roles/roleCommands';
import { privateStorage } from '../../../src/storage/storageCommands';
import { BroadcastStore } from '../../../src/broadcast/store';
import { BROADCAST_COMMANDS, broadcastTreeForTests } from '../../../src/broadcast/commands';
import { builtIn } from '../../../src/providers/registry';
import { pickRoleForLaunch } from '../../../src/roles/roleLaunch';
import { createHash } from 'node:crypto';
import { gzipSync, zipSync } from 'fflate';
import { SETUP_COMMANDS, managedPathContributionForTests, setSetupDepsForTests, setupTreeForTests } from '../../../src/setup/setupView';
import { GhRelease } from '../../../src/setup/managedGh';
import { CodexRelease } from '../../../src/setup/managedCodex';

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
  ACCOUNT_COMMANDS.refresh, ACCOUNT_COMMANDS.create, ACCOUNT_COMMANDS.details, ACCOUNT_COMMANDS.limits,
  ACCOUNT_COMMANDS.edit, ACCOUNT_COMMANDS.remove, ACCOUNT_COMMANDS.login, ACCOUNT_COMMANDS.launch,
  ROLE_COMMANDS.refresh, ROLE_COMMANDS.create, ROLE_COMMANDS.edit, ROLE_COMMANDS.preview, ROLE_COMMANDS.remove,
  BROADCAST_COMMANDS.refresh, BROADCAST_COMMANDS.send, BROADCAST_COMMANDS.revoke,
  SETUP_COMMANDS.refresh, SETUP_COMMANDS.retryGh
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
  assert.match(String(item?.description ?? ''), /limits not set/);
  assert.match(String(item?.tooltip ?? ''), /Limits: none set/);
  assert.match(String(item?.tooltip ?? ''), /Set Account Limits/);
  assert.match(String(item?.tooltip ?? ''), /Usage: unknown/);
  const overviewAccount = ((await overviewTreeForTests().getChildren()) ?? []).find((entry) => entry.label === 'Host Work Account');
  assert.ok(overviewAccount, 'the overview lists each account even when no agent uses it');
  assert.match(String(overviewAccount.description ?? ''), /Usage: unknown.*Limits: none set/);
  assert.match(String(overviewAccount.tooltip ?? ''), /No verified usage source/);
  await vscode.commands.executeCommand(ACCOUNT_COMMANDS.details, created.profile.id);
  assert.match(vscode.window.activeTextEditor?.document.getText() ?? '', /Service identity: unknown/);
  assert.match(vscode.window.activeTextEditor?.document.getText() ?? '', /Account isolation: unverified/);
  const detailDocument = vscode.window.activeTextEditor?.document;
  assert.equal(detailDocument?.uri.scheme, 'multiagent-account', 'the details are a virtual document, not an unsaved file');
  assert.equal(detailDocument?.isUntitled, false);
  await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(detailDocument!.uri, Buffer.from('x'))), 'the details cannot be saved into a project');
  assert.match(detailDocument?.getText() ?? '', /Provider abilities \(dedicated support\):/);
  assert.match(detailDocument?.getText() ?? '', /Start in a native terminal: the extension has code for it, not yet checked on a real machine/);
  assert.match(detailDocument?.getText() ?? '', /Model in use: unknown \(no source reports which model a session uses\)\./);
  assert.doesNotMatch(detailDocument?.getText() ?? '', /verified on a real machine/);

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
  const orderedOverview = (await overviewTreeForTests().getChildren()) ?? [];
  const agentsHeading = orderedOverview.findIndex((entry) => entry.label === 'Agents');
  const accountsHeading = orderedOverview.findIndex((entry) => entry.label === 'Accounts');
  assert.ok(agentsHeading >= 0 && accountsHeading > agentsHeading, 'running agents remain ahead of account usage in the default overview');
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

  // Account limits: with none set nothing is held back; with limits that cannot be met (usage is unknown and the setting
  // says do not start), a non-interactive start is refused with a plain reason and opens no terminal; clearing them lifts it.
  const gated = (name: string) => vscode.commands.executeCommand<{ ok: boolean; code?: string; message?: string; session?: { id: string } }>('multiagentSystem.sessions.start', { interactive: false, provider: 'claude', name, cwd: workspace, accountProfileId: created.profile.id, launch: false });
  const freeStart = await gated('Ungated');
  assert.equal(freeStart.ok, true, 'an account with no limits is never held back');
  await vscode.commands.executeCommand('multiagentSystem.sessions.stop', { interactive: false, id: freeStart.session?.id });
  const setLimits = await vscode.commands.executeCommand<{ ok: boolean }>(ACCOUNT_COMMANDS.limits, { id: created.profile.id, interactive: false, warn: '70', block: '90', max: '1', unknownQuota: 'block' });
  assert.equal(setLimits.ok, true);
  const overviewWithLimits = ((await overviewTreeForTests().getChildren()) ?? []).find((entry) => entry.label === 'Host Work Account');
  assert.match(String(overviewWithLimits?.description ?? ''), /Limits: warn at 70% used/);
  assert.match(String(overviewWithLimits?.tooltip ?? ''), /Usage: unknown/);
  const badLimits = await vscode.commands.executeCommand<{ ok: boolean; problems?: string[] }>(ACCOUNT_COMMANDS.limits, { id: created.profile.id, interactive: false, warn: '95', block: '90' });
  assert.deepEqual([badLimits.ok, badLimits.problems?.[0]], [false, 'The warning level cannot be higher than the pause level.']);
  const held = await gated('Gated');
  assert.deepEqual([held.ok, held.code], [false, 'quota-gate']);
  assert.match(String(held.message), /No verified, current usage reading.*do not start new agents/);
  assert.equal(vscode.window.terminals.some((terminal) => terminal.name === 'Multiagent: Gated'), false, 'a held-back start opens no terminal');
  await vscode.commands.executeCommand(ACCOUNT_COMMANDS.details, created.profile.id);
  const limitText = vscode.window.activeTextEditor?.document.getText() ?? '';
  assert.match(limitText, /Limits: warn at 70% used; pause new agents at 90%; at most 1 running at once; if usage is unknown, do not start new agents\./);
  assert.match(limitText, /Usage: unknown\. No verified usage source is connected/);
  assert.doesNotMatch(limitText, /\d+% used, verified/, 'no usage percentage is invented');
  const cleared = await vscode.commands.executeCommand<{ ok: boolean }>(ACCOUNT_COMMANDS.limits, { id: created.profile.id, interactive: false, clear: true });
  assert.equal(cleared.ok, true);
  const lifted = await gated('Lifted');
  assert.equal(lifted.ok, true, 'clearing the limits lifts the hold');
  await vscode.commands.executeCommand('multiagentSystem.sessions.stop', { interactive: false, id: lifted.session?.id });
  console.log('host smoke: profile identity remains unknown; validated login terminal carries its config folder and exact command; provider mismatch is refused; new session keeps its selected profile');
}

async function setupFlow(): Promise<void> {
  const platform = process.platform;
  const arch = process.arch;
  assert.ok(['darwin', 'win32'].includes(platform) && ['x64', 'arm64'].includes(arch), 'Host setup test runs on a supported target');
  const executable = platform === 'win32' ? 'gh.exe' : 'gh';
  const asset = platform === 'darwin' ? (arch === 'arm64' ? 'macOS_arm64' : 'macOS_amd64') : (arch === 'arm64' ? 'windows_arm64' : 'windows_amd64');
  const entry = `gh_2.102.0_${asset}/bin/${executable}`;
  const bytes = Buffer.from(platform === 'win32' ? 'synthetic managed gh; it is never executed' : '#!/bin/sh\nprintf synthetic > "$MULTIAGENT_TEST_GH_SENTINEL"\n');
  const archive = zipSync({ [entry]: bytes });
  const release: GhRelease = {
    tool: 'gh', version: '2.102.0', platform, arch,
    url: `https://github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_${asset}.zip`,
    sha256: createHash('sha256').update(archive).digest('hex'), entry, executable
  };
  const codexExecutable = platform === 'win32' ? 'codex.exe' : 'codex';
  const codexTarget = platform === 'darwin'
    ? `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`
    : `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-pc-windows-msvc`;
  const codexBytes = Buffer.from('synthetic managed codex; it is never executed');
  const makeTar = (name: string, value: Uint8Array): Uint8Array => {
    const header = new Uint8Array(512);
    header.set(Buffer.from(name), 0);
    header.set(Buffer.from(`${value.byteLength.toString(8).padStart(11, '0')}\0`), 124);
    header[156] = 48;
    const output = new Uint8Array(512 + Math.ceil(value.byteLength / 512) * 512 + 1024);
    output.set(header); output.set(value, 512);
    return output;
  };
  const codexAsset = platform === 'win32' ? codexBytes : gzipSync(makeTar(`codex-${codexTarget}`, codexBytes));
  const codexRelease: CodexRelease = {
    tool: 'codex', version: '0.163.0', platform, arch,
    url: `https://github.com/openai/codex/releases/download/rust-v0.163.0/codex-${codexTarget}${platform === 'win32' ? '.exe' : '.tar.gz'}`,
    sha256: createHash('sha256').update(codexAsset).digest('hex'), format: platform === 'win32' ? 'raw' : 'tar.gz',
    entry: platform === 'win32' ? null : `codex-${codexTarget}`, executable: codexExecutable
  };
  let downloads = 0; let codexDownloads = 0;
  setSetupDepsForTests({
    platform, arch, release, download: async () => { downloads += 1; return archive; }, codexRelease,
    codexDownload: async () => { codexDownloads += 1; return codexAsset; }
  });
  const before = (await setupTreeForTests().getChildren()) ?? [];
  assert.match(String(before.find((item) => String(item.label).includes('GitHub CLI'))?.description), /Needs setup/);
  assert.match(String(before.find((item) => String(item.label) === 'Codex CLI')?.description), /Needs setup/);
  const result = await vscode.commands.executeCommand<{ state: string; version?: string }>(SETUP_COMMANDS.retryGh);
  assert.deepEqual([result.state, result.version], ['ready', '2.102.0']);
  const codexResult = await vscode.commands.executeCommand<{ state: string; version?: string }>(SETUP_COMMANDS.retryCodex);
  assert.deepEqual([codexResult.state, codexResult.version], ['ready', '0.163.0']);
  assert.equal(downloads, 1);
  assert.equal(codexDownloads, 1);
  const after = (await setupTreeForTests().getChildren()) ?? [];
  const gh = after.find((item) => String(item.label).includes('GitHub CLI'));
  assert.match(String(gh?.description), /Ready · 2\.102\.0/);
  const codex = after.find((item) => String(item.label) === 'Codex CLI');
  assert.match(String(codex?.description), /Ready · 0\.163\.0/);
  assert.match(String(codex?.tooltip), /Sign-in, identity, quota and rule injection are not implied/);
  assert.equal(String(gh?.tooltip).includes('synthetic managed gh'), false, 'status does not display binary content');
  const contributed = managedPathContributionForTests();
  assert.ok(contributed, 'verified managed bin directories are contributed to new native terminal PATHs');
  assert.equal(contributed.split(path.delimiter).length, 2, 'both verified gh and Codex directories remain on the managed PATH');
  if (platform !== 'win32') {
    const sentinel = process.env.MULTIAGENT_TEST_GH_SENTINEL;
    assert.ok(sentinel);
    const terminal = vscode.window.createTerminal({ name: 'Managed gh PATH check', location: vscode.TerminalLocation.Editor });
    try {
      terminal.show();
      terminal.sendText('gh', true);
      await waitFor(() => fs.existsSync(sentinel) ? true : undefined, 10000);
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'synthetic');
    } finally { terminal.dispose(); }
  }
  console.log('host smoke: Tools Setup installs synthetic gh and Codex assets only after SHA-256 verification; real downloads and execution are not tested');
}

async function roleFlow(workspace: string): Promise<void> {
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

  // A live, applicable administrator broadcast appears in the preview as a `user`-layer instruction
  // (stronger than the role group's own rules); one targeted at a different role group does not; a
  // revoked one stops appearing; a broadcast store that cannot be read says so and never silently
  // drops the note.
  {
    const broadcastHandle = await privateStorage()?.use();
    assert.equal(broadcastHandle?.ok, true);
    const broadcasts = new BroadcastStore(broadcastHandle.store);
    const createdAt = new Date().toISOString();
    const forEveryone = broadcasts.create({ id: 'stand-down', version: 1, target: { scope: 'all' }, text: 'Stop non-M1 work.', createdAt, expiresAt: null, revokedAt: null });
    assert.equal(forEveryone.ok, true, JSON.stringify(forEveryone));
    const forWorker = broadcasts.create({ id: 'worker-only', version: 1, target: { scope: 'roleGroup', role: 'worker' }, text: 'Rebase before pushing.', createdAt, expiresAt: null, revokedAt: null });
    assert.equal(forWorker.ok, true);
    const pmTextWithBroadcast = await previewText('host-pm');
    assert.match(pmTextWithBroadcast, /Stop non-M1 work\. {2}\[user v1; broadcast:stand-down\]/, 'a broadcast for everyone is a user-layer instruction');
    assert.equal(pmTextWithBroadcast.includes('Rebase before pushing.'), false, 'a broadcast for a different role group does not appear here');
    assert.equal(broadcasts.revoke('stand-down', new Date().toISOString()).ok, true);
    const pmTextAfterRevoke = await previewText('host-pm');
    assert.equal(pmTextAfterRevoke.includes('Stop non-M1 work.'), false, 'a revoked broadcast no longer appears');
    assert.equal(pmTextAfterRevoke.includes('Administrator broadcasts: unknown'), false, 'a successful (even if empty) read is not reported as unknown');
  }

  // The preview is a virtual document: it has no file behind it, so it cannot be saved into a repository.
  const shown = vscode.window.activeTextEditor?.document;
  assert.equal(shown?.uri.scheme, PREVIEW_SCHEME);
  assert.equal(shown?.isUntitled, false);
  await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(previewUri('host-pm'), Buffer.from('x'))), 'a virtual preview cannot be written');
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  assert.equal(fs.existsSync(path.join(workspaceRoot, 'effective-rules.txt')), false, 'no preview file appears in the project');

  // Two editor windows that read the same private record cannot overwrite each other.
  const privateHandle = await privateStorage()?.use();
  assert.equal(privateHandle?.ok, true);
  const loadedRole = privateHandle.store.get('roleGroups', 'host-pm');
  assert.equal(loadedRole.ok && 'found' in loadedRole && loadedRole.found, true);
  const first = (loadedRole as { value: Parameters<typeof saveRoleRecord>[0] & { revision: number } }).value;
  const second = structuredClone(first);
  first.group.rules[0].text = 'Review the latest approved head.';
  assert.equal((await saveRoleRecord(first, first.revision)).ok, true);
  second.group.rules[0].text = 'Stale instruction.';
  assert.equal((await saveRoleRecord(second, second.revision)).reason, 'stale-revision');
  const latestRole = privateHandle.store.get('roleGroups', 'host-pm');
  assert.equal(latestRole.ok && 'found' in latestRole && latestRole.found, true);
  assert.equal((latestRole as { value: { group: { rules: Array<{ text: string }> } } }).value.group.rules[0].text, 'Review the latest approved head.');

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
  const agyWithDefault = {
    group: { ...structuredClone((privateHandle.store.get('roleGroups', 'host-agy') as { value: { group: object } }).value.group),
      id: 'host-agy-bound', name: 'Agy With Default', defaultAccountProfileId: 'acct-synthetic' },
    layers: {}
  } as Parameters<typeof saveRoleRecord>[0];
  assert.equal((await saveRoleRecord(agyWithDefault)).ok, true);
  const refusedAgy = await vscode.commands.executeCommand<{ ok: boolean; code?: string }>('multiagentSystem.sessions.start', {
    interactive: false, provider: 'agy', roleGroupId: 'host-agy-bound', name: 'Agy Default Refused', cwd: workspace, launch: false
  });
  assert.deepEqual([refusedAgy.ok, refusedAgy.code], [false, 'role-group-account-isolation-unknown']);
  const refusedFromRole = await vscode.commands.executeCommand<{ ok: boolean; code?: string }>(ROLE_COMMANDS.start, {
    id: 'host-agy-bound', interactive: false, name: 'Agy Role Refused', cwd: workspace, launch: false
  });
  assert.deepEqual([refusedFromRole.ok, refusedFromRole.code], [false, 'role-group-account-isolation-unknown']);
  assert.equal(vscode.window.terminals.some((terminal) => /Agy (Default|Role) Refused/.test(terminal.name)), false);

  // Assigning a role group to a NEW session: checked against the provider, fixed for that session, shown in the overview.
  const start = (options: object): Thenable<{ ok: boolean; code?: string; session?: { id: string; roleGroupId: string; provider: string } }> =>
    vscode.commands.executeCommand('multiagentSystem.sessions.start', { interactive: false, provider: 'claude', name: 'Role Session', cwd: workspace, launch: false, ...options });
  const refused = async (options: object, code: string): Promise<void> => {
    const result = await start(options);
    assert.deepEqual([result.ok, result.code], [false, code], JSON.stringify(options));
  };
  await refused({ roleGroupId: 'host-agy' }, 'role-group-provider-mismatch');
  await refused({ roleGroupId: 'no-such-role' }, 'role-group-not-found');
  await refused({ roleGroupId: '../escape' }, 'invalid-role-group');
  await refused({ roleGroupId: 'unassigned' }, 'invalid-role-group');
  assert.equal(vscode.window.terminals.some((terminal) => terminal.name === 'Multiagent: Role Session'), false, 'a refused assignment opens no terminal');
  const assigned = await start({ roleGroupId: 'host-pm' });
  assert.equal(assigned.ok, true);
  assert.equal(assigned.session?.roleGroupId, 'host-pm');
  const viaRole = await vscode.commands.executeCommand<{ ok: boolean; session?: { roleGroupId: string; name: string } }>(ROLE_COMMANDS.start, { id: 'host-pm', interactive: false, name: 'Started From Role', launch: false });
  assert.equal(viaRole.ok, true);
  assert.equal(viaRole.session?.roleGroupId, 'host-pm', 'the Start Agent command assigns the group to the new session');
  try {
    const rows = (await overviewTreeForTests().getChildren()) ?? [];
    const row = rows.find((entry) => entry.label === 'Role Session');
    assert.ok(row, 'the assigned session is in the overview');
    assert.match(String(row?.description ?? ''), /^Host PM · /, 'the overview shows the role group name');
    assert.match(String(row?.tooltip ?? ''), /not sent to the CLI yet/);
    const after = await vscode.commands.executeCommand<{ sessions?: Array<{ id: string; roleGroupId: string }> }>('multiagentSystem.sessions.list', { interactive: false });
    assert.equal(after.sessions?.find((entry) => entry.id === assigned.session?.id)?.roleGroupId, 'host-pm');
  } finally {
    for (const terminal of vscode.window.terminals.filter((candidate) => candidate.name === 'Multiagent: Role Session' || candidate.name === 'Multiagent: Started From Role')) terminal.dispose();
  }
  assert.equal(privateHandle.store.put('roleGroups', 'broken', { group: { id: 'broken' }, layers: {} }).ok, true);
  try {
    await assert.rejects(pickRoleForLaunch('agy'), (error: { code?: string }) => error.code === 'role-group-unreadable',
      'a malformed private role is not treated as an empty list');
  } finally {
    privateHandle.store.delete('roleGroups', 'broken');
  }
  console.log('host smoke: private role group previews as a read-only virtual document with per-rule injection status (preview only; agy manual); it cannot be saved to the project');
}

// `send` and `revoke` are interactive-only by design, with no non-interactive bypass at all (unlike
// every other command here that supports `interactive: false` for host testing): accepting a
// pre-filled target or text would reopen exactly the self-declared-role bypass the product forbids.
// That means headless CI cannot drive their QuickPick/InputBox sequence (there is no UI to answer it,
// and `showQuickPick` simply waits), so — the same way ROLE_COMMANDS.create/edit are only ever
// registration-checked, never executed, in this suite — this only proves they are registered and
// that the read-only list reflects whatever BroadcastStore already holds.
async function broadcastFlow(): Promise<void> {
  const opened = await privateStorage()?.use();
  assert.equal(opened?.ok, true);
  const broadcasts = new BroadcastStore(opened.store);
  const listed = broadcasts.list();
  assert.ok(listed.ok && 'items' in listed);
  const expectedIds = ((listed as { items: Array<{ id: string }> }).items ?? []).map((item) => item.id).sort();

  await vscode.commands.executeCommand(BROADCAST_COMMANDS.refresh);
  const rows = await broadcastTreeForTests().getChildren();
  assert.ok(Array.isArray(rows) && rows.length > 0, 'the broadcast list always shows something, even when empty');
  const shownIds = rows.map((row) => (row as { broadcast?: { id: string } }).broadcast?.id).filter((id): id is string => typeof id === 'string').sort();
  assert.deepEqual(shownIds, expectedIds, 'the read-only list shows exactly what BroadcastStore holds');
  console.log('host smoke: broadcast view commands are registered and the read-only list reflects stored broadcasts');
}

async function agyFlow(workspace: string): Promise<void> {
  const capabilities = builtIn.get('agy')?.capabilities;
  assert.ok(capabilities);
  assert.equal(capabilities.terminalLaunch, 'unverified');
  for (const [name, state] of Object.entries(capabilities)) {
    if (name !== 'terminalLaunch') assert.equal(state, 'unknown', `${name} must stay unknown`);
  }
  const sentinel = process.env.MULTIAGENT_TEST_AGY_SENTINEL;
  assert.ok(sentinel);
  const cannotAssignAccount = await vscode.commands.executeCommand<SessionOutcome>('multiagentSystem.sessions.start', {
    interactive: false, provider: 'agy', roleGroupId: 'host-agy', accountProfileId: 'acct-synthetic',
    name: 'Agy Account Refused', cwd: workspace, launch: false
  });
  assert.equal(cannotAssignAccount.code, 'account-isolation-unknown');
  assert.equal(vscode.window.terminals.some((terminal) => terminal.name === 'Multiagent: Agy Account Refused'), false);
  const command = (name: string): Thenable<SessionOutcome> => vscode.commands.executeCommand('multiagentSystem.sessions.start', {
    interactive: false, provider: 'agy', roleGroupId: 'host-agy', name, cwd: workspace, launch: true
  });
  const started = await command('Agy Fake');
  assert.equal(started.ok, true);
  assert.equal(started.session?.state, 'launch-requested', 'typing a CLI command is not proof it is working');
  assert.equal(started.session?.provider, 'agy');
  await waitFor(() => vscode.window.terminals.find((terminal) => terminal.name === 'Multiagent: Agy Fake'), 10000);
  await waitFor(() => fs.existsSync(sentinel) ? true : undefined, 20000);
  assert.equal(fs.readFileSync(sentinel, 'utf8').trim(), 'synthetic');
  if (started.session?.id) await vscode.commands.executeCommand('multiagentSystem.sessions.stop', { interactive: false, id: started.session.id });

  const previousPath = process.env.PATH;
  try {
    process.env.PATH = path.join(path.dirname(sentinel), 'missing-cli-bin');
    const missing = await command('Agy Missing');
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'executable-not-found');
    assert.equal(vscode.window.terminals.some((terminal) => terminal.name === 'Multiagent: Agy Missing'), false, 'missing agy opens no terminal');
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
  console.log('host smoke: synthetic agy starts in a native terminal; capabilities remain unknown; missing executable is actionable');
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
  console.log(await runPlanChecks(workspace));
  console.log(await runReportChecks());
  await setupFlow();
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
  await roleFlow(workspace);
  await broadcastFlow();
  await agyFlow(workspace);

  const worktreeTarget = process.env.MULTIAGENT_TEST_WORKTREE;
  assert.ok(worktreeTarget, 'the worktree test folder is provided');
  await worktreeFlow(workspace, worktreeTarget);
}
