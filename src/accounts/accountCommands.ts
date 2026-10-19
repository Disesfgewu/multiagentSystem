import * as os from 'node:os';
import * as vscode from 'vscode';
import { SessionCommands } from '../sessions/sessionCommands';
import { builtIn } from '../providers/registry';
import { accountService, launchEnvironment } from './accountRuntime';
import { chooseConfigFolder, settleChosenFolder, ChooserUi, ChosenFolder, Explained } from './folderChooser';
import { runCommand, childEnvironment } from './identityRunner';
import { editLimits, clearLimits, offerSlotRecovery, limitLines, currentGateState } from './quotaGateUi';
import { isExtensionTestMode, requireInteractive, allowNonInteractive } from '../shared/testMode';
import { configureStatusLineWizard, inspectStatusLineConfig, getBridgeScriptPath, StatusLineUi } from './claudeStatusLine';

const { accountProviderChoices } = require('./provider-choices') as {
  accountProviderChoices(): Array<{ id: string; label: string; description: string; detail: string; canCreateProfile: boolean }>;
};
const { describeProviderCapabilities } = require('../providers/capability-text') as { describeProviderCapabilities(id: unknown): string[] };
const { explainFailure } = require('./folder-guidance') as { explainFailure(result: unknown): Explained[] };
const { checkAccountIdentity, describeCheck, splitFolderIssues } = require('./identity-check') as {
  splitFolderIssues(issues: unknown): { folder: string[]; confirmation: string[] };
  checkAccountIdentity(input: Record<string, unknown>): Promise<{ ok: boolean; state: string; reason: string; checkedAt: string; source: string | null; identity: any }>;
  describeCheck(result: unknown): { summary: string; hint: string };
};
const { describeAccounts } = require('./profile-view') as { describeAccounts(input: { profiles: any[]; observations?: Map<string, unknown>; context: { repoRoot: string } }): any[] };

export const ACCOUNT_VIEW = 'multiagentSystem.accountsView';
export const ACCOUNT_COMMANDS = {
  refresh: 'multiagentSystem.accounts.refresh',
  create: 'multiagentSystem.accounts.create',
  details: 'multiagentSystem.accounts.details',
  edit: 'multiagentSystem.accounts.edit',
  remove: 'multiagentSystem.accounts.remove',
  login: 'multiagentSystem.accounts.login',
  launch: 'multiagentSystem.accounts.launch',
  check: 'multiagentSystem.accounts.check',
  limits: 'multiagentSystem.accounts.limits',
  configureStatusLine: 'multiagentSystem.accounts.configureStatusLine'
} as const;

const LOGIN_COMMANDS: Record<string, string> = {
  claude: 'claude auth login',
  codex: 'codex login'
};

/** Start a native login terminal. The caller must supply a freshly validated profile environment. */
export function openLoginTerminal(provider: string, profile: Record<string, any>, env: Record<string, string | null>, execute = true): { terminal: vscode.Terminal; command: string } {
  const command = LOGIN_COMMANDS[provider];
  if (!command) throw new Error('provider-login-unsupported');
  const terminal = vscode.window.createTerminal({
    name: `Multiagent: ${profile.label} sign-in`,
    cwd: profile.configDir,
    env,
    location: vscode.TerminalLocation.Editor
  });
  terminal.show();
  if (execute) terminal.sendText(command);
  return { terminal, command };
}

type CheckResult = { ok: boolean; state: string; reason: string; checkedAt: string; source: string | null; identity: any };
// Results of the sign-in checks, kept only while this window is open. They hold a fingerprint and
// a login method, never the CLI's output or an email address.
const checkResults = new Map<string, CheckResult>();

const {
  registerProfileIdentity,
  getProfileIdentity
} = require('./identity-registry') as {
  registerProfileIdentity(profileId: string, identity: unknown): void;
  getProfileIdentity(profileId: string): unknown;
};

export function observationsFor(profiles: Array<{ id: string }>): Map<string, { identity: unknown }> {
  const observed = new Map<string, { identity: unknown }>();
  for (const profile of profiles) {
    const fromRegistry = getProfileIdentity(profile.id);
    if (fromRegistry) {
      observed.set(profile.id, { identity: fromRegistry });
      continue;
    }
    const result = checkResults.get(profile.id);
    if (result?.ok && result.identity) observed.set(profile.id, { identity: result.identity });
  }
  return observed;
}

function lastCheckedText(id: string): string {
  const result = checkResults.get(id);
  if (!result) return 'Sign-in has not been checked in this window. Use Check Sign-in.';
  return result.ok
    ? `Last checked ${result.checkedAt} (${result.source ?? 'unknown source'}).`
    : `Last check ${result.checkedAt} could not confirm the sign-in: ${describeCheck(result).summary}`;
}

class AccountItem extends vscode.TreeItem {
  constructor(override readonly id: string, label: string, provider: string, health: string, identity: string, issues: string[], gateState: 'allow' | 'warn' | 'confirm' | 'block' | null = null) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = `${provider} · ${identity} · ${health}`;
    this.tooltip = issues.length ? issues.join('\n') : `${provider}: identity is unknown until a provider observation is available.`;
    this.contextValue = 'multiagentAccountProfile';
    this.iconPath = new vscode.ThemeIcon(gateState === 'block' ? 'circle-slash' : gateState === 'confirm' ? 'question' : health === 'ready' ? 'account' : 'warning');
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
  constructor(id: string, name: string, provider: string, account: string, state: string, terminalOpen: boolean) {
    super(`Session: ${name}`, vscode.TreeItemCollapsibleState.None);
    this.description = `${provider} · ${account} · ${state}`;
    this.tooltip = [
      `Session: ${name}`,
      `Provider: ${provider}`,
      `Account: ${account}`,
      `Status: ${state}`,
      terminalOpen ? 'Terminal: open in this window' : 'Terminal: not open in this window (click to reopen as a new session)'
    ].join('\n');
    this.contextValue = terminalOpen ? 'multiagentAccountSession' : 'multiagentAccountSessionClosed';
    this.iconPath = new vscode.ThemeIcon(terminalOpen ? 'terminal' : 'debug-disconnect');
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
    if (!result.ok) return [new AccountMessage(result.message), ...liveSessions.map((entry) => new SessionItem(entry.id, entry.name, entry.provider, entry.accountProfileId, entry.stateLabel, entry.terminalOpen))];
    const loaded = result.service.list();
    if (!loaded.ok) return [new AccountMessage(loaded.message), ...liveSessions.map((entry) => new SessionItem(entry.id, entry.name, entry.provider, entry.accountProfileId, entry.stateLabel, entry.terminalOpen))];
    const rows: AccountTreeItem[] = [];
    if (loaded.profiles.length === 0) rows.push(new AccountMessage('No account profiles. Use Create Profile to add one.'));
    const described = describeAccounts({ profiles: loaded.profiles, observations: observationsFor(loaded.profiles), context: { repoRoot: result.store.repoRoot } });
    const limitText = await Promise.all(loaded.profiles.map((profile: any) => limitLines(profile.id, () => sessions?.list() ?? [])));
    const gateStates = await Promise.all(loaded.profiles.map((profile: any) => currentGateState(profile.id, () => sessions?.list() ?? [])));
    rows.push(...loaded.profiles.map((profile: any, index: number) => {
      const status = described[index];
      const provider = builtIn.get(profile.provider)?.label ?? profile.provider;
      const identity = status.verifiedIdentity.state === 'verified'
        ? `identity ${status.verifiedIdentity.fingerprint}`
        : 'identity unknown';
      const issues = status.issues.map((issue: { hint: string }) => issue.hint);
      if (builtIn.capability(profile.provider, 'accountIsolation') !== 'verified') issues.push('Account isolation is not verified for this provider on this machine.');
      issues.push(lastCheckedText(profile.id));
      issues.push(...limitText[index]);
      const gateState = gateStates[index];
      const item = new AccountItem(profile.id, profile.label, provider, status.health, identity, issues, gateState?.action ?? null);
      const policyLine = limitText[index][0] ?? 'Limits: could not be read.';
      item.description += policyLine.startsWith('Limits: none set.') ? ' · limits not set' : policyLine.startsWith('Limits: could not be read.') ? ' · limits unknown' : ' · limits set';
      if (gateState?.action === 'block') item.description += ' · BLOCKED NOW';
      else if (gateState?.action === 'confirm') item.description += ' · needs confirmation';
      else if (gateState?.action === 'warn') item.description += ' · near limit';
      return item;
    }));
    const labels = new Map<string, string>(loaded.profiles.map((profile: any) => [profile.id, profile.label]));
    rows.push(...liveSessions.map((entry) => new SessionItem(
      entry.id, entry.name, builtIn.get(entry.provider)?.label ?? entry.provider,
      labels.get(entry.accountProfileId) ?? (entry.accountProfileId === 'unassigned' ? 'unassigned' : 'profile missing'),
      entry.stateLabel,
      entry.terminalOpen
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
  const candidate = typeof value === 'string'
    ? value
    : value && typeof value === 'object' && 'id' in value && typeof (value as { id: unknown }).id === 'string'
      ? (value as { id: string }).id
      : undefined;
  return candidate && /^[A-Za-z0-9_-]{1,80}$/.test(candidate) ? candidate : undefined;
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

function errorFor(result: { code?: string; message?: string; problems?: string[]; kind?: string }): string {
  const explained = explainFailure(result);
  if (explained.length > 0) return explained.map((item) => `${item.message} ${item.fix}`).join(' ');
  return result.message ?? `Account operation failed${result.code ? ` (${result.code})` : ''}.`;
}

const folderUi: ChooserUi = {
  async pickAction(suggestionName) {
    const picked = await vscode.window.showQuickPick([
      { label: '$(add) Create a recommended folder for this account', description: suggestionName, detail: 'A new private folder under your home folder, outside your project. Recommended.', action: 'create' as const },
      { label: '$(folder-opened) Choose an existing folder…', detail: 'Pick a new, empty folder outside your project. It is checked as soon as you choose it.', action: 'choose' as const }
    ], { placeHolder: 'Where should this account keep its sign-in data?', ignoreFocusOut: true });
    return picked?.action;
  },
  async openFolder(defaultPath) {
    const folders = await vscode.window.showOpenDialog({
      canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
      defaultUri: vscode.Uri.file(defaultPath),
      title: 'Choose a new folder for this account (outside your project)',
      openLabel: 'Use this folder'
    });
    return folders?.[0]?.fsPath;
  },
  async showProblems(summary, detail, offerRecommended) {
    const buttons = offerRecommended ? ['Use the recommended folder', 'Choose another folder'] : ['Try again'];
    const answer = await vscode.window.showWarningMessage(summary, { modal: true, detail }, ...buttons);
    if (answer === 'Use the recommended folder') return 'recommended';
    return answer === undefined ? undefined : 'another';
  }
};

async function pickConfigFolder(provider: string, label: string, profiles: any[], repoRoot: string): Promise<ChosenFolder> {
  return chooseConfigFolder({ provider, label, profiles, repoRoot, homeDir: os.homedir(), ui: folderUi });
}

let extensionContext: vscode.ExtensionContext | undefined;

export function registerAccountCommands(context: vscode.ExtensionContext, sessionCommands: SessionCommands): void {
  extensionContext = context;
  sessions = sessionCommands;
  const tree = new AccountTree();
  currentTree = tree;
  treeForTest = context.extensionMode === vscode.ExtensionMode.Test ? tree : undefined;
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(ACCOUNT_DETAIL_SCHEME, { provideTextDocumentContent: (uri) => detailDocs.get(uri.query) ?? 'These details are no longer available. Open them again from the account list.' }),
    vscode.window.createTreeView(ACCOUNT_VIEW, { treeDataProvider: tree }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => tree.refresh()),
    sessionCommands.onDidChange(() => tree.refresh()),
    vscode.commands.registerCommand(ACCOUNT_COMMANDS.refresh, () => tree.refresh()),
    vscode.commands.registerCommand(ACCOUNT_COMMANDS.create, create),
    vscode.commands.registerCommand(ACCOUNT_COMMANDS.details, (id?: unknown) => showDetails(id, tree)),
    vscode.commands.registerCommand(ACCOUNT_COMMANDS.edit, (id?: unknown) => edit(id, tree)),
    vscode.commands.registerCommand(ACCOUNT_COMMANDS.remove, (id?: unknown) => remove(id, tree)),
    vscode.commands.registerCommand(ACCOUNT_COMMANDS.login, (id?: unknown) => login(id)),
    vscode.commands.registerCommand(ACCOUNT_COMMANDS.launch, (id?: unknown) => launch(id)),
    vscode.commands.registerCommand(ACCOUNT_COMMANDS.check, (id?: unknown) => check(id)),
    vscode.commands.registerCommand(ACCOUNT_COMMANDS.limits, (value?: unknown) => limits(value)),
    vscode.commands.registerCommand(ACCOUNT_COMMANDS.configureStatusLine, (value?: unknown) => configureStatusLine(value))
  );
}

async function create(): Promise<void> {
  const providers = accountProviderChoices();
  const picked = await vscode.window.showQuickPick(providers, { placeHolder: 'Choose a CLI provider for this account' });
  if (!picked) return;
  if (!picked.canCreateProfile) {
    void vscode.window.showWarningMessage(`${picked.label} can launch in a terminal, but separate account profiles are unavailable. Account isolation, identity verification and quota/usage are unknown. Use the CLI's default sign-in; no account profile or configuration folder was created.`);
    return;
  }
  const label = await vscode.window.showInputBox({ prompt: 'Account label (shown only on this machine)', placeHolder: 'Work, Personal, Research…', validateInput: (value) => value.trim() ? undefined : 'Enter a label.' });
  if (!label) return;
  const result = await accountService(() => sessions?.list() ?? []);
  if (!result.ok) { void vscode.window.showErrorMessage(result.message); return; }
  const existing = result.service.list();
  if (!existing.ok) { void vscode.window.showErrorMessage(errorFor(existing)); return; }
  const chosen = await pickConfigFolder(picked.id, label, existing.profiles, (result.store as { repoRoot: string }).repoRoot);
  if (!chosen.ok) return;
  const created = result.service.create({ provider: picked.id, label, configDir: chosen.dir });
  settleChosenFolder(chosen, created);
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
  const checked = checkResults.get(id);
  const described = describeAccounts({ profiles: [profile], observations: observationsFor([profile]), context: { repoRoot: (result.store as { repoRoot: string }).repoRoot } })[0];
  const identityLine = described.verifiedIdentity.state === 'verified'
    ? `Service identity: confirmed by the CLI, fingerprint ${described.verifiedIdentity.fingerprint}`
    : `Service identity: unknown${checked && !checked.ok ? ` (${describeCheck(checked).summary})` : checked?.identity && !checked.identity.loggedIn ? ' (the CLI says it is not signed in)' : ' (not checked yet, or the CLI did not confirm it)'}`;
  const plan = checked?.ok && checked.identity?.plan?.value ? String(checked.identity.plan.value) : null;
  const { folder: folderProblems, confirmation } = splitFolderIssues(described.issues);
  const lines = [
    `Account profile: ${profile.label}`,
    `Provider: ${provider?.label ?? profile.provider}`,
    `Configuration folder: ${folderProblems.length === 0 ? 'passes the safety checks' : `rejected: ${folderProblems.join(' ')}`}`,
    `CLI confirmation of this folder: ${confirmation.length === 0 ? (checked?.ok && checked.identity?.configDirMatches === true ? 'confirmed' : 'unverified (the CLI has not said which folder it uses)') : `unverified: ${confirmation.join(' ')}`}`,
    identityLine,
    `Login method: ${described.loginMethod.state === 'reported' ? described.loginMethod.value : 'unknown'}`,
    `Subscription plan: ${plan ?? 'unknown (the CLI did not report one)'}`,
    ...(profile.provider === 'claude' ? [(() => {
      const info = inspectStatusLineConfig(profile.configDir, getBridgeScriptPath(extensionContext?.extensionPath));
      if (info.status === 'active') return 'Status line bridge: configured (receipt and freshness are shown separately in quota readings)';
      if (info.status === 'custom') return `Status line bridge: custom command (${info.currentCommand ?? 'custom'})`;
      return 'Status line bridge: not configured (use Configure Claude Status Line Bridge)';
    })()] : []),
    `Health: ${described.health}`,
    lastCheckedText(id),
    `Account isolation: ${isolation}`,
    ...describeProviderCapabilities(profile.provider),
    ...(await limitLines(id, () => sessions?.list() ?? [])),
    'The label is user supplied and does not prove which account is signed in.'
  ];
  // A virtual document: it has no file behind it, so the account's label and details cannot be saved into a project.
  const token = `${++detailCounter}`;
  detailDocs.set(token, lines.join('\n'));
  if (detailDocs.size > 20) detailDocs.delete(detailDocs.keys().next().value as string);
  const document = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: ACCOUNT_DETAIL_SCHEME, path: '/account-details.txt', query: token }));
  await vscode.window.showTextDocument(document, { preview: true });
}

export const ACCOUNT_DETAIL_SCHEME = 'multiagent-account';
const detailDocs = new Map<string, string>();
let detailCounter = 0;

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
  let chosenFolder: ChosenFolder | undefined;
  if (fields.value === 'label') {
    const label = await vscode.window.showInputBox({ prompt: 'New account label', value: current.profile.label, validateInput: (text) => text.trim() ? undefined : 'Enter a label.' });
    if (!label) return;
    changes = { label };
  } else {
    const all = result.service.list();
    if (!all.ok) { void vscode.window.showErrorMessage(errorFor(all)); return; }
    const others = all.profiles.filter((entry: any) => entry.id !== profileId);
    chosenFolder = await pickConfigFolder(current.profile.provider, current.profile.label, others, (result.store as { repoRoot: string }).repoRoot);
    if (!chosenFolder.ok) return;
    changes = { configDir: chosenFolder.dir };
  }
  const updated = result.service.update(profileId, changes, { expectedRevision: current.profile.revision });
  if (chosenFolder) settleChosenFolder(chosenFolder, updated);
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
  const prepared = await launchEnvironment(loaded.profile.id, loaded.profile.provider, () => sessions?.list() ?? []);
  if (!prepared.ok) { void vscode.window.showErrorMessage(prepared.message); return; }
  const answer = await vscode.window.showWarningMessage(
    `Sign in to ${loaded.profile.provider} for “${loaded.profile.label}”?`,
    { modal: true, detail: 'A native terminal will run the provider login command with this profile configuration folder. Account isolation is not verified for this CLI.' },
    'Open Login Terminal'
  );
  if (answer !== 'Open Login Terminal') return;
  const opened = openLoginTerminal(loaded.profile.provider, loaded.profile, prepared.env);
  // When the login terminal is closed the sign-in has most likely finished: check it once.
  const watcher = vscode.window.onDidCloseTerminal((closed) => {
    if (closed !== opened.terminal) return;
    watcher.dispose();
    void check(loaded.profile.id);
  });
  const next = await vscode.window.showInformationMessage(`Finish signing in inside the terminal, then check “${loaded.profile.label}”.`, 'I have signed in — check now');
  if (next === 'I have signed in — check now') void check(loaded.profile.id);
}

/** Runs the provider's own status command in this profile's environment and shows the result in plain words. */
async function check(value: unknown): Promise<CheckResult | undefined> {
  // It runs the provider's CLI: outside test mode it always shows its progress and result.
  const options = requireInteractive(value && typeof value === 'object' && !(value instanceof vscode.TreeItem) ? (value as { id?: unknown; interactive?: boolean }) : {});
  const interactive = options.interactive !== false;
  const id = selectedId(options.id ?? value);
  const profile = id || !interactive ? undefined : await chooseProfile();
  const selected = profile ?? (id ? { id } : undefined);
  if (!selected) return undefined;
  const result = await accountService(() => sessions?.list() ?? []);
  if (!result.ok) { if (interactive) void vscode.window.showErrorMessage(result.message); return undefined; }
  const loaded = result.service.get(selected.id);
  if (!loaded.ok) { if (interactive) void vscode.window.showErrorMessage(errorFor(loaded)); return undefined; }
  const repoRoot = (result.store as { repoRoot: string }).repoRoot;
  const prepared = await launchEnvironment(loaded.profile.id, loaded.profile.provider, () => sessions?.list() ?? []);
  let outcome: CheckResult;
  if (!prepared.ok) {
    outcome = { ok: false, state: 'unknown', reason: 'profile-rejected', checkedAt: new Date().toISOString(), source: null, identity: null };
  } else {
    const run = () => checkAccountIdentity({ profile: loaded.profile, context: { repoRoot }, env: childEnvironment(prepared.env), runner: runCommand });
    outcome = interactive
      ? await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Checking sign-in for “${loaded.profile.label}”…` }, run)
      : await run();
  }
  checkResults.set(loaded.profile.id, outcome);
  if (outcome.ok && outcome.identity) {
    registerProfileIdentity(loaded.profile.id, outcome.identity);
  } else {
    registerProfileIdentity(loaded.profile.id, null);
  }
  currentTree?.refresh();
  if (!interactive) return outcome;
  const words = describeCheck(outcome);
  const confirmed = outcome.ok && outcome.identity?.loggedIn === true && outcome.identity?.subject?.confidence === 'actual' && outcome.identity.anomalies.length === 0;
  const message = `“${loaded.profile.label}”: ${words.summary} ${words.hint}`;
  if (confirmed) {
    const answer = await vscode.window.showInformationMessage(message, 'Start Session with This Account');
    if (answer === 'Start Session with This Account') void vscode.commands.executeCommand(ACCOUNT_COMMANDS.launch, loaded.profile.id);
  } else {
    const answer = await vscode.window.showWarningMessage(message, 'Check Again', 'Open Login Terminal');
    if (answer === 'Check Again') void check(loaded.profile.id);
    if (answer === 'Open Login Terminal') void vscode.commands.executeCommand(ACCOUNT_COMMANDS.login, loaded.profile.id);
  }
  return outcome;
}

/** Sets (or, with `clear`, removes) the limits for one account. */
async function limits(value: unknown): Promise<unknown> {
  // Limits decide whether new agents start. Outside test mode caller-supplied values and `clear`
  // are ignored and the person is asked, so another extension cannot change or lift them.
  const given = requireInteractive(value && typeof value === 'object' && !(value instanceof vscode.TreeItem) ? (value as { id?: unknown; interactive?: boolean; clear?: boolean; warn?: string; block?: string; max?: string; unknownQuota?: string }) : {});
  const options = given.clear === true && !isExtensionTestMode() ? { ...given, clear: undefined } : given;
  const id = selectedId(options.id ?? value);
  const profile = id ? undefined : await chooseProfile();
  const selected = profile ?? (id ? { id } : undefined);
  if (!selected) return { ok: false, cancelled: true };
  const result = await accountService(() => sessions?.list() ?? []);
  if (!result.ok) { if (options.interactive !== false) void vscode.window.showErrorMessage(result.message); return { ok: false, reason: 'storage-unavailable' }; }
  const loaded = result.service.get(selected.id);
  if (!loaded.ok) { if (options.interactive !== false) void vscode.window.showErrorMessage(errorFor(loaded)); return { ok: false, reason: 'profile-not-found' }; }
  if (options.clear === true) {
    const cleared = await clearLimits(loaded.profile.id, () => sessions?.list() ?? []);
    currentTree?.refresh();
    return { ok: cleared };
  }
  // Only a person at the keyboard may free slots of vanished windows; the headless test form never does.
  if (options.interactive !== false) {
    const freed = await offerSlotRecovery(loaded.profile.id, loaded.profile.label, () => sessions?.list() ?? []);
    if (freed > 0) void vscode.window.showInformationMessage(`Freed ${freed} running-agent slot${freed === 1 ? '' : 's'} for “${loaded.profile.label}”.`);
  }
  const outcome = await editLimits(loaded.profile.id, loaded.profile.label, () => sessions?.list() ?? [], options.interactive === false ? { warn: options.warn, block: options.block, max: options.max, unknownQuota: options.unknownQuota } : undefined);
  if (outcome.ok) {
    currentTree?.refresh();
    if (options.interactive !== false) void vscode.window.showInformationMessage(`Limits saved for “${loaded.profile.label}”. They apply to agents started from now on; agents already running are not changed.`);
  }
  return outcome;
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

/** Configures or manages the Claude Code status line bridge for real quota reporting. */
export async function configureStatusLine(value: unknown): Promise<unknown> {
  const rawOptions = value && typeof value === 'object' && !(value instanceof vscode.TreeItem)
    ? (value as { id?: unknown; interactive?: boolean; consent?: boolean; action?: 'enable' | 'disable' })
    : {};
  const testMode = isExtensionTestMode();
  const interactive = testMode ? (rawOptions.interactive !== false) : true;
  const consent = testMode ? rawOptions.consent : undefined;
  const action = testMode ? rawOptions.action : undefined;
  const id = selectedId(rawOptions.id ?? value);
  const profile = id ? undefined : await chooseProfile('claude');
  const selected = profile ?? (id ? { id } : undefined);
  if (!selected) return { ok: false, status: 'cancelled' };

  const result = await accountService(() => sessions?.list() ?? []);
  if (!result.ok) {
    if (interactive) void vscode.window.showErrorMessage(result.message);
    return { ok: false, status: 'failed', message: result.message };
  }
  const loaded = result.service.get(selected.id);
  if (!loaded.ok) {
    if (interactive) void vscode.window.showErrorMessage(errorFor(loaded));
    return { ok: false, status: 'failed', message: errorFor(loaded) };
  }

  const vscodeStatusLineUi: StatusLineUi = {
    async confirmEnable(label, settingsPath, bridgeCommand) {
      const answer = await vscode.window.showInformationMessage(
        `Enable Claude status line bridge for “${label}”?`,
        {
          modal: true,
          detail: `Multiagent will configure statusLine in settings.json (${settingsPath}):\n\nCommand: ${bridgeCommand}\n\nWhen Claude Code runs, it will feed session metrics to this bridge via stdin and write 5-hour and 7-day rate limits to local storage.\n\nNote: Only claude.ai Pro/Max subscription accounts report rate limits, and only after the first API response in an active session. Non-subscription accounts will show unknown quota.`
        },
        'Enable Status Line Bridge'
      );
      return answer === 'Enable Status Line Bridge';
    },
    async confirmOverwrite(label, currentCommand, bridgeCommand) {
      const answer = await vscode.window.showWarningMessage(
        `Overwrite existing statusLine in “${label}” settings.json?`,
        {
          modal: true,
          detail: `Current statusLine command:\n${currentCommand}\n\nOverwriting will replace this statusLine command with the Multiagent bridge script:\n${bridgeCommand}\n\nNote: Real rate limits (5-hour and 7-day windows) are only reported by Claude Code for claude.ai Pro/Max subscription accounts after the first API response in an active session.`
        },
        'Overwrite and Enable Bridge'
      );
      return answer === 'Overwrite and Enable Bridge';
    },
    async promptActiveChoice(label) {
      const picked = await vscode.window.showQuickPick([
        { label: '$(check) Keep Status Line Bridge Enabled', description: 'Currently capturing rate limits into Multiagent', value: 'keep' as const },
        { label: '$(trash) Disable / Remove Status Line Bridge', description: 'Remove statusLine from settings.json and delete local quota observations', value: 'disable' as const }
      ], { placeHolder: `Status Line Bridge is active for “${label}”` });
      return picked?.value;
    },
    async confirmDisable(label) {
      const confirm = await vscode.window.showWarningMessage(
        `Remove statusLine bridge from “${label}”?`,
        {
          modal: true,
          detail: 'This removes the statusLine command from settings.json and clears the local quota reading. Other settings will remain untouched.'
        },
        'Remove Bridge'
      );
      return confirm === 'Remove Bridge';
    },
    showInfo(message) {
      void vscode.window.showInformationMessage(message);
    },
    showError(message) {
      void vscode.window.showErrorMessage(message);
    }
  };

  const outcome = await configureStatusLineWizard(loaded.profile, {
    interactive,
    consent,
    action,
    extensionPath: extensionContext?.extensionPath,
    ui: vscodeStatusLineUi
  });

  currentTree?.refresh();
  return outcome;
}

