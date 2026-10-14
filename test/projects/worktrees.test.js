'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const { WorktreeService, githubRepository, parseWorktrees } = require('../../src/projects/worktrees');

async function git(cwd, ...args) {
  return (await exec('git', args, { cwd, encoding: 'utf8' })).stdout.trim();
}

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'multiagent-worktree-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'repo with space 帳號');
  const empty = path.join(temporary, 'empty-template');
  await fs.mkdir(root);
  await fs.mkdir(empty);
  await git(root, 'init', '-b', 'main', `--template=${empty}`);
  await git(root, 'config', 'user.name', 'Synthetic Test');
  await git(root, 'config', 'user.email', 'synthetic@example.test');
  await git(root, 'config', 'commit.gpgsign', 'false');
  await git(root, 'config', 'core.hooksPath', empty);
  await fs.writeFile(path.join(root, 'file.txt'), 'initial\n');
  await fs.writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
  await git(root, 'add', 'file.txt', '.gitignore');
  await git(root, 'commit', '-m', 'initial');
  return { temporary, root, service: await WorktreeService.open(root) };
}

test('GitHub remote normalization strips credentials and rejects unrelated hosts', () => {
  for (const remote of ['git@github.com:Owner/Repo.git', 'https://synthetic:secret@github.com/Owner/Repo.git', 'ssh://git@github.com/Owner/Repo.git']) {
    assert.equal(githubRepository(remote), 'github.com/owner/repo');
  }
  for (const remote of ['https://github.com.attacker.test/owner/repo', '/local/repo', 'not-a-url']) {
    assert.equal(githubRepository(remote), null);
  }
});

test('porcelain parsing preserves literal newlines and spaces in paths', () => {
  const result = parseWorktrees('worktree /synthetic/a\n b\0HEAD abc\0branch refs/heads/main\0\0worktree /synthetic/other\0HEAD def\0detached\0locked synthetic reason\0\0');
  assert.equal(result[0].path, '/synthetic/a\n b');
  assert.equal(result[0].branch, 'main');
  assert.equal(result[1].detached, true);
  assert.equal(result[1].locked, true);
});

test('opens local projects without origin, creates a named linked worktree, and shares common identity', async t => {
  const { temporary, root, service } = await fixture(t);
  assert.equal(service.githubRepository, null);
  const target = path.join(temporary, 'worker 空白');
  const created = await service.create({ branch: 'feature/work', target });
  assert.equal(created.branch, 'feature/work');
  assert.equal((await fs.stat(path.join(target, '.git'))).isFile(), true);
  const linked = await WorktreeService.open(target);
  assert.equal(linked.commonDir, service.commonDir);
  assert.notEqual(linked.root, service.root);
  assert.equal((await service.list()).length, 2);
  await assert.rejects(linked.remove(target), { code: 'current-worktree-protected' });
  assert.equal(await fs.readFile(path.join(root, 'file.txt'), 'utf8'), 'initial\n');
});

test('cannot remove the primary worktree', async t => {
  const { root, service } = await fixture(t);
  await assert.rejects(service.remove(root), { code: 'primary-worktree-protected' });
});

test('nested paths and branch-option input are rejected without modifying the repo', async t => {
  const { root, temporary, service } = await fixture(t);
  await assert.rejects(service.create({ branch: 'nested', target: path.join(root, 'inside') }), { code: 'worktree-path-overlap' });
  await assert.rejects(service.create({ branch: '--force', target: path.join(temporary, 'other') }), { code: 'branch-invalid' });
  assert.equal((await service.list()).length, 1);
});

test('a link into the repo cannot disguise a nested destination', async t => {
  const { root, temporary, service } = await fixture(t);
  const link = path.join(temporary, 'linked-repo');
  await fs.symlink(root, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(service.create({ branch: 'linked', target: path.join(link, 'inside') }), { code: 'worktree-path-overlap' });
});

test('unresolvable dangling links and non-directory ancestors are rejected', async t => {
  const { temporary, service } = await fixture(t);
  const link = path.join(temporary, 'dangling');
  await fs.symlink(path.join(temporary, 'missing'), link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(service.create({ branch: 'dangling', target: path.join(link, 'child') }), { code: 'path-unverifiable' });
  const file = path.join(temporary, 'ordinary-file');
  await fs.writeFile(file, 'preserve');
  await assert.rejects(service.create({ branch: 'file', target: path.join(file, 'child') }), { code: 'path-unverifiable' });
});

for (const kind of ['tracked', 'untracked', 'ignored']) {
  test(`refuses to remove a worktree containing ${kind} local changes/files`, async t => {
    const { temporary, service } = await fixture(t);
    const target = path.join(temporary, 'worker');
    await service.create({ branch: 'feature/preserve', target });
    const name = kind === 'tracked' ? 'file.txt' : kind === 'ignored' ? 'ignored.txt' : 'untracked.txt';
    await fs.writeFile(path.join(target, name), 'local content');
    await assert.rejects(service.remove(target), { code: 'worktree-has-local-files' });
    assert.equal(await fs.readFile(path.join(target, name), 'utf8'), 'local content');
  });
}

test('locked worktrees are preserved and clean removal retains the branch', async t => {
  const { temporary, root, service } = await fixture(t);
  const target = path.join(temporary, 'worker');
  await service.create({ branch: 'feature/retained', target });
  await git(root, 'worktree', 'lock', target);
  await assert.rejects(service.remove(target), { code: 'worktree-locked' });
  await git(root, 'worktree', 'unlock', target);
  assert.deepEqual(await service.remove(target), { removed: true, branch: 'feature/retained' });
  assert.equal((await service.list()).length, 1);
  assert.ok(await git(root, 'rev-parse', '--verify', 'refs/heads/feature/retained'));
});

test('parallel requests for one branch do not create two worktrees', async t => {
  const { temporary, service } = await fixture(t);
  const outcomes = await Promise.allSettled([
    service.create({ branch: 'feature/one', target: path.join(temporary, 'one') }),
    service.create({ branch: 'feature/one', target: path.join(temporary, 'two') })
  ]);
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
  assert.equal((await service.list()).filter(w => w.branch === 'feature/one').length, 1);
});
