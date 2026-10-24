import * as os from 'node:os';
import * as vscode from 'vscode';
import { SessionCommands } from '../sessions/sessionCommands';
import { builtIn } from '../providers/registry';
import { accountService, launchEnvironment } from './accountRuntime';
import { chooseConfigFolder, settleChosenFolder, ChooserUi, ChosenFolder, Explained } from './folderChooser';
import { runCommand, childEnvironment } from './identityRunner';
import { editLimits, clearLimits, offerSlotRecovery, limitLines, currentGateState, recordVerifiedIdentity, setIdentityProbe, quotaDetail } from './quotaGateUi';
import { isExtensionTestMode, requireInteractive, allowNonInteractive } from '../shared/testMode';
import { configureHooksWizard, describeHookEnable, inspectHookConfig, getHookBridgeScriptPath, HookUi } from './claudeHooks';
import { configureStatusLineWizard, inspectStatusLineConfig, getBridgeScriptPath, StatusLineUi } from './claudeStatusLine';

const { accountProviderChoices } = require('./provider-choices') as {
  accountProviderChoices(): Array<{ id: string; label: string; description: string; detail: string; canCreateProfile: boolean }>;
};
const { describeProviderCapabilities } = require('../providers/capability-text') as { describeProviderCapabilities(id: unknown): string[] };
const { explainFailure, suggestFolder, createRecommendedFolder, discardCreated } = require('./folder-guidance') as {
  explainFailure(result: unknown): Explained[];
  suggestFolder(input: { homeDir: string; provider: string; label: string }): { parent: string; dir: string; name: string };
  createRecommendedFolder(input: { provider: string; label: string; suggestion: { parent: string; dir: string; name: string }; profiles: unknown[]; context: { repoRoot: string; homeDir: string } }): { ok: boolean; dir?: string; madeFolders?: unknown[]; items?: Explained[] };
  discardCreated(made: unknown[]): void;
};
const addAccountFlow = require('./add-account') as {
  addAccount(provider: string, deps: Record<string, unknown>): Promise<{ ok: boolean; cancelled?: boolean; profile?: any; steps: Array<{ step: string; ok: boolean; message?: string; next?: string }> }>;
  checkLabel(value: unknown): { ok: true; label: string } | { ok: false; message: string };
  summarize(provider: string, label: string, result: unknown): { level: 'info' | 'warning' | 'error'; text: string } | null;
};
const { checkAccountIdentity, describeCheck, splitFolderIssues, CHECKS } = require('./identity-check') as {
  CHECKS: Record<string, unknown>;
  splitFolderIssues(issues: unknown): { folder: string[]; confirmation: string[] };
  checkAccountIdentity(input: Record<string, unknown>): Promise<{ ok: boolean; state: string; reason: string; checkedAt: string; source: string | null; identity: any; display?: { email: string | null; organization: string | null } }>;
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
  configureStatusLine: 'multiagentSystem.accounts.configureStatusLine',
  configureHooks: 'multiagentSystem.accounts.configureHooks',
  addClaude: 'multiagentSystem.accounts.addClaude',
  addCodex: 'multiagentSystem.accounts.addCodex'
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

type CheckResult = { ok: boolean; state: string; reason: string; checkedAt: string; source: string | null; identity: any; restored?: boolean };
type Display = { email: string | null; organization: string | null };
// Results of the sign-in checks: a fingerprint, a login method and a plan, never the CLI's output or an e-mail address. They are
// also saved in the private store (account-checks.js) so the view shows them after a reload (#352).
const checkResults = new Map<string, CheckResult>();
// The e-mail address and organization the CLI reported, so the person can tell accounts apart (#352). In this window's memory only:
// never stored, logged, exported, sent to GitHub or put in an agent's instructions. After a reload they come back from the check
// that runs on start.
const checkDisplays = new Map<string, Display>();
const checking = new Set<string>();
let checksRestored = false;
const { AccountCheckStore } = require('./account-checks') as { AccountCheckStore: new (store: unknown) => { save(id: string, result: unknown): { ok: boolean }; load(ids: string[]): Map<string, CheckResult> } };
const { quotaSummary, identitySummary, accountsOverview, duplicateLine } = require('./account-row') as {
  quotaSummary(detail: unknown, now?: Date): { text: string; attention: boolean };
  identitySummary(input: { check?: unknown; display?: unknown; now?: Date; checking?: boolean }): { text: string; signedIn: boolean | null; attention: boolean; lines: string[] };
  accountsOverview(rows: Array<{ signedIn: boolean | null; attention: boolean }>): string;
  duplicateLine(labels: string[]): string | null;
};

/** The saved checks, read once per window into the in-memory results (a check made in this window is kept over a saved one). */
function restoreChecks(store: unknown, profiles: Array<{ id: string }>): void {
  if (checksRestored) return;
  checksRestored = true;
  try {
    for (const [id, saved] of new AccountCheckStore(store).load(profiles.map((profile) => profile.id))) if (!checkResults.has(id)) checkResults.set(id, saved);
  } catch { /* nothing saved can be read: every account shows "not checked yet" */ }
}

export function observationsFor(profiles: Array<{ id: string }>): Map<string, { identity: unknown }> {
  const observed = new Map<string, { identity: unknown }>();
  for (const profile of profiles) {
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
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
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

/** Opens the token usage log of one account (issue #294). */
class UsageLogItem extends vscode.TreeItem {
  constructor(accountId: string) {
    super('Token usage log', vscode.TreeItemCollapsibleState.None);
    this.description = 'open';
    this.tooltip = 'Opens the recorded token usage of this account. Only providers with a real reading source are recorded.';
    this.iconPath = new vscode.ThemeIcon('graph');
    this.command = { command: 'multiagentSystem.usage.showLog', title: 'Show token usage log', arguments: [{ id: accountId }] };
  }
}

type AccountTreeItem = AccountItem | AccountMessage | SessionItem | UsageLogItem;

// Fired whenever the accounts' rows are drawn again: an account added, changed, removed or checked (#357). The Workbench and the side
// bar listen, so a new account or a finished sign-in check shows there without waiting for an agent to change.
const accountsChanged = new vscode.EventEmitter<void>();
export const onDidChangeAccounts = accountsChanged.event;

class AccountTree implements vscode.TreeDataProvider<AccountTreeItem> {
  private readonly changed = new vscode.EventEmitter<AccountTreeItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  refresh(): void { this.changed.fire(undefined); accountsChanged.fire(); }
  getTreeItem(item: AccountTreeItem): vscode.TreeItem { return item; }

  async getChildren(item?: AccountTreeItem): Promise<AccountTreeItem[]> {
    // An account row expands into its quota: the limits the person set, the current readings (used, remaining, window, read time,
    // source or why it cannot be read) and a link to the usage log. A reading that cannot be read says why; it is never shown as 0.
    if (item instanceof AccountItem) {
      const lines = await limitLines(item.id as string, () => sessions?.list() ?? []);
      return [...lines.map((line) => new AccountMessage(line)), new UsageLogItem(item.id as string)];
    }
    if (item) return [];
    const liveSessions = sessions?.list() ?? [];
    const result = await accountService(() => sessions?.list() ?? []);
    if (!result.ok) return [new AccountMessage(result.message), ...liveSessions.map((entry) => new SessionItem(entry.id, entry.name, entry.provider, entry.accountProfileId, entry.stateLabel, entry.terminalOpen))];
    const loaded = result.service.list();
    if (!loaded.ok) return [new AccountMessage(loaded.message), ...liveSessions.map((entry) => new SessionItem(entry.id, entry.name, entry.provider, entry.accountProfileId, entry.stateLabel, entry.terminalOpen))];
    const rows: AccountTreeItem[] = [];
    if (loaded.profiles.length === 0) rows.push(new AccountMessage('No account profiles. Use Create Profile to add one.'));
    restoreChecks(result.store, loaded.profiles);
    const described = describeAccounts({ profiles: loaded.profiles, observations: observationsFor(loaded.profiles), context: { repoRoot: result.store.repoRoot } });
    const limitText = await Promise.all(loaded.profiles.map((profile: any) => limitLines(profile.id, () => sessions?.list() ?? [])));
    const gateStates = await Promise.all(loaded.profiles.map((profile: any) => currentGateState(profile.id, () => sessions?.list() ?? [])));
    const quotas = await Promise.all(loaded.profiles.map((profile: any) => quotaDetail(profile.id, () => sessions?.list() ?? []).catch(() => null)));
    const labels0 = new Map<string, string>(loaded.profiles.map((profile: any) => [profile.id, profile.label]));
    const now = new Date();
    const summaries: Array<{ signedIn: boolean | null; attention: boolean }> = [];
    const accountRows = loaded.profiles.map((profile: any, index: number) => {
      const status = described[index];
      const provider = builtIn.get(profile.provider)?.label ?? profile.provider;
      // #352: which account it is (e-mail and organization, this window only), plan, sign-in with its check time, and usage.
      const who = identitySummary({ check: checkResults.get(profile.id), display: checkDisplays.get(profile.id), now, checking: checking.has(profile.id) });
      const usage = quotaSummary(quotas[index], now);
      const duplicate = duplicateLine((status.duplicateOf ?? []).map((other: string) => labels0.get(other) ?? other));
      const issues = [...who.lines, `Usage: ${usage.text}`, ...(duplicate ? [duplicate] : []), ...status.issues.map((issue: { hint: string }) => issue.hint)];
      if (builtIn.capability(profile.provider, 'accountIsolation') !== 'verified') issues.push('Account isolation is not verified for this provider on this machine.');
      issues.push(...limitText[index]);
      const gateState = gateStates[index];
      const attention = who.attention || usage.attention || duplicate !== null || status.health === 'attention';
      summaries.push({ signedIn: who.signedIn, attention });
      const item = new AccountItem(profile.id, profile.label, provider, attention ? 'needs attention' : status.health, '', issues, gateState?.action ?? null);
      const policyLine = limitText[index][0] ?? 'Limits: could not be read.';
      const limits = policyLine.startsWith('Limits: none set.') ? 'limits not set' : policyLine.startsWith('Limits: could not be read.') ? 'limits unknown' : 'limits set';
      item.description = [provider, who.text, usage.text.startsWith('usage') ? usage.text : `usage ${usage.text}`, limits, ...(duplicate ? ['DUPLICATE ACCOUNT'] : [])].join(' · ');
      if (gateState?.action === 'block') item.description += ' · BLOCKED NOW';
      else if (gateState?.action === 'confirm') item.description += ' · needs confirmation';
      else if (gateState?.action === 'warn') item.description += ' · near limit';
      return item;
    });
    if (loaded.profiles.length > 0) rows.push(new AccountMessage(accountsOverview(summaries)));
    rows.push(...accountRows);
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

/**
 * The accounts at a glance, for the side bar's one line (#357): how many, how many signed in, how many need the person. The same
 * judgement as the Accounts rows (sign-in, usage that needs a step, a duplicate, an unhealthy profile). Unknown when unreadable.
 */
export async function accountsAtAGlance(): Promise<{ ok: true; total: number; signedIn: number; attention: number } | { ok: false }> {
  try {
    const result = await accountService(() => sessions?.list() ?? []);
    if (!result.ok) return { ok: false };
    const loaded = result.service.list();
    if (!loaded.ok) return { ok: false };
    restoreChecks(result.store, loaded.profiles);
    const described = describeAccounts({ profiles: loaded.profiles, observations: observationsFor(loaded.profiles), context: { repoRoot: result.store.repoRoot } });
    const quotas = await Promise.all(loaded.profiles.map((profile: any) => quotaDetail(profile.id, () => sessions?.list() ?? []).catch(() => null)));
    let signedIn = 0;
    let attention = 0;
    loaded.profiles.forEach((profile: any, index: number) => {
      const who = identitySummary({ check: checkResults.get(profile.id), display: checkDisplays.get(profile.id), checking: checking.has(profile.id) });
      const usage = quotaSummary(quotas[index], new Date());
      if (who.signedIn === true) signedIn += 1;
      if (who.attention || usage.attention || (described[index].duplicateOf ?? []).length > 0 || described[index].health === 'attention') attention += 1;
    });
    return { ok: true, total: loaded.profiles.length, signedIn, attention };
  } catch { return { ok: false }; }
}

/** The plan the CLI reported in this account's last sign-in check (#352: Free, Pro, Max, Team, Enterprise), or null. */
export function accountPlan(profileId: string): string | null {
  const plan = checkResults.get(profileId)?.identity?.plan?.value;
  const labels: Record<string, string> = { free: 'Free', pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise' };
  return typeof plan === 'string' && Object.hasOwn(labels, plan) ? labels[plan] : null;
}

/** The e-mail address the CLI reported for an account in this window's last check (#357 cards), or null. Memory only, never stored. */
export function accountEmail(profileId: string): string | null {
  return checkDisplays.get(profileId)?.email ?? null;
}

// Where the wizard makes account folders (~/multiagent-accounts/…) and how it opens the sign-in terminal. Only the extension's own
// host tests replace them, so a test never makes a folder in the real home or runs a real sign-in.
let accountHome = (): string => os.homedir();
let signInOpener: ((provider: string, profile: any, env: Record<string, string | null>) => { done: Promise<void> }) | undefined;
export function setAddAccountSeamsForTests(seams: { home?: string; openSignIn?: (provider: string, profile: any, env: Record<string, string | null>) => { done: Promise<void> } } | undefined): void {
  if (!isExtensionTestMode()) throw new Error('This is only exposed in Extension Host tests.');
  accountHome = seams?.home ? () => seams.home as string : () => os.homedir();
  signInOpener = seams?.openSignIn;
}

/**
 * Add Claude Code Account / Add Codex Account (#352): one wizard from a name to a signed-in account with its e-mail, plan and usage.
 * The person types a name and confirms once a list of everything it will do; see add-account.js for the steps. It takes no
 * argument but the provider, so no caller can choose the folder or skip the confirmation.
 */
async function addAccountWizard(provider: 'claude' | 'codex'): Promise<unknown> {
  const accounts = await accountService(() => sessions?.list() ?? []);
  if (!accounts.ok) { void vscode.window.showErrorMessage(accounts.message); return { ok: false, reason: 'storage' }; }
  const repoRoot = (accounts.store as { repoRoot: string }).repoRoot;
  const listed = accounts.service.list();
  const profiles = listed.ok ? listed.profiles : [];
  const providerLabel = provider === 'claude' ? 'Claude Code' : 'Codex';
  let label = '';
  // The folders made for this account, so they can be removed again if the account cannot be saved.
  let madeFolders: unknown[] = [];
  const result = await addAccountFlow.addAccount(provider, {
    askLabel: async () => {
      const typed = await vscode.window.showInputBox({ prompt: `A name for this ${providerLabel} account (shown only on this computer)`, placeHolder: 'Work, Personal, Research…', ignoreFocusOut: true, validateInput: (value) => { const checked = addAccountFlow.checkLabel(value); return checked.ok ? undefined : checked.message; } });
      if (typed !== undefined) label = typed.trim();
      return typed;
    },
    suggest: (name: string) => suggestFolder({ homeDir: accountHome(), provider, label: name }).dir,
    confirm: async (lines: string[]) => (await vscode.window.showInformationMessage(`Add the ${providerLabel} account “${label}”?`, { modal: true, detail: lines.join('\n') }, 'Add and Sign In')) === 'Add and Sign In',
    createFolder: (name: string) => {
      const made = createRecommendedFolder({ provider, label: name, suggestion: suggestFolder({ homeDir: accountHome(), provider, label: name }), profiles, context: { repoRoot, homeDir: accountHome() } });
      madeFolders = made.madeFolders ?? [];
      return made.ok && made.dir ? { ok: true, dir: made.dir } : { ok: false, message: (made.items ?? []).map((item) => `${item.message} ${item.fix}`).join(' ') || 'The recommended folder could not be created.' };
    },
    createProfile: ({ label: name, dir }: { label: string; dir: string }) => {
      const created = accounts.service.create({ provider, label: name, configDir: dir });
      return created.ok ? { ok: true, profile: created.profile } : { ok: false, message: errorFor(created) };
    },
    discardFolder: () => discardCreated(madeFolders),
    statusLine: async (profile: any) => configureStatusLineWizard(profile, { consent: true, action: 'enable', extensionPath: extensionContext?.extensionPath }),
    hooks: async (profile: any) => configureHooksWizard(profile, { consent: true, action: 'enable', extensionPath: extensionContext?.extensionPath }),
    openSignIn: async (profile: any) => {
      const prepared = await launchEnvironment(profile.id, provider, () => sessions?.list() ?? []);
      if (!prepared.ok) return { ok: false, message: prepared.message };
      if (signInOpener) return { ok: true, done: signInOpener(provider, profile, prepared.env).done };
      const opened = openLoginTerminal(provider, profile, prepared.env);
      // Done when the person says so or closes the terminal, whichever comes first.
      const done = new Promise<void>((resolve) => {
        const watcher = vscode.window.onDidCloseTerminal((closed) => { if (closed === opened.terminal) { watcher.dispose(); resolve(); } });
        void vscode.window.showInformationMessage(`Sign in to ${providerLabel} in the terminal that opened for “${label}”. Then check it here, or just close the terminal.`, 'I have signed in — check now').then((answer) => { if (answer) { watcher.dispose(); resolve(); } });
      });
      return { ok: true, done };
    },
    // Done only when the CLI says this account is signed in; a check that ran but found no sign-in says so.
    check: async (profile: any) => {
      const checked = await runCheck(accounts, profile);
      const signedIn = checked.ok && checked.identity?.loggedIn === true;
      return { ok: signedIn, reason: signedIn ? 'signed in' : checked.ok ? 'not signed in yet' : checked.reason };
    }
  });
  currentTree?.refresh();
  const said = addAccountFlow.summarize(provider, label, result);
  if (said) void (said.level === 'info' ? vscode.window.showInformationMessage(said.text) : said.level === 'warning' ? vscode.window.showWarningMessage(said.text) : vscode.window.showErrorMessage(said.text));
  return { ok: result.ok, cancelled: result.cancelled === true, steps: result.steps.map((step) => ({ step: step.step, ok: step.ok })) };
}

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

/**
 * Asks the profile's CLI who is signed in right now, with the same check the person can run by hand. A
 * launch uses it to compare with what the profile was verified as. Any failure reads as "could not tell".
 */
async function probeIdentity(profileId: string): Promise<unknown> {
  const result = await accountService(() => sessions?.list() ?? []);
  if (!result.ok) return null;
  const loaded = result.service.get(profileId);
  if (!loaded.ok) return null;
  const repoRoot = (result.store as { repoRoot: string }).repoRoot;
  const prepared = await launchEnvironment(loaded.profile.id, loaded.profile.provider, () => sessions?.list() ?? []);
  if (!prepared.ok) return null;
  const { display: _display, ...outcome } = await checkAccountIdentity({ profile: loaded.profile, context: { repoRoot }, env: childEnvironment(prepared.env), runner: identityRunner });
  return outcome;
}

export function registerAccountCommands(context: vscode.ExtensionContext, sessionCommands: SessionCommands): void {
  extensionContext = context;
  sessions = sessionCommands;
  setIdentityProbe(probeIdentity);
  context.subscriptions.push({ dispose: () => setIdentityProbe(undefined) });
  const tree = new AccountTree();
  currentTree = tree;
  // Every account that has a check is checked once when the window opens, so the view says who is signed in (#352).
  setTimeout(() => { void checkAllOnStart().catch(() => undefined); }, 1500);
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
    vscode.commands.registerCommand(ACCOUNT_COMMANDS.configureStatusLine, (value?: unknown) => configureStatusLine(value)),
    vscode.commands.registerCommand(ACCOUNT_COMMANDS.configureHooks, (value?: unknown) => configureHooks(value)),
    // No argument is read: the name, the folder and the confirmation come from the wizard's own windows.
    vscode.commands.registerCommand(ACCOUNT_COMMANDS.addClaude, () => addAccountWizard('claude')),
    vscode.commands.registerCommand(ACCOUNT_COMMANDS.addCodex, () => addAccountWizard('codex'))
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
  const label = await vscode.window.showInputBox({ prompt: 'Account label (shown only on this machine)', placeHolder: 'Work, Personal, Research…', ignoreFocusOut: true, validateInput: (value) => value.trim() ? undefined : 'Enter a label.' });
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
  // #352: who the account is, its usage, a duplicate, and which agents use it, at the top.
  const who = identitySummary({ check: checked, display: checkDisplays.get(id), checking: checking.has(id) });
  const usage = quotaSummary(await quotaDetail(id, () => sessions?.list() ?? []).catch(() => null));
  const allProfiles = result.service.list();
  const labelOf = new Map<string, string>(allProfiles.ok ? allProfiles.profiles.map((other: any) => [other.id, other.label]) : []);
  const duplicate = duplicateLine((described.duplicateOf ?? []).map((other: string) => labelOf.get(other) ?? other));
  const users = (sessions?.list() ?? []).filter((entry) => entry.accountProfileId === id);
  const lines = [
    `Account profile: ${profile.label}`,
    ...who.lines,
    `Usage: ${usage.text}`,
    ...(duplicate ? [duplicate] : []),
    users.length === 0 ? 'Agents using this account: none right now.' : `Agents using this account: ${users.map((entry) => `${entry.codename ? `${entry.codename} · ` : ''}${entry.name} (${entry.stateLabel})`).join('; ')}`,
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
    })(), (() => {
      const info = inspectHookConfig(profile.configDir, getHookBridgeScriptPath(extensionContext?.extensionPath));
      if (info.status === 'active') return 'Hook bridge: configured (session state comes from the CLI\'s own hooks)';
      if (info.status === 'partial') return 'Hook bridge: partly configured (run Configure Claude Hook Bridge to review it)';
      if (info.status === 'unreadable') return `Hook bridge: cannot be checked (${info.reason ?? 'settings unreadable'})`;
      return 'Hook bridge: not configured (use Configure Claude Hook Bridge)';
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

const { RoleStore } = require('../roles/role-store') as { RoleStore: new (store: unknown) => unknown };
const { describeGroups, removeProfileFlow } = require('../roles/profile-usage') as {
  describeGroups(groups: Array<{ name: string }>): string;
  removeProfileFlow(input: {
    service: { remove(id: string, options?: { allowHistoricalReferences?: boolean }): Promise<{ ok: boolean; code?: string }> };
    roleStore: unknown;
    profileId: string;
    ui: { confirmRemove(usedBy: Array<{ name: string }>, button: string): Promise<boolean>; confirmHistorical(): Promise<boolean> };
  }): Promise<{ outcome: 'roles-unreadable' | 'cancelled' } | { outcome: 'error'; code: string } | { outcome: 'removed'; cleared: number; failed: number; rolesUnknown: boolean }>;
};

async function remove(value: unknown, tree: AccountTree): Promise<void> {
  let profileId = selectedId(value);
  const profile = profileId ? undefined : await chooseProfile();
  profileId ??= profile?.id;
  if (!profileId) return;
  const result = await accountService(() => sessions?.list() ?? []);
  if (!result.ok) { void vscode.window.showErrorMessage(result.message); return; }
  const current = result.service.get(profileId);
  if (!current.ok) { void vscode.window.showErrorMessage(errorFor(current)); tree.refresh(); return; }
  // Role groups that name this profile as their default would keep pointing at an account that no longer exists.
  // If they cannot be read, nobody can say none does: nothing is removed.
  const baseDetail = 'This removes only the extension profile. It keeps the CLI configuration folder and does not delete CLI login data.';
  const outcome = await removeProfileFlow({
    service: result.service,
    roleStore: new RoleStore(result.store),
    profileId,
    ui: {
      confirmRemove: async (usedBy, button) => {
        const detail = usedBy.length > 0
          ? `${baseDetail}\n\n${usedBy.length === 1 ? 'This role group uses' : `These ${usedBy.length} role groups use`} the account as ${usedBy.length === 1 ? 'its' : 'their'} default: ${describeGroups(usedBy)}. Their default account will be cleared; you can choose another account when you create an agent from them.`
          : baseDetail;
        return (await vscode.window.showWarningMessage(`Remove account profile “${current.profile.label}”?`, { modal: true, detail }, button)) === button;
      },
      confirmHistorical: async () => (await vscode.window.showWarningMessage('Earlier sessions still refer to this profile.', { modal: true, detail: 'Those sessions will no longer be reopenable with this account profile. The CLI folder and sign-in data will remain.' }, 'Delete Anyway')) === 'Delete Anyway'
    }
  });
  if (outcome.outcome === 'roles-unreadable') { void vscode.window.showErrorMessage('Role groups could not be read, so it is not known whether any of them uses this account as its default. Nothing was removed. Check Private Storage diagnostics and try again.'); return; }
  if (outcome.outcome === 'error') { void vscode.window.showErrorMessage(errorFor({ code: outcome.code })); return; }
  if (outcome.outcome !== 'removed') return;
  tree.refresh();
  const { cleared, failed } = outcome;
  if (failed > 0 || outcome.rolesUnknown) {
    void vscode.window.showWarningMessage(outcome.rolesUnknown
      ? 'Account profile removed, but role groups could not be read afterwards, so a role group that names it as the default may remain; starting an agent from it is refused until you edit the role group and choose an available account.'
      : `Account profile removed. ${failed} role group${failed === 1 ? '' : 's'} still name${failed === 1 ? 's' : ''} it as the default and could not be updated; starting an agent from ${failed === 1 ? 'it' : 'them'} is refused until you edit the role group and choose an available account.`);
    return;
  }
  void vscode.window.showInformationMessage(`Account profile removed. Its CLI configuration folder was kept.${cleared > 0 ? ` The default account of ${cleared} role group${cleared === 1 ? '' : 's'} was cleared.` : ''}`);
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

// The runner of the provider's status command; only the extension's own host tests replace it (a synthetic `claude auth status`).
let identityRunner: typeof runCommand = runCommand;
export function setIdentityRunnerForTests(runner: typeof runCommand | undefined): void {
  if (!isExtensionTestMode()) throw new Error('This is only exposed in Extension Host tests.');
  identityRunner = runner ?? runCommand;
}

/**
 * Checks one account with no window of its own: runs the status command in the profile's environment, keeps the e-mail address and
 * organization in memory only, saves the rest (account-checks.js) and refreshes the view. Returns the result without the display part.
 */
async function runCheck(accounts: any, profile: any): Promise<CheckResult> {
  const repoRoot = (accounts.store as { repoRoot: string }).repoRoot;
  checking.add(profile.id);
  currentTree?.refresh();
  let outcome: CheckResult & { display?: Display };
  try {
    const prepared = await launchEnvironment(profile.id, profile.provider, () => sessions?.list() ?? []);
    outcome = !prepared.ok
      ? { ok: false, state: 'unknown', reason: 'profile-rejected', checkedAt: new Date().toISOString(), source: null, identity: null }
      : await checkAccountIdentity({ profile, context: { repoRoot }, env: childEnvironment(prepared.env), runner: identityRunner });
  } finally { checking.delete(profile.id); }
  const { display, ...result } = outcome;
  checkResults.set(profile.id, result);
  if (display && (display.email || display.organization)) checkDisplays.set(profile.id, { email: display.email ?? null, organization: display.organization ?? null });
  else checkDisplays.delete(profile.id);
  try { new AccountCheckStore(accounts.store).save(profile.id, result); } catch { /* the view still shows this window's result */ }
  // What a successful check verified is saved in the shared private store, so the profile's account group
  // is the same in every window and after a restart. A failed or signed-out check never removes it.
  if (result.ok && result.identity) recordVerifiedIdentity(accounts.store, profile.id, result.identity, new Date());
  currentTree?.refresh();
  return result;
}

/** Checks every account whose provider has a check, once, when the window opens (#352), one after another and without windows. */
async function checkAllOnStart(): Promise<void> {
  const accounts = await accountService(() => sessions?.list() ?? []);
  if (!accounts.ok) return;
  const listed = accounts.service.list();
  if (!listed.ok) return;
  restoreChecks(accounts.store, listed.profiles);
  for (const profile of listed.profiles) {
    if (!Object.hasOwn(CHECKS, profile.provider) || process.platform === 'win32') continue;
    try { await runCheck(accounts, profile); } catch { /* one account that cannot be checked does not stop the others */ }
  }
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
  const run = () => runCheck(result, loaded.profile);
  const outcome = interactive
    ? await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Checking sign-in for “${loaded.profile.label}”…` }, run)
    : await run();
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


/**
 * Configures or removes the Claude Code hook bridge (session state from the CLI's own hooks). Interactive
 * only: `interactive: false`, `consent` and `action` are honoured in extension test mode alone, so no other
 * extension or command caller can write to a settings.json without the person seeing the dialog.
 */
export async function configureHooks(value: unknown): Promise<unknown> {
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

  const hookUi: HookUi = {
    async confirmEnable(label, settingsPath, command, events) {
      const answer = await vscode.window.showInformationMessage(
        `Enable Claude hook bridge for “${label}”?`,
        {
          modal: true,
          detail: `${describeHookEnable(label)}\n\nFile: ${settingsPath}\nCommand added to each of these events: ${events.join(', ')}\n${command}\n\nNot verified against a real Claude Code CLI yet.`
        },
        'Enable Hook Bridge'
      );
      return answer === 'Enable Hook Bridge';
    },
    async promptActiveChoice(label) {
      const picked = await vscode.window.showQuickPick([
        { label: '$(check) Keep Hook Bridge Enabled', description: 'Session state from the CLI\'s own hooks', value: 'keep' as const },
        { label: '$(trash) Disable / Remove Hook Bridge', description: 'Remove only the hook entries Multiagent added', value: 'disable' as const }
      ], { placeHolder: `Hook Bridge is active for “${label}”` });
      return picked?.value;
    },
    async confirmDisable(label) {
      const confirm = await vscode.window.showWarningMessage(
        `Remove the hook bridge from “${label}”?`,
        { modal: true, detail: 'This removes only the hook entries Multiagent added to settings.json. Your own hooks and other settings stay untouched.' },
        'Remove Hook Bridge'
      );
      return confirm === 'Remove Hook Bridge';
    },
    showInfo(message) { void vscode.window.showInformationMessage(message); },
    showError(message) { void vscode.window.showErrorMessage(message); }
  };

  // In test mode a caller that asks for non-interactive operation gets no UI, as for the status line.
  const outcome = await configureHooksWizard(loaded.profile, {
    consent,
    action,
    extensionPath: extensionContext?.extensionPath,
    ui: interactive ? hookUi : undefined
  });
  currentTree?.refresh();
  return outcome;
}
