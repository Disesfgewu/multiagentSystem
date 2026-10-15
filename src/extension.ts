import * as vscode from 'vscode';
import { registerSessionCommands, SessionCommands } from './sessions/sessionCommands';
import { registerWorktreeCommands } from './projects/worktreeCommands';
import { GROUP_NAMES, PROVIDERS, CliProvider, errorMessage, terminalTitle, validateTerminalName } from './agents';

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

  let first: vscode.Terminal | undefined;
  try {
    for (const name of GROUP_NAMES) {
      const terminal = vscode.window.createTerminal({
        name: terminalTitle(name),
        cwd,
        location: first
          ? { parentTerminal: first }
          : vscode.TerminalLocation.Editor
      });
      first = first ?? terminal;
      terminal.show(true);
    }
    first?.show();
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
  context.subscriptions.push(
    vscode.commands.registerCommand('multiagentSystem.openTerminalGroup', openTerminalGroup),
    vscode.commands.registerCommand('multiagentSystem.launchAgent', launchAgent)
  );
  sessions = registerSessionCommands(context);
  registerWorktreeCommands(context);
}

export function deactivate(): void {}
