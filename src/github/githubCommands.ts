import * as vscode from 'vscode';
import { createFetchTransport, createGitHubReadAdapter } from '../../packages/github-read-adapter/src';
import { WorktreeService } from '../projects/worktrees';
import {
  Category,
  GitHubAdapter,
  GitHubReader,
  parseRepository,
  GitHubCommandOptions,
  GitHubController,
  GitHubUi,
  PickItem,
  SignInOutcome
} from './controller';
import { GitHubTree, GITHUB_TREE_COMMANDS, GITHUB_TREE_VIEW } from './githubTree';

export const GITHUB_COMMANDS = {
  browse: 'multiagentSystem.github.browse',
  openIssue: 'multiagentSystem.github.openIssue',
  openPullRequest: 'multiagentSystem.github.openPullRequest',
  openChecks: 'multiagentSystem.github.openChecks',
  pullRequestStatus: 'multiagentSystem.github.pullRequestStatus',
  signIn: 'multiagentSystem.github.signIn'
} as const;

// The only way this extension obtains a GitHub credential is the editor's own authentication
// provider. It is asked silently on each request (never prompting), is held in memory only for
// that request, and is not stored, logged or shown. The extension never reads a `gh` login, a
// CLI credential file or an environment variable.
//
// `repo` is the narrowest OAuth scope the editor's provider offers for reading private
// repositories; the scope itself also permits writes, which this extension never performs:
// the adapter only issues GET requests and one fixed GraphQL query. See docs/GITHUB_READ_INTEGRATION.md.
export const GITHUB_AUTH_PROVIDER = 'github';
export const GITHUB_SCOPES: readonly string[] = ['repo'];

async function sessionToken(): Promise<string | undefined> {
  const session = await vscode.authentication.getSession(GITHUB_AUTH_PROVIDER, [...GITHUB_SCOPES], { silent: true });
  return session?.accessToken;
}

/**
 * What the Extension Host test replaces. It is reachable only from code inside this extension
 * and only while the editor runs in test mode; a command argument can never select a transport
 * or a credential, so another extension cannot redirect where a token is sent.
 */
export interface TestOverrides {
  fetch?: typeof fetch;
  getToken?: () => Promise<string | undefined>;
  openExternal?: (url: string) => Promise<boolean>;
  onSessionChange?: (listener: () => void) => vscode.Disposable;
}

let testMode = false;
let overrides: TestOverrides = {};
let adapter: GitHubAdapter | undefined;
let testTree: GitHubTree | undefined;

export function githubTreeForTests(): GitHubTree {
  if (!testMode || !testTree) throw new Error('The GitHub tree is available only in Extension Host tests.');
  return testTree;
}

export function notifySessionChangedForTests(): void {
  if (!testMode) throw new Error('The session notification test hook is available only in Extension Host tests.');
  adapter?.clearCache?.();
  testTree?.refresh();
  void vscode.commands.executeCommand('multiagentSystem.reports.refresh');
  void vscode.commands.executeCommand('multiagentSystem.overview.refresh');
}

export function installTestOverrides(next: TestOverrides): void {
  if (!testMode) throw new Error('Test overrides are only available when the editor runs in test mode.');
  overrides = { ...next };
  adapter = undefined;
}

function getAdapter(): GitHubAdapter {
  if (!adapter) {
    adapter = createGitHubReadAdapter({
      transport: createFetchTransport(overrides.fetch ?? globalThis.fetch),
      getToken: overrides.getToken ?? sessionToken,
      userAgent: 'multiagent-system-vscode'
    }) as unknown as GitHubAdapter;
  }
  return adapter;
}

/** A read-only reader for one repository (`owner/name`), or null when the name is not valid. Used by the overview. */
export function githubReaderFor(repository: string): GitHubReader | null {
  const parsed = parseRepository(repository);
  return parsed ? getAdapter().useRepository(parsed) : null;
}

const isUserDecline = (error: unknown): boolean => error instanceof Error && /did not consent|cancel/i.test(error.message);

const vscodeUi: GitHubUi = {
  isTrusted: () => vscode.workspace.isTrusted,
  workspaceFolders: () => (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
  async pickProjectFolder(folders) {
    const picked = await vscode.window.showQuickPick(
      folders.map((folder) => ({ label: folder.split(/[\\/]/).filter(Boolean).pop() ?? folder, description: folder, folder })),
      { placeHolder: 'Select the project whose GitHub repository to use' }
    );
    return picked?.folder;
  },
  askRepository: (validate) =>
    Promise.resolve(vscode.window.showInputBox({
      prompt: 'GitHub repository (owner/name). This workspace has no GitHub origin to use.',
      validateInput: validate
    })),
  askNumber: (prompt, validate) => Promise.resolve(vscode.window.showInputBox({ prompt, validateInput: validate })),
  pickCategory: (items: PickItem<Category>[]) => Promise.resolve(vscode.window.showQuickPick(items, { placeHolder: 'What do you want to browse?' })),
  pickItem: <T>(items: PickItem<T>[], placeholder: string) =>
    Promise.resolve(vscode.window.showQuickPick(items, { placeHolder: placeholder, matchOnDescription: true, matchOnDetail: true })),
  withProgress: <T>(title: string, task: (signal: AbortSignal) => Promise<T>) =>
    Promise.resolve(vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: true },
      async (_progress, token) => {
        const controller = new AbortController();
        const subscription = token.onCancellationRequested(() => controller.abort());
        try {
          return await task(controller.signal);
        } finally {
          subscription.dispose();
        }
      }
    )),
  showSummary: (title, lines) => void vscode.window.showInformationMessage(title, { modal: true, detail: lines.join('\n') }),
  async openExternal(url) {
    if (overrides.openExternal) return overrides.openExternal(url);
    return vscode.env.openExternal(vscode.Uri.parse(url, true));
  },
  async signIn(): Promise<SignInOutcome> {
    try {
      const session = await vscode.authentication.getSession(GITHUB_AUTH_PROVIDER, [...GITHUB_SCOPES], { createIfNone: true });
      return session ? 'signed-in' : 'cancelled';
    } catch (error) {
      return isUserDecline(error) ? 'cancelled' : 'unavailable';
    }
  },
  info: (message) => void vscode.window.showInformationMessage(message),
  warn: (message) => void vscode.window.showWarningMessage(message),
  error: (message) => {
    if (message.includes('Sign In to GitHub')) {
      void vscode.window.showErrorMessage(message, 'Sign In to GitHub').then((action) => {
        if (action === 'Sign In to GitHub') {
          void vscode.commands.executeCommand(GITHUB_COMMANDS.signIn);
        }
      });
    } else {
      void vscode.window.showErrorMessage(message);
    }
  }
};

// Only these fields are taken from a command argument, and only with the right type.
function commandOptions(value: unknown): GitHubCommandOptions {
  if (!value || typeof value !== 'object') return {};
  const input = value as Record<string, unknown>;
  const options: GitHubCommandOptions = {};
  if (typeof input.interactive === 'boolean') options.interactive = input.interactive;
  if (typeof input.repository === 'string') options.repository = input.repository;
  if (input.kind === 'issues' || input.kind === 'pullRequests') options.kind = input.kind;
  if (typeof input.number === 'number') options.number = input.number;
  if (typeof input.open === 'boolean') options.open = input.open;
  return options;
}

export function registerGitHubCommands(context: vscode.ExtensionContext): void {
  testMode = context.extensionMode === vscode.ExtensionMode.Test;
  const controller = new GitHubController({
    ui: vscodeUi,
    adapter: getAdapter,
    resolveOriginRepository: async (folder) => {
      const project = await WorktreeService.open(folder);
      return typeof project.githubRepository === 'string' ? project.githubRepository : null;
    }
  });
  const tree = new GitHubTree(controller, getAdapter, GITHUB_COMMANDS.signIn);
  if (testMode) testTree = tree;
  const onSessionChanged = () => {
    adapter?.clearCache?.();
    tree.refresh();
    void vscode.commands.executeCommand('multiagentSystem.reports.refresh');
    void vscode.commands.executeCommand('multiagentSystem.overview.refresh');
  };

  context.subscriptions.push(
    vscode.authentication.onDidChangeSessions((event) => {
      if (event.provider.id === GITHUB_AUTH_PROVIDER) {
        onSessionChanged();
      }
    })
  );
  if (testMode && overrides.onSessionChange) {
    context.subscriptions.push(overrides.onSessionChange(onSessionChanged));
  }
  context.subscriptions.push(
    vscode.window.createTreeView(GITHUB_TREE_VIEW, { treeDataProvider: tree }),
    vscode.commands.registerCommand(GITHUB_TREE_COMMANDS.refresh, () => tree.refresh()),
    vscode.commands.registerCommand(GITHUB_TREE_COMMANDS.openItem, (value?: unknown) => tree.openItem(value)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => tree.refresh())
  );
  // Invoked from the Command Palette the argument is undefined. Other callers (the Extension
  // Host smoke test) pass options; see GitHubCommandOptions. These commands only read or open a
  // github.com page and have no confirmation, so `interactive: false` is not gated by test mode.
  context.subscriptions.push(
    vscode.commands.registerCommand(GITHUB_COMMANDS.browse, (value?: unknown) => controller.browse(commandOptions(value))),
    vscode.commands.registerCommand(GITHUB_COMMANDS.openIssue, (value?: unknown) => controller.openPage('issue', commandOptions(value))),
    vscode.commands.registerCommand(GITHUB_COMMANDS.openPullRequest, (value?: unknown) => controller.openPage('pullRequest', commandOptions(value))),
    vscode.commands.registerCommand(GITHUB_COMMANDS.openChecks, (value?: unknown) => controller.openPage('checks', commandOptions(value))),
    vscode.commands.registerCommand(GITHUB_COMMANDS.pullRequestStatus, (value?: unknown) => controller.pullRequestStatus(commandOptions(value))),
    vscode.commands.registerCommand(GITHUB_COMMANDS.signIn, async () => {
      const result = await controller.signIn();
      if (result.ok) tree.refresh();
      return result;
    })
  );
}
