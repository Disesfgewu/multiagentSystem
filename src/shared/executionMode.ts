/**
 * In VS Code, ExtensionMode enum values are:
 * Production = 1, Development = 2, Test = 3.
 */
export const EXTENSION_MODE_PRODUCTION = 1;
export const EXTENSION_MODE_DEVELOPMENT = 2;
export const EXTENSION_MODE_TEST = 3;

export interface ModeContext {
  extensionMode?: number;
}

/**
 * Returns true only when running in VS Code test mode (ExtensionMode.Test === 3).
 *
 * Security rationale: VS Code commands are globally executable. Any code or untrusted
 * extension that can invoke `vscode.commands.executeCommand` could attempt to pass
 * `interactive: false` to bypass user confirmations, mutate storage, clear credentials,
 * launch arbitrary processes, or delete worktrees. Restricting non-interactive bypass
 * strictly to ExtensionMode.Test guarantees that production and development environments
 * always enforce interactive user confirmations.
 */
export function allowNonInteractive(context?: ModeContext): boolean {
  return context?.extensionMode === EXTENSION_MODE_TEST;
}

/**
 * Resolves whether a command must run interactively.
 * In production/development, this unconditionally returns true (bypassing interactive confirmation is rejected).
 * In ExtensionMode.Test, it respects `requestedInteractive === false`.
 */
export function resolveInteractive(
  context: ModeContext | undefined,
  requestedInteractive?: boolean
): boolean {
  return allowNonInteractive(context) ? requestedInteractive !== false : true;
}
