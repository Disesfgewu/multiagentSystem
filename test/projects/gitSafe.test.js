'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const { safeArgs, BASE } = require('../../src/projects/gitSafe');
const { inspectWorktree } = require('../../src/projects/gitEvidence');
const { WorktreeService } = require('../../src/projects/worktrees');

const git = async (cwd, ...args) => (await exec('git', args, { cwd, encoding: 'utf8' })).stdout.trim();
const exists = (file) => fs.access(file).then(() => true, () => false);
const skipWindows = { skip: process.platform === 'win32' };

async function repo(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'multiagent-git-safe-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const empty = path.join(temporary, 'empty-template');
  await fs.mkdir(empty);
  const root = path.join(temporary, 'work tree');
  await fs.mkdir(root);
  await git(root, 'init', '-b', 'main', `--template=${empty}`);
  for (const [key, value] of [['user.name', 'Synthetic Test'], ['user.email', 'synthetic@example.test'], ['commit.gpgsign', 'false'], ['core.hooksPath', empty]]) await git(root, 'config', key, value);
  await fs.writeFile(path.join(root, '.gitattributes'), '*.txt filter=probe\n*.bin filter=other.name\n');
  await fs.writeFile(path.join(root, 'f.txt'), 'initial\n');
  await fs.writeFile(path.join(root, 'g.bin'), 'initial\n');
  await git(root, 'add', '-A');
  await git(root, 'commit', '-m', 'initial');
  return { temporary, root };
}

// A filter command that records that it ran, and passes the content through.
const recorder = (marker) => `sh -c 'touch ${marker}; cat'`;

test('without any filter configured the safe arguments are just the base ones', async (t) => {
  const { root } = await repo(t);
  const args = await safeArgs((probe) => exec('git', probe, { cwd: root, encoding: 'utf8' }).then((result) => result.stdout));
  assert.deepEqual(args, [...BASE]);
});

test('every configured content filter is emptied for the call, whatever its name', skipWindows, async (t) => {
  const { root } = await repo(t);
  await git(root, 'config', 'filter.probe.clean', 'x');
  await git(root, 'config', 'filter.probe.smudge', 'y');
  await git(root, 'config', 'filter.other.name.process', 'z');
  const args = await safeArgs((probe) => exec('git', probe, { cwd: root, encoding: 'utf8' }).then((result) => result.stdout));
  for (const expected of ['filter.probe.clean=', 'filter.probe.smudge=', 'filter.probe.process=', 'filter.other.name.process=', 'filter.other.name.clean=']) assert.ok(args.includes(expected), expected);
  assert.ok(args.includes('filter.probe.required=false'));
});

test('a filter name that cannot be passed safely makes the call refuse instead of guessing', async () => {
  await assert.rejects(safeArgs(async () => 'local\tfilter.a=b.clean\n'), { code: 'filter-name-unsafe' });
  assert.deepEqual(await safeArgs(async () => 'local\tcore.editor\nlocal\tuser.name\n'), [...BASE], 'keys that are not filters are ignored');
  assert.deepEqual(await safeArgs(async () => 'global\tfilter.lfs.clean\nsystem\tfilter.lfs.smudge\n'), [...BASE], 'filters the person installed themselves are left alone');
  assert.ok((await safeArgs(async () => 'command\tfilter.x.clean\nworktree\tfilter.y.process\n')).includes('filter.y.process='), 'worktree and command-line settings are not the person\'s');
  await assert.rejects(safeArgs(async () => { throw Object.assign(new Error('boom'), { code: 128 }); }), /boom/, 'a real failure is not read as "no filters"');
});

test('a filter the person installed in their own configuration keeps working, but the repository cannot take it over', skipWindows, async (t) => {
  const { temporary, root } = await repo(t);
  const userConfig = path.join(temporary, 'user-gitconfig');
  await fs.writeFile(userConfig, '[filter "probe"]\n\tclean = cat\n');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: userConfig, GIT_CONFIG_NOSYSTEM: '1' };
  const run = (probe) => exec('git', probe, { cwd: root, encoding: 'utf8', env }).then((result) => result.stdout);
  assert.deepEqual(await safeArgs(run), [...BASE], 'their own (global) filter is not emptied');
  await git(root, 'config', '--local', 'filter.probe.clean', 'sh -c "touch x; cat"');
  const args = await safeArgs(run);
  assert.ok(args.includes('filter.probe.clean='), 'but the same name redefined by the repository is');
});

test('reading Git evidence never runs a repository-configured content filter', skipWindows, async (t) => {
  const { temporary, root } = await repo(t);
  const marker = path.join(temporary, 'filter-ran');
  await git(root, 'config', 'filter.probe.clean', recorder(marker));
  // Control: plain git does run it for a diff here, so the checks below are not vacuous.
  await fs.writeFile(path.join(root, 'f.txt'), 'changed\n');
  await exec('git', ['diff', '--name-only', 'HEAD'], { cwd: root });
  assert.equal(await exists(marker), true, 'control: the filter runs under plain git');
  await fs.rm(marker);
  const evidence = await inspectWorktree(root);
  assert.equal(evidence.state, 'known');
  assert.deepEqual([evidence.dirty, evidence.changed], [true, 1], 'the answer is still right');
  assert.equal(await exists(marker), false, 'evidence did not run the filter');
});

test('listing the files a worktree changed never runs a configured filter, and still lists them', skipWindows, async (t) => {
  const { temporary, root } = await repo(t);
  const service = await WorktreeService.open(root);
  const wt = path.join(temporary, 'agent-worktree');
  await service.create({ branch: 'feat/agent', target: wt });
  const marker = path.join(temporary, 'filter-ran');
  await git(wt, 'config', '--local', 'filter.probe.clean', recorder(marker));
  await git(wt, 'config', '--local', 'filter.other.name.clean', recorder(`${marker}-2`));
  await fs.writeFile(path.join(wt, 'f.txt'), 'edit\n');
  await fs.writeFile(path.join(wt, 'g.bin'), 'edit\n');
  const changed = await service.changedFiles(wt);
  assert.deepEqual(changed.files, ['f.txt', 'g.bin']);
  assert.equal(await exists(marker), false);
  assert.equal(await exists(`${marker}-2`), false);
});

test('releasing a worktree does not run a configured filter either', skipWindows, async (t) => {
  const { temporary, root } = await repo(t);
  const service = await WorktreeService.open(root);
  const wt = path.join(temporary, 'to-release');
  await service.create({ branch: 'feat/release', target: wt });
  const marker = path.join(temporary, 'filter-ran');
  await git(wt, 'config', '--local', 'filter.probe.clean', recorder(marker));
  await fs.writeFile(path.join(wt, 'f.txt'), 'edit\n');
  await assert.rejects(service.remove(wt), { code: 'worktree-has-local-files' });
  assert.equal(await exists(marker), false);
});
