# Terminal session state model

This is the local state core for Issue #11. It does not launch a CLI or claim
that a native terminal is visible or interactive. The VS Code adapter will bind
each `vscode.Terminal` to a process-local token and forward close and provider
events to this registry. The persisted snapshot belongs in private local
storage, never in GitHub Issues, PRs, commits or workspace settings.

Each session fixes its project, role group, provider, account profile and
worktree when created. An account switch creates a new session. Attaching a
terminal does not prove a CLI launched; sending a command records only
`launch-requested`. `cli-observed` requires a provider event with the matching
provider and account profile. A shell remaining open after the CLI exits is
`cli-exited`, and a terminal close is `terminal-closed`.

After Extension Host restart, `SessionRegistry.restore` sets every session to
`unknown` and forgets terminal bindings and observation evidence. It preserves
the fixed account selection for navigation, but the UI must reverify the
provider identity before a managed relaunch. A late close event from an older
terminal token cannot close a newer attachment.

`snapshot()` contains private account profile and worktree identifiers. Its
caller must store it through Issue #9's private storage interface. This module
does not use VS Code storage directly and does not implement focus, stop,
relaunch, shell input, Ctrl+C, or Windows terminal interaction. Those remain
in Issue #11 and the P0 acceptance matrix in Issues #1 and #3.

## Extension integration (Issue #11, first slice)

`src/sessions/manager.ts` (`SessionManager`) puts the registry behind the VS Code commands. It does not import `vscode`: native terminals and persistence are injected, so the behaviour is tested with fakes; `src/sessions/sessionCommands.ts` is the thin VS Code layer. The existing `Multiagent: Launch CLI Agent in Native Terminal` command now creates a session through it.

- **Start**: creates a native terminal (editor location, project folder as `cwd`, platform default shell profile) and a session, binds an opaque in-memory token, types the provider executable and records `launch-requested`. That state is *not* evidence the CLI runs; only a provider event (future #18/#19 adapters, through `observeCli`) can reach `cli-observed`. A running shell is never shown as the model working.
- **Close / stop**: `onDidCloseTerminal` calls `terminalClosed`. `stop` closes the terminal, records the state first and ignores the close event that follows. Events for terminals the manager does not track, or late events from a replaced terminal, change nothing.
- **Focus**: shows the live terminal and takes focus; refused (`terminal-not-open`) when there is none.
- **Reopen**: always creates a NEW session with the same project, role group, provider, account profile and folder. The old session stays as history and is never revived. It is refused while the old session still has an open terminal, or when the folder is gone. The account cannot be changed here; starting a session with another account is the account switch.
- **Restart**: after the Extension Host restarts every restored session is `unknown` with no terminal, token or observation, and focus/stop/observation are refused. Terminals left over from before are not adopted.
- **Reopening after a restart**: a session restored as `unknown` can have an earlier terminal (and CLI) still running in the same folder that this window cannot see, because VS Code can keep terminals alive across a reload. `reopen` therefore refuses with `confirm-unknown-reopen` until the caller passes `acknowledgeUnknown: true`; the interactive command asks in a modal dialog first. A session this window knows is closed reopens without asking. Known limitation: even after confirmation the manager cannot tell whether the old terminal is still writing.
- **Account and role group**: no account profiles (#12) or role groups (#14) exist yet, so sessions carry the explicit placeholder `unassigned`. The terminal inherits the environment exactly as before; nothing here verifies an account identity, isolates a config directory or blocks an unsafe credential source.

### Persistence interface (injected; not implemented here)

```ts
interface SessionRecord { id; repoId; roleGroupId; provider; accountProfileId; worktree; name }  // all strings
interface SessionSnapshotStore {
  load(): Promise<unknown>;                    // what save() stored, or undefined
  save(records: SessionRecord[]): Promise<void>;
}
```

**Loading is fail closed.** `initialize()` runs once, before any session exists **or is being created**, and `start`/`reopen` that begin after it started wait for it. A `start`/`reopen` that was already past that gate refuses `initialize()` up front (`sessions-exist`, the stored snapshot is not even read); and if one appears while the snapshot is loading, the restore is refused instead of replacing the new session, with saving staying off. If `load()` throws, or its content cannot be read (wrong shape, damaged, duplicate ids, a newer format), the manager starts empty and **saving stays off** for the rest of the window: `save` is never called, so the unreadable data is not overwritten, and the user is told once (`onPersistenceBlocked`). Saving is also off when `initialize()` was never run. Names are validated with the same rule as new ones (trimmed, at most 80 characters, no control characters); an invalid stored name falls back to `<provider> session` and never reaches a terminal title.

Records are identity plus a display name: no state, terminal, token or observation. They are private local data (paths, account profile ids) and must go through the private storage of Issue #9, never GitHub or workspace settings. `initialize()` restores them as `unknown`; a snapshot that cannot be read is rejected as a whole and the manager starts empty. A failing `save` never breaks a session; it is reported without details. `start` also refuses a folder that does not exist (`worktree-missing`). The extension passes no store yet, so sessions live only while the window is open.

The `sessions.start|focus|stop|reopen` commands are internal: they are not in the Command Palette, only run in a trusted workspace, and `start` accepts only a known provider executable. Any extension can still call them with an arbitrary folder; this is a known, limited exposure.

### Not verified

Interactive prompts and the session picker, typing into the CLI, Ctrl+C, four sessions on real macOS and Windows machines, real CLI launch, terminal profile and inherited-environment checks, and managed-launch blocking for unsafe credential sources are not covered by CI. They stay in #11 and the P0 matrix of #1 and #3.

## Connecting a Claude Code agent to this VS Code window (Issue #354)

Claude Code finds its IDE through lock files: `~/.claude/ide/<port>.lock`, and `<CLAUDE_CONFIG_DIR>/ide/<port>.lock` for an account folder. The CLI accepts a lock when the terminal's `CLAUDE_CODE_SSE_PORT` is its port, or when the CLI's folder is one of the lock's `workspaceFolders`. An agent runs in its worktree, which is usually not one of the window's folders, and the port the VS Code Claude Code extension sets for its own terminals does not reach terminals this extension opens, so without help the agent showed "VS Code disconnected".

When a Claude Code session is started or reopened, `src/sessions/ideBridge.js` reads those lock folders and picks the port of the one lock that has one of this window's folders open and whose VS Code process is still running. That port is set as `CLAUDE_CODE_SSE_PORT` in the agent's terminal. Only the port (the file name) and `workspaceFolders` are taken from a lock: the `authToken` is never read into the extension's results, logged, shown or passed on (the CLI reads it from the file itself).

Where to see it: the agent's card in the Command Center, the agent's tooltip in the Overview, and the session picker each carry one line:

- `VS Code: connected through this window's Claude Code port (<port>)`
- `VS Code: not connected (<reason>: <what to do>)`, shown as an alert on the card. The reasons: no lock folder or no lock file (the Claude Code extension for VS Code is not installed or not enabled), no lock for this project's folder, more than one running window has this folder open (no port is guessed), or this window has no folder open. After fixing it, reopen the session.

A session that is not connected still starts; only the connection to VS Code (diffs, selection, diagnostics) is missing. Not verified: a real Claude Code CLI and the real VS Code Claude Code extension connecting through the chosen port, and a sandboxed agent (#224 isolation) reaching the port on loopback.
