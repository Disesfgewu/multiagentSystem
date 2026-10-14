'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderContext, planInjection, writePlan, cleanupPlan } = require('../../src/memory/injection');

const failure = (code) => Object.assign(new Error(`synthetic ${code}`), { code });

const roleGroup = { id: 'impl', name: 'Implementation' };
const rules = {
  forbids: [{ id: 'p1', layer: 'platform', key: 'git.merge' }],
  requires: [{ id: 'r1', layer: 'roleGroup', key: 'tests.run' }],
  instructions: [
    { id: 't1', layer: 'task', text: 'Keep the change small.' },
    { id: 'u1', layer: 'user', text: 'Prefer plain language.' }
  ],
  conflicts: [],
  sources: []
};
const memories = [
  { id: 'mem_b', content: 'Release builds use the packaging script.', source: { ref: 'docs/RELEASE.md' }, verifiedAt: '2026-01-02T00:00:00.000Z' },
  { id: 'mem_a', content: 'Migrations run before tests.', source: { ref: 'docs/DB.md' }, verifiedAt: '2026-01-03T00:00:00.000Z' }
];

function paths(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multiagent-inject-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(repoRoot);
  return { root, repoRoot, privateDir: path.join(root, 'private'), codexHome: path.join(root, 'codex-home') };
}

const base = (p, extra) => ({
  roleGroup, rules, memories, repoRoot: p.repoRoot, privateDir: p.privateDir,
  sessionToken: 'abcdef123456', ...extra
});

test('context is deterministic: rules by layer strength, memory by id', () => {
  const first = renderContext({ roleGroup, rules, memories });
  const second = renderContext({ roleGroup, rules, memories: [...memories].reverse() });
  assert.equal(first, second);
  assert.ok(first.indexOf('Prefer plain language.') < first.indexOf('Keep the change small.'));
  assert.ok(first.indexOf('mem_a') === -1, 'internal ids are not rendered');
  assert.ok(first.indexOf('Migrations run before tests.') < first.indexOf('Release builds use'));
  assert.match(first, /Do not: git\.merge/);
  assert.match(first, /Always: tests\.run/);
});

test('Claude plan passes a file path in argv and keeps content in a private file', (t) => {
  const p = paths(t);
  const plan = planInjection(base(p, { provider: 'claude', capabilities: { appendSystemPromptFile: true } }));
  assert.equal(plan.method, 'append-system-prompt-file');
  assert.deepEqual(plan.argv, ['--append-system-prompt-file', plan.files[0].path]);
  assert.ok(plan.files[0].path.startsWith(p.privateDir));
  for (const arg of plan.argv) {
    assert.equal(arg.includes('Migrations run before tests.'), false);
  }
  assert.match(plan.files[0].content, /Migrations run before tests\./);
});

test('Claude without the file flag falls back to a manual plan', (t) => {
  const p = paths(t);
  const plan = planInjection(base(p, { provider: 'claude', capabilities: {} }));
  assert.equal(plan.method, 'manual');
  assert.deepEqual(plan.argv, []);
});

test('Codex plan uses a per-session profile file in CODEX_HOME and only a name in argv', (t) => {
  const p = paths(t);
  const plan = planInjection(base(p, {
    provider: 'codex', codexHome: p.codexHome, capabilities: { profileFlag: true }
  }));
  assert.equal(plan.method, 'profile-developer-instructions');
  assert.deepEqual(plan.argv, ['-p', 'mas-abcdef123456']);
  assert.equal(plan.files[0].path, path.join(p.codexHome, 'mas-abcdef123456.config.toml'));
  const match = /^developer_instructions = (".*")\n$/s.exec(plan.files[0].content);
  assert.ok(match, 'single TOML basic string');
  assert.equal(JSON.parse(match[1]), renderContext({ roleGroup, rules, memories }));
});

test('TOML escaping covers quotes, newlines, backslashes and DEL', (t) => {
  const p = paths(t);
  const tricky = [{ ...memories[0], id: 'mem_x', content: 'Say "hi"\\now\u007f.' }];
  const plan = planInjection(base(p, {
    provider: 'codex', memories: tricky, codexHome: p.codexHome, capabilities: { profileFlag: true }
  }));
  const value = /^developer_instructions = (".*")\n$/s.exec(plan.files[0].content)[1];
  assert.equal(value.includes('\u007f'), false);
  assert.equal(JSON.parse(value).includes('Say "hi"\\now\u007f.'), true);
});

test('locations inside the repository, bad tokens and unknown providers are rejected', (t) => {
  const p = paths(t);
  const claude = { provider: 'claude', capabilities: { appendSystemPromptFile: true } };
  assert.throws(() => planInjection(base(p, { ...claude, privateDir: path.join(p.repoRoot, '.private') })),
    /private-root-inside-repo/);
  assert.throws(() => planInjection(base(p, { ...claude, sessionToken: '../escape' })), /invalid session token/);
  assert.throws(() => planInjection(base(p, { provider: 'other' })), /unsupported provider/);
  assert.throws(() => planInjection(base(p, {
    provider: 'codex', codexHome: path.join(p.repoRoot, '.codex'), capabilities: { profileFlag: true }
  })), /CODEX_HOME rejected/);
});

test('files are written owner-only and cleanup removes them', (t) => {
  const p = paths(t);
  const plan = planInjection(base(p, { provider: 'claude', capabilities: { appendSystemPromptFile: true } }));
  writePlan(plan);
  assert.equal(fs.readFileSync(plan.files[0].path, 'utf8'), plan.files[0].content);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(plan.files[0].path).mode & 0o777, 0o600);
  }
  cleanupPlan(plan);
  assert.equal(fs.existsSync(plan.files[0].path), false);
});

const claudeOptions = (p, extra) => base(p, {
  provider: 'claude', capabilities: { appendSystemPromptFile: true }, ...extra
});

test('a link below the private root that points into the repository is refused and nothing is written', (t) => {
  const p = paths(t);
  fs.mkdirSync(p.privateDir);
  try {
    fs.symlinkSync(p.repoRoot, path.join(p.privateDir, 'sessions'), 'junction');
  } catch (error) {
    t.skip(`cannot create a directory link here: ${error.code}`);
    return;
  }
  const plan = planInjection(claudeOptions(p));
  assert.throws(() => writePlan(plan), /private-path-not-a-directory/);
  assert.deepEqual(fs.readdirSync(p.repoRoot), []);
  assert.equal(plan.created, undefined);
});

test('a session directory that already exists is never reused, overwritten or cleaned up', (t) => {
  const p = paths(t);
  const first = planInjection(claudeOptions(p));
  writePlan(first);
  const filePath = first.files[0].path;
  const before = fs.readFileSync(filePath, 'utf8');
  fs.writeFileSync(path.join(path.dirname(filePath), 'unrelated.txt'), 'keep me');

  const second = planInjection(claudeOptions(p, { memories: [] }));
  assert.throws(() => writePlan(second), /private-path-exists/);
  cleanupPlan(second);

  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(path.dirname(filePath), 'unrelated.txt'), 'utf8'), 'keep me');

  cleanupPlan(first);
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(fs.existsSync(path.join(path.dirname(filePath), 'unrelated.txt')), true,
    'cleanup removes only what the plan created');
});

test('an existing Codex profile file is not overwritten and its mode is not trusted', (t) => {
  const p = paths(t);
  fs.mkdirSync(p.codexHome);
  const target = path.join(p.codexHome, 'mas-abcdef123456.config.toml');
  fs.writeFileSync(target, 'existing = true\n', { mode: 0o644 });
  const plan = planInjection(base(p, { provider: 'codex', codexHome: p.codexHome, capabilities: { profileFlag: true } }));
  assert.throws(() => writePlan(plan), /EEXIST/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'existing = true\n');
  cleanupPlan(plan);
  assert.equal(fs.existsSync(target), true);
});

test('only directories the plan created are removed, and a plan cannot be written twice', (t) => {
  const p = paths(t);
  const plan = planInjection(claudeOptions(p));
  writePlan(plan);
  assert.throws(() => writePlan(plan), /plan-already-written/);
  assert.ok(fs.existsSync(path.join(p.privateDir, 'sessions')));
  cleanupPlan(plan);
  assert.equal(fs.existsSync(path.join(p.privateDir, 'sessions')), false, 'directories it made are removed');
  assert.equal(fs.existsSync(p.privateDir), false);
});

test('unresolvable locations are rejected, not treated as missing', (t) => {
  const p = paths(t);
  const realpath = (value) => {
    if (value === p.privateDir) throw failure('EACCES');
    if (value === p.repoRoot) return value;
    throw failure('ENOENT');
  };
  assert.throws(() => planInjection(claudeOptions(p, { context: { realpath } })), /private-root-unresolvable/);
});
