import * as os from 'node:os';
import * as vscode from 'vscode';
import { SessionCommands } from '../sessions/sessionCommands';
import { builtIn } from '../providers/registry';
import { accountService } from './accountRuntime';

const { PROVIDERS } = require('./profile') as { PROVIDERS: Record<string, { configEnvVar: string }> };
const { describeAccounts } = require('./profile-view') as { describeAccounts(input: { profiles: any[]; context: { repoRoot: string } }): any[] };

export const ACCOUNT_VIEW = 'multiagentSystem.accountsView';
export const ACCOUNT_COMMANDS = {
  refresh: 'multiagentSystem.accounts.refresh',
  create: 'multiagentSystem.accounts.create',
  details: 'multiagentSystem.accounts.details',
  edit: 'multiagentSystem.accounts.edit',
  remove: 'multiagentSystem.accounts.remove',
  login: 'multiagentSystem.accounts.login',
  launch: 'multiagentSystem.accounts.launch'
} as const;

class AccountItem extends vscode.TreeItem {
  constructor(override readonly id: string, label: string, provider: string, health: string, identity: string, issues: string[]) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = `${provider} · ${identity} · ${health}`;
    this.tooltip = issues.length ? issues.join('\n') : `${provider}: identity is unknown until a provider observation is available.`;
    this.contextValue = 'multiagentAccountProfile';
    this.iconPath = new vscode.ThemeIcon(health === 'ready' ? 'account' : 'warning');
    this.command = { command: ACCOUNT_COMMANDS.details, title: 'Account details', arguments: [id] };
  }
}

class AccountMessage extends vscode.TreeItem {
  constructor(text: string) {
    super(text, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('info');
  }
}

class SessionItem extends vscode.TreeItem {
  constructor(id: string, name: string, provider: string, account: string, state: string) {
    super(`Session: ${name}`, vscode.TreeItemCollapsibleState.None);
    this.description = `${provider} · ${account} · ${state}`;
    this.contextValue = 'multiagentAccountSession';
    this.iconPath = new vscode.ThemeIcon('terminal');
    this.command = { command: 'multiagentSystem.sessions.focus', title: 'Focus session terminal', arguments: [{ id }] };
  }
}

type AccountTreeItem = AccountItem | AccountMessage | SessionItem;

class AccountTree implements vscode.TreeDataProvider<AccountTreeItem> {
  private readonly changed = new vscode.EventEmitter<AccountTreeItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  refresh(): void { this.changed.fire(undefined); }
  getTreeItem(item: AccountTreeItem): vscode.TreeItem { return item; }

  async getChildren(item?: AccountTreeItem): Promise<AccountTreeItem[]> {
    if (item) return [];
    const liveSessions = sessions?.list() ?? [];
    const result = await accountService(() => sessions?.list() ?? []);
    if (!result.ok) return [new AccountMessage(result.message), ...liveSessions.map((entry) => new SessionItem(entry.id, entry.name, entry.provider, entry.accountProfileId, entry.stateLabel))];
    const loaded = result.service.list();
    if (!loaded.ok) return [new AccountMessage(loaded.message), ...liveSessions.map((entry) => new SessionItem(entry.id, entry.name, entry.provider, entry.accountProfileId, entry.stateLabel))];
    const rows: AccountTreeItem[] = [];
    if (loaded.profiles.length === 0) rows.push(new AccountMessage('No account profiles. Use Create Profile to add one.'));
    const described = describeAccounts({ profiles: loaded.profiles, context: { repoRoot: result.store.repoRoot } });
    rows.push(...loaded.profiles.map((profile: any, index: number) => {
      const status = described[index];
      const provider = builtIn.get(profile.provider)?.label ?? profile.provider;
      const identity = status.verifiedIdentity.state === 'verified'
        ? `identity ${status.verifiedIdentity.fingerprint}`
        : 'identity unknown';
      const issues = status.issues.map((issue: { hint: string }) => issue.hint);
      if (builtIn.capability(profile.provider, 'accountIsolation') !== 'verified') issues.push('Account isolation is not verified for this provider on this machine.');
      return new AccountItem(profile.id, profile.label, provider, status.health, identity, issues);
    }));
    const labels = new Map<string, string>(loaded.profiles.map((profile: any) => [profile.id, profile.label]));
    rows.push(...liveSessions.map((entry) => new SessionItem(
      entry.id, entry.name, builtIn.get(entry.provider)?.label ?? entry.provider,
      labels.get(entry.accountProfileId) ?? (entry.accountProfileId === 'unassigned' ? 'unassigned' : 'profile missing'),
      entry.stateLabel
    )));
    return rows;
  }
}

let sessions: SessionCommands | undefined;
let treeForTest: AccountTree | undefined;
let currentTree: AccountTree | undefined;

export function accountTreeForTests(): vscode.TreeDataProvider<AccountTreeItem> {
  if (!treeForTest) throw new Error('The account tree is available only in Extension Host tests.');
  return treeForTest;
}

function selectedId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : undefined;
}

async function chooseProfile(provider?: string): Promise<any | undefined> {
  const result = await accountService(() => sessions?.list() ?? []);
  if (!result.ok) {
    void vscode.window.showErrorMessage(result.message);
    return undefined;
  }
  const loaded = result.service.list();
  if (!loaded.ok) {
    void vscode.window.showErrorMessage(loaded.message);
    return undefined;
  }
  const profiles = loaded.profiles.filter((profile: any) => !provider || profile.provider === provider);
  if (profiles.length === 0) {
    void vscode.window.showInformationMessage(provider ? `No ${builtIn.get(provider)?.label ?? provider} account profiles. Create a profile first.` : 'No account profiles. Create a profile first.');
    return undefined;
  }
  const choice = await vscode.window.showQuickPick<{ label: string; description: string; detail: string; profile: any }>(profiles.map((profile: any) => ({
    label: profile.label,
    description: `${builtIn.get(profile.provider)?.label ?? profile.provider} · identity unknown`,
    detail: 'Account identity is unknown until the CLI reports it.',
    profile
  })), { placeHolder: 'Choose an account profile' });
  return choice?.profile;
}

function errorFor(result: { code?: string; message?: string }): string {
  return result.message ?? `Account operation failed${result.code ? ` (${result.code})` : ''}.`;
}

export function registerAccountCommands(context: vscode.ExtensionContext, sessionCommands: SessionCommands): void {
  sessions = sessionCommands;
  const tree = new AccountTree();
  currentTree = tree;
  treeForTest = context.extensionMode === vscode.ExtensionMode.Test ? tree : undefined;
  context.subscriptions.push(
    vscode.window.createTreeView(ACCOUNT_VIEW, { treeDataProvider: tree }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => tree.refresh()),
    sessionCommands.onDidChange(() => tree.refresh()),
    vscode.commands.registerCommand(ACCOUNT_COMMANDS.refresh, () => tree.refresh()),
    vscode.commands.registerCommand(ACCOUNT_COMMANDS.create, create),
    vscode.commands.registerCommand(ACCOUNT_COMMANDS.details, (id?: unknown) => showDetails(id, tree)),
    vscode.commands.registerCommand(ACCOUNT_COMMANDS.edit, (id?: unknown) => edit(id, tree)),
    vscode.commands.registerCommand(ACCOUNT_COMMANDS.remove, (id?: unknown) => remove(id, tree)),
    vscode.commands.registerCommand(ACCOUNT_COMMANDS.login, (id?: unknown) => login(id)),
    vscode.commands.registerCommand(ACCOUNT_COMMANDS.launch, (id?: unknown) => launch(id))
  );
}

async function create(): Promise<void> {
  const providers = Object.keys(PROVIDERS).map((id) => ({ id, label: builtIn.get(id)?.label ?? id }));
  const picked = await vscode.window.showQuickPick(providers, { placeHolder: 'Choose a CLI provider for this account' });
  if (!picked) return;
  const label = await vscode.window.showInputBox({ prompt: 'Account label (shown only on this machine)', placeHolder: 'Work, Personal, Research…', validateInput: (value) => value.trim() ? undefined : 'Enter a label.' });
  if (!label) return;
  const folders = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, defaultUri: vscode.Uri.file(os.homedir()), openLabel: 'Use account configuration folder' });
  if (!folders?.[0]) return;
  const result = await accountService(() => sessions?.list() ?? []);
  if (!result.ok) { void vscode.window.showErrorMessage(result.message); return; }
  const created = result.service.create({ provider: picked.id, label, configDir: folders[0].fsPath });
  if (!created.ok) { void vscode.window.showErrorMessage(errorFor(created)); return; }
  void vscode.window.showInformationMessage(`Account profile “${created.profile.label}” was saved. Its service identity remains unknown until verified by the CLI.`);
  currentTree?.refresh();
}

async function showDetails(value: unknown, tree?: AccountTree): Promise<void> {
  const id = selectedId(value);
  if (!id) return;
  const result = await accountService(() => sessions?.list() ?? []);
  if (!result.ok) { void vscode.window.showErrorMessage(result.message); return; }
  const loaded = result.service.get(id);
  if (!loaded.ok) { void vscode.window.showErrorMessage(errorFor(loaded)); tree?.refresh(); return; }
  const profile = loaded.profile;
  const provider = builtIn.get(profile.provider);
  const isolation = provider?.capabilities.accountIsolation ?? 'unknown';
  const lines = [
    `Account profile: ${profile.label}`,
    `Provider: ${provider?.label ?? profile.provider}`,
    'Service identity: unknown (no live provider observation is connected yet)',
    'Login method: unknown (no live provider observation is connected yet)',
    `Account isolation: ${isolation}`,
    'The label is user supplied and does not prove which account is signed in.'
  ];
  const document = await vscode.workspace.openTextDocument({ language: 'plaintext', content: lines.join('\n') });
  await vscode.window.showTextDocument(document, { preview: true });
}

async function edit(value: unknown, tree: AccountTree): Promise<void> {
  let profileId = selectedId(value);
  const profile = profileId ? undefined : await chooseProfile();
  profileId ??= profile?.id;
  if (!profileId) return;
  const result = await accountService(() => sessions?.list() ?? []);
  if (!result.ok) { void vscode.window.showErrorMessage(result.message); return; }
  const current = result.service.get(profileId);
  if (!current.ok) { void vscode.window.showErrorMessage(errorFor(current)); tree.refresh(); return; }
  const fields = await vscode.window.showQuickPick([
    { label: 'Change label', value: 'label' },
    { label: 'Change account configuration folder', value: 'configDir' }
  ], { placeHolder: `Edit ${current.profile.label}` });
  if (!fields) return;
  let changes: Record<string, unknown>;
  if (fields.value === 'label') {
    const label = await vscode.window.showInputBox({ prompt: 'New account label', value: current.profile.label, validateInput: (text) => text.trim() ? undefined : 'Enter a label.' });
    if (!label) return;
    changes = { label };
  } else {
    const folders = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, defaultUri: vscode.Uri.file(os.homedir()), openLabel: 'Use account configuration folder' });
    if (!folders?.[0]) return;
    changes = { configDir: folders[0].fsPath };
  }
  const updated = result.service.update(profileId, changes, { expectedRevision: current.profile.revision });
  if (!updated.ok) { void vscode.window.showErrorMessage(errorFor(updated)); return; }
  tree.refresh();
  void vscode.window.showInformationMessage(`Account profile “${updated.profile.label}” was updated.`);
}

async function remove(value: unknown, tree: AccountTree): Promise<void> {
  let profileId = selectedId(value);
  const profile = profileId ? undefined : await chooseProfile();
  profileId ??= profile?.id;
  if (!profileId) return;
  const result = await accountService(() => sessions?.list() ?? []);
  if (!result.ok) { void vscode.window.showErrorMessage(result.message); return; }
  const current = result.service.get(profileId);
  if (!current.ok) { void vscode.window.showErrorMessage(errorFor(current)); tree.refresh(); return; }
  const answer = await vscode.window.showWarningMessage(`Remove account profile “${current.profile.label}”?`, { modal: true, detail: 'This removes only the extension profile. It keeps the CLI configuration folder and does not delete CLI login data.' }, 'Remove Profile');
  if (answer !== 'Remove Profile') return;
  let removed = await result.service.remove(profileId);
  if (!removed.ok && removed.code === 'profile-referenced') {
    const confirm = await vscode.window.showWarningMessage('Earlier sessions still refer to this profile.', { modal: true, detail: 'Those sessions will no longer be reopenable with this account profile. The CLI folder and sign-in data will remain.' }, 'Delete Anyway');
    if (confirm !== 'Delete Anyway') return;
    removed = await result.service.remove(profileId, { allowHistoricalReferences: true });
  }
  if (!removed.ok) { void vscode.window.showErrorMessage(errorFor(removed)); return; }
  tree.refresh();
  void vscode.window.showInformationMessage('Account profile removed. Its CLI configuration folder was kept.');
}

async function login(value: unknown): Promise<void> {
  const id = selectedId(value);
  const profile = id ? undefined : await chooseProfile();
  const selected = profile ?? (id ? { id } : undefined);
  if (!selected || !sessions) return;
  const result = await accountService(() => sessions?.list() ?? []);
  if (!result.ok) { void vscode.window.showErrorMessage(result.message); return; }
  const loaded = result.service.get(selected.id);
  if (!loaded.ok) { void vscode.window.showErrorMessage(errorFor(loaded)); return; }
  await sessions.launchWithAccount({
    interactive: true,
    provider: loaded.profile.provider,
    name: `${loaded.profile.label} sign-in`,
    cwd: loaded.profile.configDir,
    accountProfileId: loaded.profile.id
  });
}

async function launch(value: unknown): Promise<void> {
  const id = selectedId(value);
  const profile = id ? undefined : await chooseProfile();
  const selected = profile ?? (id ? { id } : undefined);
  if (!selected || !sessions) return;
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) { void vscode.window.showErrorMessage('Open a project folder before starting an agent session.'); return; }
  const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Choose the project for this session' });
  if (!folder) return;
  const result = await accountService(() => sessions?.list() ?? []);
  if (!result.ok) { void vscode.window.showErrorMessage(result.message); return; }
  const loaded = result.service.get(selected.id);
  if (!loaded.ok) { void vscode.window.showErrorMessage(errorFor(loaded)); return; }
  const name = await vscode.window.showInputBox({ prompt: 'Session name', value: loaded.profile.label, validateInput: (text) => text.trim() ? undefined : 'Enter a session name.' });
  if (!name) return;
  await sessions.launchWithAccount({ interactive: true, provider: loaded.profile.provider, name, cwd: folder.uri.fsPath, accountProfileId: loaded.profile.id });
}
