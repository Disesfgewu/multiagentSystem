'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const skills = require('../../src/skills/workspace-skills');

const repoRoot = path.resolve(__dirname, '..', '..');
const skillsRoot = path.join(repoRoot, 'resources', 'agent-skills');
const templatesRoot = path.join(repoRoot, 'resources', 'agent-templates');
const BUNDLED = ['code-review-on-git', 'fetch-comments', 'fetch-issues', 'fetch-prs', 'raise-issue', 'raise-pr', 'resolve-conflicts', 'resolve-issues'];

function world(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-skills-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const workspace = path.join(sandbox, 'project');
  fs.mkdirSync(workspace);
  return { sandbox, workspace };
}

function memoryStore(initial = {}) {
  const data = { ...initial };
  return { data, get: (key) => data[key], update: async (key, value) => { if (value === undefined) delete data[key]; else data[key] = JSON.parse(JSON.stringify(value)); } };
}

function fakeUi(answers = []) {
  const calls = [];
  return {
    calls,
    async confirm(message, detail, button) { calls.push({ message, detail, button }); return answers.length ? answers.shift() : false; },
    info(message) { calls.push({ info: message }); },
    error(message) { calls.push({ error: message }); }
  };
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).map((p) => String(p).split(path.sep).join('/')).sort();
}

const deps = (workspace, over = {}) => ({ isTestMode: false, arg: undefined, workspaceRoot: workspace, skillsRoot, templatesRoot, store: memoryStore(), ui: fakeUi(), ...over });

test('bundled skills are the eight generic procedures with no repository-specific values', () => {
  const loaded = skills.loadBundledSkills(skillsRoot);
  assert.deepEqual(loaded.map((entry) => entry.rel), BUNDLED.map((name) => `.claude/skills/${name}/SKILL.md`));
  const all = loaded.concat(skills.loadBundledTemplates(templatesRoot));
  for (const entry of all) {
    const text = entry.content.toString('utf8');
    assert.doesNotMatch(text, /multiagentSystem|Disesfgewu|this repo\b|#\d+/i, entry.rel);
    assert.doesNotMatch(text, /\/Users\/|\/home\/|C:\\\\|(^|[\s"'(])\/tmp\//, entry.rel);
    assert.doesNotMatch(text, /`(ready|mvp|blocked|priority)`/, entry.rel);
  }
  for (const entry of loaded) assert.match(entry.content.toString('utf8'), /^---\r?\nname: [a-z-]+\r?\ndescription: /, entry.rel);
  assert.match(fs.readFileSync(path.join(skillsRoot, 'raise-issue', 'SKILL.md'), 'utf8'), /gh label list/);
  assert.match(fs.readFileSync(path.join(skillsRoot, 'raise-issue', 'SKILL.md'), 'utf8'), /gh repo view/);
});

test('outside Extension Test mode an interactive:false argument never skips the dialog', async (t) => {
  assert.equal(skills.resolveInteractive(false, { interactive: false }), true);
  assert.equal(skills.resolveInteractive(undefined, { interactive: false }), true);
  assert.equal(skills.resolveInteractive('true', { interactive: false }), true);
  assert.equal(skills.resolveInteractive(true, { interactive: false }), false);
  assert.equal(skills.resolveInteractive(true, undefined), true);

  const { workspace } = world(t);
  const ui = fakeUi([false]);
  const result = await skills.runInstall(deps(workspace, { isTestMode: false, arg: { interactive: false, includeTemplates: true }, ui }));
  assert.equal(result.code, 'cancelled');
  assert.equal(ui.calls.filter((call) => call.button).length, 1, 'the modal was shown despite interactive:false');
  assert.deepEqual(listFiles(workspace), []);
});

test('nothing is written before consent, and the dialog lists exactly the files to be written', async (t) => {
  const { workspace } = world(t);
  const ui = fakeUi([false]);
  const store = memoryStore();
  const result = await skills.runInstall(deps(workspace, { ui, store }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'cancelled');
  assert.deepEqual(listFiles(workspace), []);
  assert.deepEqual(store.data, {});
  const [dialog] = ui.calls;
  assert.equal(dialog.button, 'Install');
  for (const name of BUNDLED) assert.ok(dialog.detail.includes(`.claude/skills/${name}/SKILL.md`), name);
  assert.match(dialog.detail, /Codex: not supported/);
  assert.match(dialog.detail, /agy: not supported/);
  assert.equal(ui.calls.length, 1, 'templates are not offered when skills were declined');
});

test('after consent skills are written, and the template offer is a separate confirmation', async (t) => {
  const { workspace } = world(t);
  const ui = fakeUi([true, false]);
  const store = memoryStore();
  const result = await skills.runInstall(deps(workspace, { ui, store }));
  assert.equal(result.ok, true);
  assert.equal(result.written.length, BUNDLED.length);
  assert.deepEqual(listFiles(path.join(workspace, '.claude', 'skills')).filter((p) => p.endsWith('SKILL.md')), BUNDLED.map((n) => `${n}/SKILL.md`));
  assert.equal(fs.readFileSync(path.join(workspace, '.claude/skills/fetch-prs/SKILL.md'), 'utf8'), fs.readFileSync(path.join(skillsRoot, 'fetch-prs/SKILL.md'), 'utf8'));
  assert.equal(ui.calls[1].button, 'Add Templates');
  assert.match(ui.calls[1].detail, /\.github\/pull_request_template\.md/);
  assert.equal(fs.existsSync(path.join(workspace, '.github')), false, 'declined templates are not written');
  assert.ok(!listFiles(workspace).some((p) => p.endsWith('.tmp')), 'no temporary files left behind');
  const record = store.data[skills.recordKey(workspace)];
  assert.equal(record.files.length, BUNDLED.length);
  assert.deepEqual(record.dirs, ['.claude', '.claude/skills', ...BUNDLED.map((n) => `.claude/skills/${n}`)]);
});

test('existing user files and same-named skill folders are listed as conflicts and never overwritten', async (t) => {
  const { workspace } = world(t);
  fs.mkdirSync(path.join(workspace, '.claude', 'skills', 'fetch-prs'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.claude', 'skills', 'fetch-prs', 'notes.md'), 'my own skill folder');
  fs.mkdirSync(path.join(workspace, '.claude', 'skills', 'raise-pr'));
  fs.writeFileSync(path.join(workspace, '.claude', 'skills', 'raise-pr', 'SKILL.md'), 'user skill');
  fs.mkdirSync(path.join(workspace, '.github'));
  fs.writeFileSync(path.join(workspace, '.github', 'pull_request_template.md'), 'user template');

  const ui = fakeUi([true, true]);
  const store = memoryStore();
  const result = await skills.runInstall(deps(workspace, { ui, store }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.conflicts.sort(), ['.claude/skills/fetch-prs/SKILL.md', '.claude/skills/raise-pr/SKILL.md', '.github/pull_request_template.md']);
  assert.match(ui.calls[0].detail, /will NOT be overwritten[\s\S]*\.claude\/skills\/raise-pr\/SKILL\.md/);
  assert.ok(!ui.calls[0].detail.split('will NOT')[0].includes('raise-pr'), 'conflicts are not in the write list');
  assert.equal(fs.readFileSync(path.join(workspace, '.claude/skills/raise-pr/SKILL.md'), 'utf8'), 'user skill');
  assert.equal(fs.existsSync(path.join(workspace, '.claude/skills/fetch-prs/SKILL.md')), false);
  assert.equal(fs.readFileSync(path.join(workspace, '.github/pull_request_template.md'), 'utf8'), 'user template');
  assert.ok(fs.existsSync(path.join(workspace, '.github/ISSUE_TEMPLATE/standard.md')));
  assert.match(result.message, /Skipped 3 existing/);
  const record = store.data[skills.recordKey(workspace)];
  assert.ok(!record.files.some((file) => file.path.includes('raise-pr') || file.path === '.github/pull_request_template.md'));
  assert.ok(!record.dirs.includes('.claude') && !record.dirs.includes('.github'), 'pre-existing folders are not claimed');

  // A second install writes nothing and asks nothing.
  const again = fakeUi([]);
  const second = await skills.runInstall(deps(workspace, { ui: again, store }));
  assert.equal(second.code, 'nothing-to-write');
  assert.equal(again.calls.filter((call) => call.button).length, 0);
});

test('a file that appears after the dialog is not overwritten', async (t) => {
  const { workspace } = world(t);
  const entries = skills.loadBundledSkills(skillsRoot);
  const plan = skills.planInstall(workspace, entries);
  fs.mkdirSync(path.join(workspace, '.claude', 'skills', 'fetch-issues'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.claude', 'skills', 'fetch-issues', 'SKILL.md'), 'raced');
  const result = skills.applyInstall(workspace, plan.writes);
  assert.ok(result.conflicts.includes('.claude/skills/fetch-issues/SKILL.md'));
  assert.equal(fs.readFileSync(path.join(workspace, '.claude/skills/fetch-issues/SKILL.md'), 'utf8'), 'raced');
});

test('the atomic writer never replaces an existing file and leaves no temporary file', (t) => {
  const { workspace } = world(t);
  const target = path.join(workspace, 'SKILL.md');
  fs.writeFileSync(target, 'existing');
  assert.equal(skills.writeNewFileAtomic(target, Buffer.from('new')), false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'existing');
  const fresh = path.join(workspace, 'fresh.md');
  assert.equal(skills.writeNewFileAtomic(fresh, Buffer.from('new')), true);
  assert.equal(fs.readFileSync(fresh, 'utf8'), 'new');
  assert.deepEqual(fs.readdirSync(workspace).sort(), ['SKILL.md', 'fresh.md']);
});

test('a failure while writing or syncing the temporary file leaves no temporary file behind', (t) => {
  const { workspace } = world(t);
  for (const failing of ['writeSync', 'fsyncSync', 'linkSync']) {
    const io = { ...fs, [failing]() { const error = new Error(`injected ${failing} failure`); error.code = 'EIO'; throw error; } };
    const target = path.join(workspace, `${failing}.md`);
    assert.throws(() => skills.writeNewFileAtomic(target, Buffer.from('content'), io), /injected/);
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(fs.readdirSync(workspace).filter((name) => name.endsWith('.tmp')), [], failing);
  }
});

test('remove deletes only unchanged files it wrote and keeps edited and user files', async (t) => {
  const { workspace } = world(t);
  fs.mkdirSync(path.join(workspace, '.claude', 'skills', 'mine'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.claude', 'skills', 'mine', 'SKILL.md'), 'user skill');
  const store = memoryStore();
  await skills.runInstall(deps(workspace, { ui: fakeUi([true, true]), store }));
  fs.writeFileSync(path.join(workspace, '.claude/skills/fetch-issues/SKILL.md'), 'edited by the user');
  fs.writeFileSync(path.join(workspace, '.claude/skills/fetch-prs/extra.md'), 'user addition');

  const declined = fakeUi([false]);
  const cancelled = await skills.runRemove(deps(workspace, { ui: declined, store }));
  assert.equal(cancelled.code, 'cancelled');
  assert.ok(fs.existsSync(path.join(workspace, '.claude/skills/fetch-comments/SKILL.md')), 'nothing removed before consent');
  assert.match(declined.calls[0].detail, /will be kept:\n  \.claude\/skills\/fetch-issues\/SKILL\.md/);

  const ui = fakeUi([true]);
  const result = await skills.runRemove(deps(workspace, { ui, store }));
  assert.equal(result.ok, true);
  assert.equal(result.removed.length, BUNDLED.length + 2 - 1);
  assert.deepEqual(result.kept, ['.claude/skills/fetch-issues/SKILL.md']);
  assert.equal(fs.readFileSync(path.join(workspace, '.claude/skills/fetch-issues/SKILL.md'), 'utf8'), 'edited by the user');
  assert.equal(fs.readFileSync(path.join(workspace, '.claude/skills/fetch-prs/extra.md'), 'utf8'), 'user addition');
  assert.equal(fs.readFileSync(path.join(workspace, '.claude/skills/mine/SKILL.md'), 'utf8'), 'user skill');
  assert.equal(fs.existsSync(path.join(workspace, '.claude/skills/fetch-comments')), false, 'emptied folders it created are removed');
  assert.equal(fs.existsSync(path.join(workspace, '.github')), false);
  const record = store.data[skills.recordKey(workspace)];
  assert.deepEqual(record.files.map((f) => f.path), ['.claude/skills/fetch-issues/SKILL.md']);
});

test('remove deletes nothing when the install record is malformed or names unsafe paths', async (t) => {
  const { workspace, sandbox } = world(t);
  const outside = path.join(sandbox, 'outside.md');
  fs.writeFileSync(outside, 'outside');
  const userFile = path.join(workspace, 'keep.md');
  fs.writeFileSync(userFile, 'keep');

  const malformed = memoryStore({ [skills.recordKey(workspace)]: { version: 1, files: [{ path: 'keep.md' }], dirs: [] } });
  const bad = await skills.runRemove(deps(workspace, { store: malformed, isTestMode: true, arg: { interactive: false } }));
  assert.equal(bad.code, 'record-invalid');
  assert.ok(fs.existsSync(userFile));

  const crypto = require('node:crypto');
  const hash = crypto.createHash('sha256').update('outside').digest('hex');
  const escaping = memoryStore({ [skills.recordKey(workspace)]: { version: 1, files: [{ path: '../outside.md', sha256: hash }, { path: '/etc/hosts', sha256: hash }], dirs: ['..'] } });
  const result = await skills.runRemove(deps(workspace, { store: escaping, isTestMode: true, arg: { interactive: false } }));
  assert.equal(result.code, 'record-invalid');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
  assert.ok(fs.existsSync(sandbox));
});

test('a record with one escaping or unrelated entry is unreadable as a whole, so even valid entries are kept', async (t) => {
  const { workspace } = world(t);
  const store = memoryStore();
  await skills.runInstall(deps(workspace, { isTestMode: true, arg: { interactive: false }, store }));
  const key = skills.recordKey(workspace);
  const valid = store.data[key];
  assert.ok(skills.parseRecord(valid));
  const bad = [
    { ...valid, files: [...valid.files, { path: '.claude/skills/../../x/SKILL.md', sha256: valid.files[0].sha256 }] },
    { ...valid, files: [...valid.files, { path: 'src/index.js', sha256: valid.files[0].sha256 }] },
    { ...valid, files: [...valid.files, { path: '/abs/SKILL.md', sha256: valid.files[0].sha256 }] },
    { ...valid, files: [...valid.files, { path: '.claude\\skills\\x\\SKILL.md', sha256: valid.files[0].sha256 }] },
    { ...valid, dirs: [...valid.dirs, '..'] },
    { ...valid, dirs: [...valid.dirs, 'src'] }
  ];
  for (const record of bad) {
    assert.equal(skills.parseRecord(record), null);
    store.data[key] = record;
    const result = await skills.runRemove(deps(workspace, { store, isTestMode: true, arg: { interactive: false } }));
    assert.equal(result.code, 'record-invalid');
    assert.ok(fs.existsSync(path.join(workspace, '.claude/skills/fetch-prs/SKILL.md')), 'nothing deleted');
  }
});

test('symlinked target folders and escaping paths are refused before anything is written', async (t) => {
  const { workspace, sandbox } = world(t);
  const elsewhere = path.join(sandbox, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(workspace, '.claude'), process.platform === 'win32' ? 'junction' : 'dir');
  const ui = fakeUi([true, true]);
  const result = await skills.runInstall(deps(workspace, { ui }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'symlink-refused');
  assert.equal(ui.calls.filter((call) => call.button).length, 0, 'refused before asking');
  assert.deepEqual(fs.readdirSync(elsewhere), []);

  fs.unlinkSync(path.join(workspace, '.claude'));
  fs.mkdirSync(path.join(workspace, '.claude'));
  fs.symlinkSync(elsewhere, path.join(workspace, '.claude', 'skills'), process.platform === 'win32' ? 'junction' : 'dir');
  const nested = await skills.runInstall(deps(workspace, { ui: fakeUi([true]) }));
  assert.equal(nested.code, 'symlink-refused');
  assert.deepEqual(fs.readdirSync(elsewhere), []);

  for (const rel of ['../escape.md', '/abs.md', 'a/../../b.md', 'a\\b.md', 'C:/x.md', '']) {
    assert.throws(() => skills.planInstall(workspace, [{ rel, content: Buffer.from('x'), sha256: '0'.repeat(64) }]), (error) => error.code === 'path-escape', rel);
  }
  assert.equal(fs.existsSync(path.join(sandbox, 'escape.md')), false);
});

test('Extension Test mode may skip the dialog, and templates then need an explicit flag', async (t) => {
  const { workspace } = world(t);
  const ui = fakeUi([]);
  const store = memoryStore();
  const result = await skills.runInstall(deps(workspace, { isTestMode: true, arg: { interactive: false }, ui, store }));
  assert.equal(result.ok, true);
  assert.equal(result.written.length, BUNDLED.length);
  assert.equal(ui.calls.length, 0);
  assert.equal(fs.existsSync(path.join(workspace, '.github')), false);
  const withTemplates = await skills.runInstall(deps(workspace, { isTestMode: true, arg: { interactive: false, includeTemplates: true }, ui, store }));
  assert.deepEqual(withTemplates.written.sort(), ['.github/ISSUE_TEMPLATE/standard.md', '.github/pull_request_template.md']);
});

test('only Claude Code is reported as supported', () => {
  assert.equal(skills.PROVIDER_SUPPORT.claude.supported, true);
  assert.equal(skills.PROVIDER_SUPPORT.codex.supported, false);
  assert.equal(skills.PROVIDER_SUPPORT.agy.supported, false);
});

test('the commands are contributed and the VSIX ignore list ships the resources but not .claude', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const commands = Object.fromEntries(manifest.contributes.commands.map((c) => [c.command, c.title]));
  assert.match(commands['multiagentSystem.skills.install'], /^Multiagent: Install Agent Skills in This Workspace/);
  assert.equal(commands['multiagentSystem.skills.remove'], 'Multiagent: Remove Installed Agent Skills');
  const ignore = fs.readFileSync(path.join(repoRoot, '.vscodeignore'), 'utf8').split(/\r?\n/);
  assert.ok(ignore.includes('.claude/**'));
  assert.ok(ignore.includes('!resources/agent-skills/**'));
  assert.ok(ignore.includes('!resources/agent-templates/**'));
});
