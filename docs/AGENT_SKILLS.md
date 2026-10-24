# Bundled collaboration skills

The VSIX ships eleven reviewed text procedures: fetch-prs, fetch-issues, fetch-comments,
raise-issue, raise-pr, code-review-on-git, resolve-conflicts, resolve-issues, and (#359)
run-tests, respond-to-review and claim-issue.

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

## The skills library (#359)

Besides the bundled procedures above, the owner keeps a **library** of skills in the extension's
private storage (collection `skills`), managed from the Workbench's Knowledge tab:

- Each skill is a `SKILL.md` in Claude Code's own shape: a front matter with `name` (lower-case
  letters, digits and dashes, up to 64) and `description` (one line, up to 1024 characters), then
  the steps (up to 16 KB). At most 50 skills.
- Editing opens `multiagent-skill:/<name>/SKILL.md` in an ordinary editor; saving it checks the
  text and keeps it. A skill changed elsewhere since it was opened is not overwritten.
- Checked before it is kept and again whenever it is listed or given to an agent
  (`src/skills/library.js`): no control, invisible or direction-changing characters, no wording
  that tells an agent to ignore its rules (`checkPromptInjection`), none of this package's own
  message markers (`OWN_MARKER`), nothing that looks like a secret, an e-mail address or a home
  folder (`scanSensitive`). A record that no longer passes is shown as unusable and given to no one.
- A skill is given to the role groups the owner chooses. A skill an agent suggests is a
  **candidate**: it reaches no agent until the owner approves it.
- **Add starter skills** brings in the bundled procedures; **Bring in this repository's skills**
  reads `.claude/skills` and `.agents/skills` of the open project; **Write skills into this
  repository** writes the chosen ones to both locations after a confirmation that lists every
  file, and never replaces a file that is already there.

### What an agent is given (#359, PM decision recorded on the issue)

At start, an agent of a role group gets, in its instructions, only a **Skills** section: one line
per skill of that role group (on, approved, still passing its checks), with its name, its
description and the path of its file. The skill's text is not in the instructions.

- Each file is written as `SKILL.md` in the session's own private folder:
  `<private>/sessions/<session>/skills/<name>/SKILL.md` (Claude Code and the manual plan), or next to
  the session's profile in `CODEX_HOME` (`mas-<session>-skills/<name>/SKILL.md`). Nothing is written
  into the repository, and `.git/info/exclude` is not touched.
- Claude Code is started with `--add-dir <that skills folder>` (only that folder, not the session
  folder), so it can read a skill without asking. Codex reads the path. agy gets the manual plan.
- Claude Code therefore reads the list and opens a skill when it needs it; this is not Claude
  Code's native skill loading.
- The skills' names and revisions are part of the instruction digest and of the snapshot: a skill
  changed, added, turned off or removed between the confirmation and the start makes it stale.
- The Workbench card shows how many rules, notes and skills were prepared, and their size:
  characters per part and an estimate of tokens (one per CJK character, one per four other
  characters). Nothing claims how many tokens were saved.
