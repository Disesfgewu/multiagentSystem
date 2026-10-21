'use strict';

const { TOOLS } = require('./role-group');

/**
 * What a role group's tool permissions turn into for the CLI that runs the role (issue #310). Pure: no file, no process.
 *
 * Sources (read 2026-10-22):
 *  - Claude Code permission rules: https://code.claude.com/docs/en/permissions ("Rules are evaluated in order: deny, then ask, then
 *    allow"; a bare tool name such as `Edit` or `Bash` as a deny rule "removes the tool from Claude's context entirely"; `mcp__*` as a
 *    deny rule matches every MCP tool; `Bash(git push *)` also matches the bare command; and, importantly, a Bash rule "isn't a
 *    security boundary around the program": `/usr/bin/curl`, `sh -c '…'`, `git -C . push` are not matched) and
 *    https://code.claude.com/docs/en/settings ("Lists merge instead of overriding": the user's own `permissions` lists still apply;
 *    `--settings` sits above project and user files and below managed settings).
 *  - Codex CLI flags: https://developers.openai.com/codex/cli/reference (`--sandbox, -s` takes read-only | workspace-write |
 *    danger-full-access). Codex has no per-command allow or deny list among its flags, so only the sandbox mode is used.
 *
 * Levels: `deny` becomes deny rules; `ask` becomes ask rules (the CLI asks even in its automatic mode, because the person chose to
 * be asked); `allow` becomes NO rule at all: it never widens what the CLI's own permission mode (and the person's auto-mode
 * setting) decides, exactly as `allow` never overrides a stronger layer's ban in the effective rules.
 *
 * How firmly each is held is stated with it, never implied: `enforced` (the CLI itself removes or blocks the tool), `partial` (the
 * CLI blocks the usual form of a command or file change, but another way to do the same thing remains), `advice` (the agent is only
 * told), `none`.
 */

// Rules per tool. Every entry is a Claude Code permission rule string.
const FILE_TOOLS = Object.freeze(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const RULES = Object.freeze({
  shell: { rules: ['Bash'], kind: 'tool' },
  fileWrite: { rules: FILE_TOOLS, kind: 'tool' },
  network: { rules: ['WebFetch', 'WebSearch'], kind: 'tool', alsoCommands: ['Bash(curl *)', 'Bash(wget *)'] },
  githubRead: { rules: ['Bash(gh pr view *)', 'Bash(gh pr list *)', 'Bash(gh pr diff *)', 'Bash(gh pr checks *)', 'Bash(gh issue view *)', 'Bash(gh issue list *)'], kind: 'command' },
  githubWrite: { rules: ['Bash(gh issue create *)', 'Bash(gh issue edit *)', 'Bash(gh issue close *)', 'Bash(gh issue reopen *)', 'Bash(gh pr edit *)', 'Bash(gh pr close *)', 'Bash(gh pr reopen *)', 'Bash(gh pr ready *)', 'Bash(gh api *)'], kind: 'command' },
  // `gh api` can merge too (a PUT to .../pulls/N/merge), so its merge form is refused with the rest; `*` may stand anywhere in a rule.
  merge: { rules: ['Bash(gh pr merge *)', 'Bash(git merge *)', 'Bash(gh api *merge*)'], kind: 'command' },
  gitCommit: { rules: ['Bash(git commit *)'], kind: 'command' },
  gitPush: { rules: ['Bash(git push *)'], kind: 'command' },
  prCreate: { rules: ['Bash(gh pr create *)'], kind: 'command' },
  prReview: { rules: ['Bash(gh pr review *)'], kind: 'command' },
  comment: { rules: ['Bash(gh issue comment *)', 'Bash(gh pr comment *)'], kind: 'command' },
  mcp: { rules: ['mcp__*'], kind: 'tool' }
});

const LEVELS = Object.freeze(['deny', 'ask', 'allow']);
const RULE_SHAPE = /^(?:[A-Za-z][A-Za-z0-9]*|mcp__\*)(?:\([A-Za-z0-9 _.:/*-]{1,80}\))?$/;
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The tools that are never rules a person could widen by accident: a missing or unknown level counts as deny. */
function levelOf(permissions, tool) {
  const level = isPlain(permissions) ? permissions[tool] : undefined;
  return LEVELS.includes(level) ? level : 'deny';
}

/**
 * Claude Code's `permissions` for a role group. `deny` and `ask` only; sorted and without repeats, so the same group always gives
 * the same file. A tool that is not one of this module's tools is ignored (it has no rule), never guessed at.
 * @returns {{ deny: string[], ask: string[] }}
 */
function claudePermissions(toolPermissions) {
  const deny = new Set();
  const ask = new Set();
  for (const tool of TOOLS) {
    if (!Object.hasOwn(RULES, tool)) continue;
    const level = levelOf(toolPermissions, tool);
    const target = level === 'deny' ? deny : level === 'ask' ? ask : null;
    if (!target) continue;
    for (const rule of RULES[tool].rules) target.add(rule);
    // Commands that reach the network through the shell are asked or refused with the web tools, in their usual form only.
    for (const rule of RULES[tool].alsoCommands ?? []) target.add(rule);
  }
  // With the shell itself denied the bare `Bash` rule covers every command, so the command patterns would only repeat it.
  if (deny.has('Bash')) for (const rule of [...deny]) if (rule.startsWith('Bash(')) deny.delete(rule);
  if (deny.has('Bash')) for (const rule of [...ask]) if (rule.startsWith('Bash')) ask.delete(rule);
  // A rule is both denied and asked only by a mistake in a table: the stronger one (deny) is kept, as the CLI would decide anyway.
  for (const rule of deny) ask.delete(rule);
  const clean = (set) => [...set].filter((rule) => RULE_SHAPE.test(rule)).sort();
  return { deny: clean(deny), ask: clean(ask) };
}

/**
 * The settings document handed to Claude Code with `--settings <path>`: the author-line switch (issue #293) and, for a session with a
 * role group, its permissions. One document, so there is only ever one `--settings`. Without a role group there is no
 * `permissions` key at all: the CLI's own behaviour is untouched.
 */
function claudeSettings({ toolPermissions } = {}) {
  const document = { attribution: { commit: '', pr: '', sessionUrl: false } };
  if (toolPermissions !== undefined && toolPermissions !== null) {
    const { deny, ask } = claudePermissions(toolPermissions);
    document.permissions = { ...(deny.length > 0 ? { deny } : {}), ...(ask.length > 0 ? { ask } : {}) };
    if (Object.keys(document.permissions).length === 0) delete document.permissions;
  }
  return document;
}

/**
 * Codex's launch arguments for a role group. The only official switch that matches a permission is the sandbox mode: a role that may not
 * write files runs in `read-only`. Nothing else is expressible as a flag, so nothing else is passed, and no flag ever widens the
 * sandbox (`danger-full-access` is never used here).
 * @returns {{ args: string[] }}
 */
function codexArguments(toolPermissions) {
  if (toolPermissions === undefined || toolPermissions === null) return { args: [] };
  return levelOf(toolPermissions, 'fileWrite') === 'deny' ? { args: ['--sandbox', 'read-only'] } : { args: [] };
}

/**
 * The launch arguments of the automatic mode (issue #296) and those of the role's permissions, as one list. When both set the
 * sandbox, the role's wins and the automatic mode's is dropped: the stricter, role-derived mode is never overridden by a convenience.
 * @param {string[]} autoArgs @param {string[]} permissionArgs
 */
function mergeSandboxArguments(autoArgs, permissionArgs) {
  const auto = Array.isArray(autoArgs) ? [...autoArgs] : [];
  const mine = Array.isArray(permissionArgs) ? [...permissionArgs] : [];
  const index = mine.indexOf('--sandbox');
  if (index >= 0) {
    const at = auto.indexOf('--sandbox');
    if (at >= 0) auto.splice(at, 2);
  }
  return [...auto, ...mine];
}

const DOES = Object.freeze({
  claude: {
    removed: "Claude Code removes this tool from the agent's context (enforced by the CLI)",
    usualForm: "Claude Code refuses the usual form of the command; the same step by another route (a full path, `sh -c`, `git -C`) is not matched, so this is not a boundary",
    asks: 'Claude Code asks before this, even in its automatic mode',
    nothing: "no rule is passed; Claude Code's own permission mode decides whether it asks"
  }
});

/**
 * One line per tool for the screen: the level, what the CLI is given for it and how firmly it holds. Says "advice only" for every
 * tool a CLI has no mechanism for, and never "enforced" for something that is only a command pattern.
 * @returns {Array<{ tool: string, level: string, enforcement: 'enforced'|'partial'|'advice'|'none', how: string }>}
 */
function describePermissions(provider, toolPermissions) {
  const shellDenied = levelOf(toolPermissions, 'shell') === 'deny';
  const out = [];
  for (const tool of TOOLS) {
    const level = levelOf(toolPermissions, tool);
    if (provider === 'claude' && Object.hasOwn(RULES, tool)) {
      const spec = RULES[tool];
      let enforcement;
      let how;
      if (level === 'allow') { enforcement = 'none'; how = DOES.claude.nothing; }
      else if (level === 'ask') { enforcement = spec.kind === 'tool' ? 'enforced' : 'partial'; how = DOES.claude.asks; }
      else if (spec.kind === 'tool') {
        enforcement = 'enforced'; how = DOES.claude.removed;
        // A file or network ban on the CLI's own tools does not stop a shell that is still allowed from doing the same thing.
        if ((tool === 'fileWrite' || tool === 'network') && !shellDenied) { enforcement = 'partial'; how += tool === 'fileWrite' ? '; the shell can still change files (for example `sed -i`) unless it is denied too' : '; the shell can still reach the network unless it is denied too'; }
      } else if (shellDenied) { enforcement = 'enforced'; how = 'the shell is denied, so no command of this kind can run'; }
      else { enforcement = 'partial'; how = DOES.claude.usualForm; }
      out.push({ tool, level, enforcement, how });
    } else if (provider === 'codex' && tool === 'fileWrite' && level === 'deny') {
      out.push({ tool, level, enforcement: 'enforced', how: "Codex runs in its read-only sandbox (--sandbox read-only); this also keeps the agent from changing files through the shell" });
    } else {
      out.push({ tool, level, enforcement: 'advice', how: provider === 'claude' || provider === 'codex' ? 'this CLI has no setting for it that this extension can pass: the agent is only told' : 'no setting is passed for this CLI: the agent is only told' });
    }
  }
  return out;
}

/** The plain lines for a preview or a confirmation window. */
function permissionLines(provider, toolPermissions) {
  const rows = describePermissions(provider, toolPermissions);
  const lines = rows.map((row) => `${row.tool}: ${row.level} — ${row.enforcement === 'enforced' ? 'ENFORCED' : row.enforcement === 'partial' ? 'PARTLY enforced' : row.enforcement === 'none' ? 'no rule' : 'advice only'}; ${row.how}`);
  const settings = provider === 'claude' ? claudePermissions(toolPermissions) : { deny: [], ask: [] };
  if (provider === 'claude') lines.push(`Claude Code is passed ${settings.deny.length} deny and ${settings.ask.length} ask rule${settings.ask.length === 1 ? '' : 's'}; your own settings files still apply (Claude Code merges the lists).`);
  if (provider === 'codex') lines.push(codexArguments(toolPermissions).args.length > 0 ? `Codex is passed: ${codexArguments(toolPermissions).args.join(' ')}.` : 'Codex is passed no permission flag.');
  return lines;
}

/**
 * The Broker operations a role group may use, as the Broker's own role: a PM role group is the Broker's `pm`, a worker role group its
 * `worker`; any other role has no Broker role and therefore no write operation. A group whose tool permissions would let it do more
 * than its Broker role (a PM that may commit, a worker that may review) is reported, so the two can never silently disagree.
 * @returns {{ brokerRole: 'pm'|'worker'|null, conflicts: string[] }}
 */
function brokerRoleFor(group) {
  if (!isPlain(group) || !isPlain(group.toolPermissions)) return { brokerRole: null, conflicts: [] };
  const role = group.role;
  const level = (tool) => levelOf(group.toolPermissions, tool);
  const conflicts = [];
  if (role === 'pm') {
    for (const tool of ['gitCommit', 'gitPush', 'prCreate', 'fileWrite']) if (level(tool) !== 'deny') conflicts.push(`${tool}-must-be-denied-for-pm`);
    return { brokerRole: 'pm', conflicts };
  }
  if (role === 'worker') {
    for (const tool of ['prReview', 'merge']) if (level(tool) !== 'deny') conflicts.push(`${tool}-must-be-denied-for-worker`);
    return { brokerRole: 'worker', conflicts };
  }
  return { brokerRole: null, conflicts };
}

module.exports = { claudePermissions, claudeSettings, codexArguments, mergeSandboxArguments, describePermissions, permissionLines, brokerRoleFor, RULES, levelOf };
