'use strict';

const { TOOLS, LEVELS } = require('./role-group');

// Plain-language help shown next to each role group field. Every sentence says what the setting
// is for, and nothing here claims a setting is enforced: a CLI is only told about these settings,
// and whether it obeys them is not verified.

const ENFORCEMENT_NOTE = 'Not enforced yet: the agent is only told about this, and the CLI is not verified to obey it.';
// Tool permissions are the one setting a launch turns into the CLI's own configuration (issue #310); the note says exactly how far.
const TOOL_ENFORCEMENT_NOTE = 'For Claude Code, deny and ask become the CLI\'s own permission rules when an agent starts (Preview Effective Rules says how firmly each holds); for Codex only "no file writing" becomes a read-only sandbox; for every other tool and CLI the agent is only told. None of it is verified on a real machine.';

const TOOL_HELP = Object.freeze({
  shell: 'Run commands in a terminal shell.',
  fileWrite: 'Create, change or delete files in the project.',
  network: 'Use the internet (download, search, call web services).',
  githubRead: 'Read GitHub Issues, pull requests and reviews.',
  githubWrite: 'Change GitHub: open or edit Issues, push, open pull requests, comment, review.',
  merge: 'Merge a pull request.',
  gitCommit: 'Create a git commit.',
  gitPush: 'Push commits to a remote branch.',
  prCreate: 'Open a pull request.',
  prReview: 'Review a pull request (approve, request changes or comment as a review).',
  comment: 'Comment on an Issue or a pull request.',
  mcp: 'Use MCP tools (research and other external tools the CLI has connected).'
});

const LEVEL_HELP = Object.freeze({
  deny: 'Not allowed. The agent is told never to do this, and a stronger layer\'s ban cannot be lifted.',
  ask: 'The agent is told to ask you before doing this.',
  allow: 'The agent may do this without asking. This never overrides a ban from a stronger layer.'
});

const FIELD_HELP = Object.freeze({
  role: 'What this agent is for, such as PM or Developer. It names the work; it does not grant anything by itself.',
  provider: 'Which command-line agent runs this role (Claude Code, Codex CLI, agy). It decides whether rules can be handed to the agent automatically.',
  name: 'A label you will recognise. It is shown only on this computer.',
  defaultAccount: 'The account this role uses unless you pick another when you start an agent. An account label is not proof of who is signed in.',
  repositories: 'The GitHub repositories this role may work in. Empty means none.',
  paths: 'The folders inside the project this role may work in. Empty means none.',
  memory: 'Whether this role may use the reviewed project notes kept on this computer. Off means no notes.',
  instructions: 'Text the agent is told to follow. It is private to this computer and is never sent to GitHub.',
  tools: 'What this role is allowed to do. Anything not listed is denied.'
});

/** One sentence for a tool, its level choices, and the standing caveat. Unknown names give no help, not a guess. */
function toolHelp(tool) {
  return Object.hasOwn(TOOL_HELP, tool) ? TOOL_HELP[tool] : null;
}

function levelHelp(level) {
  return Object.hasOwn(LEVEL_HELP, level) ? LEVEL_HELP[level] : null;
}

function fieldHelp(field) {
  return Object.hasOwn(FIELD_HELP, field) ? FIELD_HELP[field] : null;
}

module.exports = { toolHelp, levelHelp, fieldHelp, ENFORCEMENT_NOTE, TOOL_ENFORCEMENT_NOTE, TOOL_HELP, LEVEL_HELP, FIELD_HELP, TOOLS, LEVELS };
