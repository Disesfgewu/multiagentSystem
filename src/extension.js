'use strict';

const vscode = require('vscode');

const providers = [
  { label: 'Claude Code', executable: 'claude' },
  { label: 'Codex CLI', executable: 'codex' }
];

async function workspaceDirectory() {
  const folders = vscode.workspace.workspaceFolders || [];
  if (folders.length === 0) {
    vscode.window.showErrorMessage('Open a project folder before creating agent terminals.');
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0].uri;
  }
  const selected = await vscode.window.showWorkspaceFolderPick({
    placeHolder: 'Select the project for these terminals'
  });
  return selected && selected.uri;
}

async function openTerminalGroup() {
  const cwd = await workspaceDirectory();
  if (!cwd) return;

  const names = ['PM', 'Worker 1', 'Worker 2', 'Worker 3'];
  let first;
  try {
    for (const name of names) {
      const terminal = vscode.window.createTerminal({
        name: `Multiagent: ${name}`,
        cwd,
        location: first
          ? { parentTerminal: first }
          : vscode.TerminalLocation.Editor
      });
      first = first || terminal;
      terminal.show(true);
    }
    first.show();
  } catch (error) {
    vscode.window.showErrorMessage(`Could not create native terminals: ${error.message}`);
  }
}

async function launchAgent() {
  const cwd = await workspaceDirectory();
  if (!cwd) return;

  const provider = await vscode.window.showQuickPick(providers, {
    placeHolder: 'Choose the CLI to run in a native terminal'
  });
  if (!provider) return;

  const name = await vscode.window.showInputBox({
    prompt: 'Terminal name',
    value: provider.label,
    validateInput: value => value.trim() ? undefined : 'Enter a terminal name.'
  });
  if (!name) return;

  try {
    const terminal = vscode.window.createTerminal({
      name: `Multiagent: ${name.trim()}`,
      cwd,
      location: vscode.TerminalLocation.Editor
    });
    terminal.show();
    terminal.sendText(provider.executable, true);
  } catch (error) {
    vscode.window.showErrorMessage(`Could not launch ${provider.label}: ${error.message}`);
  }
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('multiagentSystem.openTerminalGroup', openTerminalGroup),
    vscode.commands.registerCommand('multiagentSystem.launchAgent', launchAgent)
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
