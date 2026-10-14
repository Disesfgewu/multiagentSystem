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
