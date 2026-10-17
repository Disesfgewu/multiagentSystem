'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TEMPLATES, templateIds, buildFromTemplate, describeRoleGroup } = require('../../src/roles/templates');
const { toolHelp, levelHelp, fieldHelp, TOOL_HELP, LEVEL_HELP, FIELD_HELP, ENFORCEMENT_NOTE, TOOLS, LEVELS } = require('../../src/roles/field-help');
const { injectionStatus, LABELS, STATES } = require('../../src/roles/injection-status');
const { previewEffectiveRules, formatPreview } = require('../../src/roles/preview');
const { validateRoleGroup } = require('../../src/roles/role-group');
const { builtIn } = require('../../src/providers/registry');

const build = (templateId, over = {}) => buildFromTemplate({ templateId, provider: 'claude', name: '', role: 'researcher', newId: 'role-test', ...over });

test('templates: PM, Developer, Researcher and Blank exist, and every one builds a valid role group for every provider', () => {
  assert.deepEqual(templateIds().sort(), ['blank', 'pm', 'researcher', 'worker']);
  for (const id of templateIds()) {
    for (const provider of builtIn.ids()) {
      const built = build(id, { provider });
      assert.equal(built.ok, true, `${id}/${provider}: ${JSON.stringify(built.problems)}`);
      assert.equal(validateRoleGroup(built.record.group).ok, true);
      assert.equal(built.record.group.provider, provider);
      assert.equal(built.record.group.version, 1);
      assert.equal(built.record.group.defaultAccountProfileId, null);
      assert.deepEqual(built.record.group.allowedScope, { repositories: [], paths: [] }, 'nothing is allowed until chosen');
      assert.deepEqual(built.record.group.memoryScope, { mode: 'off' });
      assert.deepEqual(built.record.layers, {});
    }
  }
});

test('templates fail closed: every tool is listed explicitly, merge is denied, and the blank template denies everything', () => {
  for (const id of ['pm', 'worker', 'researcher']) {
    const { group } = build(id).record;
    assert.deepEqual(Object.keys(group.toolPermissions).sort(), [...TOOLS].sort(), `${id} lists every tool`);
    assert.equal(group.toolPermissions.merge, 'deny', `${id} cannot merge`);
    if (id === 'researcher') {
      assert.equal(group.toolPermissions.githubWrite, 'deny', 'a researcher cannot write to github');
    } else {
      assert.equal(group.toolPermissions.githubWrite, 'ask', `${id} asks before changing GitHub`);
    }
    for (const level of Object.values(group.toolPermissions)) assert.ok(LEVELS.includes(level));
  }
  assert.ok(Object.values(build('blank').record.group.toolPermissions).every((level) => level === 'deny'));
  assert.equal(build('worker').record.group.toolPermissions.network, 'ask');
  assert.equal(build('pm').record.group.toolPermissions.fileWrite, 'ask', 'a PM does not write code by default');
  assert.equal(build('worker').record.group.toolPermissions.fileWrite, 'allow');
  assert.equal(build('researcher').record.group.toolPermissions.shell, 'deny');
  assert.equal(build('researcher').record.group.toolPermissions.fileWrite, 'deny');
  assert.equal(build('researcher').record.group.toolPermissions.network, 'allow');
  assert.equal(build('researcher').record.group.toolPermissions.githubRead, 'allow');
});

test('the template roles are fixed and the blank template takes an open role id', () => {
  assert.equal(build('pm').record.group.role, 'pm');
  assert.equal(build('worker').record.group.role, 'worker');
  assert.equal(build('researcher').record.group.role, 'researcher');
  assert.equal(build('pm', { role: 'ignored' }).record.group.role, 'pm');
  assert.equal(build('blank', { role: 'researcher' }).record.group.role, 'researcher');
  for (const role of ['', 'Has Space', 'UPPER', '1x', undefined, 'x'.repeat(40)]) assert.equal(build('blank', { role }).ok, false, String(role));
});

test('names default from the template, are trimmed, and a bad name is refused rather than repaired', () => {
  assert.equal(build('pm').record.group.name, 'PM');
  assert.equal(build('worker', { name: '  Backend  ' }).record.group.name, 'Backend');
  assert.equal(build('researcher').record.group.name, 'Researcher');
  assert.equal(build('worker', { name: 'x'.repeat(200) }).ok, false);
  assert.equal(build('worker', { name: 'two\nlines' }).ok, false);
});

test('bad inputs are refused without a partial result', () => {
  for (const templateId of ['', 'admin', undefined, null, 7, '__proto__', 'constructor', 'toString']) {
    const built = build(templateId);
    assert.equal(built.ok, false, String(templateId));
    assert.equal(built.record, undefined);
    assert.equal(built.problems[0].code, 'unknown-template');
  }
  for (const provider of ['opencode', '', undefined, 'CLAUDE', 'constructor']) assert.equal(buildFromTemplate({ templateId: 'pm', provider, newId: 'role-x' }).ok, false, String(provider));
});

test('every template instruction is plain text without private data or paths', () => {
  for (const template of Object.values(TEMPLATES)) {
    if (template.instruction) assert.equal(/[/\\]|@|token|secret/i.test(template.instruction), false, template.id);
    assert.ok(template.summary.length > 30);
  }
});

test('the template instruction becomes a role group rule that the preview shows with its source', () => {
  const { record } = build('worker');
  const preview = previewEffectiveRules({ roleGroup: record.group, layers: record.layers });
  assert.equal(preview.ok, true);
  assert.equal(preview.rules.instructions.some((rule) => rule.id === 'worker-template-instruction'), true);
  assert.equal(preview.permissions.find((entry) => entry.tool === 'merge').effective, 'deny');
  assert.equal(preview.permissions.find((entry) => entry.tool === 'shell').effective, 'allow');
});

test('help: every tool, level and field has a sentence, unknown names have none, and nothing claims enforcement', () => {
  for (const tool of TOOLS) assert.ok(toolHelp(tool).length > 15, tool);
  for (const level of LEVELS) assert.ok(levelHelp(level).length > 15, level);
  for (const field of ['role', 'provider', 'name', 'defaultAccount', 'repositories', 'paths', 'memory', 'instructions', 'tools']) assert.ok(fieldHelp(field).length > 15, field);
  for (const name of ['toString', 'constructor', '__proto__', 'nope', '', undefined, null, 5]) {
    assert.equal(toolHelp(name), null, String(name));
    assert.equal(levelHelp(name), null);
    assert.equal(fieldHelp(name), null);
  }
  assert.deepEqual(Object.keys(TOOL_HELP).sort(), [...TOOLS].sort(), 'help covers exactly the tools role groups know');
  assert.deepEqual(Object.keys(LEVEL_HELP).sort(), [...LEVELS].sort());
  const all = [...Object.values(TOOL_HELP), ...Object.values(LEVEL_HELP), ...Object.values(FIELD_HELP)].join(' ');
  assert.equal(/\benforced by\b|\bguarantee/i.test(all), false);
  assert.match(ENFORCEMENT_NOTE, /Not enforced yet/);
  assert.match(LEVEL_HELP.deny, /stronger layer/);
  assert.match(LEVEL_HELP.allow, /never overrides/);
});

test('the creation summary says what the agent may do, that it is not enforced, and what reached the CLI', () => {
  const text = describeRoleGroup(build('worker', { provider: 'claude' }).record);
  assert.match(text, /shell: allow — Run commands/);
  assert.match(text, /merge: deny — Merge a pull request/);
  assert.match(text, /Not enforced yet/);
  assert.match(text, /Anything not listed above is denied/);
  assert.match(text, /Rules in the CLI: Preview only: not sent to the CLI/);
  assert.match(describeRoleGroup(build('pm', { provider: 'agy' }).record), /Rules in the CLI: Not supported by this provider: give these rules to the agent by hand/);
  assert.equal(/applied|enforced by/i.test(text), false);
});

test('injection status: no provider is ever "sent" without evidence, and agy is manual', () => {
  assert.equal(injectionStatus({ provider: 'claude' }).state, 'preview-only');
  assert.equal(injectionStatus({ provider: 'codex' }).state, 'preview-only');
  assert.deepEqual(injectionStatus({ provider: 'agy' }), { state: 'unsupported', label: LABELS.unsupported, reason: 'provider-injection-unknown' });
  for (const provider of ['opencode', '', undefined, null, 'constructor', '__proto__']) {
    assert.deepEqual([injectionStatus({ provider }).state, injectionStatus({ provider }).reason], ['unsupported', 'unknown-provider'], String(provider));
  }
  assert.deepEqual(injectionStatus(), { state: 'unsupported', label: LABELS.unsupported, reason: 'unknown-provider' });
  assert.deepEqual(STATES, ['sent-to-cli', 'preview-only', 'unsupported']);
});

test('evidence alone cannot make rules "sent": the provider capability must be verified and the evidence must match', () => {
  const evidence = (over = {}) => ({ kind: 'injected', provider: 'claude', digest: 'sha256:abc', ...over });
  // today no capability is verified, so even matching evidence does not produce "sent"
  assert.equal(injectionStatus({ provider: 'claude', evidence: evidence(), digest: 'sha256:abc' }).state, 'preview-only');
  assert.equal(injectionStatus({ provider: 'agy', evidence: evidence({ provider: 'agy' }), digest: 'sha256:abc' }).state, 'unsupported');
  // with a verified capability (a registry the product does not have yet), only matching evidence counts
  const { createRegistry } = require('../../src/providers/registry');
  const registry = createRegistry([{ id: 'claude', label: 'Claude', executable: 'claude', support: 'dedicated', capabilities: { ruleInjection: 'verified' } }]);
  assert.equal(injectionStatus({ provider: 'claude', registry, evidence: evidence(), digest: 'sha256:abc' }).state, 'sent-to-cli');
  for (const bad of [undefined, null, 'x', evidence({ kind: 'planned' }), evidence({ provider: 'codex' }), evidence({ digest: 'sha256:other' }), evidence({ digest: '' }), evidence({ digest: undefined })]) {
    const result = injectionStatus({ provider: 'claude', registry, evidence: bad, digest: 'sha256:abc' });
    assert.deepEqual([result.state, result.reason], ['preview-only', 'no-launch-evidence'], JSON.stringify(bad));
  }
  assert.equal(injectionStatus({ provider: 'claude', registry, evidence: evidence({ digest: '' }), digest: '' }).state, 'preview-only', 'an empty digest is no evidence');
  const unverified = createRegistry([{ id: 'claude', label: 'Claude', executable: 'claude', support: 'dedicated', capabilities: { ruleInjection: 'unverified' } }]);
  assert.equal(injectionStatus({ provider: 'claude', registry: unverified, evidence: evidence(), digest: 'sha256:abc' }).state, 'preview-only');
  const unsupported = createRegistry([{ id: 'claude', label: 'Claude', executable: 'claude', support: 'dedicated', capabilities: { ruleInjection: 'unsupported' } }]);
  assert.equal(injectionStatus({ provider: 'claude', registry: unsupported }).reason, 'provider-unsupported');
});

test('the preview tags every rule and every tool permission with what happened to it', () => {
  const { record } = build('worker');
  const preview = previewEffectiveRules({ roleGroup: record.group, layers: { platform: [{ id: 'p-no-merge', type: 'forbid', key: 'tool:merge', version: 1 }] } });
  const text = formatPreview(preview, { injection: injectionStatus({ provider: 'claude' }) });
  assert.match(text, /Rules in the CLI: Preview only: not sent to the CLI/);
  const ruleLines = text.split('\n').filter((line) => /^  - (forbid|require|instruction)/.test(line));
  assert.ok(ruleLines.length >= 2);
  for (const line of ruleLines) assert.match(line, /<NOT sent to the CLI>$/);
  const toolLines = text.split('\n').filter((line) => /^  - (shell|fileWrite|network|githubRead|githubWrite|merge):/.test(line));
  assert.equal(toolLines.length, 6);
  for (const line of toolLines) assert.match(line, /<told to the agent only, not enforced>$/);
  const manual = formatPreview(preview, { injection: injectionStatus({ provider: 'agy' }) });
  for (const line of manual.split('\n').filter((entry) => /^  - (forbid|require|instruction)/.test(entry))) assert.match(line, /<not supported: give by hand>$/);
  assert.match(manual, /Rules in the CLI: Not supported by this provider/);
});

test('without a status the preview is unchanged, and an unknown state adds no claim', () => {
  const { record } = build('pm');
  const preview = previewEffectiveRules({ roleGroup: record.group, layers: {} });
  const plain = formatPreview(preview);
  assert.equal(plain.includes('Rules in the CLI'), false);
  assert.equal(plain.includes('<'), false);
  for (const state of ['applied', '__proto__', 'constructor', undefined]) {
    const text = formatPreview(preview, { injection: { state, label: 'Applied' } });
    assert.equal(text.split('\n').filter((line) => /^  - (forbid|require|instruction)/.test(line)).some((line) => line.includes('<')), false, String(state));
  }
});

test('researcher template instruction becomes a role group rule and effective permissions are fail-closed', () => {
  const { record } = build('researcher');
  const preview = previewEffectiveRules({ roleGroup: record.group, layers: record.layers });
  assert.equal(preview.ok, true);
  assert.equal(preview.rules.instructions.some((rule) => rule.id === 'researcher-template-instruction'), true);
  assert.equal(preview.permissions.find((entry) => entry.tool === 'merge').effective, 'deny');
  assert.equal(preview.permissions.find((entry) => entry.tool === 'shell').effective, 'deny');
  assert.equal(preview.permissions.find((entry) => entry.tool === 'fileWrite').effective, 'deny');
  assert.equal(preview.permissions.find((entry) => entry.tool === 'network').effective, 'allow');
  assert.equal(preview.permissions.find((entry) => entry.tool === 'githubRead').effective, 'allow');
  assert.equal(preview.permissions.find((entry) => entry.tool === 'githubWrite').effective, 'deny');
});

const HASH = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const entry = (serverId, tools, over = {}) => ({
  serverId, name: serverId, description: 'synthetic catalog entry', version: '1.0.0', integrity: HASH,
  source: 'https://github.com/example/synthetic.git', license: 'MIT', command: ['node', 'server.js'],
  tools: tools.map((name) => ({ name, readOnly: true })), env: {}, ...over
});
const arxiv = () => entry('arxiv-mcp-server', ['search_papers', 'get_abstract', 'read_paper', 'download_paper']);
const github = () => entry('github-mcp-server', ['get_file_contents', 'search_code']);
const researcherWith = (over) => {
  const { record } = build('researcher');
  record.group.toolPermissions = { ...record.group.toolPermissions, ...over };
  return record;
};
const both = (record, options) => {
  const preview = previewEffectiveRules({ roleGroup: record.group, layers: record.layers });
  assert.equal(preview.ok, true);
  return { summary: describeRoleGroup(record, options), preview: formatPreview(preview, options) };
};

test('MCP preview is worded as a static policy check, never as an effective or permitted tool', () => {
  const options = { catalog: [arxiv()], allowlist: { 'arxiv-mcp-server': ['search_papers', 'get_abstract'] } };
  const { summary, preview } = both(build('researcher').record, options);
  for (const text of [summary, preview]) {
    assert.match(text, /MCP tool preview \(static policy check only: not sent to any CLI, not enforced, runtime authorization unknown, catalog sources unverified\):/);
    assert.match(text, /arxiv-mcp-server: search_papers, get_abstract -> allowed by role settings \(preview only, not a runtime permission\)/);
    assert.match(text, /arxiv-mcp-server\/read_paper -> blocked \(not in the requested list\)/);
    assert.match(text, /arxiv-mcp-server\/download_paper -> blocked \(not in the requested list\)/);
    assert.equal(/\bpermitted\b|requested -> effective|authorized -> effective|\bverified\b(?! )/.test(text.replace(/unverified/g, '')), false, 'no claim of permission or verification');
  }
  assert.match(describeRoleGroup(build('researcher').record, { catalog: [arxiv()], allowlist: {} }), /\(no MCP tool is allowed by these role settings\)/);
});

test('a role deny is kept: githubRead deny blocks a valid read-only GitHub tool, even with network allow', () => {
  const record = researcherWith({ githubRead: 'deny', network: 'allow' });
  const options = { catalog: [github()], allowlist: { 'github-mcp-server': ['get_file_contents'] } };
  const { summary, preview } = both(record, options);
  for (const text of [summary, preview]) {
    assert.match(text, /github-mcp-server\/get_file_contents -> blocked \(role setting githubRead: deny\)/);
    assert.equal(text.includes('get_file_contents -> allowed'), false);
    assert.match(text, /\(no MCP tool is allowed by these role settings\)/);
  }
});

test('every role permission a tool needs is checked: network deny and fileWrite deny block', () => {
  const allow = { 'arxiv-mcp-server': ['search_papers', 'download_paper', 'read_paper'] };
  const netDeny = both(researcherWith({ network: 'deny' }), { catalog: [arxiv()], allowlist: allow });
  assert.match(netDeny.summary, /arxiv-mcp-server\/search_papers -> blocked \(role setting network: deny\)/);
  assert.match(netDeny.summary, /arxiv-mcp-server: read_paper -> allowed/, 'a local cache read needs no network permission');
  const writeDeny = both(build('researcher').record, { catalog: [arxiv()], allowlist: allow });
  assert.match(writeDeny.preview, /arxiv-mcp-server\/download_paper -> blocked \(role setting fileWrite: deny\)/);
  assert.match(writeDeny.preview, /arxiv-mcp-server: search_papers, read_paper -> allowed/);
});

test('ask is shown as needing confirmation and is never listed as allowed', () => {
  const record = researcherWith({ githubRead: 'ask', network: 'ask' });
  const options = { catalog: [github(), arxiv()], allowlist: { 'github-mcp-server': ['search_code'], 'arxiv-mcp-server': ['search_papers', 'read_paper'] } };
  for (const text of Object.values(both(record, options))) {
    assert.match(text, /Needs your confirmation \(role setting: ask\):/);
    assert.match(text, /github-mcp-server\/search_code -> ask before use \(githubRead, network\)/);
    assert.match(text, /arxiv-mcp-server\/search_papers -> ask before use \(network\)/);
    assert.equal(/search_code -> allowed|search_papers.*-> allowed/.test(text), false);
    assert.match(text, /arxiv-mcp-server: read_paper -> allowed/);
  }
});

test('a tool with no reviewed capability is never allowed, whatever its name or catalog entry says', () => {
  const unknownTools = entry('github-mcp-server', ['get_file_contents', 'get_issue_comments', 'create_issue']);
  const unknownServer = entry('synthetic-github-server', ['get_file_contents', 'search_papers']);
  const options = {
    catalog: [unknownTools, unknownServer],
    allowlist: { 'github-mcp-server': ['get_file_contents', 'get_issue_comments', 'create_issue'], 'synthetic-github-server': ['get_file_contents', 'search_papers'] }
  };
  for (const text of Object.values(both(build('researcher').record, options))) {
    assert.match(text, /github-mcp-server: get_file_contents -> allowed/);
    assert.match(text, /github-mcp-server\/get_issue_comments -> blocked \(capability not reviewed \(unknown\): treated as not allowed\)/);
    assert.match(text, /github-mcp-server\/create_issue -> blocked \(capability not reviewed/);
    assert.match(text, /synthetic-github-server\/get_file_contents -> blocked \(capability not reviewed/);
    assert.match(text, /synthetic-github-server\/search_papers -> blocked \(capability not reviewed/);
    assert.equal(/synthetic-github-server: .*allowed/.test(text), false);
  }
});

test('a write tool or a hostile command in the catalog is rejected by the catalog validator before any role check', () => {
  const writeTool = entry('github-mcp-server', ['get_file_contents']);
  writeTool.tools.push({ name: 'write_issue', readOnly: false });
  const shell = entry('arxiv-mcp-server', ['search_papers'], { command: ['bash', '-c', 'echo x'] });
  const options = { catalog: [writeTool, shell], allowlist: { 'github-mcp-server': ['get_file_contents', 'write_issue'], 'arxiv-mcp-server': ['search_papers'] } };
  for (const text of Object.values(both(build('researcher').record, options))) {
    assert.match(text, /catalog entry github-mcp-server: rejected \(write-tool-forbidden\)/);
    assert.match(text, /catalog entry arxiv-mcp-server: rejected \(shell-executable-forbidden\)/);
    assert.match(text, /github-mcp-server\/write_issue -> blocked \(catalog invalid \(write-tool-forbidden\)\)/);
    assert.match(text, /\(no MCP tool is allowed by these role settings\)/);
  }
});

test('damaged or incomplete catalog input never throws and never breaks the role preview', () => {
  const record = build('researcher').record;
  const damaged = [
    [null], [undefined, 5, 'x', []], [{}], [{ serverId: 'bad-item' }], [{ serverId: 'bad-item', tools: 'not-a-list' }],
    [{ serverId: 'x'.repeat(200), tools: [] }], [{ serverId: 'a\u202Eb\u0000c', tools: [{ name: 'x\u202E', readOnly: true }] }],
    'not-an-array', {}, 7
  ];
  for (const catalog of damaged) {
    for (const allowlist of [undefined, null, 'x', [], { 'bad-item': ['some_tool'] }, { 'bad-item': 'x' }, { 'bad-item': [null, 5, {}] }]) {
      assert.doesNotThrow(() => {
        const { summary, preview } = both(record, { catalog, allowlist });
        assert.match(summary, /Role: researcher/);
        assert.match(preview, /Role group: Researcher/);
        assert.equal(/\u202E|\u0000/.test(summary + preview), false, 'no hidden or control characters are rendered');
      }, JSON.stringify([catalog, allowlist]));
    }
  }
  const { preview } = both(record, { catalog: [null], allowlist: {} });
  assert.match(preview, /catalog entry unknown: rejected \(invalid-catalog-item\)/);
  assert.match(both(record, { catalog: 'nope' }).summary, /catalog could not be read: catalog-not-array/);
});

test('inherited object keys and hostile names are not treated as reviewed tools or servers', () => {
  const hostile = entry('github-mcp-server', ['get_file_contents']);
  const options = { catalog: [hostile], allowlist: { 'github-mcp-server': ['constructor', '__proto__', 'toString', 'get_file_contents'], __proto__: ['x'], constructor: ['y'] } };
  const text = both(build('researcher').record, options).summary;
  assert.match(text, /github-mcp-server: get_file_contents -> allowed/);
  assert.match(text, /github-mcp-server\/constructor -> blocked \(not found in the catalog entry\)/);
  assert.equal(/toString -> allowed|__proto__ -> allowed/.test(text), false);
  const inherited = entry('constructor', ['constructor']);
  assert.match(both(build('researcher').record, { catalog: [inherited], allowlist: { constructor: ['constructor'] } }).summary, /constructor\/constructor -> blocked \(capability not reviewed/);
  const rejected = entry('constructor', ['toString']);
  assert.match(both(build('researcher').record, { catalog: [rejected], allowlist: { constructor: ['toString'] } }).summary, /constructor\/toString -> blocked \(catalog invalid/);
});

test('both views come from one evaluation, so they list the same tools', () => {
  const options = { catalog: [arxiv(), github()], allowlist: { 'arxiv-mcp-server': ['get_abstract'], 'github-mcp-server': ['search_code', 'missing_tool'] } };
  const { summary, preview } = both(researcherWith({ githubRead: 'ask' }), options);
  const lines = (text) => text.split('\n').filter((line) => /->/.test(line) && /(allowed|ask before|blocked)/.test(line)).map((line) => line.replace(/^\s*[-•]\s+/, ''));
  assert.deepEqual(lines(preview), lines(summary));
  assert.ok(lines(summary).length >= 5);
});
