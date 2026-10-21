// Which of the group's terminals are already open. The extension keeps its own reference to every terminal it creates for the
// group and trusts that first: a terminal's `name` is not stable (on Windows the shell can retitle it a moment after it starts),
// so a name match is only the fallback, for a terminal from before this window's references (for example after a reload).

export interface GroupTerminal {
  name: string;
  exitStatus?: unknown;
}

/**
 * @param titles the title of each of the group's terminals, in order
 * @param live the terminals the editor lists now
 * @param owned what the extension created for each title (updated here: a reference that is gone or has exited is dropped)
 * @returns the open terminal for each title, `undefined` where there is none
 */
export function findGroupTerminals<T extends GroupTerminal>(titles: readonly string[], live: readonly T[], owned: Map<string, T>): Array<T | undefined> {
  return titles.map((title) => {
    const own = owned.get(title);
    if (own !== undefined) {
      if (live.includes(own) && own.exitStatus === undefined) return own;
      owned.delete(title);
    }
    return live.find((terminal) => terminal.name === title && terminal.exitStatus === undefined);
  });
}
