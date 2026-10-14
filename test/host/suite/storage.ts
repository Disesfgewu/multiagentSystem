import * as fs from 'node:fs';
import * as path from 'node:path';
import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
// The same module file the extension loaded, so these are the extension's own objects.
import { STORAGE_COMMANDS, extensionContextForTests, privateStorage } from '../../../src/storage/storageCommands';
import { StorageStatus, createStorageHandle } from '../../../src/storage/extensionStorage';
import { CONFIRM_CLEAR } from '../../../src/storage/private-store';

// Exercises private storage in a real Extension Host: the editor's own storage folder and its
// own SecretStorage. Every value is synthetic and everything written is removed at the end.
const SECRET_VALUE = 'synthetic-host-secret-value-0000';
const WAIT_MS = 20000;

const within = async <T>(what: string, work: PromiseLike<T>): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not answer within ${WAIT_MS / 1000}s`)), WAIT_MS); });
  try {
    return await Promise.race([Promise.resolve(work), limit]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

// The editor gives the storage folder's path before anything has created the folder, so a path is
// resolved through its nearest existing ancestor.
function real(value: string): string {
  const tail: string[] = [];
  let current = path.resolve(value);
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...tail.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      assert.notEqual(parent, current, 'no part of the path exists');
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

function relation(parent: string, child: string): boolean {
  const fold = (text: string): string => (process.platform === 'win32' ? text.toLowerCase() : text);
  const rel = path.relative(fold(real(parent)), fold(real(child)));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export async function runStorageChecks(registered: string[], workspace: string): Promise<string> {
  assert.ok(registered.includes(STORAGE_COMMANDS.status), `${STORAGE_COMMANDS.status} is registered`);
  const context = extensionContextForTests();
  const handle = privateStorage();
  assert.ok(handle, 'the extension created its storage handle');

  const storageFolder = context.globalStorageUri.fsPath;
  const dataFolder = path.join(storageFolder, 'private');
  try {
    // 1. The status command reports availability with codes only.
    const status = await vscode.commands.executeCommand<StorageStatus>(STORAGE_COMMANDS.status, { interactive: false });
    assert.equal(status.state, 'available', JSON.stringify(status));
    assert.equal(JSON.stringify(status).includes(storageFolder), false, 'no path in the report');
    // The test project is not a Git repository, so Git reports no repository for it, and the report says that only the folder itself was checked.
    assert.deepEqual(status.coverage, { level: 'folders-only', folders: 1, withoutRepositoryRoot: 1 });

    // 2. The real storage folder is outside the open project, and the store reads and writes there.
    const used = await handle.use();
    assert.equal(used.ok, true, JSON.stringify(used));
    if (!used.ok) return 'unreachable';
    assert.equal(relation(workspace, storageFolder) || relation(storageFolder, workspace), false, 'the data folder is outside the project, and the project is not inside it');
    const put = used.store.put('profiles', 'host-test-1', { provider: 'claude', label: 'Synthetic host record' }) as { ok: boolean };
    assert.equal(put.ok, true);
    assert.equal((used.store.get('profiles', 'host-test-1') as { found?: boolean }).found, true);
    const file = path.join(dataFolder, 'store.json');
    assert.equal(fs.existsSync(file), true, 'the file is in the editor\'s storage folder');
    assert.equal(relation(workspace, file), false);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o077, 0, 'private to the user');
    assert.deepEqual(fs.readdirSync(workspace), [], 'nothing was written into the project');

    // 3. The editor's real SecretStorage round-trips a synthetic value; the record holds only a reference.
    const saved = await within('SecretStorage store', used.vault.save('host-test-1', SECRET_VALUE)) as { secretRef: string };
    assert.match(saved.secretRef, /^secret:default\/host-test-1$/);
    assert.equal(await within('SecretStorage get', used.vault.read(saved.secretRef)), SECRET_VALUE);
    used.store.put('profiles', 'host-test-1', { provider: 'claude', label: 'Synthetic host record', secretRef: saved.secretRef });
    assert.equal(fs.readFileSync(file, 'utf8').includes(SECRET_VALUE), false, 'the credential is not in the data file');
    const probed = await vscode.commands.executeCommand<StorageStatus>(STORAGE_COMMANDS.status, { interactive: false, probeSecrets: true });
    assert.equal(probed.secrets, 'reachable');

    // 4. Removing the secret and clearing the data leave nothing behind.
    await within('SecretStorage delete', used.vault.remove(saved.secretRef));
    assert.equal(await within('SecretStorage get', used.vault.read(saved.secretRef)), null);
    const cleared = used.store.clear({ confirm: CONFIRM_CLEAR } as never) as { ok: boolean };
    assert.equal(cleared.ok, true);
    assert.equal(fs.existsSync(file), false);

    // 5. When the data folder cannot be used, the reason is reported and nothing is stored elsewhere:
    //    here the editor's data is taken to be inside the project the user opened.
    const inside = path.join(workspace, '.editor-data', 'ext');
    const refused = await createStorageHandle({
      context: { globalStorageUri: { fsPath: inside }, secrets: context.secrets, extensionPath: context.extensionPath },
      workspaceFolders: () => [workspace]
    }).use();
    assert.equal(refused.ok, false);
    assert.ok(!refused.ok && refused.reason === 'directory-rejected' && refused.problems.includes('private-root-inside-repo'));
    assert.deepEqual(fs.readdirSync(workspace), [], 'no folder was created in the project');
  } finally {
    // Whatever happened above, leave no synthetic data behind.
    try { await within('SecretStorage cleanup', context.secrets.delete('multiagentSystem/default/host-test-1')); } catch { /* nothing to remove */ }
    fs.rmSync(dataFolder, { recursive: true, force: true });
  }
  return 'storage host smoke: the editor\'s own storage folder is outside the project; the store reads, writes and clears there; SecretStorage round-trips a synthetic value; an unusable folder is reported and nothing is stored elsewhere';
}
