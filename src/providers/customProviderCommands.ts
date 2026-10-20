import * as vscode from 'vscode';

const { readUserLevel } = require('../settings/user-level') as { readUserLevel(inspected: unknown): { value: unknown; ignoredScopes: string[] } };
const { customProvidersFrom } = require('./custom-providers') as {
  customProvidersFrom(raw: unknown): { providers: Array<{ id: string; label: string }>; rejected: Array<{ index: number; code: string }>; code: string | null };
};

export const CUSTOM_PROVIDER_COMMANDS = { show: 'multiagentSystem.providers.showCustom' } as const;
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

export function registerCustomProviderCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand(CUSTOM_PROVIDER_COMMANDS.show, () => {
    const state = readCustomProviders();
    void vscode.window.showInformationMessage(describeCustomProviders(state));
    return { providers: state.providers.map((provider) => provider.id), rejected: state.rejected, code: state.code, ignoredScopes: state.ignoredScopes };
  }));
}
