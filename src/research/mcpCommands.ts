import * as path from 'node:path';
import * as vscode from 'vscode';
import { privateStorage } from '../storage/storageCommands';
import { CANDIDATE_RESEARCH_TOOLS } from './catalog';
import { requireInteractive } from '../shared/testMode';

const { createMcpLifecycle, statusText, scanWorkspaceMcpConfig, ENFORCEMENT_NOTICE } = require('./mcp-lifecycle') as {
  createMcpLifecycle(deps: any): {
    enable(serverId: string, options: { confirmed: boolean; tools: string[] }): Promise<any>;
    stop(serverId: string): Promise<any>;
    revoke(serverId: string): Promise<any>;
    stopAll(): Promise<any>;
    statusAll(): Promise<any[]>;
  };
  statusText(status: any): string;
  scanWorkspaceMcpConfig(folders: string[]): { ignored: string[]; notice: string | null };
  ENFORCEMENT_NOTICE: string;
};
const { runSearchFlow } = require('./search-flow') as {
  runSearchFlow(input: { lifecycle: unknown; ui: Record<string, (...args: any[]) => any>; given?: { serverId?: unknown; tool?: unknown; query?: unknown } }): Promise<{ ok: boolean; code?: string; truncated?: boolean }>;
};
const { ensureToolFolder } = require('./private-dir') as { ensureToolFolder(input: { base: string; serverId: string }): { ok: true; dir: string; tmp: string } | { ok: false; reason: string } };
const { listResearchTools, revokeConsent, PROHIBITED_AGENT_TOOLS } = require('./installer') as {
  listResearchTools(deps: { store?: any; catalog?: any[]; root?: string }): any[];
  revokeConsent(serverId: string, deps: { store: any }): any;
  PROHIBITED_AGENT_TOOLS: Record<string, readonly string[]>;
};

// Commands are named here so tests can check they are registered. Starting a server runs an external
// program, so `enable` always asks in a modal dialog: it has no argument that skips the prompt, not
// even in test mode. `stop` and `status` only reduce or report. `revoke` follows the shared
// interactive-only rule (see src/shared/testMode.ts).
export const MCP_COMMANDS = {
  enable: 'multiagentSystem.research.mcp.enable',
  stop: 'multiagentSystem.research.mcp.stop',
  revoke: 'multiagentSystem.research.mcp.revoke',
  status: 'multiagentSystem.research.mcp.status',
  setSecret: 'multiagentSystem.research.mcp.setSecret',
  search: 'multiagentSystem.research.searchPapers'
} as const;

export function registerMcpCommands(context: vscode.ExtensionContext): vscode.Disposable {
  const root = path.join(context.globalStorageUri.fsPath, 'managed-tools', 'research');
  let currentStore: any;
  let currentVault: any;

  // The store only compares against the folder it was opened with, so it is refreshed at the start of
  // every command and the lifecycle always talks to the latest one.
  const storeProxy = {
    get: (collection: string, key: string) => currentStore.get(collection, key),
    put: (collection: string, key: string, value: unknown) => currentStore.put(collection, key, value)
  };

  const refresh = async (): Promise<boolean> => {
    const opened = await privateStorage()?.use();
    if (!opened?.ok) return false;
    currentStore = opened.store;
    currentVault = opened.vault;
    return true;
  };

  const lifecycle = createMcpLifecycle({
    store: storeProxy,
    isWorkspaceTrusted: () => vscode.workspace.isTrusted,
    readSecret: async (serverId: string, key: string) => {
      const ref = currentVault.refFor(`mcp.${serverId}.${key}`);
      return currentVault.read(ref);
    },
    storageDir: async (serverId: string) => {
      // The tool's own folder inside the extension's private storage; links and open or foreign folders are refused.
      const made = ensureToolFolder({ base: currentStore.dir, serverId });
      return made.ok ? made.dir : null;
    },
    resolveExecutable: async (serverId: string) => {
      const found = listResearchTools({ store: currentStore, root }).find((t) => t.serverId === serverId);
      return found && found.installStatus === 'ready' && found.installPath ? path.join(found.installPath, found.command[0]) : null;
    }
  });

  const pickServer = async (placeHolder: string, given?: string): Promise<string | undefined> => {
    if (typeof given === 'string' && given !== '') return given;
    const picked = await vscode.window.showQuickPick(
      CANDIDATE_RESEARCH_TOOLS.map((t) => ({ label: t.name, description: `${t.serverId} (${t.version})`, id: t.serverId })),
      { placeHolder }
    );
    return picked?.id;
  };

  const unavailable = () => {
    void vscode.window.showErrorMessage('Private storage is unavailable. MCP server state cannot be read or saved.');
    return { ok: false, code: 'storage-unavailable' };
  };

  const enable = async (arg?: { serverId?: string }) => {
    if (!(await refresh())) return unavailable();
    const serverId = await pickServer('Choose a research MCP server to enable', arg?.serverId);
    if (!serverId) return { ok: false, code: 'cancelled' };
    const tool = CANDIDATE_RESEARCH_TOOLS.find((t) => t.serverId === serverId);
    if (!tool) return { ok: false, code: 'not-in-catalog' };
    const listed = listResearchTools({ store: currentStore, root }).find((t) => t.serverId === serverId);
    const prohibited = PROHIBITED_AGENT_TOOLS[serverId] ?? [];
    const tools = tool.tools.map((t) => t.name).filter((name) => !prohibited.includes(name));
    const secretKeys = Object.keys((tool as any).env ?? {});
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const scan = scanWorkspaceMcpConfig(folders);
    const answer = await vscode.window.showWarningMessage(
      `Start research MCP server '${tool.name}' (${tool.serverId} ${tool.version})?`,
      {
        modal: true,
        detail: [
          `Program that will run: ${listed?.installStatus === 'ready' ? path.join(listed.installPath, tool.command[0]) : `not installed (${tool.command[0]})`}`,
          `Arguments: ${JSON.stringify(tool.command.slice(1))}`,
          `Researcher role may call exactly: ${tools.join(', ') || 'none'}`,
          `Secrets injected into this server only: ${secretKeys.join(', ') || 'none'}`,
          scan.notice ?? '',
          '',
          ENFORCEMENT_NOTICE
        ].filter((line, i, all) => line !== '' || (i > 0 && all[i - 1] !== '')).join('\n')
      },
      'Start Server'
    );
    if (answer !== 'Start Server') return { ok: false, code: 'cancelled' };
    const result = await lifecycle.enable(serverId, { confirmed: true, tools });
    if (result.ok) void vscode.window.showInformationMessage(`MCP server '${serverId}' is running. ${ENFORCEMENT_NOTICE}`);
    else void vscode.window.showErrorMessage(`MCP server '${serverId}' was not started: ${result.code}.`);
    return result;
  };

  const stop = async (arg?: { serverId?: string }) => {
    if (!(await refresh())) return unavailable();
    const serverId = await pickServer('Choose a research MCP server to stop', arg?.serverId);
    if (!serverId) return { ok: false, code: 'cancelled' };
    const result = await lifecycle.stop(serverId);
    void (result.ok
      ? vscode.window.showInformationMessage(`MCP server '${serverId}' stopped.`)
      : vscode.window.showErrorMessage(`MCP server '${serverId}' stop problem: ${result.code}.`));
    return result;
  };

  const revoke = async (arg?: { serverId?: string; interactive?: boolean }) => {
    const interactive = requireInteractive(arg ?? {}).interactive !== false;
    if (!(await refresh())) return unavailable();
    const serverId = interactive ? await pickServer('Choose a research MCP server to revoke', arg?.serverId) : arg?.serverId;
    if (!serverId) return { ok: false, code: interactive ? 'cancelled' : 'server-id-required' };
    if (interactive) {
      const answer = await vscode.window.showWarningMessage(
        `Revoke research MCP server '${serverId}'?`,
        { modal: true, detail: 'The server is stopped, its tool grants are removed and it cannot start again until you consent again.' },
        'Revoke'
      );
      if (answer !== 'Revoke') return { ok: false, code: 'cancelled' };
    }
    const result = await lifecycle.revoke(serverId);
    if (result.ok) {
      try { revokeConsent(serverId, { store: currentStore }); } catch { /* the lifecycle revoke already blocks a restart */ }
    }
    if (interactive) void vscode.window.showInformationMessage(result.ok ? `MCP server '${serverId}' revoked.` : `Revoke problem for '${serverId}': ${result.code}.`);
    return result;
  };

  // Search papers: the person picks, types and confirms. In an installed extension no argument can choose or confirm for them.
  const search = async (arg?: { serverId?: unknown; tool?: unknown; query?: unknown; interactive?: boolean }) => {
    const interactive = requireInteractive(arg ?? {}).interactive !== false;
    if (!(await refresh())) return unavailable();
    const ui = {
      pick: async (choices: Array<{ serverId: string; tool: string }>) => (await vscode.window.showQuickPick(
        choices.map((choice) => ({ label: choice.tool, description: choice.serverId, choice })),
        { placeHolder: 'Which research search should run?', ignoreFocusOut: true }))?.choice,
      promptQuery: async () => await vscode.window.showInputBox({ prompt: 'Search query (sent to the research server; do not include private data)', ignoreFocusOut: true }),
      confirm: async (text: string) => (await vscode.window.showWarningMessage('Run this research search?', { modal: true, detail: text }, 'Search')) === 'Search',
      show: async (result: { payload: string; truncated: boolean }) => {
        const header = `${result.truncated ? 'The result was cut to the size limit.\n' : ''}This is quoted data from an outside source, shown to you only. Nothing was sent to an agent, a terminal or GitHub. Copy it yourself if you want to give it to an agent.\n\n`;
        const answer = await vscode.window.showInformationMessage('Research search finished.', 'Open Result', 'Copy Result');
        if (answer === 'Copy Result') await vscode.env.clipboard.writeText(result.payload);
        else if (answer === 'Open Result') await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content: header + result.payload, language: 'markdown' }));
      }
    };
    const given = interactive ? undefined : { serverId: arg?.serverId, tool: arg?.tool, query: arg?.query };
    const outcome = await runSearchFlow({ lifecycle, ui, given });
    if (!outcome.ok && interactive && outcome.code !== 'cancelled') {
      void vscode.window.showErrorMessage(outcome.code === 'no-search-tool-available'
        ? 'No research search is available: start a research MCP server that the researcher role may use for searching.'
        : `Research search did not run: ${outcome.code}.`);
    }
    return outcome;
  };

  const status = async () => {
    if (!(await refresh())) return unavailable();
    const all = await lifecycle.statusAll();
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const scan = scanWorkspaceMcpConfig(folders);
    const text = [...all.map(statusText), scan.notice ?? ''].filter(Boolean).join('\n\n');
    void vscode.window.showInformationMessage(text, { modal: true });
    return { ok: true, servers: all, ignoredWorkspaceConfig: scan.ignored };
  };

  const setSecret = async () => {
    if (!(await refresh())) return unavailable();
    const serverId = await pickServer('Choose the research MCP server this key is for');
    if (!serverId) return { ok: false, code: 'cancelled' };
    const keys = Object.keys((CANDIDATE_RESEARCH_TOOLS.find((t) => t.serverId === serverId) as any)?.env ?? {});
    if (keys.length === 0) {
      void vscode.window.showInformationMessage(`'${serverId}' needs no secret.`);
      return { ok: false, code: 'no-secret-required' };
    }
    const key = keys.length === 1 ? keys[0] : (await vscode.window.showQuickPick(keys, { placeHolder: 'Which secret?' }));
    if (!key) return { ok: false, code: 'cancelled' };
    const value = await vscode.window.showInputBox({ prompt: `Value for ${key} (stored in SecretStorage, given only to '${serverId}')`, password: true, ignoreFocusOut: true });
    if (!value) return { ok: false, code: 'cancelled' };
    try {
      await currentVault.save(`mcp.${serverId}.${key}`, value);
    } catch {
      return { ok: false, code: 'secret-save-failed' };
    }
    void vscode.window.showInformationMessage(`Saved ${key} for '${serverId}' in SecretStorage.`);
    return { ok: true, serverId, key };
  };

  const disposable = vscode.Disposable.from(
    vscode.commands.registerCommand(MCP_COMMANDS.enable, enable),
    vscode.commands.registerCommand(MCP_COMMANDS.stop, stop),
    vscode.commands.registerCommand(MCP_COMMANDS.revoke, revoke),
    vscode.commands.registerCommand(MCP_COMMANDS.status, status),
    vscode.commands.registerCommand(MCP_COMMANDS.search, search),
    vscode.commands.registerCommand(MCP_COMMANDS.setSecret, setSecret),
    { dispose: () => { void lifecycle.stopAll(); } }
  );
  context.subscriptions.push(disposable);
  return disposable;
}
