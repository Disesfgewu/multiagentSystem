import { test, TestContext } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  COLLECTIONS,
  ExtensionContextLike,
  SecretsLike,
  StorageDeps,
  createStorageHandle,
  describeStorage,
  probeSecretVault,
  statusMessage
} from '../../src/storage/extensionStorage';
import { CONFIRM_CLEAR } from '../../src/storage/private-store';
import { FileProbe } from '../../src/storage/repositoryRoots';

// Real temporary folders and a fake secret backend; everything is synthetic.
interface Sandbox {
  root: string;
  repo: string;
  other: string;
  storage: string;
  context: ExtensionContextLike;
  backend: Map<string, string>;
}

function memorySecrets(backend: Map<string, string>): SecretsLike {
  return {
    async get(key) { return backend.get(key); },
    async store(key, value) { backend.set(key, value); },
    async delete(key) { backend.delete(key); }
  };
}

function sandbox(t: TestContext): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multiagent-extstorage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo with space 帳號');
  const other = path.join(root, 'other project');
  const storage = path.join(root, 'editor data', 'globalStorage', 'publisher.extension');
  fs.mkdirSync(repo);
  fs.mkdirSync(other);
  fs.mkdirSync(path.dirname(storage), { recursive: true });
  const backend = new Map<string, string>();
  return {
    root, repo, other, storage, backend,
    context: { globalStorageUri: { fsPath: storage }, secrets: memorySecrets(backend), extensionPath: path.join(root, 'extension') }
  };
}

const handleFor = (s: Sandbox, folders: () => string[], extra: Partial<StorageDeps> = {}) =>
  createStorageHandle({ context: s.context, workspaceFolders: folders, ...extra });

// Every entry below `dir`, so a test can show that nothing was created anywhere.
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      out.push(path.relative(dir, full));
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out.sort();
}

function tryLink(t: TestContext, target: string, link: string): boolean {
  try {
    fs.symlinkSync(target, link, 'junction');
    return true;
  } catch (error) {
    t.skip(`cannot create a directory link here: ${(error as NodeJS.ErrnoException).code}`);
    return false;
  }
}

// ---- opening ----------------------------------------------------------------

test('storage opens in the editor\'s storage folder, outside the repository, and works', async (t) => {
  const s = sandbox(t);
  const handle = handleFor(s, () => [s.repo]);
  const result = await handle.use();
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.store.put('profiles', 'p1', { provider: 'claude', label: 'Synthetic profile' }).ok, true);
  assert.equal((result.store.get('profiles', 'p1') as { found?: boolean }).found, true);
  for (const name of COLLECTIONS) assert.equal(result.store.list(name).ok, true, `${name} is a collection`);
  assert.equal((result.store.list as (name: string) => { ok: boolean })('somethingElse').ok, false);

  const file = path.join(s.storage, 'private', 'store.json');
  assert.equal(fs.existsSync(file), true, 'the data is in the editor\'s storage folder');
  assert.deepEqual(snapshot(s.repo), [], 'nothing is in the repository');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o077, 0, 'the file is private to the user');
});

test('a secret goes to the editor\'s secret storage and the record holds only an opaque reference', async (t) => {
  const s = sandbox(t);
  const result = await handleFor(s, () => [s.repo]).use();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const saved = await result.vault.save('profile-1', 'synthetic-secret-value-0000') as { secretRef: string };
  assert.equal(result.store.put('profiles', 'p1', { provider: 'codex', label: 'Synthetic', secretRef: saved.secretRef }).ok, true);
  assert.deepEqual([...s.backend.keys()], ['multiagentSystem/default/profile-1']);
  assert.equal(await result.vault.read(saved.secretRef), 'synthetic-secret-value-0000');
  assert.equal(fs.readFileSync(path.join(s.storage, 'private', 'store.json'), 'utf8').includes('synthetic-secret-value'), false);
  // A credential written into a record is refused by the store.
  assert.equal((result.store.put('profiles', 'p2', { provider: 'claude', apiKey: 'synthetic-secret-value-0000' }) as { reason: string }).reason, 'secret-detected');
  await result.vault.remove(saved.secretRef);
  assert.equal(s.backend.size, 0);
});

test('with no folder open there is no repository to be inside of, and nothing is created by opening', async (t) => {
  const s = sandbox(t);
  const before = snapshot(s.root);
  const result = await handleFor(s, () => []).use();
  assert.equal(result.ok, true);
  assert.deepEqual(snapshot(s.root), before, 'opening creates no folder or file');
});

// ---- the data folder must be outside every repository --------------------------

test('a folder that contains the storage folder is refused, with a reason, and nothing is stored elsewhere', async (t) => {
  const s = sandbox(t);
  const before = snapshot(s.root);
  const handle = handleFor(s, () => [s.root]); // the user opened a folder above the editor's data
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await handle.use();
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'directory-rejected');
    assert.ok(result.problems.includes('private-root-inside-repo'), JSON.stringify(result.problems));
  }
  assert.deepEqual(snapshot(s.root), before, 'no folder or file appeared anywhere, so there was no fallback place');
});

test('the repository a folder is inside of is checked, not only the folder: found by its .git, with no Git run', async (t) => {
  const s = sandbox(t);
  // The editor's data lives inside the repository's top level, but outside the opened subfolder.
  const repo = path.join(s.root, 'monorepo');
  const subfolder = path.join(repo, 'packages', 'app');
  const storage = path.join(repo, '.editor-data', 'ext');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(subfolder, { recursive: true });
  fs.mkdirSync(path.dirname(storage), { recursive: true });
  const context: ExtensionContextLike = { ...s.context, globalStorageUri: { fsPath: storage } };
  const before = snapshot(repo);

  const result = await createStorageHandle({ context, workspaceFolders: () => [subfolder] }).use();
  assert.equal(result.ok, false, 'refused on the very first use');
  assert.ok(!result.ok && result.reason === 'directory-rejected' && result.problems.includes('private-root-inside-repo'));
  assert.deepEqual(snapshot(repo), before, 'nothing was created in the repository');
});

test('a storage folder that is a link into the repository is refused and the repository is untouched', async (t) => {
  const s = sandbox(t);
  const data = path.join(s.repo, '.data');
  fs.mkdirSync(data);
  const linked = path.join(s.root, 'editor data', 'globalStorage', 'linked.extension');
  if (!tryLink(t, data, linked)) return;
  const context: ExtensionContextLike = { ...s.context, globalStorageUri: { fsPath: linked } };
  const before = snapshot(s.repo);
  const result = await createStorageHandle({ context, workspaceFolders: () => [s.repo] }).use();
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.problems.includes('private-root-inside-repo'));
  assert.deepEqual(snapshot(s.repo), before);
});

test('a folder added to the workspace later is checked on the next use, without a restart', async (t) => {
  const s = sandbox(t);
  let folders = [s.other];
  const handle = handleFor(s, () => folders);
  assert.equal((await handle.use()).ok, true);
  folders = [s.other, s.root];
  const refused = await handle.use();
  assert.equal(refused.ok, false);
  assert.ok(!refused.ok && refused.problems.includes('private-root-inside-repo'));
  folders = [s.other];
  assert.equal((await handle.use()).ok, true, 'and available again once the folder is removed');
});

test('every open folder is checked: one bad folder among several is enough to refuse', async (t) => {
  const s = sandbox(t);
  const result = await handleFor(s, () => [s.repo, s.other, s.root]).use();
  assert.equal(result.ok, false);
});

// The review's reproduction: Git cannot answer (missing, failing, timed out, not yet trusted). The
// check does not depend on Git, so it makes no difference, and the first use is already refused.
test('the first use is refused when the data is inside the repository, and writing through the result is impossible', async (t) => {
  const s = sandbox(t);
  const repo = path.join(s.root, 'repo-under-review');
  const subfolder = path.join(repo, 'pkg');
  const storage = path.join(repo, '.editor-data');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(subfolder);
  const context: ExtensionContextLike = { ...s.context, globalStorageUri: { fsPath: storage } };
  const before = snapshot(repo);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await createStorageHandle({ context, workspaceFolders: () => [subfolder] }).use();
    assert.equal(result.ok, false, `use ${attempt + 1}`);
    assert.ok(!result.ok && result.problems.includes('private-root-inside-repo'));
    assert.equal('store' in result, false, 'there is no store to write through');
  }
  assert.deepEqual(snapshot(repo), before, 'no .editor-data, no private/store.json');
  assert.equal(fs.existsSync(path.join(storage, 'private', 'store.json')), false);
});

test('a linked worktree or a submodule (a .git file) is found, and so is the checkout that owns it', async (t) => {
  const s = sandbox(t);
  const main = path.join(s.root, 'main-checkout');
  const worktree = path.join(s.root, 'linked-worktree');
  const gitDir = path.join(main, '.git');
  fs.mkdirSync(path.join(gitDir, 'worktrees', 'linked'), { recursive: true });
  fs.mkdirSync(worktree);
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(gitDir, 'worktrees', 'linked')}\n`);
  fs.writeFileSync(path.join(gitDir, 'worktrees', 'linked', 'commondir'), '../..\n');
  const storageInMain = path.join(main, 'notes', 'editor-data');
  fs.mkdirSync(path.dirname(storageInMain), { recursive: true });
  const storageInWorktree = path.join(worktree, '.editor-data');

  const inMain = await createStorageHandle({ context: { ...s.context, globalStorageUri: { fsPath: storageInMain } }, workspaceFolders: () => [worktree] }).use();
  assert.equal(inMain.ok, false, 'the main checkout is another place the repository lives');
  const inWorktree = await createStorageHandle({ context: { ...s.context, globalStorageUri: { fsPath: storageInWorktree } }, workspaceFolders: () => [worktree] }).use();
  assert.equal(inWorktree.ok, false);

  // A submodule: its .git file points into the parent's .git/modules, and the parent is above it.
  const parent = path.join(s.root, 'parent-repo');
  const sub = path.join(parent, 'vendor', 'sub');
  fs.mkdirSync(path.join(parent, '.git', 'modules', 'sub'), { recursive: true });
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, '.git'), 'gitdir: ../../.git/modules/sub\n');
  const storageInParent = path.join(parent, 'docs', 'data');
  fs.mkdirSync(path.dirname(storageInParent), { recursive: true });
  const inParent = await createStorageHandle({ context: { ...s.context, globalStorageUri: { fsPath: storageInParent } }, workspaceFolders: () => [sub] }).use();
  assert.equal(inParent.ok, false);
  assert.ok(!inParent.ok && inParent.problems.includes('private-root-inside-repo'));
});

test('a repository that appears later is noticed on the next use, without a restart', async (t) => {
  const s = sandbox(t);
  const folder = path.join(s.root, 'project');
  const storage = path.join(s.root, 'project-data', 'ext');
  fs.mkdirSync(folder);
  fs.mkdirSync(path.dirname(storage), { recursive: true });
  // The data folder is below the project's parent, which is made a repository afterwards.
  const handle = createStorageHandle({ context: { ...s.context, globalStorageUri: { fsPath: storage } }, workspaceFolders: () => [folder] });
  assert.equal((await handle.use()).ok, true);
  fs.mkdirSync(path.join(s.root, '.git'));
  const refused = await handle.use();
  assert.equal(refused.ok, false);
  assert.ok(!refused.ok && refused.problems.includes('private-root-inside-repo'));
  fs.rmSync(path.join(s.root, '.git'), { recursive: true });
  assert.equal((await handle.use()).ok, true, 'and available again when it is gone');
});

test('a folder that cannot be examined is refused, not assumed to be outside a repository', async (t) => {
  const s = sandbox(t);
  const asked: string[] = [];
  const failing = (codeAt: (path: string) => string | null): FileProbe => ({
    lstat(target) {
      asked.push(target);
      const code = codeAt(target);
      if (code) throw Object.assign(new Error(`synthetic ${code}`), { code });
      throw Object.assign(new Error('synthetic ENOENT'), { code: 'ENOENT' });
    },
    readText() { throw Object.assign(new Error('synthetic ENOENT'), { code: 'ENOENT' }); },
    realpath(target) { return target; }
  });
  for (const code of ['EACCES', 'EPERM', 'EIO', 'ELOOP', 'EMFILE', 'ETIMEDOUT']) {
    const result = await handleFor(s, () => [s.repo], { fileSystem: failing(() => code) }).use();
    assert.equal(result.ok, false, code);
    assert.deepEqual(!result.ok && [result.reason, result.problems], ['directory-rejected', ['repo-root-unresolvable']], code);
  }
  // Only "not there" counts as not there.
  for (const code of ['ENOENT', 'ENOTDIR']) {
    const result = await handleFor(s, () => [s.repo], { fileSystem: failing(() => null) }).use();
    assert.equal(result.ok, true, 'a missing .git everywhere means no repository');
    void code;
  }
  // A failure far up the tree, at an ancestor, is just as much a failure as one at the folder.
  const high = await handleFor(s, () => [s.repo], { fileSystem: failing((target) => (target === path.join(path.dirname(path.dirname(s.repo)), '.git') ? 'EACCES' : null)) }).use();
  assert.equal(high.ok, false);
  assert.ok(asked.length > 0);
  // And so is a link target that cannot be resolved.
  const unresolved: FileProbe = { ...failing(() => null), realpath() { throw Object.assign(new Error('synthetic'), { code: 'EACCES' }); } };
  assert.equal((await handleFor(s, () => [s.repo], { fileSystem: unresolved }).use()).ok, false);
  // A folder that does not exist (a workspace folder that was deleted) has nothing to be inside of.
  const gone: FileProbe = { ...failing(() => null), realpath() { throw Object.assign(new Error('synthetic'), { code: 'ENOENT' }); } };
  assert.equal((await handleFor(s, () => [s.repo], { fileSystem: gone }).use()).ok, true);
  assert.deepEqual(snapshot(s.repo), []);
});

test('a folder reached through a link into a repository is checked as the repository it really is', async (t) => {
  const s = sandbox(t);
  const repo = path.join(s.root, 'real-repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const inner = path.join(repo, 'pkg');
  fs.mkdirSync(inner);
  const alias = path.join(s.root, 'alias');
  if (!tryLink(t, inner, alias)) return;
  const storage = path.join(repo, '.editor-data');
  const result = await createStorageHandle({ context: { ...s.context, globalStorageUri: { fsPath: storage } }, workspaceFolders: () => [alias] }).use();
  assert.equal(result.ok, false, 'the alias sits outside the repository, the folder it points at does not');
});

test('the result says what was covered, and that a repository was found above the open folders', async (t) => {
  const s = sandbox(t);
  const outside = await handleFor(s, () => [s.repo, s.other]).use();
  assert.deepEqual(outside.ok && outside.coverage, { level: 'ancestors-checked', folders: 2, repositoriesFound: 0 });
  fs.mkdirSync(path.join(s.repo, '.git'));
  const inside = await handleFor(s, () => [s.repo, s.other]).use();
  assert.deepEqual(inside.ok && inside.coverage, { level: 'ancestors-checked', folders: 2, repositoriesFound: 1 });
  const none = await handleFor(s, () => []).use();
  assert.deepEqual(none.ok && none.coverage, { level: 'no-folder-open', folders: 0, repositoriesFound: 0 });
});

// ---- the editor does not provide what is needed -------------------------------

test('a context without a storage folder or secret storage is reported, not thrown', async (t) => {
  const s = sandbox(t);
  const incomplete: unknown[] = [
    {}, null, undefined, { globalStorageUri: { fsPath: s.storage } }, { secrets: memorySecrets(new Map()) },
    { globalStorageUri: {}, secrets: memorySecrets(new Map()) }, { globalStorageUri: { fsPath: s.storage }, secrets: {} }
  ];
  for (const context of incomplete) {
    const result = await createStorageHandle({ context: context as ExtensionContextLike, workspaceFolders: () => [s.repo] }).use();
    assert.equal(result.ok, false, JSON.stringify(context));
    assert.ok(!result.ok && result.reason === 'context-incomplete');
  }
  assert.deepEqual(snapshot(s.repo), []);
});

test('a folder where a file is in the way is refused by the store, not worked around', async (t) => {
  const s = sandbox(t);
  fs.mkdirSync(s.storage, { recursive: true });
  fs.writeFileSync(path.join(s.storage, 'private'), 'a file where the data folder should be');
  const result = await handleFor(s, () => [s.repo]).use();
  assert.equal(result.ok, true, 'opening only builds the store');
  if (!result.ok) return;
  const put = result.store.put('profiles', 'p1', { provider: 'claude' }) as { ok: boolean; reason?: string };
  assert.equal(put.ok, false);
  assert.equal(put.reason, 'directory-rejected');
  assert.deepEqual(fs.readdirSync(s.storage), ['private'], 'no other folder was used instead');
  assert.deepEqual(snapshot(s.repo), []);
});

// ---- the report ---------------------------------------------------------------

test('the status report holds codes only: no path, no contents', async (t) => {
  const s = sandbox(t);
  const ready = await describeStorage(handleFor(s, () => [s.repo]), { probeSecrets: true });
  assert.deepEqual(ready, {
    state: 'available', reason: null, problems: [], store: { ok: true, reason: null, detail: null },
    coverage: { level: 'ancestors-checked', folders: 1, repositoriesFound: 0 }, secrets: 'reachable'
  });
  const refused = await describeStorage(handleFor(s, () => [s.root]));
  assert.equal(refused.state, 'unavailable');
  assert.equal(refused.reason, 'directory-rejected');
  assert.equal(refused.coverage, null);
  assert.equal(refused.secrets, 'not-checked');
  for (const report of [ready, refused]) {
    const text = JSON.stringify(report);
    assert.equal(text.includes(s.root), false, 'no path');
    assert.equal(text.includes(os.tmpdir()), false, 'no path');
    assert.equal(text.includes('帳號'), false);
  }
  assert.equal(s.backend.size, 0, 'the probe leaves nothing behind');
});

test('a store that cannot be read is reported with the store\'s own reason, and the file is not touched', async (t) => {
  const s = sandbox(t);
  const handle = handleFor(s, () => [s.repo]);
  const opened = await handle.use();
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  opened.store.put('profiles', 'p1', { provider: 'claude' });
  const file = path.join(s.storage, 'private', 'store.json');
  fs.writeFileSync(file, '{ truncated');
  const report = await describeStorage(handle);
  assert.equal(report.state, 'available');
  assert.deepEqual([report.store?.ok, report.store?.reason], [false, 'corrupt']);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ truncated');
  // Clearing is the recovery path, and needs the explicit confirmation.
  assert.equal((opened.store.clear({ confirm: CONFIRM_CLEAR } as never) as { ok: boolean }).ok, true);
  assert.equal(fs.existsSync(file), false);
});

test('the secret probe fails cleanly when the backend fails or never answers, and cleans up what it can', async (t) => {
  const s = sandbox(t);
  const opened = await handleFor(s, () => [s.repo]).use();
  assert.equal(opened.ok, true);
  if (!opened.ok) return;

  const broken: SecretsLike = { get: async () => { throw new Error('backend down'); }, store: async () => { throw new Error('backend down'); }, delete: async () => undefined };
  const failing = await createStorageHandle({ context: { ...s.context, secrets: broken }, workspaceFolders: () => [s.repo] }).use();
  assert.equal(failing.ok && (await probeSecretVault(failing.vault)), false);

  const stuck: SecretsLike = { get: () => new Promise(() => undefined), store: () => new Promise(() => undefined), delete: () => new Promise(() => undefined) };
  const hanging = await createStorageHandle({ context: { ...s.context, secrets: stuck }, workspaceFolders: () => [s.repo] }).use();
  const started = Date.now();
  assert.equal(hanging.ok && (await probeSecretVault(hanging.vault, 60)), false);
  assert.ok(Date.now() - started < 5000, 'it does not wait without end');
  const report = await describeStorage(createStorageHandle({ context: { ...s.context, secrets: broken }, workspaceFolders: () => [s.repo] }), { probeSecrets: true });
  assert.equal(report.secrets, 'unreachable');
});

test('secret references are scoped to the namespace the extension chose', async (t) => {
  const s = sandbox(t);
  const result = await handleFor(s, () => [s.repo], { namespace: 'accounts' }).use();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  await result.vault.save('profile-1', 'synthetic-value');
  assert.deepEqual([...s.backend.keys()], ['multiagentSystem/accounts/profile-1']);
  await assert.rejects(() => result.vault.read('secret:default/profile-1'), TypeError);
});

test('the message for the user says what is wrong in codes, and that nothing is stored elsewhere', async (t) => {
  const s = sandbox(t);
  const ready = statusMessage(await describeStorage(handleFor(s, () => [s.repo])));
  assert.deepEqual(ready, { level: 'info', text: 'Private storage is available (store: ok).' });

  const refused = statusMessage(await describeStorage(handleFor(s, () => [s.root])));
  assert.equal(refused.level, 'error');
  assert.match(refused.text, /^Private storage is unavailable: directory-rejected \(private-root-inside-repo\)\. Nothing is stored elsewhere instead\.$/);
  assert.equal(refused.text.includes(s.root), false);

  const incomplete = statusMessage(await describeStorage(createStorageHandle({ context: {}, workspaceFolders: () => [] })));
  assert.match(incomplete.text, /unavailable: context-incomplete \(storage-folder-or-secrets-missing\)\./);

  const opened = await handleFor(s, () => [s.repo]).use();
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  opened.store.put('profiles', 'p1', { provider: 'claude' });
  fs.writeFileSync(path.join(s.storage, 'private', 'store.json'), '{ truncated');
  assert.deepEqual(statusMessage(await describeStorage(handleFor(s, () => [s.repo]))),
    { level: 'error', text: 'Private storage is available (store: corrupt).' });
});

test('two probes at once cannot delete each other\'s value', async (t) => {
  const s = sandbox(t);
  const opened = await handleFor(s, () => [s.repo]).use();
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const results = await Promise.all(Array.from({ length: 6 }, () => probeSecretVault(opened.vault)));
  assert.deepEqual(results, [true, true, true, true, true, true], 'each probe has its own key');
  assert.equal(s.backend.size, 0, 'and none leaves a value behind');
});
