'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveCustomExecutable, planCustomLaunch, confirmationKey, terminalEnvironment, isInside } = require('../../src/providers/custom-launch');

const posix = process.platform !== 'win32';
const onlyPosix = posix ? {} : { skip: 'uses POSIX permission bits and links' };

function sandbox(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mas-custom-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(bin);
  fs.mkdirSync(workspace);
  const program = (dir, name, mode = 0o755) => { const file = path.join(dir, name); fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode }); return file; };
  return { root, bin, workspace, program };
}
const provider = (over = {}) => ({ id: 'synthetic', label: 'Synthetic CLI', executable: 'synthetic-cli', args: ['--plain'], ...over });

test('a program name is resolved to the real absolute path of the first usable program on an absolute PATH entry', onlyPosix, (t) => {
  const { bin, program } = sandbox(t);
  const file = program(bin, 'synthetic-cli');
  const found = resolveCustomExecutable('synthetic-cli', { env: { PATH: `relative/dir${path.delimiter}${path.delimiter}${bin}` }, platform: 'linux' });
  assert.deepEqual(found, { ok: true, executable: file });
});

test('a PATH entry that is relative (it would mean the folder the editor happens to be in) is never searched, even where the program really is', onlyPosix, (t) => {
  const { bin, program } = sandbox(t);
  program(bin, 'synthetic-cli');
  const relative = path.relative(process.cwd(), bin);
  assert.equal(path.isAbsolute(relative), false);
  assert.equal(resolveCustomExecutable('synthetic-cli', { env: { PATH: relative }, platform: 'linux' }).reason, 'executable-not-found');
  assert.equal(resolveCustomExecutable('synthetic-cli', { env: { PATH: `.${path.delimiter}${relative}` }, platform: 'linux' }).reason, 'executable-not-found');
});

test('a program that is not there, not a file or not executable is not found; an unusable name or PATH is refused', onlyPosix, (t) => {
  const { root, bin, program } = sandbox(t);
  program(bin, 'not-executable', 0o644);
  fs.mkdirSync(path.join(bin, 'a-folder'));
  const env = { PATH: bin };
  assert.equal(resolveCustomExecutable('missing', { env, platform: 'linux' }).reason, 'executable-not-found');
  assert.equal(resolveCustomExecutable('not-executable', { env, platform: 'linux' }).reason, 'executable-not-found');
  assert.equal(resolveCustomExecutable('a-folder', { env, platform: 'linux' }).reason, 'executable-not-found');
  for (const name of ['', '../x', 'a/b', 'a b', 'a;b', undefined, 5, 'x'.repeat(65)]) assert.equal(resolveCustomExecutable(name, { env, platform: 'linux' }).reason, 'executable-name-invalid', String(name));
  for (const bad of [{}, { PATH: 5 }, null]) assert.equal(resolveCustomExecutable('synthetic-cli', { env: bad, platform: 'linux' }).reason, 'path-unavailable', JSON.stringify(bad));
  assert.equal(resolveCustomExecutable('synthetic-cli', { env: { PATH: path.join(root, 'nowhere') }, platform: 'linux' }).reason, 'executable-not-found');
});

test('a program inside an open workspace folder or the working folder is never used, even when it is first on PATH or reached through a link', onlyPosix, (t) => {
  const { root, bin, workspace, program } = sandbox(t);
  const planted = program(workspace, 'synthetic-cli');
  const env = { PATH: `${workspace}${path.delimiter}${path.join(workspace, 'sub')}` };
  // Only a program in the workspace: refused, with the reason that says so.
  assert.equal(resolveCustomExecutable('synthetic-cli', { env, platform: 'linux', forbiddenFolders: [workspace] }).reason, 'executable-only-in-workspace');
  // The same program beside a good one further along PATH: the good one is used.
  const good = program(bin, 'synthetic-cli');
  assert.deepEqual(resolveCustomExecutable('synthetic-cli', { env: { PATH: `${workspace}${path.delimiter}${bin}` }, platform: 'linux', forbiddenFolders: [workspace] }), { ok: true, executable: good });
  // A link in a system-looking folder that points into the workspace is the same as a program in the workspace.
  fs.rmSync(good);
  fs.symlinkSync(planted, path.join(bin, 'synthetic-cli'));
  assert.equal(resolveCustomExecutable('synthetic-cli', { env: { PATH: bin }, platform: 'linux', forbiddenFolders: [workspace] }).reason, 'executable-only-in-workspace');
  // The working folder counts as well as the workspace folders, and a folder next to it with a similar name does not.
  const cwdFolder = path.join(root, 'elsewhere');
  fs.mkdirSync(cwdFolder);
  const inCwd = program(cwdFolder, 'other-cli');
  assert.equal(resolveCustomExecutable('other-cli', { env: { PATH: cwdFolder }, platform: 'linux', forbiddenFolders: [cwdFolder] }).reason, 'executable-only-in-workspace');
  const near = path.join(root, 'elsewhere-2');
  fs.mkdirSync(near);
  const nearFile = program(near, 'other-cli');
  assert.deepEqual(resolveCustomExecutable('other-cli', { env: { PATH: near }, platform: 'linux', forbiddenFolders: [cwdFolder] }), { ok: true, executable: nearFile });
  assert.ok(inCwd);
});

test('a workspace opened through a link is the same folder as its real one: a program in it is refused whichever way the folder or the PATH entry is spelled', onlyPosix, (t) => {
  const { root, workspace, program } = sandbox(t);
  const inside = path.join(workspace, 'bin');
  fs.mkdirSync(inside);
  const planted = program(inside, 'mycli');
  const wslink = path.join(root, 'wslink');
  fs.symlinkSync(workspace, wslink);
  const sys = path.join(root, 'sys');
  fs.mkdirSync(sys);
  fs.symlinkSync(planted, path.join(sys, 'mycli'));
  const resolve = (forbiddenFolders, pathEntry) => resolveCustomExecutable('mycli', { env: { PATH: pathEntry }, platform: 'linux', forbiddenFolders });
  // A: the workspace given by its real path.
  assert.equal(resolve([workspace], sys).reason, 'executable-only-in-workspace');
  // B: the workspace given through a link, the program reached through a link in another folder.
  assert.equal(resolve([wslink], sys).reason, 'executable-only-in-workspace');
  // C: the workspace given through a link, the PATH entry given by its real path.
  assert.equal(resolve([wslink], inside).reason, 'executable-only-in-workspace');
  // D: the PATH entry given through the link, the workspace by its real path.
  assert.equal(resolve([workspace], path.join(wslink, 'bin')).reason, 'executable-only-in-workspace');
  // E: both through the link.
  assert.equal(resolve([wslink], path.join(wslink, 'bin')).reason, 'executable-only-in-workspace');
  // A folder that cannot be resolved is still compared as given.
  assert.equal(resolve([path.join(root, 'gone', 'missing')], sys).ok, true, 'a program elsewhere is still found');
  assert.equal(resolveCustomExecutable('mycli', { env: { PATH: inside }, platform: 'linux', forbiddenFolders: [workspace], realpath: () => { throw new Error('x'); } }).reason, 'executable-only-in-workspace', 'when nothing can be resolved the spelling as given still decides');
});

test('folder containment is exact: the folder itself and what is inside it, not a name that merely starts the same way', () => {
  assert.equal(isInside('/a/b', '/a/b', 'linux'), true);
  assert.equal(isInside('/a/b/c/d', '/a/b', 'linux'), true);
  assert.equal(isInside('/a/bc', '/a/b', 'linux'), false);
  assert.equal(isInside('/a', '/a/b', 'linux'), false);
  assert.equal(isInside('/a/b/../c', '/a/b', 'linux'), false, 'a path with .. is normalized first');
  assert.equal(isInside('C:\\Work\\Repo\\bin', 'c:\\work\\repo', 'win32'), true, 'Windows paths ignore case');
  assert.equal(isInside('C:\\Work\\Repo2', 'C:\\Work\\Repo', 'win32'), false);
  assert.equal(isInside('D:\\Work\\Repo', 'C:\\Work\\Repo', 'win32'), false, 'another drive');
});

test('on Windows only .exe and .com are accepted; a script is refused with its own reason (simulated file system)', () => {
  const files = new Set(['C:\\Tools\\synthetic-cli.cmd', 'C:\\Tools\\other.exe', 'C:\\Tools\\third.com', 'C:\\Tools\\fourth.bat', 'C:\\Tools\\fifth.ps1']);
  const fake = { platform: 'win32', stat: (target) => { if (!files.has(target)) throw new Error('ENOENT'); return { isFile: () => true }; }, access: () => {}, realpath: (target) => target };
  const env = { Path: 'C:\\Tools' };
  assert.equal(resolveCustomExecutable('synthetic-cli', { ...fake, env }).reason, 'script-not-supported');
  assert.equal(resolveCustomExecutable('fourth', { ...fake, env }).reason, 'script-not-supported');
  assert.equal(resolveCustomExecutable('fifth', { ...fake, env }).reason, 'executable-not-found');
  assert.deepEqual(resolveCustomExecutable('other', { ...fake, env }), { ok: true, executable: 'C:\\Tools\\other.exe' });
  assert.deepEqual(resolveCustomExecutable('third', { ...fake, env }), { ok: true, executable: 'C:\\Tools\\third.com' });
  // A Windows PATH entry inside the workspace is skipped, and the variable is found whatever its case.
  const inWorkspace = { ...fake, env: { PATH: 'C:\\Repo\\bin;C:\\Tools' }, forbiddenFolders: ['c:\\repo'] };
  files.add('C:\\Repo\\bin\\other.exe');
  assert.deepEqual(resolveCustomExecutable('other', inWorkspace), { ok: true, executable: 'C:\\Tools\\other.exe' });
  assert.equal(resolveCustomExecutable('other', { ...fake, env: { PATH: 'C:\\Repo\\bin' }, forbiddenFolders: ['C:\\Repo'] }).reason, 'executable-only-in-workspace');
});

test('the environment of the terminal loses what scrubEnvironment removes (set to null), and nothing else is touched', () => {
  const env = terminalEnvironment({ PATH: '/usr/bin', HOME: '/h', GH_TOKEN: 'x', gh_token: 'y', GITHUB_TOKEN: 'z', SSH_AUTH_SOCK: '/s', GIT_ASKPASS: 'p', GIT_CONFIG_PARAMETERS: 'q', LANG: 'C' });
  assert.deepEqual(Object.keys(env).sort(), ['GH_TOKEN', 'GITHUB_TOKEN', 'GIT_ASKPASS', 'GIT_CONFIG_PARAMETERS', 'SSH_AUTH_SOCK', 'gh_token']);
  for (const value of Object.values(env)) assert.equal(value, null);
  assert.deepEqual(terminalEnvironment({}), {});
  assert.deepEqual(terminalEnvironment(null), {});
});

test('a confirmation covers one provider id, one program path and one list of arguments, and nothing else', () => {
  const base = { id: 'a', executable: '/usr/bin/x', args: ['--one'] };
  const key = confirmationKey(base);
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.equal(confirmationKey({ ...base }), key);
  for (const other of [{ id: 'b' }, { executable: '/usr/bin/y' }, { args: ['--two'] }, { args: ['--one', '--two'] }, { args: [] }, { args: ['--on', 'e'] }]) assert.notEqual(confirmationKey({ ...base, ...other }), key, JSON.stringify(other));
});

test('a plan names what would run and asks first; the same thing confirmed once is not asked again, a different thing is', onlyPosix, (t) => {
  const { bin, workspace, program } = sandbox(t);
  const file = program(bin, 'synthetic-cli');
  const input = { providers: [provider()], id: 'synthetic', trusted: true, cwd: workspace, folders: [workspace] };
  const options = { env: { PATH: bin, GH_TOKEN: 'x', HOME: '/h' }, platform: 'linux' };
  const plan = planCustomLaunch(input, options);
  assert.equal(plan.ok, true);
  assert.equal(plan.needsConfirmation, true);
  assert.deepEqual(plan.launch, { shellPath: file, shellArgs: ['--plain'], cwd: workspace, env: { GH_TOKEN: null } });
  assert.match(plan.detail, new RegExp(`Program: ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(plan.detail, /Arguments: \["--plain"\]/);
  assert.match(plan.detail, /Nothing about it is verified/);
  const again = planCustomLaunch({ ...input, confirmed: [plan.key] }, options);
  assert.equal(again.needsConfirmation, false);
  // Another program path, other arguments or another id are a different thing to confirm.
  const moved = path.join(path.dirname(bin), 'bin2');
  fs.mkdirSync(moved);
  program(moved, 'synthetic-cli');
  assert.equal(planCustomLaunch({ ...input, confirmed: [plan.key] }, { ...options, env: { PATH: moved } }).needsConfirmation, true);
  assert.equal(planCustomLaunch({ ...input, providers: [provider({ args: ['--other'] })], confirmed: [plan.key] }, options).needsConfirmation, true);
  assert.equal(planCustomLaunch({ ...input, providers: [provider({ id: 'renamed' })], id: 'renamed', confirmed: [plan.key] }, options).needsConfirmation, true);
});

test('nothing is planned for an untrusted workspace, an unknown provider, a missing folder or a program that cannot be found safely', onlyPosix, (t) => {
  const { bin, workspace, program } = sandbox(t);
  program(bin, 'synthetic-cli');
  const input = { providers: [provider()], id: 'synthetic', trusted: true, cwd: workspace, folders: [workspace] };
  const options = { env: { PATH: bin }, platform: 'linux' };
  for (const trusted of [false, undefined, 'yes', 1, null]) assert.equal(planCustomLaunch({ ...input, trusted }, options).reason, 'workspace-untrusted', String(trusted));
  for (const id of ['other', undefined, '', 5, '__proto__']) assert.equal(planCustomLaunch({ ...input, id }, options).reason, 'provider-not-found', String(id));
  assert.equal(planCustomLaunch({ ...input, providers: undefined }, options).reason, 'provider-not-found');
  for (const cwd of [undefined, '', 'relative', 5]) assert.equal(planCustomLaunch({ ...input, cwd }, options).reason, 'folder-required', String(cwd));
  assert.equal(planCustomLaunch(input, { ...options, env: { PATH: `${path.join(workspace, 'bin')}` } }).reason, 'executable-not-found');
  // The only copy is in the folder the terminal would start in.
  program(workspace, 'only-here');
  assert.equal(planCustomLaunch({ ...input, providers: [provider({ executable: 'only-here' })] }, { ...options, env: { PATH: workspace } }).reason, 'executable-only-in-workspace');
});

// ---- on native Windows only: the real file system -------------------------------------------------------------------

const onlyWindows = process.platform === 'win32' ? {} : { skip: 'needs native Windows' };

function windowsSandbox(t) {
  // Names with a space and non-ASCII characters, under the runner's temporary folder (which is a short 8.3 name on CI).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mas custom 工具-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'tools 空白', 'bin');
  const workspace = path.join(root, 'work space 專案');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const program = (dir, name) => { fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, name); fs.writeFileSync(file, 'MZ synthetic program'); return file; };
  return { root, bin, workspace, program };
}

test('on Windows: a .exe in a folder with spaces and non-ASCII characters is found by its real path, whatever the PATH spelling or case', onlyWindows, (t) => {
  const { bin, program } = windowsSandbox(t);
  const exe = program(bin, 'synthetic-cli.exe');
  const real = fs.realpathSync.native(exe);
  const found = resolveCustomExecutable('synthetic-cli', { env: { Path: bin } });
  assert.deepEqual(found, { ok: true, executable: real });
  assert.equal(path.isAbsolute(found.executable), true);
  // PATH may be spelled in any case; the entry may be given in upper case.
  assert.deepEqual(resolveCustomExecutable('synthetic-cli', { env: { PATH: bin.toUpperCase() } }).ok, true);
  assert.equal(resolveCustomExecutable('missing-cli', { env: { Path: bin } }).reason, 'executable-not-found');
});

test('on Windows: .com is accepted; .cmd, .bat and .ps1 are refused or not found, never started through an interpreter', onlyWindows, (t) => {
  const { bin, program } = windowsSandbox(t);
  program(bin, 'older-cli.com');
  program(bin, 'script-cli.cmd');
  program(bin, 'batch-cli.bat');
  program(bin, 'shell-cli.ps1');
  const env = { Path: bin };
  assert.equal(resolveCustomExecutable('older-cli', { env }).ok, true);
  assert.equal(resolveCustomExecutable('script-cli', { env }).reason, 'script-not-supported');
  assert.equal(resolveCustomExecutable('batch-cli', { env }).reason, 'script-not-supported');
  assert.equal(resolveCustomExecutable('shell-cli', { env }).reason, 'executable-not-found');
});

test('on Windows: a program in the workspace is not used, even when the workspace is named by its short 8.3 name or through a junction', onlyWindows, (t) => {
  const { root, bin, workspace, program } = windowsSandbox(t);
  const planted = path.join(workspace, 'bin');
  program(planted, 'synthetic-cli.exe');
  const env = { Path: `${planted};${bin}` };
  // Only the workspace has it.
  assert.equal(resolveCustomExecutable('synthetic-cli', { env, forbiddenFolders: [workspace] }).reason, 'executable-only-in-workspace');
  // The same folder spelled with the runner's short names: the operating system's real path is what is compared.
  const short = fs.realpathSync.native(workspace);
  assert.equal(resolveCustomExecutable('synthetic-cli', { env: { Path: planted }, forbiddenFolders: [short] }).reason, 'executable-only-in-workspace');
  assert.equal(resolveCustomExecutable('synthetic-cli', { env: { Path: planted }, forbiddenFolders: [workspace.toUpperCase()] }).reason, 'executable-only-in-workspace', 'the case of folders is not a way around it');
  // A good copy further along PATH is used instead.
  const good = program(bin, 'synthetic-cli.exe');
  assert.deepEqual(resolveCustomExecutable('synthetic-cli', { env, forbiddenFolders: [workspace] }), { ok: true, executable: fs.realpathSync.native(good) });
  // A junction (needs no special right on Windows) in a "system" folder that points into the workspace is the workspace.
  const sys = path.join(root, 'sys');
  fs.mkdirSync(sys);
  const junction = path.join(sys, 'linked');
  fs.symlinkSync(planted, junction, 'junction');
  assert.equal(resolveCustomExecutable('synthetic-cli', { env: { Path: junction }, forbiddenFolders: [workspace] }).reason, 'executable-only-in-workspace');
  // The workspace opened through a junction is the same workspace.
  const wslink = path.join(root, 'wslink');
  fs.symlinkSync(workspace, wslink, 'junction');
  assert.equal(resolveCustomExecutable('synthetic-cli', { env: { Path: planted }, forbiddenFolders: [wslink] }).reason, 'executable-only-in-workspace');
});

test('on Windows: a plan for a real program names its real path and the arguments as listed, and a relative PATH entry is never searched', onlyWindows, (t) => {
  const { bin, workspace, program } = windowsSandbox(t);
  const exe = program(bin, 'synthetic-cli.exe');
  const plan = planCustomLaunch({ providers: [provider({ args: ['--name', 'with space', '工具'] })], id: 'synthetic', trusted: true, cwd: workspace, folders: [workspace] }, { env: { Path: `.;relative\\dir;${bin}` } });
  assert.equal(plan.ok, true);
  assert.equal(plan.launch.shellPath, fs.realpathSync.native(exe));
  assert.deepEqual(plan.launch.shellArgs, ['--name', 'with space', '工具']);
  assert.match(plan.detail, /Program: /);
});
