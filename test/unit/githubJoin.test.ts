import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { collectGitHub, worktreeInfoFor, MAX_CHECK_READS, JoinDeps, JoinReader } from '../../src/overview/githubJoin';

const { buildOverview } = require('../../src/overview/model') as { buildOverview(input: Record<string, unknown>): { rows: any[] } };

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const pr = (over: Record<string, unknown> = {}) => ({ number: 7, state: 'open', headRef: 'feat/x', headSha: SHA, headRepository: 'owner/repo', draft: false, title: 'T', ...over });

function deps(over: { worktrees?: Record<string, { repository: string | null; branch: string | null } | Error>; reader?: Partial<JoinReader> | null } = {}): JoinDeps & { calls: string[] } {
  const calls: string[] = [];
  const base: JoinReader = {
    async listPullRequests() { return { kind: 'ok', data: [pr()] }; },
    async getPullRequestSnapshot() { return { status: 'complete', checksSummary: { state: 'passing', requiredState: 'passing', headSha: SHA } }; },
    ...over.reader
  };
  const reader: JoinReader | null = over.reader === null ? null : {
    async listPullRequests(filter) { calls.push('list'); return base.listPullRequests(filter); },
    async getPullRequestSnapshot(number) { calls.push(`snapshot:${number}`); return base.getPullRequestSnapshot(number); }
  };
  return {
    calls,
    now: () => new Date('2026-10-16T00:00:00.000Z'),
    async worktreeInfo(worktree) {
      const found = over.worktrees?.[worktree];
      if (found instanceof Error) throw found;
      return found ?? { repository: 'owner/repo', branch: 'feat/x' };
    },
    readerFor: () => reader
  };
}
const session = (id: string, worktree = `/wt/${id}`) => ({ id, worktree });
const rowFor = async (sessions: ReturnType<typeof session>[], d: ReturnType<typeof deps>) => {
  const joined = await collectGitHub(sessions, d);
  const group = joined.groups[0];
  return buildOverview({ sessions: sessions.map((entry) => ({ id: entry.id, roleGroupId: 'r', accountProfileId: 'a', state: 'terminal-open' })), branches: joined.branches, repository: group?.repository, github: group?.github }).rows[0];
};

test('a session on a branch with an open pull request shows the pull request and its checks', async () => {
  const d = deps();
  const row = await rowFor([session('s1')], d);
  assert.deepEqual(row.branch, { state: 'known', value: 'feat/x' });
  assert.equal(row.pullRequest.number, 7);
  assert.equal(row.pullRequest.url, 'https://github.com/owner/repo/pull/7');
  assert.deepEqual([row.ci.state, row.ci.value], ['known', 'passing']);
  assert.deepEqual(d.calls, ['list', 'snapshot:7']);
});

test('only pull requests on a session\'s branch have their checks read, and never more than the cap', async () => {
  const many = Array.from({ length: 40 }, (_, i) => pr({ number: i + 1, headRef: i < 30 ? 'feat/x' : 'other' }));
  const d = deps({ reader: { async listPullRequests() { return { kind: 'ok', data: many }; } } });
  const joined = await collectGitHub([session('s1')], d);
  assert.equal(d.calls.filter((call) => call.startsWith('snapshot')).length, MAX_CHECK_READS);
  assert.equal(joined.groups[0].github.pullRequests?.length, 40);
  assert.equal(joined.groups[0].github.pullRequests?.filter((entry) => entry.checks).length, MAX_CHECK_READS);
  const none = deps({ reader: { async listPullRequests() { return { kind: 'ok', data: [pr({ headRef: 'unrelated' })] }; } } });
  await collectGitHub([session('s1')], none);
  assert.deepEqual(none.calls, ['list'], 'no checks are read for other branches');
});

test('an incomplete or failed list is passed on as such, never as "no pull request"', async () => {
  for (const kind of ['partial', 'truncated', 'denied', 'rate_limited', 'transient', 'offline', 'cancelled', 'invalid', 'not_found']) {
    const d = deps({ reader: { async listPullRequests() { return { kind, data: [pr()] }; } } });
    const row = await rowFor([session('s1')], d);
    assert.equal(row.pullRequest.state, 'unknown', kind);
    assert.equal(row.ci.state, 'unknown', kind);
    assert.deepEqual(d.calls, ['list'], `${kind}: nothing more is read`);
  }
  const thrown = await rowFor([session('s1')], deps({ reader: { async listPullRequests() { throw new Error('network down'); } } }));
  assert.equal(thrown.pullRequest.state, 'unknown');
  const empty = await rowFor([session('s1')], deps({ reader: { async listPullRequests() { return { kind: 'empty', data: [] }; } } }));
  assert.deepEqual(empty.pullRequest, { state: 'none' }, 'an empty, complete list is "none"');
  const noReader = await collectGitHub([session('s1')], deps({ reader: null }));
  assert.equal(noReader.groups[0].github.kind, 'denied');
  assert.equal(buildOverview({ sessions: [{ id: 's1', roleGroupId: 'r', accountProfileId: 'a', state: 'terminal-open' }], branches: noReader.branches, repository: 'owner/repo', github: noReader.groups[0].github }).rows[0].pullRequest.state, 'unknown');
});

test('a pull request from a fork with the same branch name is not adopted', async () => {
  const d = deps({ reader: { async listPullRequests() { return { kind: 'ok', data: [pr({ number: 99, headRepository: 'someone-else/fork' })] }; } } });
  const row = await rowFor([session('s1')], d);
  assert.equal(row.pullRequest.state, 'unknown');
  assert.equal(JSON.stringify(row).includes('99'), false);
});

test('checks that cannot be read, or belong to another head, are unknown', async () => {
  const cases: Array<[string, Partial<JoinReader>]> = [
    ['throws', { async getPullRequestSnapshot() { throw new Error('x'); } }],
    ['partial', { async getPullRequestSnapshot() { return { status: 'partial', checksSummary: { state: 'passing', requiredState: 'passing', headSha: SHA } }; } }],
    ['no summary', { async getPullRequestSnapshot() { return { status: 'complete', checksSummary: null }; } }],
    ['missing fields', { async getPullRequestSnapshot() { return { status: 'complete', checksSummary: { state: 'passing' } }; } }],
    ['other head', { async getPullRequestSnapshot() { return { status: 'complete', checksSummary: { state: 'passing', requiredState: 'passing', headSha: OTHER } }; } }]
  ];
  for (const [name, reader] of cases) {
    const row = await rowFor([session('s1')], deps({ reader }));
    assert.equal(row.pullRequest.state, 'open', name);
    assert.equal(row.ci.state, 'unknown', name);
  }
});

test('sessions without a branch, a repository or a readable worktree stay unknown and do not stop the others', async () => {
  const d = deps({ worktrees: { '/wt/detached': { repository: 'owner/repo', branch: null }, '/wt/norepo': { repository: null, branch: 'feat/x' }, '/wt/broken': new Error('not a repository'), '/wt/badrepo': { repository: 'not a repo', branch: 'feat/x' } } });
  const joined = await collectGitHub([session('good'), session('detached'), session('norepo'), session('broken'), session('badrepo')], d);
  assert.deepEqual(Object.keys(joined.branches).sort(), ['badrepo', 'good', 'norepo']);
  assert.deepEqual(joined.groups.map((group) => [group.repository, group.sessionIds]), [['owner/repo', ['good', 'detached']]]);
  assert.equal(Object.hasOwn(joined.branches, '__proto__'), false);
});

test('a session whose id is a property name of every object still gets its own branch', async () => {
  const joined = await collectGitHub([session('__proto__'), session('constructor')], deps());
  assert.equal(Object.hasOwn(joined.branches, '__proto__'), true);
  assert.equal(joined.branches['__proto__'], 'feat/x');
  assert.equal(joined.branches['constructor'], 'feat/x');
  assert.deepEqual(joined.groups[0].sessionIds, ['__proto__', 'constructor']);
});

test('sessions of different repositories are read separately', async () => {
  const d = deps({ worktrees: { '/wt/a': { repository: 'one/a', branch: 'feat/x' }, '/wt/b': { repository: 'two/b', branch: 'feat/y' } } });
  const joined = await collectGitHub([session('a'), session('b')], d);
  assert.deepEqual(joined.groups.map((group) => group.repository), ['one/a', 'two/b']);
  assert.equal(d.calls.filter((call) => call === 'list').length, 2);
});

test('the real worktree lookup finds the branch by resolved path, in the main folder and in a linked worktree', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'multiagent-join-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  const linked = path.join(root, 'linked');
  git('worktree', 'add', '-q', '-b', 'feat/linked', linked);
  const link = path.join(root, 'link-to-linked');
  fs.symlinkSync(linked, link, 'dir');
  return (async () => {
    assert.deepEqual(await worktreeInfoFor(repo), { repository: 'owner/project', branch: 'main' });
    assert.deepEqual(await worktreeInfoFor(linked), { repository: 'owner/project', branch: 'feat/linked' });
    assert.deepEqual(await worktreeInfoFor(link), { repository: 'owner/project', branch: 'feat/linked' }, 'matched by resolved path');
    git('-C', linked, 'checkout', '-q', '--detach');
    assert.equal((await worktreeInfoFor(linked)).branch, null, 'a detached head has no branch');
    await assert.rejects(worktreeInfoFor(path.join(root, 'missing')));
  })();
});
