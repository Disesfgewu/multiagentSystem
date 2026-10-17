import * as vscode from 'vscode';
import { registerSessionCommands, SessionCommands } from './sessions/sessionCommands';
import { registerWorktreeCommands } from './projects/worktreeCommands';
import { registerGitHubCommands } from './github/githubCommands';
import { registerStorageCommands } from './storage/storageCommands';
import { ACCOUNT_COMMANDS, ACCOUNT_VIEW, registerAccountCommands } from './accounts/accountCommands';
import { registerRoleCommands } from './roles/roleCommands';
import { registerBroadcastCommands } from './broadcast/commands';
import { registerOverview } from './overview/overviewView';
import { registerPlanView } from './plan/planView';
import { registerReports } from './reports/reportsView';
import { PROVIDERS, CliProvider, errorMessage, validateTerminalName } from './agents';
import { openTerminalGroup as openFourTerminalGroup } from './terminals/terminalGroup';
import { registerSetup } from './setup/setupView';

async function workspaceDirectory(): Promise<vscode.Uri | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showErrorMessage('Open a project folder before creating agent terminals.');
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0].uri;
  }
  const selected = await vscode.window.showWorkspaceFolderPick({
    placeHolder: 'Select the project for these terminals'
  });
  return selected?.uri;
}

async function openTerminalGroup(): Promise<void> {
  const cwd = await workspaceDirectory();
  if (!cwd) return;
  try {
    await openFourTerminalGroup(cwd);
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not create native terminals: ${errorMessage(error)}`);
  }
}

async function launchAgent(): Promise<void> {
  const cwd = await workspaceDirectory();
  if (!cwd) return;

  const choices = PROVIDERS.map((provider) => ({ label: provider.label, provider }));
  const picked = await vscode.window.showQuickPick(choices, {
    placeHolder: 'Choose the CLI to run in a native terminal'
  });
  if (!picked) return;
  const provider: CliProvider = picked.provider;

  const name = await vscode.window.showInputBox({
    prompt: 'Terminal name',
    value: provider.label,
    validateInput: validateTerminalName
  });
  if (!name) return;

  // The session is recorded, but the CLI is only *requested*: nothing here proves it is running.
  // Failures are reported to the user by the session layer itself.
  if (!sessions) {
    void vscode.window.showErrorMessage(`Could not launch ${provider.label}: sessions are not ready.`);
    return;
  }
  await sessions.launch({ interactive: true, provider: provider.executable, name, cwd: cwd.fsPath });
}

let sessions: SessionCommands | undefined;

export function activate(context: vscode.ExtensionContext): void {
  registerStorageCommands(context);
  registerSetup(context);
  context.subscriptions.push(
    vscode.commands.registerCommand('multiagentSystem.openTerminalGroup', openTerminalGroup),
    vscode.commands.registerCommand('multiagentSystem.launchAgent', launchAgent)
  );
  sessions = registerSessionCommands(context);
  registerAccountCommands(context, sessions);
  registerOverview(context, sessions);
  registerPlanView(context);
  registerReports(context);
  registerRoleCommands(context, sessions);
  registerBroadcastCommands(context);
  registerWorktreeCommands(context);
  registerGitHubCommands(context);
}

export function deactivate(): void {}
