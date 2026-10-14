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
- **Account and role group**: no account profiles (#12) or role groups (#14) exist yet, so sessions carry the explicit placeholder `unassigned`. The terminal inherits the environment exactly as before; nothing here verifies an account identity, isolates a config directory or blocks an unsafe credential source.

### Persistence interface (injected; not implemented here)

```ts
interface SessionRecord { id; repoId; roleGroupId; provider; accountProfileId; worktree; name }  // all strings
interface SessionSnapshotStore {
  load(): Promise<unknown>;                    // what save() stored, or undefined
  save(records: SessionRecord[]): Promise<void>;
}
```

Records are identity plus a display name: no state, terminal, token or observation. They are private local data (paths, account profile ids) and must go through the private storage of Issue #9, never GitHub or workspace settings. `initialize()` restores them as `unknown`; a snapshot that cannot be read is rejected as a whole and the manager starts empty. A failing `save` never breaks a session; it is reported without details. The extension passes no store yet, so sessions live only while the window is open.

### Not verified

Interactive prompts and the session picker, typing into the CLI, Ctrl+C, four sessions on real macOS and Windows machines, real CLI launch, terminal profile and inherited-environment checks, and managed-launch blocking for unsafe credential sources are not covered by CI. They stay in #11 and the P0 matrix of #1 and #3.
