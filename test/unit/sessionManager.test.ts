import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  ManagerDeps,
  SessionManager,
  SessionRecord,
  SessionSnapshotStore,
  TerminalHandle,
  UNASSIGNED,
  describeState
} from '../../src/sessions/manager';

class FakeTerminal implements TerminalHandle {
  sent: Array<{ text: string; newline: boolean | undefined }> = [];
  shown: Array<boolean | undefined> = [];
  disposed = 0;
  constructor(readonly name: string, readonly cwd: string) {}
  show(preserveFocus?: boolean): void {
    this.shown.push(preserveFocus);
  }
  sendText(text: string, newline?: boolean): void {
    this.sent.push({ text, newline });
  }
  dispose(): void {
    this.disposed += 1;
  }
}

class MemoryStore implements SessionSnapshotStore {
  saved: SessionRecord[] | undefined;
  saves = 0;
  failing = false;
  async load(): Promise<unknown> {
    return this.saved === undefined ? undefined : JSON.parse(JSON.stringify(this.saved));
  }
  async save(records: SessionRecord[]): Promise<void> {
    this.saves += 1;
    if (this.failing) throw new Error('disk full at /private/synthetic/path');
    this.saved = JSON.parse(JSON.stringify(records));
  }
}

interface Rig {
  manager: SessionManager<FakeTerminal>;
  terminals: FakeTerminal[];
  store: MemoryStore;
  existing: Set<string>;
  persistErrors: number;
  deps: ManagerDeps<FakeTerminal>;
}

function rig(overrides: Partial<ManagerDeps<FakeTerminal>> = {}, store = new MemoryStore()): Rig {
  const terminals: FakeTerminal[] = [];
  const existing = new Set<string>(['/synthetic/project', '/synthetic/other']);
  let counter = 0;
  const state = { persistErrors: 0 };
  const deps: ManagerDeps<FakeTerminal> = {
    terminals: {
      create: ({ name, cwd }) => {
        const terminal = new FakeTerminal(name, cwd);
        terminals.push(terminal);
        return terminal;
      }
    },
    providers: { claude: 'claude', codex: 'codex' },
    resolveProject: async () => ({ repoId: 'repo-1' }),
    pathExists: (target) => existing.has(target),
    store,
    newId: () => `session-${(counter += 1)}`,
    newToken: () => `token-${counter}-${Math.random()}`,
    now: () => '2026-10-14T12:00:00.000Z',
    terminalTitle: (name) => `Multiagent: ${name}`,
    onPersistError: () => {
      state.persistErrors += 1;
    },
    ...overrides
  };
  const manager = new SessionManager<FakeTerminal>(deps);
  return {
    manager,
    terminals,
    store,
    existing,
    deps,
    get persistErrors() {
      return state.persistErrors;
    }
  };
}

const start = (r: Rig, over: Record<string, unknown> = {}) =>
  r.manager.start({ provider: 'claude', name: 'Worker 1', cwd: '/synthetic/project', ...over });

async function rejectsWithCode(promise: Promise<unknown> | (() => unknown), code: string): Promise<void> {
  await assert.rejects(async () => (typeof promise === 'function' ? promise() : promise), (error: { code?: string }) => error.code === code);
}

test('start creates a native terminal in the project directory and records only a launch REQUEST', async () => {
  const r = rig();
  const session = await start(r);
  assert.equal(r.terminals.length, 1);
  assert.equal(r.terminals[0].name, 'Multiagent: Worker 1');
  assert.equal(r.terminals[0].cwd, '/synthetic/project');
  assert.deepEqual(r.terminals[0].sent, [{ text: 'claude', newline: true }]);
  assert.equal(session.state, 'launch-requested');
  assert.equal(session.stateLabel, 'CLI launch requested, not confirmed');
  assert.equal(session.terminalOpen, true);
  assert.equal(session.observedAt, null);
  assert.equal(session.accountProfileId, UNASSIGNED);
  assert.equal(session.roleGroupId, UNASSIGNED);
});

test('a shell that merely exists is never reported as the CLI working', async () => {
  const r = rig();
  const shellOnly = await start(r, { launch: false });
  assert.equal(shellOnly.state, 'terminal-open');
  assert.deepEqual(r.terminals[0].sent, [], 'nothing is typed when launch is false');
  for (const view of r.manager.list()) assert.notEqual(view.state, 'cli-observed');
  assert.equal(describeState('terminal-open'), 'Shell open, CLI not started');
});

test('only a verified provider event for the same provider and account confirms the CLI', async () => {
  const r = rig();
  const session = await start(r, { accountProfileId: 'account-a' });
  const event = { provider: 'claude', accountProfileId: 'account-a', source: 'provider-event' };
  assert.throws(() => r.manager.observeCli(session.id, { ...event, accountProfileId: 'account-b' }), { code: 'account-binding-mismatch' });
  assert.throws(() => r.manager.observeCli(session.id, { ...event, provider: 'codex' }), { code: 'account-binding-mismatch' });
  assert.throws(() => r.manager.observeCli(session.id, { ...event, source: 'shell-prompt' }), { code: 'observation-unverified' });
  assert.equal(r.manager.get(session.id)?.state, 'launch-requested');
  const observed = r.manager.observeCli(session.id, event);
  assert.equal(observed.state, 'cli-observed');
  assert.equal(observed.stateLabel, 'CLI observed (provider event)');
  assert.equal(r.manager.cliExited(session.id).state, 'cli-exited');
});

test('four sessions are independent: closing or stopping one does not touch the others', async () => {
  const r = rig();
  const sessions = [];
  for (const name of ['PM', 'Worker 1', 'Worker 2', 'Worker 3']) {
    sessions.push(await start(r, { name, provider: name === 'PM' ? 'claude' : 'codex', accountProfileId: `account-${name}` }));
  }
  assert.equal(new Set(sessions.map((s) => s.id)).size, 4);
  r.manager.handleTerminalClosed(r.terminals[1]);
  r.manager.stop(sessions[2].id);
  const states = Object.fromEntries(r.manager.list().map((s) => [s.name, [s.state, s.terminalOpen]]));
  assert.deepEqual(states, {
    PM: ['launch-requested', true],
    'Worker 1': ['terminal-closed', false],
    'Worker 2': ['terminal-closed', false],
    'Worker 3': ['launch-requested', true]
  });
  assert.deepEqual(
    r.manager.list().map((s) => s.accountProfileId),
    ['account-PM', 'account-Worker 1', 'account-Worker 2', 'account-Worker 3'],
    'accounts are never mixed up between sessions'
  );
  assert.equal(r.terminals[0].disposed + r.terminals[3].disposed, 0);
});

test('closing a terminal records terminal-closed; events for unknown terminals and repeats are harmless', async () => {
  const r = rig();
  const session = await start(r);
  r.manager.handleTerminalClosed(new FakeTerminal('stranger', '/x'));
  assert.equal(r.manager.get(session.id)?.state, 'launch-requested');
  r.manager.handleTerminalClosed(r.terminals[0]);
  r.manager.handleTerminalClosed(r.terminals[0]);
  const closed = r.manager.get(session.id);
  assert.equal(closed?.state, 'terminal-closed');
  assert.equal(closed?.terminalOpen, false);
  assert.throws(() => r.manager.focus(session.id), { code: 'terminal-not-open' });
});

test('focus shows the terminal and takes focus', async () => {
  const r = rig();
  const session = await start(r);
  r.manager.focus(session.id);
  assert.equal(r.terminals[0].shown.at(-1), false, 'preserveFocus is false so the user can type');
  assert.throws(() => r.manager.focus('missing'), { code: 'session-not-found' });
});

test('stop closes the terminal once, records the state first, and ignores the close event that follows', async () => {
  const r = rig();
  const session = await start(r);
  const stopped = r.manager.stop(session.id);
  assert.equal(stopped.state, 'terminal-closed');
  assert.equal(r.terminals[0].disposed, 1);
  r.manager.handleTerminalClosed(r.terminals[0]);
  assert.equal(r.manager.get(session.id)?.state, 'terminal-closed');
  assert.throws(() => r.manager.stop(session.id), { code: 'terminal-not-open' });
  assert.equal(r.terminals[0].disposed, 1, 'not disposed twice');
});

test('reopen creates a NEW session with the same fixed account and leaves the old one as history', async () => {
  const r = rig();
  const first = await start(r, { accountProfileId: 'account-a', roleGroupId: 'worker' });
  await rejectsWithCode(r.manager.reopen(first.id), 'session-still-open');
  r.manager.handleTerminalClosed(r.terminals[0]);

  const second = await r.manager.reopen(first.id);
  assert.notEqual(second.id, first.id);
  assert.equal(second.accountProfileId, 'account-a');
  assert.equal(second.provider, first.provider);
  assert.equal(second.roleGroupId, 'worker');
  assert.equal(second.worktree, first.worktree);
  assert.equal(second.name, 'Worker 1');
  assert.equal(second.state, 'launch-requested');
  assert.equal(r.manager.get(first.id)?.state, 'terminal-closed', 'the old session is not revived');
  assert.equal(r.terminals.length, 2);
  assert.notEqual(r.terminals[1], r.terminals[0]);
  assert.deepEqual(r.terminals[1].sent, [{ text: 'claude', newline: true }]);
  assert.equal(r.manager.reopen.length <= 2, true);
});

test('an account switch is a new session: the old one keeps its account and its terminal', async () => {
  const r = rig();
  const a = await start(r, { accountProfileId: 'account-a' });
  const b = await start(r, { accountProfileId: 'account-b' });
  assert.equal(r.manager.get(a.id)?.accountProfileId, 'account-a');
  assert.equal(r.manager.get(b.id)?.accountProfileId, 'account-b');
  assert.equal(r.terminals.length, 2);
  assert.equal(r.manager.get(a.id)?.terminalOpen, true);
});

test('reopen after the CLI exited needs the shell closed first, and refuses a missing directory', async () => {
  const r = rig();
  const session = await start(r);
  r.manager.observeCli(session.id, { provider: 'claude', accountProfileId: UNASSIGNED, source: 'provider-event' });
  r.manager.cliExited(session.id);
  await rejectsWithCode(r.manager.reopen(session.id), 'session-still-open');
  r.manager.stop(session.id);
  r.existing.delete('/synthetic/project');
  await rejectsWithCode(r.manager.reopen(session.id), 'worktree-missing');
  assert.equal(r.terminals.length, 1, 'no terminal is created for a missing directory');
  r.existing.add('/synthetic/project');
  assert.equal((await r.manager.reopen(session.id)).state, 'launch-requested');
});

test('inputs are validated before anything is created', async () => {
  const r = rig();
  await rejectsWithCode(start(r, { provider: 'rm -rf' }), 'provider-unsupported');
  await rejectsWithCode(start(r, { provider: 'constructor' }), 'provider-unsupported');
  await rejectsWithCode(start(r, { name: '   ' }), 'invalid-name');
  await rejectsWithCode(r.manager.reopen('missing'), 'session-not-found');
  assert.equal(r.terminals.length, 0);
  assert.deepEqual(r.manager.list(), []);
});

test('a failure while registering disposes the terminal that was just created', async () => {
  const r = rig({ newId: () => 'same-id' });
  await start(r);
  await rejectsWithCode(start(r, { name: 'Second' }), 'session-exists');
  assert.equal(r.terminals.length, 2);
  assert.equal(r.terminals[1].disposed, 1);
  assert.equal(r.manager.list().length, 1);
});

test('sessions are saved as identity and name only: no state, token, terminal or observation', async () => {
  const r = rig();
  const session = await start(r, { accountProfileId: 'account-a' });
  r.manager.observeCli(session.id, { provider: 'claude', accountProfileId: 'account-a', source: 'provider-event' });
  r.manager.stop((await start(r, { name: 'Two' })).id);
  assert.deepEqual(Object.keys(r.store.saved?.[0] ?? {}).sort(), ['accountProfileId', 'id', 'name', 'provider', 'repoId', 'roleGroupId', 'worktree']);
  const text = JSON.stringify(r.store.saved);
  assert.doesNotMatch(text, /token-|cli-observed|launch-requested|terminal-closed|observedAt|provider-event/);
});

test('after a restart every restored session is unknown, with no terminal and nothing to act on', async () => {
  const before = rig();
  const a = await start(before, { accountProfileId: 'account-a' });
  const b = await start(before, { name: 'Worker 2', provider: 'codex', accountProfileId: 'account-b' });
  before.manager.observeCli(a.id, { provider: 'claude', accountProfileId: 'account-a', source: 'provider-event' });

  let next = 0;
  const after = rig({ newId: () => `after-${(next += 1)}` }, before.store);
  assert.deepEqual(await after.manager.initialize(), { restored: 2 });
  const sessions = after.manager.list();
  assert.deepEqual(sessions.map((s) => [s.id, s.state, s.terminalOpen, s.observedAt]), [
    [a.id, 'unknown', false, null],
    [b.id, 'unknown', false, null]
  ]);
  assert.equal(sessions[0].stateLabel, 'Unknown (no evidence since this window started)');
  assert.deepEqual(sessions.map((s) => [s.name, s.accountProfileId]), [['Worker 1', 'account-a'], ['Worker 2', 'account-b']], 'names and the fixed account survive');
  assert.throws(() => after.manager.focus(a.id), { code: 'terminal-not-open' });
  assert.throws(() => after.manager.stop(a.id), { code: 'terminal-not-open' });
  assert.throws(() => after.manager.observeCli(a.id, { provider: 'claude', accountProfileId: 'account-a', source: 'provider-event' }), { code: 'terminal-not-open' });
  assert.throws(() => after.manager.cliExited(a.id), { code: 'terminal-not-open' });

  // A terminal left over from before the restart cannot affect a restored session.
  after.manager.handleTerminalClosed(before.terminals[0]);
  assert.equal(after.manager.get(a.id)?.state, 'unknown');
  for (const view of after.manager.list()) assert.ok(!['launch-requested', 'cli-observed', 'terminal-open'].includes(view.state));

  // Reopening gives a fresh session with the same account; the restored one stays unknown.
  const reopened = await after.manager.reopen(a.id);
  assert.equal(reopened.accountProfileId, 'account-a');
  assert.equal(after.manager.get(a.id)?.state, 'unknown');
  assert.equal(after.store.saved?.length, 3);
});

test('a snapshot that cannot be read is rejected as a whole and the manager starts empty', async () => {
  for (const bad of ['text', { sessions: [] }, [{ id: 'x' }], [{ id: 's', repoId: 'r', roleGroupId: 'g', provider: 'claude', accountProfileId: 'a', worktree: 'w' }, { id: 's', repoId: 'r', roleGroupId: 'g', provider: 'claude', accountProfileId: 'a', worktree: 'w' }]]) {
    const store = new MemoryStore();
    store.load = async () => bad;
    const r = rig({}, store);
    await assert.rejects(r.manager.initialize(), { name: 'SessionError' });
    assert.deepEqual(r.manager.list(), []);
  }
  const empty = rig();
  assert.deepEqual(await empty.manager.initialize(), { restored: 0 });
  const none = rig({ store: undefined });
  assert.deepEqual(await none.manager.initialize(), { restored: 0 });
});

test('a failing store never breaks a session and reports without details', async () => {
  const store = new MemoryStore();
  store.failing = true;
  const r = rig({}, store);
  const session = await start(r);
  assert.equal(session.state, 'launch-requested');
  assert.equal(r.persistErrors, 1);
  assert.equal(r.manager.list().length, 1);
});

test('without a store sessions live only in memory and start empty', async () => {
  const r = rig({ store: undefined });
  await start(r);
  assert.equal(r.manager.list().length, 1);
  const next = rig({ store: undefined });
  await next.manager.initialize();
  assert.deepEqual(next.manager.list(), []);
});

test('list can be filtered by repository', async () => {
  const r = rig({ resolveProject: async (cwd) => ({ repoId: cwd.endsWith('other') ? 'repo-2' : 'repo-1' }) });
  await start(r);
  await start(r, { cwd: '/synthetic/other', name: 'Other' });
  assert.deepEqual(r.manager.list('repo-2').map((s) => s.name), ['Other']);
  assert.equal(r.manager.list().length, 2);
});
