import * as nodePath from 'node:path';
import { PrivateStore } from './private-store';
import { checkPrivateRoot } from './paths';
import { SecretVault, fromExtensionContext } from './secrets';
import { FileProbe, findRepositoryRoots, nodeProbe } from './repositoryRoots';

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
//     folders can be added after activation. It looks at the file system (a `.git` entry in
//     the folder or any ancestor) and never runs Git: a Git that fails, is missing or is not
//     yet allowed to run would otherwise look the same as "not in a repository", and private
//     data would be written into the repository before anyone noticed.

export const COLLECTIONS = ['profiles', 'roleGroups', 'sessions', 'policies', 'quotaReservations', 'reportFeedback', 'broadcasts', 'broadcastDeliveries', 'teamRules', 'usageLog', 'researchConsents'] as const;
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
  /** How the file system is read. Defaults to the real one; tests substitute their own. */
  fileSystem?: FileProbe;
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

/**
 * What the repository check covered.
 *   ancestors-checked  every open folder and the private storage location, plus their ancestors,
 *                      were looked at for a `.git` entry. What this does not see: a repository
 *                      whose working tree has no `.git` entry (configured with `core.worktree`).
 *   no-folder-open     nothing is open; the private storage location is still checked
 */
export interface Coverage {
  level: 'ancestors-checked' | 'no-folder-open';
  folders: number;
  /** How many distinct repository working trees were found above open folders or private storage. */
  repositoriesFound: number;
}

export interface Ready {
  ok: true;
  store: PrivateStoreInstance;
  vault: SecretVaultInstance;
  coverage: Coverage;
}

export type StorageResult = Ready | Unavailable;

export interface StorageHandle {
  /**
   * Re-checks the data folder against every open folder and its repository, then returns the
   * store and vault. Call it for each operation and do not keep the returned `store`: the store
   * only ever compares against the one folder it was opened with, so a folder opened later is
   * noticed only by the next `use()`.
   */
  use(): Promise<StorageResult>;
}

const unavailable = (reason: UnavailableReason, problems: string[]): Unavailable => ({ ok: false, reason, problems });

function distinct(values: string[]): string[] {
  return [...new Set(values)];
}

export function createStorageHandle(deps: StorageDeps): StorageHandle {
  const namespace = deps.namespace ?? DEFAULT_NAMESPACE;
  const probe = deps.fileSystem ?? nodeProbe;

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

      // Every folder that is open now, and every repository it is inside of. If the file system
      // cannot say, storage is refused: not being able to tell is not the same as not being there.
      const folders = deps.workspaceFolders();
      const checked: string[] = [];
      const repositories = new Set<string>();
      // The editor's global storage can itself sit inside an unrelated repository (for example,
      // when user data is under a dotfiles checkout and the workspace is elsewhere). Check its
      // ancestors independently; checking only workspace folders would miss that case.
      const storageRoots = findRepositoryRoots(dir, probe);
      if (storageRoots.problem !== null) return unavailable('directory-rejected', [storageRoots.problem]);
      for (const root of storageRoots.roots) {
        repositories.add(root);
        checked.push(root);
      }
      for (const folder of folders) {
        checked.push(folder);
        const found = findRepositoryRoots(folder, probe);
        if (found.problem !== null) return unavailable('directory-rejected', [found.problem]);
        for (const root of found.roots) {
          repositories.add(root);
          checked.push(root);
        }
      }
      const coverage: Coverage = {
        level: folders.length === 0 ? 'no-folder-open' : 'ancestors-checked',
        folders: folders.length,
        repositoriesFound: repositories.size
      };
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
        return { ok: true, store, vault, coverage };
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
  /** How much of the repository check was actually established; `null` when unavailable. */
  coverage: Coverage | null;
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
    return { state: 'unavailable', reason: result.reason, problems: result.problems, store: null, coverage: null, secrets: 'not-checked' };
  }
  const status = result.store.status() as { ok: boolean; reason: string | null; detail: string | null };
  let secrets: StorageStatus['secrets'] = 'not-checked';
  if (options.probeSecrets) secrets = (await probeSecretVault(result.vault)) ? 'reachable' : 'unreachable';
  return {
    state: 'available',
    reason: null,
    problems: [],
    store: { ok: status.ok, reason: status.reason ?? null, detail: status.detail ?? null },
    coverage: result.coverage,
    secrets
  };
}

/** Writes, reads and removes one synthetic value. Never leaves it behind, and never waits without end. */
export async function probeSecretVault(vault: SecretVaultInstance, timeoutMs = SECRET_PROBE_TIMEOUT_MS): Promise<boolean> {
  // Each probe uses its own key, so two windows probing at once cannot delete each other's value.
  const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const value = `probe-${unique}`;
  const attempt = (async (): Promise<boolean> => {
    let ref: string | undefined;
    let matched = false;
    let removed = false;
    try {
      const saved = await vault.save(`storage-probe-${unique}`, value) as { secretRef: string };
      ref = saved.secretRef;
      matched = (await vault.read(ref)) === value;
    } catch {
      return false;
    } finally {
      if (ref !== undefined) {
        try {
          removed = ((await vault.remove(ref)) as { ok?: boolean }).ok === true;
        } catch {
          // Nothing more can be done; the value is synthetic.
        }
      }
    }
    return matched && removed;
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
