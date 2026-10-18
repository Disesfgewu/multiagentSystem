import * as path from 'node:path';
import * as vscode from 'vscode';

type Ui = {
  confirm(message: string, detail: string, button: string): Promise<boolean>;
  info(message: string): void;
  error(message: string): void;
};
type Store = { get(key: string): unknown; update(key: string, value: unknown): Thenable<void> | Promise<void> };
type CommandArg = { interactive?: boolean; includeTemplates?: boolean } | undefined;
type FlowDeps = { isTestMode: boolean; arg: CommandArg; workspaceRoot?: string; skillsRoot?: string; templatesRoot?: string; store: Store; ui: Ui };

const { runInstall, runRemove, runAutomaticInstall } = require('./workspace-skills') as {
  runAutomaticInstall(deps: { workspaceRoot: string; skillsRoot: string; store: Store; trusted: boolean; enabled: boolean; local: boolean }): Promise<any>;
  runInstall(deps: FlowDeps): Promise<any>;
  runRemove(deps: FlowDeps): Promise<any>;
};

export const SKILL_COMMANDS = {
  install: 'multiagentSystem.skills.install',
  remove: 'multiagentSystem.skills.remove'
} as const;

const ui: Ui = {
  async confirm(message, detail, button) {
    return (await vscode.window.showWarningMessage(message, { modal: true, detail }, button)) === button;
  },
  info(message) { void vscode.window.showInformationMessage(message); },
  error(message) { void vscode.window.showErrorMessage(message); }
};

const CANCELLED = Symbol('cancelled');
const cancelledResult = () => ({ ok: false, code: 'cancelled', message: 'No workspace folder was chosen. Nothing was changed.' });

async function chooseWorkspace(interactive: boolean): Promise<string | undefined | typeof CANCELLED> {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file');
  if (folders.length <= 1 || !interactive) return folders[0]?.uri.fsPath;
  const picked = await vscode.window.showQuickPick(
    folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
    { placeHolder: 'Choose the workspace folder for agent skills' }
  );
  return picked ? picked.folder.uri.fsPath : CANCELLED;
}

export function registerSkillCommands(context: vscode.ExtensionContext): vscode.Disposable {
  const skillsRoot = path.join(context.extensionPath, 'resources', 'agent-skills');
  const templatesRoot = path.join(context.extensionPath, 'resources', 'agent-templates');
  // Only the Extension Test mode may pass interactive:false; everywhere else the modal is required.
  const isTestMode = context.extensionMode === vscode.ExtensionMode.Test;
  // Private extension storage, keyed by workspace folder path; never written into the workspace.
  const store: Store = context.globalState;

  // Serialize automatic/manual work per folder, including its asynchronous private record update.
  const pending = new Map<string, Promise<unknown>>();
  function serial<T>(root: string | undefined, operation: () => Promise<T>): Promise<T> {
    const key = root ?? '';
    const result = (pending.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation);
    pending.set(key, result);
    void result.finally(() => { if (pending.get(key) === result) pending.delete(key); }).catch(() => undefined);
    return result;
  }

  // Only the user's own setting (or the shipped default) decides whether files are written into a
  // workspace. A repository's .vscode/settings.json must never be able to turn this back on after the
  // user turned it off, so workspace and folder values are ignored even if a client supplies them.
  const autoInstallEnabled = (): boolean => {
    const inspected = vscode.workspace.getConfiguration('multiagentSystem').inspect<boolean>('skills.autoInstall');
    const value = inspected?.globalValue ?? inspected?.defaultValue ?? true;
    return value === true;
  };

  const prepare = async (folder: vscode.WorkspaceFolder) => serial(folder.uri.fsPath, async () => {
    const result = await runAutomaticInstall({
      workspaceRoot: folder.uri.fsPath, skillsRoot, store,
      trusted: vscode.workspace.isTrusted,
      local: folder.uri.scheme === 'file',
      enabled: autoInstallEnabled()
    });
    if (!result.ok) ui.error(`Agent skills preparation failed: ${result.message}`);
    else if (result.written?.length) ui.info(`Prepared ${result.written.length} bundled skill files for Claude Code, Codex and OpenCode. Actual CLI loading is unverified.${result.conflicts?.length ? ` Skipped ${result.conflicts.length} existing files.` : ''}`);
    return result;
  });
  const prepareAll = async () => {
    for (const folder of vscode.workspace.workspaceFolders ?? []) await prepare(folder);
  };

  const install = async (arg?: CommandArg) => {
    const interactive = !(isTestMode && arg?.interactive === false);
    const workspaceRoot = await chooseWorkspace(interactive);
    if (workspaceRoot === CANCELLED) return cancelledResult();
    return serial(workspaceRoot, () => runInstall({ isTestMode, arg, workspaceRoot, skillsRoot, templatesRoot, store, ui }));
  };
  const remove = async (arg?: CommandArg) => {
    const interactive = !(isTestMode && arg?.interactive === false);
    const workspaceRoot = await chooseWorkspace(interactive);
    if (workspaceRoot === CANCELLED) return cancelledResult();
    return serial(workspaceRoot, () => runRemove({ isTestMode, arg, workspaceRoot, store, ui }));
  };

  const disposable = vscode.Disposable.from(
    vscode.commands.registerCommand(SKILL_COMMANDS.install, install),
    vscode.commands.registerCommand(SKILL_COMMANDS.remove, remove),
    vscode.workspace.onDidChangeWorkspaceFolders((event) => { void (async () => { for (const folder of event.added) await prepare(folder); })(); }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => { void prepareAll(); }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('multiagentSystem.skills.autoInstall')) void prepareAll();
    })
  );
  context.subscriptions.push(disposable);
  void prepareAll();
  return disposable;
}
