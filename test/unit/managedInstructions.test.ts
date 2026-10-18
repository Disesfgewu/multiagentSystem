'use strict';

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  prepareInstructionSnapshot,
  isSnapshotStale,
  cleanupSessionPlan
} from '../../src/sessions/managedInstructions';
import {
  SessionManager,
  TerminalHandle,
  ManagerDeps
} from '../../src/sessions/manager';

class FakeStore {
  collections = new Map<string, Map<string, any>>();
  dir: string;

  constructor(dir: string) {
    this.dir = dir;
    this.collections.set('roleGroups', new Map());
    this.collections.set('broadcasts', new Map());
  }

  get(collection: string, id: string) {
    const col = this.collections.get(collection);
    if (!col || !col.has(id)) return { ok: true, found: false };
    return { ok: true, found: true, value: JSON.parse(JSON.stringify(col.get(id))) };
  }

  list(collection: string) {
    const col = this.collections.get(collection);
    if (!col) return { ok: true, items: [] };
    return { ok: true, items: [...col.entries()].map(([id, v]) => ({ id, value: JSON.parse(JSON.stringify(v)) })) };
  }

  put(collection: string, id: string, value: any) {
    let col = this.collections.get(collection);
    if (!col) {
      col = new Map();
      this.collections.set(collection, col);
    }
    col.set(id, JSON.parse(JSON.stringify(value)));
  }

  delete(collection: string, id: string) {
    const col = this.collections.get(collection);
    if (!col) return { ok: true };
    col.delete(id);
    return { ok: true };
  }

  transact(fn: (tx: any) => any) {
    return { ok: true, value: fn(this) };
  }
}

function makeRoleRecord(id = 'worker-1', version = 1, role = 'worker', provider = 'claude') {
  return {
    group: {
      id,
      name: 'Worker Role',
      role,
      provider,
      version,
      defaultAccountProfileId: null,
      allowedScope: { repositories: ['owner/repo'], paths: [] },
      toolPermissions: {
        shell: 'allow',
        fileWrite: 'allow',
        network: 'deny',
        githubRead: 'allow',
        githubWrite: 'deny',
        merge: 'deny'
      },
      memoryScope: { mode: 'off' },
      rules: [
        { id: 'rule-test-1', type: 'instruction', text: 'Write clear unit tests.', version: 1 }
      ]
    },
    layers: {
      platform: [
        { id: 'plat-1', type: 'instruction', text: 'Never leak credentials.', version: 1 }
      ],
      user: []
    }
  };
}

function makeBroadcast(id: string, text: string, target: any, options: { version?: number; expiresAt?: string | null; revokedAt?: string | null } = {}) {
  return {
    id,
    version: options.version ?? 1,
    target,
    text,
    createdAt: new Date('2026-10-17T00:00:00.000Z').toISOString(),
    expiresAt: options.expiresAt ?? null,
    revokedAt: options.revokedAt ?? null
  };
}

test('prepareInstructionSnapshot composes role group and matching live broadcasts into deterministic digest', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-inst-test-'));
  const privateDir = path.join(tmpDir, 'private');
  const repoRoot = path.join(tmpDir, 'project');
  fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(repoRoot, { recursive: true });
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const store = new FakeStore(privateDir);
  store.put('roleGroups', 'worker-1', makeRoleRecord('worker-1', 1, 'worker'));

  // Broadcasts: one for all, one for this role, one for other role, one expired, one revoked
  store.put('broadcasts', 'bc-all', makeBroadcast('bc-all', 'System maintenance tonight at 22:00.', { scope: 'all' }));
  store.put('broadcasts', 'bc-role', makeBroadcast('bc-role', 'All workers must run lint before commit.', { scope: 'roleGroup', role: 'worker' }));
  store.put('broadcasts', 'bc-other-role', makeBroadcast('bc-other-role', 'Researchers notice.', { scope: 'roleGroup', role: 'researcher' }));
  store.put('broadcasts', 'bc-expired', makeBroadcast('bc-expired', 'Expired notice.', { scope: 'all' }, { expiresAt: new Date(Date.now() - 60000).toISOString() }));
  store.put('broadcasts', 'bc-revoked', makeBroadcast('bc-revoked', 'Revoked notice.', { scope: 'all' }, { revokedAt: new Date(Date.now() - 30000).toISOString() }));

  const result = await prepareInstructionSnapshot({
    store,
    repoRoot,
    repoId: 'owner/repo',
    provider: 'claude',
    roleGroupId: 'worker-1',
    targetSessionId: 'session-target-12345678',
    privateDir
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.match(result.digest ?? '', /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.method, 'append-system-prompt-file');
  assert.equal(result.injectionState, 'prepared');
  assert.equal(result.argv.length, 2);
  assert.equal(result.argv[0], '--append-system-prompt-file');
  assert.ok(result.argv[1].startsWith(privateDir));

  // Check file exists on disk and contains both role rules and matched broadcasts
  const fileContent = fs.readFileSync(result.argv[1], 'utf8');
  assert.match(fileContent, /Write clear unit tests\./);
  assert.match(fileContent, /System maintenance tonight at 22:00\./);
  assert.match(fileContent, /All workers must run lint before commit\./);
  assert.equal(fileContent.includes('Researchers notice.'), false, 'other role notice must not be included');
  assert.equal(fileContent.includes('Expired notice.'), false, 'expired notice must not be included');
  assert.equal(fileContent.includes('Revoked notice.'), false, 'revoked notice must not be included');

  // Verify broadcastBindings recorded in snapshot
  assert.deepEqual(result.snapshot.broadcastBindings.map((b) => b.id).sort(), ['bc-all', 'bc-role']);

  // Cleanup
  cleanupSessionPlan(result.plan);
  assert.equal(fs.existsSync(result.argv[1]), false, 'file must be removed after cleanup');
});

test('prepareInstructionSnapshot isolates session-specific notices and does not leak old session notices', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-inst-session-'));
  const privateDir = path.join(tmpDir, 'private');
  const repoRoot = path.join(tmpDir, 'project');
  fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(repoRoot, { recursive: true });
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const store = new FakeStore(privateDir);
  store.put('roleGroups', 'worker-1', makeRoleRecord('worker-1', 1, 'worker'));

  // Notice targeted at an old session
  store.put('broadcasts', 'bc-old-session', makeBroadcast('bc-old-session', 'Secret note for session-old.', { scope: 'agent', agentId: 'session-old-87654321' }));
  // Notice targeted at the new session
  store.put('broadcasts', 'bc-new-session', makeBroadcast('bc-new-session', 'Note for session-new.', { scope: 'agent', agentId: 'session-new-12345678' }));

  const prepNew = await prepareInstructionSnapshot({
    store,
    repoRoot,
    repoId: 'owner/repo',
    provider: 'claude',
    roleGroupId: 'worker-1',
    targetSessionId: 'session-new-12345678',
    privateDir
  });

  assert.equal(prepNew.ok, true);
  if (!prepNew.ok) return;

  const content = fs.readFileSync(prepNew.argv[1], 'utf8');
  assert.match(content, /Note for session-new\./);
  assert.equal(content.includes('Secret note for session-old.'), false, 'old session notice must not leak to new session');
  assert.deepEqual(prepNew.snapshot.broadcastBindings.map((b) => b.id), ['bc-new-session']);

  cleanupSessionPlan(prepNew.plan);
});

test('isSnapshotStale detects role modifications, role deletions, and broadcast changes', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-stale-test-'));
  const privateDir = path.join(tmpDir, 'private');
  const repoRoot = path.join(tmpDir, 'project');
  fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(repoRoot, { recursive: true });
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const store = new FakeStore(privateDir);
  store.put('roleGroups', 'worker-1', makeRoleRecord('worker-1', 1, 'worker'));
  store.put('broadcasts', 'bc-1', makeBroadcast('bc-1', 'Active notice.', { scope: 'all' }, { version: 1 }));

  const prep = await prepareInstructionSnapshot({
    store,
    repoRoot,
    repoId: 'owner/repo',
    provider: 'claude',
    roleGroupId: 'worker-1',
    targetSessionId: 'session-12345678',
    privateDir
  });

  assert.equal(prep.ok, true);
  if (!prep.ok) return;

  // Fresh snapshot is not stale
  const freshCheck = await isSnapshotStale(prep.snapshot, { store, repoRoot });
  assert.equal(freshCheck.stale, false);

  // Stale if workspace changed
  const wsCheck = await isSnapshotStale(prep.snapshot, { store, repoRoot: '/other/path' });
  assert.equal(wsCheck.stale, true);
  assert.equal(wsCheck.reason, 'workspace-changed');

  // Stale if role version changed
  store.put('roleGroups', 'worker-1', makeRoleRecord('worker-1', 2, 'worker'));
  const roleCheck = await isSnapshotStale(prep.snapshot, { store, repoRoot });
  assert.equal(roleCheck.stale, true);
  assert.equal(roleCheck.reason, 'role-group-modified');
  // Reset role version
  store.put('roleGroups', 'worker-1', makeRoleRecord('worker-1', 1, 'worker'));

  // Stale if role removed
  store.delete('roleGroups', 'worker-1');
  const roleDelCheck = await isSnapshotStale(prep.snapshot, { store, repoRoot });
  assert.equal(roleDelCheck.stale, true);
  assert.equal(roleDelCheck.reason, 'role-group-removed');
  store.put('roleGroups', 'worker-1', makeRoleRecord('worker-1', 1, 'worker'));

  // Stale if broadcast revoked
  store.put('broadcasts', 'bc-1', makeBroadcast('bc-1', 'Active notice.', { scope: 'all' }, { version: 1, revokedAt: new Date().toISOString() }));
  const revokeCheck = await isSnapshotStale(prep.snapshot, { store, repoRoot });
  assert.equal(revokeCheck.stale, true);
  assert.equal(revokeCheck.reason, 'broadcast-revoked');

  // Stale if broadcast version changed
  store.put('broadcasts', 'bc-1', makeBroadcast('bc-1', 'Updated notice.', { scope: 'all' }, { version: 2 }));
  const bVerCheck = await isSnapshotStale(prep.snapshot, { store, repoRoot });
  assert.equal(bVerCheck.stale, true);
  assert.equal(bVerCheck.reason, 'broadcast-version-changed');

  // Stale if a new broadcast added that matches this session
  store.put('broadcasts', 'bc-1', makeBroadcast('bc-1', 'Active notice.', { scope: 'all' }, { version: 1 }));
  store.put('broadcasts', 'bc-2', makeBroadcast('bc-2', 'New broadcast arrived.', { scope: 'all' }, { version: 1 }));
  const addCheck = await isSnapshotStale(prep.snapshot, { store, repoRoot });
  assert.equal(addCheck.stale, true);
  assert.equal(addCheck.reason, 'broadcast-added');

  cleanupSessionPlan(prep.plan);
});

test('SessionManager launches native terminal with safe injection arguments and transitions state with synthetic receiver', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-sm-test-'));
  const privateDir = path.join(tmpDir, 'private');
  const repoRoot = path.join(tmpDir, 'project with spaces');
  fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(repoRoot, { recursive: true });
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const store = new FakeStore(privateDir);
  store.put('roleGroups', 'worker-1', makeRoleRecord('worker-1', 1, 'worker'));

  class SyntheticTerminal implements TerminalHandle {
    sent: Array<{ text: string; newline?: boolean }> = [];
    shown = 0;
    disposed = 0;
    constructor(readonly name: string, readonly cwd: string, readonly env?: Record<string, string | null>) {}
    show() { this.shown += 1; }
    sendText(text: string, newline?: boolean) { this.sent.push({ text, newline }); }
    dispose() { this.disposed += 1; }
  }

  const terminals: SyntheticTerminal[] = [];
  const deps: ManagerDeps<SyntheticTerminal> = {
    terminals: {
      create: (options) => {
        const term = new SyntheticTerminal(options.name, options.cwd, options.env);
        terminals.push(term);
        return term;
      }
    },
    providers: { claude: 'claude', agy: 'agy' },
    resolveProject: async () => ({ repoId: 'owner/repo' }),
    directoryExists: (p) => fs.existsSync(p),
    terminalTitle: (n) => `Title: ${n}`
  };

  const manager = new SessionManager<SyntheticTerminal>(deps);
  await manager.initialize();

  const prep = await prepareInstructionSnapshot({
    store,
    repoRoot,
    repoId: 'owner/repo',
    provider: 'claude',
    roleGroupId: 'worker-1',
    targetSessionId: 'session-managed-12345678',
    privateDir
  });

  assert.equal(prep.ok, true);
  if (!prep.ok) return;

  const session = await manager.start({
    id: 'session-managed-12345678',
    provider: 'claude',
    name: 'Managed Agent',
    cwd: repoRoot,
    roleGroupId: 'worker-1',
    requestedModel: 'sonnet',
    instructions: prep
  });

  // Verify terminal command line was safely quoted and passed --append-system-prompt-file
  assert.equal(terminals.length, 1);
  const sentCommand = terminals[0].sent[0].text;
  assert.match(sentCommand, /^claude --model sonnet --append-system-prompt-file /);
  assert.equal(session.state, 'launch-requested');
  assert.equal(session.instructionState, 'launch-requested');
  assert.equal(session.instructionDigest, prep.digest);

  // Synthetic CLI receiver reads file and confirms receipt
  const fileArg = prep.argv[1];
  assert.ok(fs.existsSync(fileArg), 'injection file must exist while session is active');
  const readContent = fs.readFileSync(fileArg, 'utf8');
  assert.match(readContent, /Write clear unit tests\./);

  // Synthetic CLI sends observation event with instructionEvidence
  manager.observeCli(session.id, {
    provider: 'claude',
    accountProfileId: 'unassigned',
    source: 'provider-event',
    instructionEvidence: true
  } as any);

  const observedView = manager.get(session.id);
  assert.equal(observedView?.state, 'cli-observed');
  assert.equal(observedView?.instructionState, 'cli-observed');
  assert.equal(observedView?.instructionStatusLabel, 'CLI evidence recorded');

  // Stop session cleans up injection file
  manager.stop(session.id);
  assert.equal(fs.existsSync(fileArg), false, 'injection file must be deleted upon session stop');
});

test('SessionManager cliExited cleans up instruction file and confirm-unknown-reopen preserves prepared instruction file for retry', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-sm-recovery-'));
  const privateDir = path.join(tmpDir, 'private');
  const repoRoot = path.join(tmpDir, 'project');
  fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(repoRoot, { recursive: true });
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const store = new FakeStore(privateDir);
  store.put('roleGroups', 'worker-1', makeRoleRecord('worker-1', 1, 'worker'));

  class SyntheticTerminal implements TerminalHandle {
    sent: Array<{ text: string; newline?: boolean }> = [];
    shown = 0;
    disposed = 0;
    constructor(readonly name: string, readonly cwd: string, readonly env?: Record<string, string | null>) {}
    show() { this.shown += 1; }
    sendText(text: string, newline?: boolean) { this.sent.push({ text, newline }); }
    dispose() { this.disposed += 1; }
  }

  let savedRecords: any[] = [];
  const terminals: SyntheticTerminal[] = [];
  const makeManager = () => new SessionManager<SyntheticTerminal>({
    store: {
      load: async () => JSON.parse(JSON.stringify(savedRecords)),
      save: async (records) => { savedRecords = JSON.parse(JSON.stringify(records)); }
    },
    terminals: {
      create: (options) => {
        const term = new SyntheticTerminal(options.name, options.cwd, options.env);
        terminals.push(term);
        return term;
      }
    },
    providers: { claude: 'claude' },
    resolveProject: async () => ({ repoId: 'owner/repo' }),
    directoryExists: (p) => fs.existsSync(p)
  });

  const manager = makeManager();
  await manager.initialize();

  const prep1 = await prepareInstructionSnapshot({
    store,
    repoRoot,
    repoId: 'owner/repo',
    provider: 'claude',
    roleGroupId: 'worker-1',
    targetSessionId: 'session-exit-12345678',
    privateDir
  });
  assert.equal(prep1.ok, true);
  if (!prep1.ok) return;

  const s1 = await manager.start({
    id: 'session-exit-12345678',
    provider: 'claude',
    name: 'CLI Exited Session',
    cwd: repoRoot,
    roleGroupId: 'worker-1',
    instructions: prep1
  });
  const file1 = prep1.argv[1];
  assert.equal(fs.existsSync(file1), true);

  // When CLI exits, its instruction file is cleaned up and status label reflects exit
  const exited = manager.cliExited(s1.id);
  assert.equal(exited.state, 'cli-exited');
  assert.equal(fs.existsSync(file1), false, 'instruction file is cleaned up when CLI exits');
  assert.match(exited.instructionStatusLabel ?? '', /CLI exited/);

  // Now simulate restart: restore sessions into a fresh manager
  const restoredManager = makeManager();
  await restoredManager.initialize();
  const restored = restoredManager.get(s1.id);
  assert.equal(restored?.state, 'unknown');

  const prep2 = await prepareInstructionSnapshot({
    store,
    repoRoot,
    repoId: 'owner/repo',
    provider: 'claude',
    roleGroupId: 'worker-1',
    targetSessionId: 'session-reopen-87654321',
    privateDir
  });
  assert.equal(prep2.ok, true);
  if (!prep2.ok) return;
  const file2 = prep2.argv[1];
  assert.equal(fs.existsSync(file2), true);

  // Attempting reopen without acknowledgeUnknown throws confirm-unknown-reopen but MUST NOT delete prep2.plan
  await assert.rejects(
    restoredManager.reopen(s1.id, { newId: 'session-reopen-87654321', instructions: prep2 }),
    (err: { code?: string }) => err.code === 'confirm-unknown-reopen'
  );
  assert.equal(fs.existsSync(file2), true, 'prepared instruction file survives confirm-unknown-reopen so retry can use it');

  // Retrying with acknowledgeUnknown: true succeeds and uses the preserved instruction file
  const reopened = await restoredManager.reopen(s1.id, {
    newId: 'session-reopen-87654321',
    acknowledgeUnknown: true,
    instructions: prep2
  });
  assert.equal(reopened.id, 'session-reopen-87654321');
  assert.equal(reopened.state, 'launch-requested');
  assert.equal(fs.existsSync(file2), true);

  restoredManager.stop(reopened.id);
  assert.equal(fs.existsSync(file2), false);
});

test('prepareInstructionSnapshot prepares a Codex profile from provider capability and stays manual without CODEX_HOME (Refs #147)', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-codex-prep-'));
  const privateDir = path.join(tmpDir, 'private');
  const codexHome = path.join(tmpDir, 'codex-home');
  const repoRoot = path.join(tmpDir, 'project');
  fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(repoRoot, { recursive: true });
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const store = new FakeStore(privateDir);
  store.put('roleGroups', 'codex-role-1', makeRoleRecord('codex-role-1', 1, 'worker', 'codex'));

  // 1. Successful automatic preparation with profile-developer-instructions
  const prep = await prepareInstructionSnapshot({
    store,
    repoRoot,
    repoId: 'owner/repo',
    provider: 'codex',
    roleGroupId: 'codex-role-1',
    targetSessionId: 'session-codex-12345678',
    privateDir,
    codexHome
  });

  assert.equal(prep.ok, true);
  if (!prep.ok) return;

  assert.equal(prep.method, 'profile-developer-instructions');
  assert.equal(prep.injectionState, 'prepared');
  assert.deepEqual(prep.argv, ['-p', 'mas-session-codex-12345678']);
  assert.match(prep.injectionStatusLabel, /config profile with developer instructions/);
  assert.match(prep.injectionStatusLabel, /CLI verification pending/);
  // Nothing has been handed to the CLI yet when this summary is read, so it must never say it was.
  assert.doesNotMatch(prep.summaryText, /<sent to the CLI>/);
  assert.match(prep.summaryText, /<NOT sent to the CLI>/);

  const profilePath = path.join(codexHome, 'mas-session-codex-12345678.config.toml');
  assert.equal(fs.existsSync(profilePath), true);
  const tomlContent = fs.readFileSync(profilePath, 'utf8');
  assert.match(tomlContent, /^developer_instructions = /);
  assert.match(tomlContent, /Write clear unit tests\./);

  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(profilePath).mode & 0o777, 0o600);
  }

  // Cleanup cleans up the profile file
  const cleanupRes = cleanupSessionPlan(prep.plan);
  assert.equal(cleanupRes.removed >= 1, true);
  assert.equal(fs.existsSync(profilePath), false);

  // Without a matching CODEX_HOME the caller cannot guarantee the CLI will read the profile,
  // so preparation stays honest and falls back to manual delivery.
  const prepManual = await prepareInstructionSnapshot({
    store,
    repoRoot,
    repoId: 'owner/repo',
    provider: 'codex',
    roleGroupId: 'codex-role-1',
    targetSessionId: 'session-codex-manual-12',
    privateDir
  });

  assert.equal(prepManual.ok, true);
  if (!prepManual.ok) return;

  assert.equal(prepManual.method, 'manual');
  assert.equal(prepManual.injectionState, 'manual');
  assert.deepEqual(prepManual.argv, []);
  assert.match(prepManual.injectionStatusLabel, /Manual: instructions written to private file/);
  assert.doesNotMatch(prepManual.summaryText, /<sent to the CLI>/);
  assert.match(prepManual.summaryText, /<not supported: give by hand>/, 'a manual paste is the user\'s job, not a delivery');
  const manualFile = path.join(privateDir, 'sessions', 'session-codex-manual-12', 'context.md');
  assert.equal(fs.existsSync(manualFile), true);
  cleanupSessionPlan(prepManual.plan);
  assert.equal(fs.existsSync(manualFile), false);
});

test('SessionManager launches native terminal for Codex with safe -p profile flag and cleans up profile on exit (Refs #147)', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-codex-sm-'));
  const privateDir = path.join(tmpDir, 'private');
  const codexHome = path.join(tmpDir, 'codex-home');
  const repoRoot = path.join(tmpDir, 'project');
  fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(repoRoot, { recursive: true });
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const store = new FakeStore(privateDir);
  store.put('roleGroups', 'codex-worker', makeRoleRecord('codex-worker', 1, 'worker', 'codex'));

  class SyntheticTerminal implements TerminalHandle {
    sent: Array<{ text: string; newline?: boolean }> = [];
    shown = 0;
    disposed = 0;
    constructor(readonly name: string, readonly cwd: string, readonly env?: Record<string, string | null>) {}
    show() { this.shown += 1; }
    sendText(text: string, newline?: boolean) { this.sent.push({ text, newline }); }
    dispose() { this.disposed += 1; }
  }

  const terminals: SyntheticTerminal[] = [];
  const deps: ManagerDeps<SyntheticTerminal> = {
    terminals: {
      create: (options) => {
        const term = new SyntheticTerminal(options.name, options.cwd, options.env);
        terminals.push(term);
        return term;
      }
    },
    providers: { codex: 'codex' },
    resolveProject: async () => ({ repoId: 'owner/repo' }),
    directoryExists: (p) => fs.existsSync(p),
    terminalTitle: (n) => `Title: ${n}`
  };

  const manager = new SessionManager<SyntheticTerminal>(deps);
  await manager.initialize();

  const prep = await prepareInstructionSnapshot({
    store,
    repoRoot,
    repoId: 'owner/repo',
    provider: 'codex',
    roleGroupId: 'codex-worker',
    targetSessionId: 'session-codex-launch-12345678',
    privateDir,
    codexHome
  });

  assert.equal(prep.ok, true);
  if (!prep.ok) return;

  const session = await manager.start({
    id: 'session-codex-launch-12345678',
    provider: 'codex',
    name: 'Codex Managed Agent',
    cwd: repoRoot,
    roleGroupId: 'codex-worker',
    requestedModel: 'o3-mini',
    env: { CODEX_HOME: codexHome },
    instructions: prep
  });

  // Verify terminal command line was safely quoted and passed -p profile name
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].env?.CODEX_HOME, codexHome);
  const sentCommand = terminals[0].sent[0].text;
  assert.match(sentCommand, /^codex --model o3-mini -p mas-session-codex-launch-12345678/);
  assert.equal(session.state, 'launch-requested');
  assert.equal(session.instructionState, 'launch-requested');
  assert.equal(session.instructionDigest, prep.digest);

  // Verify profile file was created in codexHome
  const profileFile = path.join(codexHome, 'mas-session-codex-launch-12345678.config.toml');
  assert.equal(fs.existsSync(profileFile), true);

  // Synthetic CLI sends observation event with instructionEvidence
  manager.observeCli(session.id, {
    provider: 'codex',
    accountProfileId: 'unassigned',
    source: 'provider-event',
    instructionEvidence: true
  } as any);

  const observedView = manager.get(session.id);
  assert.equal(observedView?.state, 'cli-observed');
  assert.equal(observedView?.instructionState, 'cli-observed');
  assert.equal(observedView?.instructionStatusLabel, 'CLI evidence recorded');

  // Stop session cleans up injection profile file
  manager.stop(session.id);
  assert.equal(fs.existsSync(profileFile), false, 'Codex profile config file must be deleted upon session stop');
});
