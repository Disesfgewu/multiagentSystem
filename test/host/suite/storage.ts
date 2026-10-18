import * as fs from 'node:fs';
import * as path from 'node:path';
import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
// The same module file the extension loaded, so these are the extension's own objects.
import { STORAGE_COMMANDS, extensionContextForTests, privateStorage } from '../../../src/storage/storageCommands';
import { StorageStatus, createStorageHandle } from '../../../src/storage/extensionStorage';
import { CONFIRM_CLEAR } from '../../../src/storage/private-store';
import { SETUP_COMMANDS } from '../../../src/setup/setupView';
import { outsideTestMode } from './nonInteractiveGate';

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

// The editor's secret storage is a real backend. Seen once in CI (Windows, VS Code stable): a read
// straight after `delete` still returned the old value. So a removal is checked by waiting, for a
// bounded time, until the value is gone, and how long that took is reported; it is not assumed to
// be immediate, and a value that never goes away fails the test.
const REMOVAL_WAIT_MS = 5000;
async function untilGone(read: () => PromiseLike<unknown>): Promise<number> {
  const started = Date.now();
  for (;;) {
    const value = await within('SecretStorage get', read());
    if (value === null || value === undefined) return Date.now() - started;
    if (Date.now() - started > REMOVAL_WAIT_MS) {
      throw new Error(`a removed secret was still readable ${REMOVAL_WAIT_MS} ms after it was deleted`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function relation(parent: string, child: string): boolean {
  const fold = (text: string): string => (process.platform === 'win32' ? text.toLowerCase() : text);
  const rel = path.relative(fold(real(parent)), fold(real(child)));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export async function runStorageChecks(registered: string[], workspace: string): Promise<string> {
  assert.ok(registered.includes(STORAGE_COMMANDS.status), `${STORAGE_COMMANDS.status} is registered`);
  assert.ok(registered.includes(SETUP_COMMANDS.diagnose), `${SETUP_COMMANDS.diagnose} is registered`);
  assert.ok(registered.includes(SETUP_COMMANDS.migrateStorage), `${SETUP_COMMANDS.migrateStorage} is registered`);
  assert.ok(registered.includes(SETUP_COMMANDS.recoverStorageLock), `${SETUP_COMMANDS.recoverStorageLock} is registered`);
  assert.ok(registered.includes(SETUP_COMMANDS.clearStorage), `${SETUP_COMMANDS.clearStorage} is registered`);
  const context = extensionContextForTests();
  const handle = privateStorage();
  assert.ok(handle, 'the extension created its storage handle');

  const storageFolder = context.globalStorageUri.fsPath;
  const dataFolder = path.join(storageFolder, 'private');
  // The project may already hold files (a Git repository, for one); what matters is that storage adds nothing to it.
  const projectBefore = fs.readdirSync(workspace).sort();
  let removalLagMs = -1;
  try {
    // 1. The status command reports availability with codes only.
    const status = await vscode.commands.executeCommand<StorageStatus>(STORAGE_COMMANDS.status, { interactive: false });
    assert.equal(status.state, 'available', JSON.stringify(status));
    assert.equal(JSON.stringify(status).includes(storageFolder), false, 'no path in the report');
    // The repository check reads the file system: the open folder was examined, with its ancestors.
    assert.equal(status.coverage?.level, 'ancestors-checked');
    assert.equal(status.coverage?.folders, 1);
    assert.equal((status.coverage?.repositoriesFound ?? 0) >= (fs.existsSync(path.join(workspace, '.git')) ? 1 : 0), true);

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
    assert.deepEqual(fs.readdirSync(workspace).sort(), projectBefore, 'nothing was written into the project');

    // 3. The editor's real SecretStorage round-trips a synthetic value; the record holds only a reference.
    const saved = await within('SecretStorage store', used.vault.save('host-test-1', SECRET_VALUE)) as { secretRef: string };
    assert.match(saved.secretRef, /^secret:default\/host-test-1$/);
    assert.equal(await within('SecretStorage get', used.vault.read(saved.secretRef)), SECRET_VALUE);
    used.store.put('profiles', 'host-test-1', { provider: 'claude', label: 'Synthetic host record', secretRef: saved.secretRef });
    assert.equal(fs.readFileSync(file, 'utf8').includes(SECRET_VALUE), false, 'the credential is not in the data file');
    const probed = await vscode.commands.executeCommand<StorageStatus>(STORAGE_COMMANDS.status, { interactive: false, probeSecrets: true });
    assert.equal(probed.secrets, 'reachable');

    // 3b. Actionable diagnostics, schema migration, lock recovery, and masked export via commands.
    const diag = await vscode.commands.executeCommand<{ ok: boolean; report: any; text: string; uri: string }>(
      SETUP_COMMANDS.diagnose,
      { interactive: false, probeSecrets: true }
    );
    assert.equal(diag.ok, true);
    assert.equal(diag.report.runtime.vscodeOk, true);
    assert.equal(diag.report.runtime.nodeOk, true);
    assert.equal(diag.text.includes(storageFolder), false, 'diagnostic report omits local paths');
    assert.equal(diag.text.includes('Synthetic host record'), false, 'diagnostic report masks account labels');
    assert.equal(diag.text.includes(SECRET_VALUE), false, 'diagnostic report omits secret values');
    assert.match(diag.text, /profiles#1/, 'diagnostic report includes masked record alias');
    const diagDoc = await vscode.workspace.openTextDocument(vscode.Uri.parse(diag.uri));
    assert.match(diagDoc.getText(), /Multiagent Masked Setup & Storage Diagnostics/);

    const migrated = await vscode.commands.executeCommand<{ ok: boolean; onDiskVersion?: number }>(
      SETUP_COMMANDS.migrateStorage,
      { interactive: false }
    );
    assert.equal(migrated.ok, true);
    assert.equal(migrated.onDiskVersion, 1);

    const lockRecovered = await vscode.commands.executeCommand<{ ok: boolean; recovered: boolean; reason: string }>(
      SETUP_COMMANDS.recoverStorageLock,
      { interactive: false }
    );
    assert.equal(lockRecovered.ok, true);
    assert.equal(lockRecovered.recovered, false);
    assert.equal(lockRecovered.reason, 'not-locked');

    const unconfirmedClear = await vscode.commands.executeCommand<{ ok: boolean; reason?: string }>(
      SETUP_COMMANDS.clearStorage,
      { interactive: false }
    );
    assert.equal(unconfirmedClear.ok, false);
    assert.equal(unconfirmedClear.reason, 'confirmation-required');

    // Outside test mode the confirm token in a payload cannot answer the clear dialog (Refs #183).
    const bypassClear = await outsideTestMode(() => Promise.resolve(vscode.commands.executeCommand<{ ok: boolean; reason?: string }>(
      SETUP_COMMANDS.clearStorage,
      { interactive: false, confirm: CONFIRM_CLEAR }
    )));
    assert.deepEqual(bypassClear.result, { ok: false, reason: 'cancelled' });
    assert.ok(bypassClear.prompts.some((prompt) => prompt.startsWith('Clear all Multiagent private storage')), 'the clear dialog was shown');
    assert.equal(fs.existsSync(file), true, 'a payload alone clears nothing outside test mode');
    const bypassMigrate = await outsideTestMode(() => Promise.resolve(vscode.commands.executeCommand<{ ok: boolean; reason?: string }>(
      SETUP_COMMANDS.migrateStorage,
      { interactive: false }
    )));
    assert.ok(bypassMigrate.prompts.some((prompt) => prompt.startsWith('Private storage schema')), 'outside test mode a migration is reported to the person');

    // 4. Removing the secret and clearing the data via the clearStorage command leave nothing behind.
    assert.deepEqual(await within('SecretStorage delete', used.vault.remove(saved.secretRef)), { ok: true });
    removalLagMs = await untilGone(() => used.vault.read(saved.secretRef));
    const cleared = await vscode.commands.executeCommand<{ ok: boolean }>(
      SETUP_COMMANDS.clearStorage,
      { interactive: false, confirm: CONFIRM_CLEAR }
    );
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
    assert.deepEqual(fs.readdirSync(workspace).sort(), projectBefore, 'no folder was created in the project');
  } finally {
    // Whatever happened above, leave no synthetic data behind.
    try { await within('SecretStorage cleanup', context.secrets.delete('multiagentSystem/default/host-test-1')); } catch { /* nothing to remove */ }
    fs.rmSync(dataFolder, { recursive: true, force: true });
  }
  return `storage host smoke: the editor's own storage folder is outside the project; the store reads, writes and clears there; SecretStorage round-trips a synthetic value; an unusable folder is reported and nothing is stored elsewhere; a removed secret was unreadable after ${removalLagMs} ms`;
}
