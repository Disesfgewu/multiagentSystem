// Some commands skip their prompts when the caller already names what to act on (a session id,
// a worktree folder). Any code in the editor can run a command, so a named target alone must not
// stand in for the person's decision (Refs #192). The person still decides when:
//   * the argument came from a caller, not from this extension's own tree row (see uiOrigin.ts), and
//   * the extension is not running its own tests (see testMode.ts).

export interface CallerArgument {
  /** The caller named the target itself, so no picker or input box asked the person. */
  supplied: boolean;
  /** The argument is a tree item this extension created and the person clicked. */
  fromOwnUi: boolean;
  /** The extension runs its own tests (ExtensionMode.Test). */
  testMode: boolean;
}

export function callerArgumentNeedsConfirmation(argument: CallerArgument): boolean {
  return argument.supplied === true && argument.fromOwnUi !== true && argument.testMode !== true;
}
