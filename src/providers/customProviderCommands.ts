import * as vscode from 'vscode';
import { runCustomStart, rememberKey, CustomStartArgument } from './customStart';

const { readUserLevel } = require('../settings/user-level') as { readUserLevel(inspected: unknown): { value: unknown; ignoredScopes: string[] } };
const { customProvidersFrom } = require('./custom-providers') as {
  customProvidersFrom(raw: unknown): { providers: Array<{ id: string; label: string }>; rejected: Array<{ index: number; code: string }>; code: string | null };
};

export const CUSTOM_PROVIDER_COMMANDS = { show: 'multiagentSystem.providers.showCustom', start: 'multiagentSystem.providers.startCustom' } as const;
const CONFIRMED_KEY = 'customProviders.confirmed';
export const CUSTOM_PROVIDERS_SETTING = 'providers.custom';

/** What the user-level setting holds right now. Only the user's own value is read: a workspace value is ignored and counted. */
export function readCustomProviders(): { providers: Array<{ id: string; label: string }>; rejected: Array<{ index: number; code: string }>; code: string | null; ignoredScopes: string[] } {
  const inspected = vscode.workspace.getConfiguration('multiagentSystem').inspect(CUSTOM_PROVIDERS_SETTING);
  const read = readUserLevel(inspected);
  return { ...customProvidersFrom(read.value), ignoredScopes: read.ignoredScopes };
}

/** One readable summary. Ids are the person's own data; this is shown to them on screen and goes nowhere else. */
export function describeCustomProviders(state: ReturnType<typeof readCustomProviders>): string {
  const lines: string[] = [];
  if (state.code) lines.push(`The custom providers setting cannot be used (${state.code}). No custom provider is available.`);
  else if (state.providers.length === 0 && state.rejected.length === 0) lines.push('No custom providers are set in your user settings.');
  else lines.push(`${state.providers.length} custom provider${state.providers.length === 1 ? '' : 's'} read from your user settings: ${state.providers.map((provider) => provider.id).join(', ') || 'none'}. Nothing is started from this list yet, and every capability of a custom provider is unknown.`);
  for (const item of state.rejected) lines.push(`Entry ${item.index + 1} was rejected (${item.code}).`);
  if (state.ignoredScopes.length > 0) lines.push('Values of this setting in the workspace or a folder were ignored: only your user settings can choose what to run.');
  return lines.join('\n');
}

const START_MESSAGES: Record<string, string> = {
  'no-custom-providers': 'No custom providers are set in your user settings (multiagentSystem.providers.custom).',
  'workspace-untrusted': 'Trust this workspace first: a custom provider is not started in a workspace you have not trusted.',
  'folder-required': 'Open a single project folder first.',
  'provider-not-found': 'That custom provider is not in your user settings.',
  'executable-not-found': 'The program was not found on your PATH.',
  'executable-only-in-workspace': 'The only program with that name is inside this workspace, so it was not used. Install it somewhere else on your PATH.',
  'script-not-supported': 'On Windows only .exe and .com programs can be started (not .cmd or .bat).',
  'path-unavailable': 'PATH could not be read.',
  'executable-name-invalid': 'The program name is not valid.'
};

export function registerCustomProviderCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand(CUSTOM_PROVIDER_COMMANDS.start, async (arg?: CustomStartArgument) => {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    const outcome = await runCustomStart({
      arg,
      providers: readCustomProviders().providers as Array<{ id: string; label: string; executable: string; args: string[] }>,
      trusted: vscode.workspace.isTrusted,
      cwd: folders.length === 1 ? folders[0] : undefined,
      folders,
      ui: {
        pick: async (providers) => (await vscode.window.showQuickPick(providers.map((provider) => ({ label: provider.label, description: provider.id, id: provider.id })), { placeHolder: 'Which custom provider should start?', ignoreFocusOut: true }))?.id,
        confirm: async (label, detail) => (await vscode.window.showWarningMessage(`Start “${label}” in a terminal?`, { modal: true, detail }, 'Start')) === 'Start',
        launch: (label, launch) => {
          const terminal = vscode.window.createTerminal({ name: `Custom: ${label}`, shellPath: launch.shellPath, shellArgs: launch.shellArgs, cwd: launch.cwd, env: launch.env });
          terminal.show();
        }
      },
      state: {
        confirmed: () => { const kept = context.globalState.get<unknown>(CONFIRMED_KEY); return Array.isArray(kept) ? kept.filter((entry): entry is string => typeof entry === 'string') : []; },
        remember: (key) => { const kept = context.globalState.get<unknown>(CONFIRMED_KEY); void context.globalState.update(CONFIRMED_KEY, rememberKey(Array.isArray(kept) ? kept.filter((entry): entry is string => typeof entry === 'string') : [], key)); }
      }
    });
    if (!outcome.ok && outcome.code !== 'cancelled') void vscode.window.showErrorMessage(START_MESSAGES[outcome.code ?? ''] ?? `The custom provider did not start (${outcome.code}).`);
    return outcome;
  }));
  context.subscriptions.push(vscode.commands.registerCommand(CUSTOM_PROVIDER_COMMANDS.show, () => {
    const state = readCustomProviders();
    void vscode.window.showInformationMessage(describeCustomProviders(state));
    return { providers: state.providers.map((provider) => provider.id), rejected: state.rejected, code: state.code, ignoredScopes: state.ignoredScopes };
  }));
}
