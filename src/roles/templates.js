'use strict';

const { validateRoleGroup } = require('./role-group');
const { builtIn } = require('../providers/registry');
const { toolHelp, ENFORCEMENT_NOTE } = require('./field-help');
const { injectionStatus } = require('./injection-status');

// Starting points for a role group. Every tool is listed with an explicit level so a new tool can
// never become available by omission; anything a template does not allow stays denied. The
// templates choose cautious defaults, never an enforcement: the agent is only told about them.

const TEMPLATES = Object.freeze({
  pm: Object.freeze({
    id: 'pm',
    role: 'pm',
    title: 'PM',
    summary: 'Defines the work, reviews pull requests and decides what is ready. Does not write code or merge.',
    defaultName: 'PM',
    toolPermissions: Object.freeze({ shell: 'ask', fileWrite: 'ask', network: 'ask', githubRead: 'allow', githubWrite: 'ask', merge: 'deny' }),
    instruction: 'Define work as clear GitHub Issues and review pull requests. Do not implement features yourself, and do not merge.'
  }),
  worker: Object.freeze({
    id: 'worker',
    role: 'worker',
    title: 'Developer',
    summary: 'Picks up an assigned Issue, writes code and opens a pull request. Asks before using the internet or changing GitHub; cannot merge.',
    defaultName: 'Developer',
    toolPermissions: Object.freeze({ shell: 'allow', fileWrite: 'allow', network: 'ask', githubRead: 'allow', githubWrite: 'ask', merge: 'deny' }),
    instruction: 'Work only on the Issue you were assigned, keep each change small, and do not merge your own pull request.'
  }),
  blank: Object.freeze({
    id: 'blank',
    role: null,
    title: 'Blank',
    summary: 'Starts with everything denied. You choose each permission.',
    defaultName: 'New role group',
    toolPermissions: Object.freeze({}),
    instruction: null
  })
});

function templateIds() {
  return Object.keys(TEMPLATES);
}

/**
 * A new role group record from a template. `role` is required for the blank template (an open
 * role id). Returns `{ ok, record }` or the validation problems; nothing is written.
 */
function buildFromTemplate({ templateId, provider, name, role, newId }) {
  if (typeof templateId !== 'string' || !Object.hasOwn(TEMPLATES, templateId)) return { ok: false, problems: [{ code: 'unknown-template', path: 'templateId' }] };
  if (!builtIn.has(provider)) return { ok: false, problems: [{ code: 'invalid-provider', path: 'provider' }] };
  const template = TEMPLATES[templateId];
  const group = {
    id: typeof newId === 'string' ? newId : `role-${Date.now().toString(36)}`,
    name: typeof name === 'string' && name.trim() ? name.trim() : template.defaultName,
    role: template.role ?? role,
    provider,
    version: 1,
    defaultAccountProfileId: null,
    allowedScope: { repositories: [], paths: [] },
    toolPermissions: { ...template.toolPermissions },
    memoryScope: { mode: 'off' },
    rules: template.instruction ? [{ id: `${template.id}-template-instruction`, type: 'instruction', text: template.instruction, version: 1 }] : []
  };
  const checked = validateRoleGroup(group);
  if (!checked.ok) return { ok: false, problems: checked.problems };
  return { ok: true, record: { group: checked.group, layers: {} } };
}

/** What a person confirms before a role group is created: what it lets the agent do and what is not verified. */
function describeRoleGroup(record) {
  const { group } = record;
  const lines = [`Role: ${group.role} · ${builtIn.get(group.provider)?.label ?? group.provider}`, '', 'What this agent may do:'];
  for (const [tool, level] of Object.entries(group.toolPermissions)) lines.push(`  • ${tool}: ${level} — ${toolHelp(tool) ?? ''}`);
  lines.push('', ENFORCEMENT_NOTE, 'Anything not listed above is denied.', '', `Rules in the CLI: ${injectionStatus({ provider: group.provider }).label}`);
  return lines.join('\n');
}

module.exports = { TEMPLATES, templateIds, buildFromTemplate, describeRoleGroup };
