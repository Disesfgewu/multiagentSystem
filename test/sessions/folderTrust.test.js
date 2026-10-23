'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { trustClaudeFolder, trustCodexFolder, describeTrust, usableManagedRoots, tomlString } = require('../../src/sessions/folderTrust');
const { parse: parseToml } = require('smol-toml');

function temp(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mas-trust-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const folder = path.join(path.parse(process.cwd()).root, 'work', 'repo-worktrees', 'feat-x');

test('Claude Code: the folder is marked trusted and every other key of .claude.json is kept as it was', (t) => {
  const dir = temp(t);
  const file = path.join(dir, '.claude.json');
  const before = { numStartups: 3, oauthAccount: { emailAddress: 'someone@example.test' }, projects: { '/other': { allowedTools: ['Bash(ls)'], hasTrustDialogAccepted: true } }, zLast: [1, 2] };
  fs.writeFileSync(file, JSON.stringify(before), { mode: 0o600 });
  assert.deepEqual(trustClaudeFolder({ configDir: dir, folder }), { ok: true, changed: true });
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(after, { ...before, projects: { ...before.projects, [folder]: { hasTrustDialogAccepted: true } } });
  assert.deepEqual(Object.keys(after), Object.keys(before), 'the key order is kept');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'the file keeps its mode');
  assert.deepEqual(trustClaudeFolder({ configDir: dir, folder }), { ok: true, changed: false }, 'a second time changes nothing');
  assert.deepEqual(fs.readdirSync(dir), ['.claude.json'], 'no temporary file is left');
});

test('Claude Code: an existing entry for the folder keeps its other fields', (t) => {
  const dir = temp(t);
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ projects: { [folder]: { allowedTools: ['Read'], hasTrustDialogAccepted: false } } }));
  assert.equal(trustClaudeFolder({ configDir: dir, folder }).changed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8')).projects[folder], { allowedTools: ['Read'], hasTrustDialogAccepted: true });
});

test('Claude Code: a missing file is created owner-only with only the trust entry', (t) => {
  const dir = temp(t);
  assert.deepEqual(trustClaudeFolder({ configDir: dir, folder }), { ok: true, changed: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8')), { projects: { [folder]: { hasTrustDialogAccepted: true } } });
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, '.claude.json')).mode & 0o777, 0o600);
});

test('Claude Code: anything unexpected writes nothing and says why', (t) => {
  const dir = temp(t);
  const file = path.join(dir, '.claude.json');
  for (const [text, reason] of [['{not json', 'config-not-json'], ['[1]', 'config-not-json'], ['{"projects":[]}', 'config-unexpected-shape'], [JSON.stringify({ projects: { [folder]: 'yes' } }), 'config-unexpected-shape']]) {
    fs.writeFileSync(file, text);
    assert.deepEqual(trustClaudeFolder({ configDir: dir, folder }), { ok: false, reason });
    assert.equal(fs.readFileSync(file, 'utf8'), text, `the file is unchanged (${reason})`);
  }
  assert.equal(trustClaudeFolder({ configDir: undefined, folder }).reason, 'no-account-folder');
  assert.equal(trustClaudeFolder({ configDir: path.join(dir, 'missing'), folder }).reason, 'no-account-folder');
  assert.equal(trustClaudeFolder({ configDir: dir, folder: 'relative/path' }).reason, 'folder-invalid');
  if (process.platform !== 'win32') {
    const target = path.join(dir, 'elsewhere.json');
    fs.writeFileSync(target, '{}');
    fs.rmSync(file);
    fs.symlinkSync(target, file);
    assert.equal(trustClaudeFolder({ configDir: dir, folder }).reason, 'config-not-a-file');
    assert.equal(fs.readFileSync(target, 'utf8'), '{}', 'a link is never written through');
  }
});

test('Codex: the trust table is appended and the existing text is untouched', (t) => {
  const dir = temp(t);
  const file = path.join(dir, 'config.toml');
  const before = 'model = "gpt-5"\n# a comment the person wrote\n[projects."/other"]\ntrust_level = "trusted"';
  fs.writeFileSync(file, before);
  assert.deepEqual(trustCodexFolder({ codexHome: dir, folder }), { ok: true, changed: true });
  const after = fs.readFileSync(file, 'utf8');
  assert.ok(after.startsWith(`${before}\n`), 'the existing text is kept byte for byte');
  assert.equal(after.slice(before.length), `\n\n[projects.${tomlString(folder)}]\ntrust_level = "trusted"\n`);
  assert.deepEqual(trustCodexFolder({ codexHome: dir, folder }), { ok: true, changed: false });
  assert.equal(fs.readFileSync(file, 'utf8'), after);
});

test('Codex: a folder the file already mentions otherwise is left alone, so no duplicate table is made', (t) => {
  const dir = temp(t);
  const file = path.join(dir, 'config.toml');
  for (const text of [`[projects.${tomlString(folder)}]\ntrust_level = "untrusted"\n`, `[projects.'${folder}']\ntrust_level = "untrusted"\n`, `[projects.${tomlString(folder)}]\n[other]\ntrust_level = "trusted"\n`]) {
    fs.writeFileSync(file, text);
    assert.deepEqual(trustCodexFolder({ codexHome: dir, folder }), { ok: false, reason: 'codex-entry-exists' }, text);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
  fs.rmSync(file);
  assert.deepEqual(trustCodexFolder({ codexHome: dir, folder }), { ok: true, changed: true });
  assert.equal(fs.readFileSync(file, 'utf8'), `[projects.${tomlString(folder)}]\ntrust_level = "trusted"\n`, 'a new file has only the table');
});

test('TOML strings escape backslashes and quotes and refuse control characters', () => {
  assert.equal(tomlString('C:\\Users\\a "b"'), '"C:\\\\Users\\\\a \\"b\\""');
  assert.equal(tomlString(`/a${String.fromCharCode(10)}b`), null);
});

test('the session line says whether the CLI will ask', () => {
  assert.equal(describeTrust({ ok: true, changed: true }, 'Claude Code'), 'Folder trust: Claude Code will not ask to trust this worktree (trust written to the account settings)');
  assert.equal(describeTrust({ ok: false, reason: 'no-consent' }, 'Codex'), "Folder trust: not pre-written, so Codex asks once (you have not allowed pre-trusting this project's worktrees yet)");
  assert.equal(describeTrust(undefined, 'Codex'), null);
});

test('a CLI writing .claude.json at the same moment is never written over: the change is made again on what it wrote (#362)', (t) => {
  const dir = temp(t);
  const file = path.join(dir, '.claude.json');
  fs.writeFileSync(file, JSON.stringify({ numStartups: 1 }));
  let raced = 0;
  const result = trustClaudeFolder({ configDir: dir, folder, hooks: { beforeReplace: () => { if (raced++ === 0) fs.writeFileSync(file, JSON.stringify({ numStartups: 2, written: 'by the CLI' })); } } });
  assert.deepEqual(result, { ok: true, changed: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { numStartups: 2, written: 'by the CLI', projects: { [folder]: { hasTrustDialogAccepted: true } } }, 'what the CLI wrote is kept');
  assert.equal(raced, 2, 'it was read and changed again');
  assert.deepEqual(fs.readdirSync(dir), ['.claude.json'], 'no temporary file is left');
});

test('a CLI that keeps writing, or writes over the change right after, is said so and never reported as done (#362)', (t) => {
  const dir = temp(t);
  const file = path.join(dir, '.claude.json');
  fs.writeFileSync(file, '{}');
  let count = 0;
  const busy = trustClaudeFolder({ configDir: dir, folder, hooks: { beforeReplace: () => fs.writeFileSync(file, JSON.stringify({ n: count++ })) } });
  assert.deepEqual(busy, { ok: false, reason: 'config-busy' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { n: 2 }, 'the CLI\'s last write stays');
  assert.deepEqual(fs.readdirSync(dir), ['.claude.json']);
  // The rename happened, then the CLI wrote its own older copy back: the check after the write sees it.
  const original = fs.renameSync;
  t.after(() => { fs.renameSync = original; });
  fs.renameSync = (from, to) => { original(from, to); fs.writeFileSync(to, '{"projects":{}}'); };
  assert.deepEqual(trustClaudeFolder({ configDir: dir, folder }), { ok: false, reason: 'config-overwritten' });
  fs.renameSync = original;
});

test('Codex: config.toml changed in between is read again, and the existing text it then has is kept (#362)', (t) => {
  const dir = temp(t);
  const file = path.join(dir, 'config.toml');
  fs.writeFileSync(file, 'model = "a"\n');
  let raced = 0;
  const result = trustCodexFolder({ codexHome: dir, folder, hooks: { beforeReplace: () => { if (raced++ === 0) fs.writeFileSync(file, 'model = "b"\n'); } } });
  assert.deepEqual(result, { ok: true, changed: true });
  assert.equal(fs.readFileSync(file, 'utf8'), `model = "b"\n\n[projects.${tomlString(folder)}]\ntrust_level = "trusted"\n`);
});

test('the settings file keeps its own mode, even one the umask would narrow (#362)', { skip: process.platform === 'win32' }, (t) => {
  const dir = temp(t);
  const file = path.join(dir, '.claude.json');
  fs.writeFileSync(file, '{}');
  fs.chmodSync(file, 0o620);
  const previous = process.umask(0o022);
  t.after(() => process.umask(previous));
  assert.equal(trustClaudeFolder({ configDir: dir, folder }).changed, true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o620);
});

test('Codex: a config.toml whose projects are written so that a table cannot be appended is left alone, never broken (#362)', (t) => {
  const dir = temp(t);
  const file = path.join(dir, 'config.toml');
  for (const text of [
    'projects = { "/w/z" = { trust_level = "trusted" } }\n',
    '[[projects]]\nname = "x"\n',
    'projects = 5\n'
  ]) {
    fs.writeFileSync(file, text);
    assert.deepEqual(trustCodexFolder({ codexHome: dir, folder }), { ok: false, reason: 'config-unexpected-shape' }, text);
    assert.equal(fs.readFileSync(file, 'utf8'), text, 'unchanged');
  }
  fs.writeFileSync(file, 'model = \n');
  assert.deepEqual(trustCodexFolder({ codexHome: dir, folder }), { ok: false, reason: 'config-not-toml' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'model = \n');
});

test('Codex: every file it writes parses, with exactly this folder trusted; an existing entry is found whatever the quoting (#362)', (t) => {
  const dir = temp(t);
  const file = path.join(dir, 'config.toml');
  // Every key written by hand below goes through tomlString, so a Windows path (backslashes) stays valid TOML.
  // Dotted keys may define `projects`: TOML lets a [projects."<folder>"] header add a sub-table to it, so that is written.
  for (const text of ['', 'model = "a"', '[projects]\n', 'projects."/w/z".trust_level = "trusted"\n', `[projects.${tomlString(`${folder}/longer`)}]\ntrust_level = "trusted"\n`, 'a.b = 1\n[tui]\nx = true\n']) {
    fs.writeFileSync(file, text);
    assert.deepEqual(trustCodexFolder({ codexHome: dir, folder }), { ok: true, changed: true }, JSON.stringify(text));
    const parsed = parseToml(fs.readFileSync(file, 'utf8'));
    assert.equal(parsed.projects[folder].trust_level, 'trusted');
  }
  assert.equal(parseToml(fs.readFileSync(file, 'utf8')).a.b, 1, 'what was there is still read the same');
  fs.writeFileSync(file, `projects.${tomlString(folder)}.trust_level = "untrusted"\n`);
  assert.deepEqual(trustCodexFolder({ codexHome: dir, folder }), { ok: false, reason: 'codex-entry-exists' }, 'a dotted entry for this folder is found');
  fs.writeFileSync(file, `[projects.'${folder}']\ntrust_level = "trusted"\n`);
  assert.deepEqual(trustCodexFolder({ codexHome: dir, folder }), { ok: true, changed: false }, 'a single-quoted entry is recognised');
});

test('Claude Code: an account folder that is a link is refused (#362)', { skip: process.platform === 'win32' }, (t) => {
  const dir = temp(t);
  const real = path.join(dir, 'real');
  fs.mkdirSync(real);
  fs.symlinkSync(real, path.join(dir, 'linked'));
  assert.deepEqual(trustClaudeFolder({ configDir: path.join(dir, 'linked'), folder }), { ok: false, reason: 'no-account-folder' });
  assert.deepEqual(trustCodexFolder({ codexHome: path.join(dir, 'linked'), folder }), { ok: false, reason: 'no-account-folder' });
  assert.deepEqual(fs.readdirSync(real), [], 'nothing was written through the link');
});

test('a managed worktree folder that is a link, or missing, is never used (#362)', { skip: process.platform === 'win32' }, (t) => {
  const dir = temp(t);
  fs.mkdirSync(path.join(dir, 'repo-worktrees'));
  fs.symlinkSync('/', path.join(dir, 'other-worktrees'));
  assert.deepEqual(usableManagedRoots([path.join(dir, 'repo-worktrees'), path.join(dir, 'other-worktrees'), path.join(dir, 'missing-worktrees')]), [path.join(dir, 'repo-worktrees')]);
});
