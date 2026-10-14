import * as vscode from 'vscode';
import { WorktreeService } from '../projects/worktrees';
import { StorageHandle, StorageStatus, createStorageHandle, describeStorage, statusMessage } from './extensionStorage';

export const STORAGE_COMMANDS = {
  status: 'multiagentSystem.storage.status'
} as const;

let handle: StorageHandle | undefined;
let testContext: vscode.ExtensionContext | undefined;

/**
 * The private store and secret vault of this extension, for the other parts of it. Every
 * `use()` checks the data folder against the repositories that are open at that moment. It is
 * undefined until the extension has been activated.
 */
export function privateStorage(): StorageHandle | undefined {
  return handle;
}

/**
 * The real extension context, for the Extension Host test only. It is available only while the
 * editor runs in test mode and cannot be reached from a command or another extension.
 */
export function extensionContextForTests(): vscode.ExtensionContext {
  if (!testContext) throw new Error('The extension context is only available when the editor runs in test mode.');
  return testContext;
}

export function registerStorageCommands(context: vscode.ExtensionContext): void {
  testContext = context.extensionMode === vscode.ExtensionMode.Test ? context : undefined;
  handle = createStorageHandle({
    context,
    workspaceFolders: () => (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    // Only a trusted workspace is asked: Git can run programs named in a repository's own configuration.
    repositoryRoot: async (folder) => {
      if (!vscode.workspace.isTrusted) return null;
      const project = await WorktreeService.open(folder);
      return typeof project.root === 'string' ? project.root : null;
    }
  });

  context.subscriptions.push(
    // Shows whether private storage can be used and why not, as codes only: no path, no
    // contents. The secret storage is exercised only when the caller asks for it, because
    // a real backend (the operating system's secret store) can ask the user for permission.
    vscode.commands.registerCommand(STORAGE_COMMANDS.status, async (value?: unknown): Promise<StorageStatus> => {
      const probeSecrets = Boolean(value && typeof value === 'object' && (value as { probeSecrets?: unknown }).probeSecrets === true);
      const status = await describeStorage(handle as StorageHandle, { probeSecrets });
      if (!(value && typeof value === 'object' && (value as { interactive?: unknown }).interactive === false)) {
        const message = statusMessage(status);
        void (message.level === 'info' ? vscode.window.showInformationMessage(message.text) : vscode.window.showErrorMessage(message.text));
      }
      return status;
    })
  );
}
