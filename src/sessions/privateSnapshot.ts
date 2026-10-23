import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { cleanName, SessionRecord, SessionSnapshotStore } from './manager';
import { SessionRegistry } from './registry';
import { normalizeRequestedModel } from '../providers/modelSelection';
const { parseCodename } = require('./codenames') as { parseCodename(value: unknown): { prefix: string; number: number } | null };

interface Store {
  get(collection: string, id: string): { ok: boolean; found?: boolean; value?: unknown };
  transact(work: (tx: { get(collection: string, id: string): any; put(collection: string, id: string, value: any): void }) => unknown): any;
}
interface Access {
  workspaceKey(): string | null;
  /** Must obtain a newly checked private store for every operation. */
  use(): Promise<{ ok: boolean; store?: Store }>;
}
interface Envelope { scope: string; revision: number; records: SessionRecord[] }
const COLLECTION = 'sessions';
const KEYS = new Set(['id', 'repoId', 'roleGroupId', 'provider', 'accountProfileId', 'worktree', 'name', 'requestedModel', 'instructionDigest', 'instructionMethod', 'codename']);
const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
const plain = (value: any): boolean => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Includes folder order: changing the primary folder must invalidate the old workspace scope. */
export function sessionWorkspaceKey(folders: string[], workspaceFile?: string): string | null {
  return folders.length ? createHash('sha256').update(JSON.stringify({ folders, workspaceFile: workspaceFile ?? null })).digest('hex') : null;
}

// Restored fields are untrusted: a tampered snapshot must not hand a launch a relative path (resolved
// against whatever directory the host happens to be in), a control-character-laden string or an
// unbounded one. The path must be absolute and plain; whether it still exists and belongs to the
// project is checked again when a session is reopened.
const SAFE_TEXT = /^[^\p{Cc}\p{Zl}\p{Zp}]*$/u;
function plainField(value: unknown, max: number): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= max && SAFE_TEXT.test(value);
}
function plainWorktree(value: unknown): boolean {
  return plainField(value, 1024) && path.isAbsolute(value as string);
}

function validRecords(records: unknown): records is SessionRecord[] {
  if (!Array.isArray(records) || records.length > 256) return false;
  try {
    for (const record of records) {
      if (!plain(record) || Object.keys(record).some((key) => !KEYS.has(key)) || cleanName(record.name) !== record.name) return false;
      if (!plainField(record.id, 100) || !plainField(record.accountProfileId, 200) || !plainField(record.roleGroupId, 200) || !plainField(record.repoId, 400) || !plainWorktree(record.worktree)) return false;
      normalizeRequestedModel(record.provider, record.requestedModel);
      if (record.instructionDigest !== undefined && (typeof record.instructionDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(record.instructionDigest))) return false;
      if (record.instructionMethod !== undefined && (typeof record.instructionMethod !== 'string' || !/^[a-z0-9-]+$/.test(record.instructionMethod))) return false;
      if (record.codename !== undefined && !parseCodename(record.codename)) return false;
    }
    // One holder per codename: a snapshot where two sessions hold the same one was not written by this extension.
    const held = records.map((record) => record.codename).filter((codename) => codename !== undefined);
    if (new Set(held).size !== held.length) return false;
    SessionRegistry.restore(records);
    return true;
  } catch { return false; }
}
function envelope(value: any, scope: string): value is Envelope {
  return plain(value) && Object.keys(value).length === 3 && value.scope === scope &&
    Number.isSafeInteger(value.revision) && value.revision > 0 && validRecords(value.records);
}

/** Workspace-bound snapshots, with serial writes and a transactional revision check across windows. */
export class PrivateSessionSnapshot implements SessionSnapshotStore {
  private scope: string | null = null;
  private revision: number | null = null;
  private loaded = false;
  private refused = false;
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly access: Access) {}

  private async store(): Promise<Store> {
    if (!this.scope || this.access.workspaceKey() !== this.scope) return fail('session-workspace-changed');
    const opened = await this.access.use();
    if (this.access.workspaceKey() !== this.scope) return fail('session-workspace-changed');
    if (!opened.ok || !opened.store) return fail('session-storage-unavailable');
    return opened.store;
  }
  async load(): Promise<unknown> {
    if (this.loaded || this.refused) return fail('session-snapshot-already-loaded');
    this.scope = this.access.workspaceKey();
    try {
      // An empty window has no snapshot. Opening a folder later requires a reload to bind a scope.
      if (!this.scope) { this.loaded = true; return undefined; }
      const store = await this.store();
      const found = store.get(COLLECTION, `workspace-${this.scope}`);
      if (!found.ok) return fail('session-storage-unavailable');
      if (!found.found) { this.loaded = true; return undefined; }
      if (!envelope(found.value, this.scope)) return fail('invalid-session-snapshot');
      this.revision = found.value.revision;
      this.loaded = true;
      return structuredClone(found.value.records);
    } catch (error) { this.refused = true; throw error; }
  }
  save(records: SessionRecord[]): Promise<void> {
    // Copy before waiting: later registry mutations cannot change what this save means.
    const snapshot = structuredClone(records);
    const write = async (): Promise<void> => {
      if (!this.loaded || this.refused) return fail('session-persistence-blocked');
      try {
        if (!validRecords(snapshot)) return fail('invalid-session-snapshot');
        const store = await this.store();
        const scope = this.scope!;
        const id = `workspace-${scope}`;
        const result = store.transact((tx) => {
          const old = tx.get(COLLECTION, id);
          if (old !== null && !envelope(old, scope)) return { rejected: 'invalid-session-snapshot' };
          if ((old?.revision ?? null) !== this.revision) return { rejected: 'session-snapshot-conflict' };
          const revision = (this.revision ?? 0) + 1;
          tx.put(COLLECTION, id, { scope, revision, records: snapshot });
          return { revision };
        });
        if (!result?.ok) return fail('session-storage-unavailable');
        if (result.value.rejected) return fail(result.value.rejected);
        this.revision = result.value.revision;
      } catch (error) { this.refused = true; throw error; }
    };
    const pending = this.queue.then(write);
    this.queue = pending.catch(() => {});
    return pending;
  }
}
