'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const { inspectWorktree, describeEvidence, readMainHead, parseStatus, parseDivergence } = require('../../src/projects/gitEvidence');

const git = async (cwd, ...args) => (await exec('git', args, { cwd, encoding: 'utf8' })).stdout.trim();

async function repo(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'multiagent-git-evidence-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const empty = path.join(temporary, 'empty-template');
  await fs.mkdir(empty);
  const remote = path.join(temporary, 'remote.git');
  await exec('git', ['init', '--bare', '-b', 'main', `--template=${empty}`, remote]);
  const root = path.join(temporary, 'work tree 帳號');
  await fs.mkdir(root);
  await git(root, 'init', '-b', 'main', `--template=${empty}`);
  for (const [key, value] of [['user.name', 'Synthetic Test'], ['user.email', 'synthetic@example.test'], ['commit.gpgsign', 'false'], ['core.hooksPath', empty]]) await git(root, 'config', key, value);
  await fs.writeFile(path.join(root, 'file.txt'), 'initial\n');
  await git(root, 'add', 'file.txt');
  await git(root, 'commit', '-m', 'initial');
  await git(root, 'remote', 'add', 'origin', remote);
  await git(root, 'push', '-u', 'origin', 'main');
  return { temporary, root, remote };
}

test('status output is counted: changed, untracked, renames take one entry, ignored are not work', () => {
  assert.deepEqual(parseStatus(''), { changed: 0, untracked: 0 });
  assert.deepEqual(parseStatus(' M a.txt\0A  b.txt\0?? c.txt\0?? d e.txt\0!! ignored\0'), { changed: 2, untracked: 2 });
  assert.deepEqual(parseStatus('R  new.txt\0old.txt\0 M other.txt\0'), { changed: 2, untracked: 0 }, 'a rename and its old name are one change');
  assert.deepEqual(parseStatus('UU conflict.txt\0'), { changed: 1, untracked: 0 });
});

test('divergence is read only from the exact two numbers git prints', () => {
  assert.deepEqual(parseDivergence('3\t5\n'), { behind: 3, ahead: 5 });
  assert.deepEqual(parseDivergence('0 0'), { behind: 0, ahead: 0 });
  for (const bad of ['', 'x\t1', '1', '1\t2\t3', '-1\t2', '99999999999\t1', '1\t2 extra']) assert.equal(parseDivergence(bad), null, JSON.stringify(bad));
});

test('a clean folder that matches its upstream, a dirty one, and one ahead are each reported from real git', async (t) => {
  const { root } = await repo(t);
  const clean = await inspectWorktree(root);
  assert.deepEqual([clean.state, clean.dirty, clean.changed, clean.untracked, clean.branch], ['known', false, 0, 0, 'main']);
  assert.deepEqual(clean.upstream, { ahead: 0, behind: 0 });
  assert.match(clean.head, /^[a-f0-9]{12}$/);
  await fs.writeFile(path.join(root, 'file.txt'), 'edited\n');
  await fs.writeFile(path.join(root, 'new file.txt'), 'x\n');
  const dirty = await inspectWorktree(root);
  assert.deepEqual([dirty.dirty, dirty.changed, dirty.untracked], [true, 1, 1]);
  await git(root, 'add', '-A');
  await git(root, 'commit', '-m', 'work');
  const ahead = await inspectWorktree(root);
  assert.deepEqual([ahead.dirty, ahead.upstream], [false, { ahead: 1, behind: 0 }]);
});

test('behind and diverged are counted, and a branch without an upstream says the upstream is unknown rather than zero', async (t) => {
  const { root, temporary, remote } = await repo(t);
  const other = path.join(temporary, 'other');
  await exec('git', ['clone', remote, other]);
  for (const [key, value] of [['user.name', 'Synthetic Test'], ['user.email', 'synthetic@example.test'], ['commit.gpgsign', 'false']]) await git(other, 'config', key, value);
  await fs.writeFile(path.join(other, 'remote.txt'), 'r\n');
  await git(other, 'add', '-A');
  await git(other, 'commit', '-m', 'remote work');
  await git(other, 'push');
  await git(root, 'fetch');
  assert.deepEqual((await inspectWorktree(root)).upstream, { ahead: 0, behind: 1 });
  await fs.writeFile(path.join(root, 'local.txt'), 'l\n');
  await git(root, 'add', '-A');
  await git(root, 'commit', '-m', 'local work');
  assert.deepEqual((await inspectWorktree(root)).upstream, { ahead: 1, behind: 1 });
  await git(root, 'switch', '-c', 'no-upstream');
  const lonely = await inspectWorktree(root);
  assert.deepEqual([lonely.state, lonely.upstream, lonely.branch], ['known', null, 'no-upstream']);
  assert.match(describeEvidence(lonely), /upstream unknown/);
  await git(root, 'switch', '--detach', 'HEAD');
  assert.equal((await inspectWorktree(root)).branch, null, 'a detached HEAD has no branch');
});

test('anything unreadable is unknown with a reason, never clean', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'multiagent-git-evidence-none-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  assert.deepEqual(await inspectWorktree(temporary), { state: 'unknown', reason: 'not-readable' });
  assert.deepEqual(await inspectWorktree(path.join(temporary, 'missing')), { state: 'unknown', reason: 'not-readable' });
  for (const bad of [undefined, null, '', 'relative/path', 5]) assert.deepEqual(await inspectWorktree(bad), { state: 'unknown', reason: 'no-folder' });
  assert.deepEqual(await inspectWorktree('/x', { git: async () => { throw new Error('boom'); } }), { state: 'unknown', reason: 'not-readable' });
  assert.match(describeEvidence({ state: 'unknown', reason: 'not-readable' }), /^Git: unknown \(Git could not read/);
  assert.equal(describeEvidence(undefined), 'Git: unknown');
});

test('reading never takes the repository index lock, never runs a configured file monitor, and the answer carries no path or file name', { skip: process.platform === 'win32' }, async (t) => {
  const { root, temporary } = await repo(t);
  const marker = path.join(temporary, 'monitor-ran');
  await git(root, 'config', 'core.fsmonitor', `touch ${marker} #`);
  await fs.writeFile(path.join(root, 'secret-name.txt'), 'x\n');
  // Control: plain `git status` does run the configured monitor here, so the assertions below are not vacuous.
  await exec('git', ['status', '--porcelain'], { cwd: root });
  assert.equal(await fs.access(marker).then(() => true, () => false), true, 'control: the monitor runs under plain git');
  await fs.rm(marker);
  const evidence = await inspectWorktree(root, { git: async (cwd, args) => { return (await exec('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8' })).stdout; } });
  assert.equal(evidence.untracked, 1);
  assert.equal(await fs.access(marker).then(() => true, () => false), false, 'the configured monitor command did not run');
  // The real runner (no injected git) must behave the same way.
  await inspectWorktree(root);
  assert.equal(await fs.access(marker).then(() => true, () => false), false, 'nor did the default runner run it');
  assert.equal(await fs.access(path.join(root, '.git', 'index.lock')).then(() => true, () => false), false);
  const text = JSON.stringify(evidence) + describeEvidence(evidence);
  assert.equal(text.includes('secret-name'), false);
  assert.equal(text.includes(temporary), false, 'no path');
  assert.equal(text.includes('remote.git'), false, 'no remote address');
});

test('the main head is a short commit id from the local origin/main, and anything else is unknown with a reason', async () => {
  const asked = [];
  const git = async (cwd, args) => { asked.push(args); return 'abc123def456\n'; };
  assert.deepEqual(await readMainHead(path.resolve('/work/project'), { git }), { state: 'known', head: 'abc123def456' });
  assert.ok(asked[0].includes('refs/remotes/origin/main^{commit}') && asked[0].includes('--short=12'), 'it reads the last fetched origin/main and never contacts the remote');
  assert.deepEqual(await readMainHead(path.resolve('/work/project'), { git: async () => { throw new Error('no such ref'); } }), { state: 'unknown', reason: 'not-readable' });
  for (const output of ['', 'not a sha', 'abc\nrm -rf', 5, null]) assert.deepEqual(await readMainHead(path.resolve('/work/project'), { git: async () => output }), { state: 'unknown', reason: 'not-readable' }, String(output));
  for (const folder of [undefined, null, 5, 'relative/path', '']) assert.deepEqual(await readMainHead(folder, { git: async () => 'abc123def456' }), { state: 'unknown', reason: 'no-folder' }, String(folder));
});

test('in a real repository the main head is read from refs/remotes/origin/main, and is unknown without it', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mas-mainhead-')));
  try {
    const run = (...args) => exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' });
    await run('init', '-q');
    await run('commit', '-q', '--allow-empty', '-m', 'one');
    assert.deepEqual(await readMainHead(root), { state: 'unknown', reason: 'not-readable' }, 'no origin/main yet');
    await run('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const expected = (await run('rev-parse', '--short=12', 'HEAD')).stdout.trim();
    assert.deepEqual(await readMainHead(root), { state: 'known', head: expected });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
