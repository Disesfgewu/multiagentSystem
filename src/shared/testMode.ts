// VS Code commands can be run by any code in the editor, so a command argument such as
// `interactive: false` must not let a caller skip a human confirmation. Such arguments are
// honoured only while the editor runs this extension's own tests (ExtensionMode.Test).
// `activate()` sets the mode once; nothing reachable from a command argument can change it.

let testMode = false;

export function setExtensionTestMode(enabled: boolean): void {
  testMode = enabled === true;
}

export function isExtensionTestMode(): boolean {
  return testMode;
}

/** True only when the caller asked to skip prompts AND the extension runs in test mode. */
export function allowNonInteractive(requested: boolean): boolean {
  return testMode && requested === true;
}

/**
 * Returns the options with `interactive: false` replaced by `interactive: true` outside test mode,
 * so the command goes through its normal prompts and confirmations. Other fields are kept.
 */
export function requireInteractive<T extends { interactive?: unknown }>(options: T): T {
  if (options.interactive === false && !allowNonInteractive(true)) return { ...options, interactive: true };
  return options;
}
