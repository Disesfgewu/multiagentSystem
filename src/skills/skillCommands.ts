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

const { runInstall, runRemove } = require('./workspace-skills') as {
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

async function chooseWorkspace(interactive: boolean): Promise<string | undefined> {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file');
  if (folders.length <= 1 || !interactive) return folders[0]?.uri.fsPath;
  const picked = await vscode.window.showQuickPick(
    folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
    { placeHolder: 'Choose the workspace folder for agent skills' }
  );
  return picked?.folder.uri.fsPath;
}

export function registerSkillCommands(context: vscode.ExtensionContext): vscode.Disposable {
  const skillsRoot = path.join(context.extensionPath, 'resources', 'agent-skills');
  const templatesRoot = path.join(context.extensionPath, 'resources', 'agent-templates');
  // Only the Extension Test mode may pass interactive:false; everywhere else the modal is required.
  const isTestMode = context.extensionMode === vscode.ExtensionMode.Test;
  // Private extension storage, keyed by workspace folder path; never written into the workspace.
  const store: Store = context.globalState;

  const install = async (arg?: CommandArg) => {
    const interactive = !(isTestMode && arg?.interactive === false);
    const workspaceRoot = await chooseWorkspace(interactive);
    return runInstall({ isTestMode, arg, workspaceRoot, skillsRoot, templatesRoot, store, ui });
  };
  const remove = async (arg?: CommandArg) => {
    const interactive = !(isTestMode && arg?.interactive === false);
    const workspaceRoot = await chooseWorkspace(interactive);
    return runRemove({ isTestMode, arg, workspaceRoot, store, ui });
  };

  const disposable = vscode.Disposable.from(
    vscode.commands.registerCommand(SKILL_COMMANDS.install, install),
    vscode.commands.registerCommand(SKILL_COMMANDS.remove, remove)
  );
  context.subscriptions.push(disposable);
  return disposable;
}
