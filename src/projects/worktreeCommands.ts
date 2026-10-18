import * as vscode from 'vscode';
import {
  WorktreeCommandOptions,
  WorktreeController,
  WorktreeEntry,
  WorktreePickItem,
  WorktreeProject,
  WorktreeUi
} from './worktreeController';
import { WorktreeService } from './worktrees';
import { requireInteractive } from '../shared/testMode';

export const WORKTREE_COMMANDS = {
  list: 'multiagentSystem.worktrees.list',
  create: 'multiagentSystem.worktrees.create',
  remove: 'multiagentSystem.worktrees.remove'
} as const;

const OPEN_LABEL = 'Open in New Window';
const RELEASE_LABEL = 'Release Worktree';

const vscodeUi: WorktreeUi = {
  isTrusted: () => vscode.workspace.isTrusted,
  workspaceFolders: () => (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
  async pickProjectFolder(folders) {
    const picked = await vscode.window.showQuickPick(
      folders.map((folder) => ({ label: folder.split(/[\\/]/).filter(Boolean).pop() ?? folder, description: folder, folder })),
      { placeHolder: 'Select the project folder' }
    );
    return picked?.folder;
  },
  async pickWorktree(items: WorktreePickItem[], placeholder: string) {
    return vscode.window.showQuickPick(items, { placeHolder: placeholder, matchOnDescription: true, matchOnDetail: true });
  },
  askBranch: (validate) =>
    Promise.resolve(vscode.window.showInputBox({ prompt: 'New branch name for the worktree', validateInput: validate })),
  askTarget: (defaultPath, validate) =>
    Promise.resolve(
      vscode.window.showInputBox({ prompt: 'Folder for the new worktree (outside the repository)', value: defaultPath, validateInput: validate })
    ),
  async confirmRelease(entry: WorktreeEntry) {
    const answer = await vscode.window.showWarningMessage(
      `Release the worktree for ${entry.branch ?? 'this folder'}?`,
      {
        modal: true,
        detail:
          `${entry.path}\n\nIt is refused if it holds uncommitted, untracked or ignored files. The branch is kept. ` +
          'Stop any terminal or agent working in it first.'
      },
      RELEASE_LABEL
    );
    return answer === RELEASE_LABEL;
  },
  async offerOpen() {
    return (await vscode.window.showInformationMessage('Worktree created.', OPEN_LABEL)) === OPEN_LABEL;
  },
  async openFolder(folder) {
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folder), { forceNewWindow: true });
  },
  info: (message) => void vscode.window.showInformationMessage(message),
  error: (message) => void vscode.window.showErrorMessage(message)
};

export function registerWorktreeCommands(context: vscode.ExtensionContext): void {
  const controller = new WorktreeController({
    ui: vscodeUi,
    openProject: (folder) => WorktreeService.open(folder) as Promise<WorktreeProject>
  });
  // Invoked from the Command Palette the argument is undefined. Other callers (the Extension
  // Host smoke test) pass options; see WorktreeCommandOptions.
  const options = (value: unknown): WorktreeCommandOptions =>
    value && typeof value === 'object' ? (value as WorktreeCommandOptions) : {};
  context.subscriptions.push(
    // list only reads `git worktree list`; with `interactive: false` it skips the picker that opens a
    // folder, so honouring it outside tests opens nothing and asks nothing that would be skipped.
    vscode.commands.registerCommand(WORKTREE_COMMANDS.list, (value?: unknown) => controller.list(options(value))),
    // create writes a worktree and remove deletes one: outside test mode they always run interactively,
    // so remove's `confirmed: true` (honoured only when non-interactive) cannot skip the dialog.
    vscode.commands.registerCommand(WORKTREE_COMMANDS.create, (value?: unknown) => controller.create(requireInteractive(options(value)))),
    vscode.commands.registerCommand(WORKTREE_COMMANDS.remove, (value?: unknown) => controller.remove(requireInteractive(options(value))))
  );
}
