import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import { FileProbe, findRepositoryRoots } from '../../src/storage/repositoryRoots';

// A scripted file system: paths are built with `path.join` so the same test runs on Windows.
// `entries` maps a path to what lstat shows ('file' or 'dir'); `texts` to what reading shows.
// A value of `{ code }` makes that call fail with that error code. Anything else is "not there".
type Entry = 'file' | 'dir' | { code: string };
const BASE = nodePath.join(os.tmpdir(), 'scripted-repo-walk');
const at = (...parts: string[]): string => nodePath.join(BASE, ...parts);

function probeOf(entries: Record<string, Entry>, texts: Record<string, string | { code: string }> = {}, real: (p: string) => string | { code: string } = (p) => p): FileProbe {
  const absent = (code = 'ENOENT'): never => { throw Object.assign(new Error(`synthetic ${code}`), { code }); };
  return {
    lstat(path) {
      const entry = entries[path];
      if (entry === undefined) return absent();
      if (typeof entry === 'object') return absent(entry.code);
      return { isFile: () => entry === 'file', isDirectory: () => entry === 'dir' };
    },
    readText(path) {
      const text = texts[path];
      if (text === undefined) return absent();
      if (typeof text === 'object') return absent(text.code);
      return text;
    },
    realpath(path) {
      const answer = real(path);
      if (typeof answer === 'object') return absent(answer.code);
      return answer;
    }
  };
}

const sorted = (values: string[]): string[] => [...values].sort();

test('a .git directory in the folder or any ancestor makes that directory a repository root', () => {
  const probe = probeOf({ [at('repo', '.git')]: 'dir' });
  assert.deepEqual(findRepositoryRoots(at('repo', 'a', 'b'), probe), { roots: [at('repo')], problem: null });
  assert.deepEqual(findRepositoryRoots(at('repo'), probe), { roots: [at('repo')], problem: null });
  assert.deepEqual(findRepositoryRoots(at('elsewhere'), probe), { roots: [], problem: null });
});

test('every repository above the folder is returned, not only the nearest', () => {
  const probe = probeOf({ [at('outer', '.git')]: 'dir', [at('outer', 'inner', '.git')]: 'dir' });
  assert.deepEqual(sorted(findRepositoryRoots(at('outer', 'inner', 'pkg'), probe).roots), sorted([at('outer'), at('outer', 'inner')]));
});

test('"not there" and "not a directory" mean there is no repository; any other failure means it cannot be told', () => {
  for (const code of ['ENOENT', 'ENOTDIR']) {
    const probe = probeOf({ [at('repo', 'a', '.git')]: { code } });
    assert.deepEqual(findRepositoryRoots(at('repo', 'a'), probe), { roots: [], problem: null }, code);
  }
  for (const code of ['EACCES', 'EPERM', 'EIO', 'ELOOP', 'EMFILE', 'ETIMEDOUT', 'EBUSY']) {
    for (const where of [at('repo', 'a', '.git'), at('repo', '.git'), at('.git')]) {
      const probe = probeOf({ [where]: { code } });
      assert.deepEqual(findRepositoryRoots(at('repo', 'a'), probe), { roots: [], problem: 'repo-root-unresolvable' }, `${code} at ${nodePath.relative(BASE, where)}`);
    }
  }
});

test('a .git file is followed to the Git directory, and to the checkout that owns it', () => {
  const gitDirectory = at('main', '.git', 'worktrees', 'linked');
  const probe = probeOf(
    { [at('linked', '.git')]: 'file' },
    { [at('linked', '.git')]: `gitdir: ${gitDirectory}\n`, [nodePath.join(gitDirectory, 'commondir')]: '../..\n' }
  );
  const found = findRepositoryRoots(at('linked', 'pkg'), probe);
  assert.equal(found.problem, null);
  assert.deepEqual(sorted(found.roots), sorted([at('linked'), at('main'), at('main', '.git')]));
});

test('a relative gitdir is resolved against the directory that holds the .git file', () => {
  const probe = probeOf(
    { [at('parent', 'vendor', 'sub', '.git')]: 'file' },
    { [at('parent', 'vendor', 'sub', '.git')]: 'gitdir: ../../.git/modules/sub\n' }
  );
  const found = findRepositoryRoots(at('parent', 'vendor', 'sub'), probe);
  assert.deepEqual(sorted(found.roots), sorted([at('parent', 'vendor', 'sub'), at('parent', '.git', 'modules', 'sub')]));
});

test('a .git file that cannot be read, or whose commondir cannot be read, is a failure; one that is dangling or odd is not', () => {
  const pointer = at('main', '.git', 'worktrees', 'linked');
  const entries: Record<string, Entry> = { [at('linked', '.git')]: 'file' };
  const gitFile = at('linked', '.git');
  const commondir = nodePath.join(pointer, 'commondir');
  assert.deepEqual(findRepositoryRoots(at('linked'), probeOf(entries, { [gitFile]: { code: 'EACCES' } })), { roots: [], problem: 'repo-root-unresolvable' });
  assert.deepEqual(findRepositoryRoots(at('linked'), probeOf(entries, { [gitFile]: `gitdir: ${pointer}`, [commondir]: { code: 'EACCES' } })),
    { roots: [], problem: 'repo-root-unresolvable' });

  // The file vanished between looking at it and reading it, or says nothing useful: the folder is still a root.
  assert.deepEqual(findRepositoryRoots(at('linked'), probeOf(entries, {})), { roots: [at('linked')], problem: null });
  assert.deepEqual(findRepositoryRoots(at('linked'), probeOf(entries, { [gitFile]: 'not a pointer at all' })), { roots: [at('linked')], problem: null });
  assert.deepEqual(findRepositoryRoots(at('linked'), probeOf(entries, { [gitFile]: 'gitdir:' })), { roots: [at('linked')], problem: null });
  // A Git directory that is not under a `.git` name (bare or separate) is itself the place.
  const bare = at('bare.git', 'worktrees', 'w');
  const odd = findRepositoryRoots(at('linked'), probeOf(entries, { [gitFile]: `gitdir: ${bare}`, [nodePath.join(bare, 'commondir')]: '../..' }));
  assert.deepEqual(sorted(odd.roots), sorted([at('linked'), at('bare.git')]));
});

test('the folder is walked as it really is: a link into a repository is that repository', () => {
  const probe = probeOf({ [at('repo', '.git')]: 'dir' }, {}, (p) => (p === at('alias') ? at('repo', 'pkg') : p));
  assert.deepEqual(findRepositoryRoots(at('alias'), probe), { roots: [at('repo')], problem: null });
  const missing = probeOf({ [at('repo', '.git')]: 'dir' }, {}, () => ({ code: 'ENOENT' }));
  assert.deepEqual(findRepositoryRoots(at('repo', 'gone'), missing), { roots: [at('repo')], problem: null }, 'a folder that is not there is still walked as given');
  for (const code of ['EACCES', 'ELOOP', 'EIO']) {
    assert.deepEqual(findRepositoryRoots(at('repo'), probeOf({}, {}, () => ({ code }))), { roots: [], problem: 'repo-root-unresolvable' }, code);
  }
});

test('a repository reached under two spellings is one entry, by its real location', () => {
  const probe = probeOf({ [at('spelled', '.git')]: 'dir', [at('real', '.git')]: 'dir' }, {}, (p) => p.startsWith(at('spelled')) ? p.replace(at('spelled'), at('real')) : p);
  const found = findRepositoryRoots(at('spelled', 'pkg'), probe);
  assert.deepEqual(sorted(found.roots), sorted([at('real')]));
});

test('a root whose real location cannot be worked out is a failure, unless it is simply not there', () => {
  const entries: Record<string, Entry> = { [at('repo', '.git')]: 'dir' };
  const failing = probeOf(entries, {}, (p) => (p === at('repo') ? { code: 'EACCES' } : p));
  assert.deepEqual(findRepositoryRoots(at('repo', 'a'), failing), { roots: [], problem: 'repo-root-unresolvable' });
  const absent = probeOf(entries, {}, (p) => (p === at('repo') ? { code: 'ENOENT' } : p));
  assert.deepEqual(findRepositoryRoots(at('repo', 'a'), absent), { roots: [at('repo')], problem: null });
});

test('a path that is absurdly deep is not reasoned about', () => {
  const deep = at(...Array.from({ length: 300 }, () => 'd'));
  assert.deepEqual(findRepositoryRoots(deep, probeOf({})), { roots: [], problem: 'repo-root-unresolvable' });
  const fine = at(...Array.from({ length: 40 }, () => 'd'));
  assert.deepEqual(findRepositoryRoots(fine, probeOf({})), { roots: [], problem: null });
});
