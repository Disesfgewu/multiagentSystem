import * as nodePath from 'node:path';
import { PrivateStore } from './private-store';
import { checkPrivateRoot } from './paths';
import { SecretVault, fromExtensionContext } from './secrets';

// Opens the private store and the secret vault for the extension, from what the editor
// provides: `globalStorageUri` for the data folder and `secrets` for credentials. It does
// not import `vscode`; the pieces it needs are passed in, so it is tested with real
// temporary folders and runs unchanged in the Extension Host.
//
// Two rules shape everything here:
//   * Private data lives only in the editor's own storage folder for this extension. If that
//     folder cannot be used, storage is reported as unavailable with a reason. There is no
//     fallback to another place: not a folder in the repository, not the home or temporary
//     folder, not the working directory.
//   * The check against the repositories is made on every use, not once, because workspace
//     folders can be added after activation.

export const COLLECTIONS = ['profiles', 'roleGroups', 'sessions', 'policies'] as const;
export const SCHEMA_VERSION = 1;
export const PRIVATE_FOLDER = 'private';
export const DEFAULT_NAMESPACE = 'default';

// The classes are plain JavaScript; these are the types of their instances.
export type PrivateStoreInstance = InstanceType<typeof PrivateStore>;
export type SecretVaultInstance = InstanceType<typeof SecretVault>;

export interface SecretsLike {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

export interface ExtensionContextLike {
  readonly globalStorageUri?: { readonly fsPath: string };
  readonly secrets?: SecretsLike;
  readonly extensionPath?: string;
}

export interface StorageDeps {
  context: ExtensionContextLike;
  /** The folders of the open workspace, as paths. Read again on every use. */
  workspaceFolders(): string[];
  /**
   * The top-level directory of the repository a folder belongs to, or null when it is not in
   * one. Optional: a folder is always checked as given, this adds the repository around it.
   */
  repositoryRoot?(folder: string): Promise<string | null>;
  namespace?: string;
}

export type UnavailableReason =
  | 'context-incomplete'       // the editor did not provide a storage folder or secret storage
  | 'directory-rejected'       // the data folder is inside a repository, contains one, or cannot be verified
  | 'store-rejected';          // the store refused to open for another reason

export interface Unavailable {
  ok: false;
  reason: UnavailableReason;
  /** Short codes only (for example `private-root-inside-repo`), never a path. */
  problems: string[];
}

export interface Ready {
  ok: true;
  store: PrivateStoreInstance;
  vault: SecretVaultInstance;
}

export type StorageResult = Ready | Unavailable;

export interface StorageHandle {
  /** Re-checks the data folder against every open repository, then returns the store and vault. */
  use(): Promise<StorageResult>;
}

const unavailable = (reason: UnavailableReason, problems: string[]): Unavailable => ({ ok: false, reason, problems });

function distinct(values: string[]): string[] {
  return [...new Set(values)];
}

export function createStorageHandle(deps: StorageDeps): StorageHandle {
  const namespace = deps.namespace ?? DEFAULT_NAMESPACE;
  // Repository roots found by Git are remembered per folder, so the Git lookup is not repeated
  // on every use. The folder itself is still checked each time.
  const roots = new Map<string, string | null>();

  async function rootOf(folder: string): Promise<string | null> {
    if (!deps.repositoryRoot) return null;
    if (roots.has(folder)) return roots.get(folder) ?? null;
    let found: string | null = null;
    try {
      found = await deps.repositoryRoot(folder);
    } catch {
      found = null; // not a repository, or Git is unavailable: the folder itself is still checked
    }
    roots.set(folder, found);
    return found;
  }

  return {
    async use(): Promise<StorageResult> {
      let dir: string;
      let vault: SecretVaultInstance;
      try {
        const bound = fromExtensionContext(deps.context, namespace) as { storageDir: string; vault: SecretVaultInstance };
        dir = nodePath.join(bound.storageDir, PRIVATE_FOLDER);
        vault = bound.vault;
      } catch {
        return unavailable('context-incomplete', ['storage-folder-or-secrets-missing']);
      }

      // Every folder that is open now, and the repository it belongs to.
      const folders = deps.workspaceFolders();
      const checked: string[] = [];
      for (const folder of folders) {
        checked.push(folder);
        const root = await rootOf(folder);
        if (root !== null && root !== folder) checked.push(root);
      }
      // With nothing open there is no repository to be inside of. The extension's own folder
      // stands in only so the store has a repository path to compare against; it is never
      // used as a place to store anything.
      const standIn = deps.context.extensionPath;
      const toCheck = distinct(checked.length > 0 ? checked : standIn ? [standIn] : []);
      if (toCheck.length === 0) return unavailable('directory-rejected', ['repo-root-missing']);

      const problems: string[] = [];
      for (const root of toCheck) {
        const verdict = checkPrivateRoot(dir, root) as { ok: boolean; problems: string[] };
        if (!verdict.ok) problems.push(...verdict.problems);
      }
      if (problems.length > 0) return unavailable('directory-rejected', distinct(problems));

      try {
        const options = { dir, repoRoot: toCheck[0], collections: [...COLLECTIONS], schemaVersion: SCHEMA_VERSION };
        const store = new PrivateStore(options as unknown as ConstructorParameters<typeof PrivateStore>[0]);
        return { ok: true, store, vault };
      } catch (error) {
        const found = (error as { problems?: unknown }).problems;
        return unavailable('store-rejected', Array.isArray(found) ? found.filter((item): item is string => typeof item === 'string') : ['unknown']);
      }
    }
  };
}

export interface StorageStatus {
  state: 'available' | 'unavailable';
  reason: UnavailableReason | null;
  problems: string[];
  /** The store's own report: `null` when the data folder cannot be used. */
  store: { ok: boolean; reason: string | null; detail: string | null } | null;
  /** Whether a value could be written to, read from and removed from the editor's secret storage. */
  secrets: 'reachable' | 'unreachable' | 'not-checked';
}

/** What to tell the user about a status report. Codes only: no path and no contents. */
export function statusMessage(status: StorageStatus): { level: 'info' | 'error'; text: string } {
  if (status.state === 'available') {
    const store = status.store;
    const detail = store === null ? 'unknown' : store.ok ? 'ok' : (store.reason ?? 'unknown');
    return { level: store !== null && !store.ok ? 'error' : 'info', text: `Private storage is available (store: ${detail}).` };
  }
  const codes = status.problems.length > 0 ? ` (${status.problems.join(', ')})` : '';
  return { level: 'error', text: `Private storage is unavailable: ${status.reason ?? 'unknown'}${codes}. Nothing is stored elsewhere instead.` };
}

const SECRET_PROBE_TIMEOUT_MS = 10000;

/**
 * A report that is safe to show: codes only, no paths and no contents. The secret storage
 * is exercised with a synthetic value only when `probeSecrets` is set, because a real
 * secret backend (the operating system's secret store) can ask the user for permission.
 */
export async function describeStorage(handle: StorageHandle, options: { probeSecrets?: boolean } = {}): Promise<StorageStatus> {
  const result = await handle.use();
  if (!result.ok) {
    return { state: 'unavailable', reason: result.reason, problems: result.problems, store: null, secrets: 'not-checked' };
  }
  const status = result.store.status() as { ok: boolean; reason: string | null; detail: string | null };
  let secrets: StorageStatus['secrets'] = 'not-checked';
  if (options.probeSecrets) secrets = (await probeSecretVault(result.vault)) ? 'reachable' : 'unreachable';
  return {
    state: 'available',
    reason: null,
    problems: [],
    store: { ok: status.ok, reason: status.reason ?? null, detail: status.detail ?? null },
    secrets
  };
}

/** Writes, reads and removes one synthetic value. Never leaves it behind, and never waits without end. */
export async function probeSecretVault(vault: SecretVaultInstance, timeoutMs = SECRET_PROBE_TIMEOUT_MS): Promise<boolean> {
  const value = `probe-${Date.now()}`;
  const attempt = (async (): Promise<boolean> => {
    let ref: string | undefined;
    try {
      const saved = await vault.save('storage-probe', value) as { secretRef: string };
      ref = saved.secretRef;
      return (await vault.read(ref)) === value;
    } catch {
      return false;
    } finally {
      if (ref !== undefined) {
        try {
          await vault.remove(ref);
        } catch {
          // Nothing more can be done; the value is synthetic.
        }
      }
    }
  })();
  // The timer is cleared as soon as the probe settles, so it never outlives the call.
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
