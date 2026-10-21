'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TEMPLATES } = require('../../src/roles/templates');
const { TOOLS, FINE_TOOLS, validateRoleGroup, inheritedTools } = require('../../src/roles/role-group');
const { claudePermissions, claudeSettings, codexArguments, mergeSandboxArguments, describePermissions, permissionLines, brokerRoleFor, RULES } = require('../../src/roles/tool-permissions');
const { previewEffectiveRules, formatPreview } = require('../../src/roles/preview');

const rulesOf = (id) => claudePermissions(TEMPLATES[id].toolPermissions);
const group = (role, toolPermissions) => ({ id: 'g-1', name: 'G', role, provider: 'claude', version: 1, defaultAccountProfileId: null, allowedScope: { repositories: [], paths: [] }, toolPermissions, memoryScope: { mode: 'off' }, rules: [] });

test('every tool has a rule table entry, so no tool can be added without deciding what it means for the CLI', () => {
  assert.deepEqual(Object.keys(RULES).sort(), [...TOOLS].sort());
  for (const tool of FINE_TOOLS) assert.ok(TOOLS.includes(tool));
});

test('PM: cannot edit files, commit, push, open or merge a pull request or use MCP; can review, comment and give commands', () => {
  const { deny, ask } = rulesOf('pm');
  for (const rule of ['Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'Bash(git commit *)', 'Bash(git push *)', 'Bash(gh pr create *)', 'Bash(gh pr merge *)', 'Bash(git merge *)', 'mcp__*']) assert.ok(deny.includes(rule), `PM: ${rule} is denied`);
  for (const rule of ['Bash', 'Bash(gh pr review *)', 'Bash(gh pr comment *)', 'Bash(gh issue comment *)', 'Bash(gh issue create *)', 'Bash(gh pr view *)']) assert.equal(deny.includes(rule) || ask.includes(rule), false, `PM: ${rule} is neither denied nor asked`);
  assert.ok(ask.includes('WebFetch') && ask.includes('WebSearch'), 'the PM asks before using the web');
});

test('worker: edits, tests, commits, pushes and opens a pull request; cannot merge, review or use MCP', () => {
  const { deny, ask } = rulesOf('worker');
  for (const rule of ['Bash(gh pr review *)', 'Bash(gh pr merge *)', 'Bash(git merge *)', 'mcp__*']) assert.ok(deny.includes(rule), `worker: ${rule} is denied`);
  for (const rule of ['Edit', 'Write', 'Bash', 'Bash(git commit *)', 'Bash(git push *)', 'Bash(gh pr create *)', 'Bash(gh issue comment *)', 'Bash(gh pr comment *)']) assert.equal(deny.includes(rule), false, `worker: ${rule} is not denied`);
  assert.ok(ask.includes('Bash(gh issue create *)'), 'the worker asks before creating or editing Issues');
});

test('researcher: no shell, no file changes, no GitHub writes, no git; web and MCP stay available', () => {
  const { deny, ask } = rulesOf('researcher');
  for (const rule of ['Bash', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit']) assert.ok(deny.includes(rule), rule);
  assert.equal(deny.some((rule) => rule.startsWith('Bash(')), false, 'with the shell denied the command patterns would only repeat it');
  for (const rule of ['WebFetch', 'WebSearch', 'mcp__*']) assert.equal(deny.includes(rule) || ask.includes(rule), false, rule);
  assert.deepEqual(ask, []);
});

test('the blank template and a missing level deny everything: nothing becomes available by omission', () => {
  const everything = claudePermissions(TEMPLATES.blank.toolPermissions);
  for (const rule of ['Bash', 'Edit', 'WebFetch', 'WebSearch', 'mcp__*']) assert.ok(everything.deny.includes(rule), rule);
  assert.deepEqual(claudePermissions({}), everything);
  assert.deepEqual(claudePermissions({ shell: 'allow', mcp: 'maybe', network: 5, fileWrite: null }).deny.filter((rule) => ['mcp__*', 'WebFetch', 'Edit'].includes(rule)).sort(), ['Edit', 'WebFetch', 'mcp__*'], 'an unknown level is deny');
});

test('allow is no rule at all: it never widens what the CLI\'s own mode and the person\'s auto-mode setting decide', () => {
  const all = Object.fromEntries(TOOLS.map((tool) => [tool, 'allow']));
  assert.deepEqual(claudePermissions(all), { deny: [], ask: [] });
  assert.deepEqual(claudePermissions({ ...all, gitPush: 'ask' }), { deny: [], ask: ['Bash(git push *)'] });
  assert.deepEqual(claudePermissions({ ...all, gitPush: 'deny' }), { deny: ['Bash(git push *)'], ask: [] });
});

test('a rule that is both denied and asked is only denied, and a denied shell makes the command patterns redundant', () => {
  const both = claudePermissions({ githubRead: 'deny', githubWrite: 'allow', shell: 'ask' });
  assert.equal(both.ask.includes('Bash'), true);
  const denied = claudePermissions({ shell: 'deny', gitPush: 'ask', merge: 'deny' });
  assert.ok(denied.deny.includes('Bash'));
  assert.equal([...denied.deny, ...denied.ask].some((rule) => rule.startsWith('Bash(')), false);
  const overlap = claudePermissions({ network: 'deny', shell: 'allow' });
  assert.equal(overlap.ask.some((rule) => overlap.deny.includes(rule)), false);
});

test('the rules are sorted, without repeats, and only have the shapes Claude Code accepts', () => {
  for (const id of ['pm', 'worker', 'researcher', 'blank']) {
    const { deny, ask } = rulesOf(id);
    for (const list of [deny, ask]) {
      assert.deepEqual(list, [...new Set(list)].sort(), id);
      for (const rule of list) assert.match(rule, /^(?:[A-Za-z][A-Za-z0-9]*|mcp__\*)(?:\([A-Za-z0-9 _.:/*-]{1,80}\))?$/, rule);
    }
  }
  assert.deepEqual(rulesOf('pm'), rulesOf('pm'));
});

test('the settings document holds the attribution switch always and the permissions only for a role group', () => {
  assert.deepEqual(claudeSettings(), { attribution: { commit: '', pr: '', sessionUrl: false } });
  assert.deepEqual(claudeSettings({ toolPermissions: null }), { attribution: { commit: '', pr: '', sessionUrl: false } }, 'a session without a role group is untouched');
  const withGroup = claudeSettings({ toolPermissions: TEMPLATES.pm.toolPermissions });
  assert.deepEqual(withGroup.attribution, { commit: '', pr: '', sessionUrl: false });
  assert.deepEqual(Object.keys(withGroup.permissions).sort(), ['ask', 'deny']);
  assert.equal(Object.hasOwn(withGroup.permissions, 'allow'), false, 'no allow rule is ever written');
  assert.equal(Object.hasOwn(claudeSettings({ toolPermissions: Object.fromEntries(TOOLS.map((tool) => [tool, 'allow'])) }), 'permissions'), false, 'nothing to say, nothing written');
  assert.equal(JSON.stringify(withGroup).includes('bypassPermissions'), false);
  assert.equal(JSON.stringify(withGroup).includes('defaultMode'), false, 'the permission mode is not touched: the auto-mode setting decides it');
});

test('Codex: a role that may not write files runs in the read-only sandbox; nothing else is a flag, and no flag widens the sandbox', () => {
  assert.deepEqual(codexArguments(TEMPLATES.pm.toolPermissions), { args: ['--sandbox', 'read-only'] });
  assert.deepEqual(codexArguments(TEMPLATES.researcher.toolPermissions), { args: ['--sandbox', 'read-only'] });
  assert.deepEqual(codexArguments(TEMPLATES.worker.toolPermissions), { args: [] });
  assert.deepEqual(codexArguments(null), { args: [] });
  assert.deepEqual(codexArguments(undefined), { args: [] });
  assert.deepEqual(codexArguments({}), { args: ['--sandbox', 'read-only'] }, 'a missing level is deny');
  for (const id of ['pm', 'worker', 'researcher', 'blank']) assert.equal(JSON.stringify(codexArguments(TEMPLATES[id].toolPermissions)).includes('danger'), false);
});

test('the role\'s sandbox replaces the auto mode\'s, whichever order they come in, and nothing else is touched', () => {
  const auto = ['--sandbox', 'workspace-write', '--ask-for-approval', 'never'];
  assert.deepEqual(mergeSandboxArguments(auto, ['--sandbox', 'read-only']), ['--ask-for-approval', 'never', '--sandbox', 'read-only']);
  assert.deepEqual(mergeSandboxArguments(auto, []), auto);
  assert.deepEqual(mergeSandboxArguments([], ['--sandbox', 'read-only']), ['--sandbox', 'read-only']);
  assert.deepEqual(mergeSandboxArguments(['--permission-mode', 'auto'], []), ['--permission-mode', 'auto']);
  assert.deepEqual(mergeSandboxArguments(undefined, undefined), []);
  assert.deepEqual(mergeSandboxArguments(null, ['--sandbox', 'read-only']), ['--sandbox', 'read-only']);
});

test('the screen says how firmly each permission is held: a removed tool is enforced, a command pattern is not a boundary, the rest is advice', () => {
  const rows = (provider, id) => Object.fromEntries(describePermissions(provider, TEMPLATES[id].toolPermissions).map((row) => [row.tool, row]));
  const pm = rows('claude', 'pm');
  assert.equal(pm.fileWrite.enforcement, 'partial', 'the PM may still run a shell command that changes a file');
  assert.match(pm.fileWrite.how, /the shell can still change files/);
  assert.equal(pm.gitPush.enforcement, 'partial');
  assert.match(pm.gitPush.how, /not a boundary/);
  assert.equal(pm.mcp.enforcement, 'enforced');
  assert.equal(pm.shell.enforcement, 'none');
  const researcher = rows('claude', 'researcher');
  assert.equal(researcher.shell.enforcement, 'enforced');
  assert.equal(researcher.fileWrite.enforcement, 'enforced', 'with the shell denied too, nothing is left');
  assert.equal(researcher.gitPush.enforcement, 'enforced');
  const codex = rows('codex', 'pm');
  assert.equal(codex.fileWrite.enforcement, 'enforced');
  assert.match(codex.fileWrite.how, /--sandbox read-only/);
  for (const tool of TOOLS.filter((tool) => tool !== 'fileWrite')) assert.equal(codex[tool].enforcement, 'advice', tool);
  for (const row of Object.values(rows('agy', 'pm'))) assert.equal(row.enforcement, 'advice');
  for (const row of Object.values(rows('custom-x', 'worker'))) assert.equal(row.enforcement, 'advice');
});

test('the lines never say "enforced" for something that is only a command pattern, and always say what the CLI is given', () => {
  const lines = permissionLines('claude', TEMPLATES.pm.toolPermissions);
  assert.ok(lines.some((line) => /^fileWrite: deny — PARTLY enforced/.test(line)));
  assert.ok(lines.some((line) => /^gitPush: deny — PARTLY enforced/.test(line)));
  assert.ok(lines.some((line) => /^mcp: deny — ENFORCED/.test(line)));
  assert.ok(lines.some((line) => /^shell: allow — no rule/.test(line)));
  assert.ok(lines.some((line) => /Claude Code is passed \d+ deny and \d+ ask rules?; your own settings files still apply/.test(line)));
  assert.ok(permissionLines('codex', TEMPLATES.pm.toolPermissions).some((line) => /Codex is passed: --sandbox read-only\./.test(line)));
  assert.ok(permissionLines('codex', TEMPLATES.worker.toolPermissions).some((line) => /Codex is passed no permission flag\./.test(line)));
});

test('the Broker role follows the role group, and a group that disagrees with its Broker role is reported', () => {
  assert.deepEqual(brokerRoleFor({ role: 'pm', toolPermissions: TEMPLATES.pm.toolPermissions }), { brokerRole: 'pm', conflicts: [] });
  assert.deepEqual(brokerRoleFor({ role: 'worker', toolPermissions: TEMPLATES.worker.toolPermissions }), { brokerRole: 'worker', conflicts: [] });
  assert.deepEqual(brokerRoleFor({ role: 'researcher', toolPermissions: TEMPLATES.researcher.toolPermissions }), { brokerRole: null, conflicts: [] }, 'a researcher has no Broker write operation');
  assert.deepEqual(brokerRoleFor({ role: 'pm', toolPermissions: { ...TEMPLATES.pm.toolPermissions, gitCommit: 'allow', fileWrite: 'ask' } }).conflicts.sort(), ['fileWrite-must-be-denied-for-pm', 'gitCommit-must-be-denied-for-pm']);
  assert.deepEqual(brokerRoleFor({ role: 'worker', toolPermissions: { ...TEMPLATES.worker.toolPermissions, prReview: 'allow', merge: 'ask' } }).conflicts.sort(), ['merge-must-be-denied-for-worker', 'prReview-must-be-denied-for-worker']);
  for (const bad of [null, undefined, 'x', {}, { role: 'pm' }, { role: 'pm', toolPermissions: [] }]) assert.deepEqual(brokerRoleFor(bad), { brokerRole: null, conflicts: [] });
});

test('a role group saved before the finer tools existed keeps meaning what it meant: git and GitHub steps follow githubWrite, MCP stays denied', () => {
  const old = validateRoleGroup(group('worker', { shell: 'allow', fileWrite: 'allow', network: 'ask', githubRead: 'allow', githubWrite: 'ask', merge: 'deny' }));
  assert.equal(old.ok, true);
  for (const tool of ['gitCommit', 'gitPush', 'prCreate', 'prReview', 'comment']) assert.equal(old.group.toolPermissions[tool], 'ask', `${tool} follows githubWrite`);
  assert.equal(old.group.toolPermissions.mcp, 'deny');
  assert.deepEqual(inheritedTools({ githubWrite: 'ask', shell: 'allow' }), ['gitCommit', 'gitPush', 'prCreate', 'prReview', 'comment']);
  const stated = validateRoleGroup(group('worker', { githubWrite: 'ask', gitPush: 'deny', comment: 'allow' }));
  assert.deepEqual([stated.group.toolPermissions.gitPush, stated.group.toolPermissions.comment, stated.group.toolPermissions.gitCommit], ['deny', 'allow', 'ask'], 'a stated level is never replaced');
  const denied = validateRoleGroup(group('pm', { githubWrite: 'deny' }));
  assert.equal(denied.group.toolPermissions.gitCommit, 'deny');
  for (const bad of [undefined, {}, { shell: 'allow' }]) assert.deepEqual(inheritedTools(bad === undefined ? undefined : bad).length, 0);
  const fresh = validateRoleGroup({ ...group('worker', undefined), toolPermissions: undefined });
  assert.ok(Object.values(fresh.group.toolPermissions).every((level) => level === 'deny'), 'no tool permissions at all: everything is denied');
});

test('the preview shows what a launch gives the CLI, and a stronger layer\'s ban is what is passed', () => {
  const worker = { ...group('worker', { ...TEMPLATES.worker.toolPermissions }) };
  const preview = previewEffectiveRules({ roleGroup: worker, layers: { platform: [{ id: 'p-no-push', type: 'forbid', key: 'tool:gitPush', version: 1 }] } });
  assert.equal(preview.ok, true);
  const text = formatPreview(preview);
  assert.match(text, /What the CLI is given when this role is started \(a launch passes this; this preview passes nothing\):/);
  assert.match(text, /gitPush: deny — PARTLY enforced/, 'the platform layer\'s forbid is what the CLI would be given');
  assert.match(text, /Broker role: worker; consistent with this role's permissions\./);
  const pm = previewEffectiveRules({ roleGroup: group('pm', { ...TEMPLATES.pm.toolPermissions, gitCommit: 'allow' }), layers: {} });
  assert.match(formatPreview(pm), /Broker role: pm; DISAGREES with this role's permissions \(gitCommit-must-be-denied-for-pm\)/);
  const researcher = previewEffectiveRules({ roleGroup: group('researcher', { ...TEMPLATES.researcher.toolPermissions }), layers: {} });
  assert.match(formatPreview(researcher), /Broker role: none/);
});
