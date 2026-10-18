# Bundled collaboration skills

The VSIX ships eight reviewed text procedures: fetch-prs, fetch-issues, fetch-comments,
raise-issue, raise-pr, code-review-on-git, resolve-conflicts and resolve-issues.

At activation, Multiagent automatically prepares missing skills in every trusted local
workspace folder, and repeats this when folders are added or workspace trust is granted.
VSIX installation while the editor is closed does not execute an installer. This feature
never downloads or executes tools, adds credentials, or grants GitHub write permissions.
Skills describe procedures; they do not enforce the role or broker permission boundary.

| Host | Project discovery location | Evidence |
| --- | --- | --- |
| Claude Code | `.claude/skills/<name>/SKILL.md` | [Official skills documentation](https://code.claude.com/docs/en/skills) |
| Codex | `.agents/skills/<name>/SKILL.md` | [Official skill discovery documentation](https://learn.chatgpt.com/docs/build-skills) |
| OpenCode | Discovers both locations above; no third copy | [Official Agent Skills documentation](https://opencode.ai/docs/skills/) |
| agy | Loading protocol unverified | No installation or loading claim |
| OpenRouter, DeepSeek | Use the hosting CLI's skill discovery | No provider-specific directory or API installation is claimed |

Locations were checked against official documentation on 2026-10-18. Discovery support
means the host documents these locations; it does not prove a specific installed CLI
version has loaded the files. Start or refresh the CLI and inspect its skill listing.
OpenCode can see both installed locations; its precedence rules determine which same-name
skill it loads. Per-host policy can disable discovery. A worktree opened as a separate
workspace receives its own copies; an unopened worktree is not traversed automatically.

## Control and preservation

Disable `multiagentSystem.skills.autoInstall` to stop automatic preparation. A workspace
setting can override the user default. Untrusted or remote workspace folders are skipped.
The manual **Install Agent Skills in This Workspace** command still requires confirmation;
GitHub templates are offered separately, and never installed by the automatic flow.

An existing skill directory is always left unchanged, even if its contents differ from
the bundle. Symbolic links and malformed ownership records refuse installation. Files
are created without replacement, and ownership hashes are stored in private extension
state. Nothing about sessions, accounts, prompts or usage is written into skills.

**Remove Installed Agent Skills** deletes only recorded, byte-identical files, keeps
user edits and additional files, and disables automatic reinstallation for that folder.
Explicitly running Install restores automatic preparation for that folder. Removing the
extension does not automatically remove project files; run Remove first if desired.
The removal preference and ownership record are local to this VS Code profile.

Automatic installation reports newly prepared files and skipped conflicts in a local
notification. Files already present are preserved; their presence is not a loading receipt.
These procedures can reduce repeated workflow explanations; no measured token savings
are claimed without an A/B run.
