import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  ManagerDeps,
  SessionManager,
  SessionRecord,
  SessionSnapshotStore,
  TerminalHandle,
  UNASSIGNED,
  cleanName,
  describeState
} from '../../src/sessions/manager';
import { CLAUDE_ATTRIBUTION_SETTINGS, attributionArguments, writeClaudeSettings, removeClaudeSettings } from '../../src/providers/attribution';

// What every Claude Code launch carries so that the CLI adds no author line of its own (issue #293).
const ATTRIBUTION_FILE = '/synthetic/attribution.json';
const ATTRIBUTION = `--settings ${ATTRIBUTION_FILE}`;

test('a requested model is launched, kept on reopen and stored as a request rather than an observation', async () => {
  const r = rig();
  await r.manager.initialize();
  const session = await r.manager.start({ provider: 'claude', name: 'Model choice', cwd: '/synthetic/project', requestedModel: 'sonnet' });
  assert.deepEqual(r.terminals[0].sent, [{ text: `claude ${ATTRIBUTION} --model sonnet`, newline: true }]);
  assert.equal(session.requestedModel, 'sonnet');
  assert.equal(session.state, 'launch-requested');
  assert.equal(session.observedAt, null, 'a model request is not evidence that the CLI used it');
  r.manager.stop(session.id);
  const reopened = await r.manager.reopen(session.id);
  assert.equal(reopened.requestedModel, 'sonnet');
  assert.deepEqual(r.terminals[1].sent, [{ text: `claude ${ATTRIBUTION} --model sonnet`, newline: true }]);
  const restored = rig({}, r.store);
  await restored.manager.initialize();
  assert.equal(restored.manager.get(reopened.id)?.requestedModel, 'sonnet');
  assert.equal(restored.manager.get(reopened.id)?.state, 'unknown');
});

test('an unrecognized shell refuses start and reopen: no terminal, no text, no running session', async () => {
  let shell: 'posix' | null = 'posix';
  const r = rig({ detectShellType: () => shell });
  await r.manager.initialize();
  const first = await start(r, {});
  assert.deepEqual(r.terminals[0].sent, [{ text: `claude ${ATTRIBUTION}`, newline: true }]);
  r.manager.stop(first.id);
  const terminalsBefore = r.terminals.length;
  const sessionsBefore = r.manager.list().length;
  shell = null;
  await rejectsWithCode(start(r, { name: 'Unknown shell' }), 'unsupported-shell');
  await rejectsWithCode(r.manager.reopen(first.id), 'unsupported-shell');
  assert.equal(r.terminals.length, terminalsBefore, 'no terminal is created for a shell that cannot be quoted for');
  assert.ok(r.terminals.every((terminal) => terminal.sent.length <= 1), 'nothing was typed');
  assert.equal(r.manager.list().length, sessionsBefore, 'no session record was created');
  assert.equal(r.manager.list().some((session) => session.state === 'launch-requested'), false);
  // A shell-only terminal types nothing, so it needs no quoting and is still allowed.
  const shellOnly = await start(r, { launch: false, name: 'Shell only' });
  assert.equal(shellOnly.state, 'terminal-open');
  assert.deepEqual(r.terminals[r.terminals.length - 1].sent, []);
});

test('invalid or unsupported model requests never create terminals, including shell-only starts', async () => {
  for (const requestedModel of ['bad;echo', '--dangerously-bypass-approvals-and-sandbox', 'bad\ncommand']) {
    const r = rig();
    await assert.rejects(r.manager.start({ provider: 'codex', name: 'Bad', cwd: '/synthetic/project', requestedModel, launch: false }), { code: 'invalid-model' });
    assert.equal(r.terminals.length, 0);
  }
  const r = rig({ providers: { agy: 'agy' } });
  await assert.rejects(r.manager.start({ provider: 'agy', name: 'Unknown flags', cwd: '/synthetic/project', requestedModel: 'model' }), { code: 'model-selection-unsupported' });
  assert.equal(r.terminals.length, 0);
});

test('an invalid saved model blocks restoration without overwriting private records', async () => {
  const store = new MemoryStore();
  store.saved = [{ ...identityRecord('old'), requestedModel: 'bad;echo' }];
  const r = rig({}, store);
  await assert.rejects(r.manager.initialize(), { code: 'invalid-snapshot' });
  assert.equal(store.saves, 0);
  assert.equal(store.saved[0].requestedModel, 'bad;echo');
});

test('an enforced launch types the wrapped command, built from the final arguments (the model included), and no other', async () => {
  const r = rig();
  const wrapped: Array<{ executable: string; args: string[] }> = [];
  await r.manager.start({
    provider: 'claude', name: 'Isolated', cwd: '/synthetic/project', requestedModel: 'sonnet',
    wrap: (executable, args) => { wrapped.push({ executable, args }); return { executable: '/usr/bin/sandbox-exec', args: ['-f', '/synthetic/profile.sb', executable, ...args] }; }
  });
  assert.deepEqual(wrapped, [{ executable: 'claude', args: ['--settings', ATTRIBUTION_FILE, '--model', 'sonnet'] }]);
  assert.deepEqual(r.terminals[0].sent, [{ text: `/usr/bin/sandbox-exec -f /synthetic/profile.sb claude ${ATTRIBUTION} --model sonnet`, newline: true }]);
});

test('a reopened session types the wrapped command too: the wrapper reaches reopen as well as start', async () => {
  const r = rig();
  const first = await r.manager.start({ provider: 'claude', name: 'First', cwd: '/synthetic/project', launch: false });
  r.manager.stop(first.id);
  const seen: string[] = [];
  await r.manager.reopen(first.id, { wrap: (executable, args) => { seen.push(executable); return { executable: '/usr/bin/sandbox-exec', args: ['-f', '/synthetic/profile.sb', executable, ...args] }; } });
  assert.deepEqual(seen, ['claude']);
  assert.deepEqual(r.terminals[r.terminals.length - 1].sent, [{ text: `/usr/bin/sandbox-exec -f /synthetic/profile.sb claude ${ATTRIBUTION}`, newline: true }]);
});

test('a wrap that throws starts no terminal text and leaves no session recorded', async () => {
  const r = rig();
  await assert.rejects(r.manager.start({ provider: 'claude', name: 'Isolated', cwd: '/synthetic/project', wrap: () => { throw new Error('launch-invalid'); } }), /launch-invalid/);
  assert.equal(r.terminals.every((terminal) => terminal.sent.length === 0), true, 'nothing was typed');
  assert.equal(r.terminals.every((terminal) => terminal.disposed > 0), true, 'the terminal was released');
  assert.deepEqual(r.manager.list(), []);
});

class FakeTerminal implements TerminalHandle {
  sent: Array<{ text: string; newline: boolean | undefined }> = [];
  shown: Array<boolean | undefined> = [];
  disposed = 0;
  constructor(readonly name: string, readonly cwd: string, readonly env?: Record<string, string | null>) {}
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
      create: ({ name, cwd, env }) => {
        const terminal = new FakeTerminal(name, cwd, env);
        terminals.push(terminal);
        return terminal;
      }
    },
    providers: { claude: 'claude', codex: 'codex' },
    resolveProject: async () => ({ repoId: 'repo-1' }),
    directoryExists: (target) => existing.has(target),
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
  // Every launch of Claude Code carries the settings file (the caller prepares it); a test that wants none says `attributionFile: undefined`.
  const start = manager.start.bind(manager);
  manager.start = (input) => start({ attributionFile: ATTRIBUTION_FILE, ...input });
  const reopen = manager.reopen.bind(manager);
  manager.reopen = (id, options) => reopen(id, { attributionFile: ATTRIBUTION_FILE, ...options });
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
  assert.deepEqual(r.terminals[0].sent, [{ text: `claude ${ATTRIBUTION}`, newline: true }]);
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

test('missing agy executable refuses launch before opening a terminal or saving a session', async () => {
  const r = rig({ providers: { agy: 'agy' }, executableAvailable: () => false });
  await rejectsWithCode(start(r, { provider: 'agy' }), 'executable-not-found');
  assert.equal(r.terminals.length, 0);
  assert.equal(r.manager.list().length, 0);
  assert.equal(r.store.saves, 0);

  // A shell-only view is still useful when the person wants to install the CLI there.
  const shell = await start(r, { provider: 'agy', launch: false });
  assert.equal(shell.state, 'terminal-open');
  r.manager.handleTerminalClosed(r.terminals[0]);
  await rejectsWithCode(r.manager.reopen(shell.id), 'executable-not-found');
  assert.equal(r.terminals.length, 1);
  assert.equal(r.manager.list().length, 1);
});

test('the selected account environment reaches its terminal and can be rebuilt for a reopened session', async () => {
  const r = rig();
  const env = { CLAUDE_CONFIG_DIR: '/private/accounts/work', ANTHROPIC_API_KEY: null };
  const first = await start(r, { accountProfileId: 'account-work', env });
  assert.deepEqual(r.terminals[0].env, env);
  r.manager.handleTerminalClosed(r.terminals[0]);
  const reopened = await r.manager.reopen(first.id, { env });
  assert.equal(reopened.accountProfileId, 'account-work');
  assert.deepEqual(r.terminals[1].env, env);
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

test('closing a terminal records terminal-closed, returns which session closed; events for unknown terminals and repeats are harmless', async () => {
  const r = rig();
  const session = await start(r);
  assert.equal(r.manager.handleTerminalClosed(new FakeTerminal('stranger', '/x')), null, 'a terminal this manager never opened names no session');
  assert.equal(r.manager.get(session.id)?.state, 'launch-requested');
  assert.equal(r.manager.handleTerminalClosed(r.terminals[0]), session.id, 'the closed session is returned, for a caller holding a per-session resource to release');
  assert.equal(r.manager.handleTerminalClosed(r.terminals[0]), null, 'a repeat event for an already-closed terminal names no session');
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
  assert.deepEqual(r.terminals[1].sent, [{ text: `claude ${ATTRIBUTION}`, newline: true }]);
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

test('an id collision is refused before any terminal is created, and the live session keeps its terminal', async () => {
  const r = rig({ newId: () => 'same-id' });
  await start(r);
  await rejectsWithCode(start(r, { name: 'Second' }), 'session-exists');
  assert.equal(r.terminals.length, 1, 'no second terminal was created');
  assert.equal(r.terminals[0].disposed, 0, 'the live session\'s terminal was not disposed');
  assert.equal(r.manager.list().length, 1);
  assert.equal(r.manager.list()[0].terminalOpen, true);
});

test('sessions are saved as identity and name only: no state, token, terminal or observation', async () => {
  const r = rig();
  await r.manager.initialize();
  const session = await start(r, { accountProfileId: 'account-a' });
  r.manager.observeCli(session.id, { provider: 'claude', accountProfileId: 'account-a', source: 'provider-event' });
  r.manager.stop((await start(r, { name: 'Two' })).id);
  assert.deepEqual(Object.keys(r.store.saved?.[0] ?? {}).sort(), ['accountProfileId', 'id', 'name', 'provider', 'repoId', 'roleGroupId', 'worktree']);
  const text = JSON.stringify(r.store.saved);
  assert.doesNotMatch(text, /token-|cli-observed|launch-requested|terminal-closed|observedAt|provider-event/);
});

test('after a restart every restored session is unknown, with no terminal and nothing to act on', async () => {
  const before = rig();
  await before.manager.initialize();
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
  await rejectsWithCode(after.manager.reopen(a.id), 'confirm-unknown-reopen');
  assert.equal(after.terminals.length, 0, 'nothing is opened without the acknowledgement');
  const reopened = await after.manager.reopen(a.id, { acknowledgeUnknown: true });
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
  await r.manager.initialize();
  const session = await start(r);
  assert.equal(session.state, 'launch-requested');
  assert.equal(r.persistErrors, 1);
  assert.equal(r.manager.list().length, 1);
});

test('rename changes a live session and a restored one, trims, and survives a snapshot round trip', async () => {
  const r = rig();
  await r.manager.initialize();
  const live = await start(r, { name: 'Before' });
  const view = await r.manager.rename(live.id, '  After  ');
  assert.equal(view.name, 'After');
  assert.equal(r.manager.get(live.id)?.name, 'After');
  assert.equal(view.state, live.state, 'a rename changes no state');
  assert.equal(r.manager.get(live.id)?.terminalOpen, true);
  assert.equal(r.terminals[0].sent.length, 1, 'a rename types nothing into the terminal');
  assert.equal(r.store.saved?.find((record) => record.id === live.id)?.name, 'After');
  const restored = rig({}, r.store);
  await restored.manager.initialize();
  assert.equal(restored.manager.get(live.id)?.name, 'After', 'the name survives a snapshot round trip');
  assert.equal(restored.manager.get(live.id)?.state, 'unknown');
  const again = await restored.manager.rename(live.id, 'Restored name');
  assert.equal(again.name, 'Restored name');
  assert.equal(again.state, 'unknown', 'renaming a restored session never makes it look active');
  assert.equal(restored.terminals.length, 0);
  const third = rig({}, restored.store);
  await third.manager.initialize();
  assert.equal(third.manager.get(live.id)?.name, 'Restored name');
});

test('rename refuses bad names and unknown ids and changes nothing', async () => {
  const r = rig();
  await r.manager.initialize();
  const session = await start(r, { name: 'Keep me' });
  const saves = r.store.saves;
  const bad = ['', '   ', 'x'.repeat(81), 'a\nb', 'a\u0000b', 'a' + String.fromCodePoint(0x202e) + 'b', 'a' + String.fromCodePoint(0x2028) + 'b', undefined, null, 5, {}];
  for (const name of bad) await rejectsWithCode(r.manager.rename(session.id, name), 'invalid-name');
  await r.manager.rename(session.id, 'x'.repeat(80));
  await r.manager.rename(session.id, 'Keep me');
  await r.manager.rename(session.id, 'Keep me');
  await rejectsWithCode(r.manager.rename('no-such-session', 'Name'), 'session-not-found');
  await rejectsWithCode(r.manager.rename(undefined as unknown as string, 'Name'), 'session-not-found');
  assert.equal(r.manager.get(session.id)?.name, 'Keep me');
  assert.equal(r.store.saves, saves + 2, 'only the two valid changes were saved; refused renames save nothing');
});

test('a rename that cannot be saved is reported and keeps the old name', async () => {
  const r = rig();
  await r.manager.initialize();
  const session = await start(r, { name: 'Old name' });
  r.store.failing = true;
  await rejectsWithCode(r.manager.rename(session.id, 'New name'), 'persist-failed');
  assert.equal(r.manager.get(session.id)?.name, 'Old name', 'the old name is not lost');
  r.store.failing = false;
  await r.manager.rename(session.id, 'New name');
  assert.equal(r.store.saved?.find((record) => record.id === session.id)?.name, 'New name');
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

// ---- review fixes: loading, fail-closed saving, initialisation order ----------------------

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const identityRecord = (id: string, name = 'Old'): SessionRecord => ({ id, repoId: 'repo-1', roleGroupId: UNASSIGNED, provider: 'claude', accountProfileId: 'account-a', worktree: '/synthetic/project', name });

test('a load that throws blocks saving: the unread snapshot is never overwritten, and sessions still work in memory', async () => {
  const store = new MemoryStore();
  store.saved = [identityRecord('keep-me')];
  store.load = async () => { throw new Error('transient read failure at /private/synthetic'); };
  let blocked = 0;
  const r = rig({ onPersistenceBlocked: () => { blocked += 1; } }, store);
  await assert.rejects(r.manager.initialize(), (error: { code?: string }) => error.code === 'store-unavailable');
  const session = await start(r);
  await start(r, { name: 'Second' });
  assert.equal(session.state, 'launch-requested', 'the session itself works');
  assert.equal(store.saves, 0, 'save() was never called');
  assert.deepEqual(store.saved?.map((record) => record.id), ['keep-me'], 'the stored data is untouched');
  assert.equal(blocked, 1, 'the user is told once');
});

test('content that cannot be read also blocks saving (newer format, damaged data, duplicate ids)', async () => {
  const bad: unknown[] = ['text', { sessions: [] }, [{ id: 'x' }], [identityRecord('dup'), identityRecord('dup')]];
  for (const content of bad) {
    const store = new MemoryStore();
    store.load = async () => content;
    let blocked = 0;
    const r = rig({ onPersistenceBlocked: () => { blocked += 1; } }, store);
    await assert.rejects(r.manager.initialize(), (error: { code?: string }) => error.code === 'invalid-snapshot');
    await start(r);
    assert.equal(store.saves, 0);
    assert.equal(blocked, 1);
  }
});

test('saving works after a successful load, and after a load that found nothing', async () => {
  const empty = rig();
  await empty.manager.initialize();
  await start(empty);
  assert.equal(empty.store.saves, 1);
});

test('without initialize a configured store is never written, and a later initialize is refused', async () => {
  let blocked = 0;
  const r = rig({ onPersistenceBlocked: () => { blocked += 1; } });
  await start(r);
  assert.equal(r.store.saves, 0, 'nothing was read, so nothing may be written');
  assert.equal(blocked, 1);
  await assert.rejects(r.manager.initialize(), (error: { code?: string }) => error.code === 'sessions-exist');
  await start(r, { name: 'Another' });
  assert.equal(r.store.saves, 0);
});

test('initialize runs once', async () => {
  const r = rig();
  await r.manager.initialize();
  await assert.rejects(r.manager.initialize(), (error: { code?: string }) => error.code === 'already-initialized');
  const concurrent = rig();
  const first = concurrent.manager.initialize();
  await assert.rejects(concurrent.manager.initialize(), (error: { code?: string }) => error.code === 'already-initialized');
  await first;
});

test('a session started while the snapshot is still loading waits for it: nothing is replaced and no terminal is orphaned', async () => {
  const store = new MemoryStore();
  store.saved = [identityRecord('old-1', 'Old')];
  const gate = deferred<unknown>();
  store.load = () => gate.promise;
  const r = rig({ newId: () => 'new-1' }, store);
  const initializing = r.manager.initialize();
  const starting = start(r, { name: 'New' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(r.terminals.length, 0, 'start waits; no terminal exists before the load finished');

  gate.resolve(JSON.parse(JSON.stringify(store.saved)));
  await initializing;
  const created = await starting;
  assert.deepEqual(r.manager.list().map((s) => [s.id, s.name, s.state]).sort(), [['new-1', 'New', 'launch-requested'], ['old-1', 'Old', 'unknown']]);
  assert.equal(r.manager.focus(created.id).terminalOpen, true, 'the new terminal is still managed');
  assert.equal(r.manager.stop(created.id).state, 'terminal-closed');
  assert.deepEqual(store.saved?.map((record) => record.id).sort(), ['new-1', 'old-1'], 'saved together with the restored one');
});

test('reopen also waits for a running load', async () => {
  const store = new MemoryStore();
  store.saved = [identityRecord('old-1')];
  const gate = deferred<unknown>();
  store.load = () => gate.promise;
  const r = rig({ newId: () => 'new-2' }, store);
  const initializing = r.manager.initialize();
  const reopening = r.manager.reopen('old-1', { acknowledgeUnknown: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  gate.resolve(JSON.parse(JSON.stringify(store.saved)));
  await initializing;
  assert.equal((await reopening).accountProfileId, 'account-a');
});

test('reopening an unknown session needs an explicit acknowledgement; a closed one does not', async () => {
  const before = rig();
  await before.manager.initialize();
  const gone = await start(before);
  before.manager.stop(gone.id);
  assert.ok((await before.manager.reopen(gone.id)).id, 'closed: no acknowledgement needed');

  const after = rig({ newId: () => 'later' }, before.store);
  await after.manager.initialize();
  const unknownId = after.manager.list()[0].id;
  assert.equal(after.manager.get(unknownId)?.state, 'unknown');
  await rejectsWithCode(after.manager.reopen(unknownId), 'confirm-unknown-reopen');
  await rejectsWithCode(after.manager.reopen(unknownId, { acknowledgeUnknown: false }), 'confirm-unknown-reopen');
  assert.equal(after.terminals.length, 0);
  assert.equal((await after.manager.reopen(unknownId, { acknowledgeUnknown: true })).state, 'launch-requested');
});

test('start refuses a folder that does not exist and creates nothing', async () => {
  const r = rig();
  await rejectsWithCode(start(r, { cwd: '/synthetic/does-not-exist' }), 'worktree-missing');
  await rejectsWithCode(start(r, { cwd: '' }), 'worktree-missing');
  assert.equal(r.terminals.length, 0);
  assert.deepEqual(r.manager.list(), []);
});

test('names follow one rule: typed or restored, trimmed, at most 80 characters, no control characters', async () => {
  const r = rig();
  await rejectsWithCode(start(r, { name: 'a'.repeat(81) }), 'invalid-name');
  await rejectsWithCode(start(r, { name: 'bad\nname' }), 'invalid-name');
  assert.equal((await start(r, { name: '  ok  ' })).name, 'ok');

  const store = new MemoryStore();
  store.saved = [identityRecord('r1', 'x'.repeat(200)), identityRecord('r2', 'line\nbreak'), identityRecord('r3', '  fine  ')];
  const restored = rig({}, store);
  await restored.manager.initialize();
  assert.deepEqual(restored.manager.list().map((s) => s.name), ['claude session', 'claude session', 'fine']);
  restored.manager.list().forEach((s) => assert.ok(s.name.length <= 80));
  const reopened = await restored.manager.reopen('r1', { acknowledgeUnknown: true });
  assert.equal(restored.terminals[0].name, 'Multiagent: claude session', 'a bad stored name never reaches a terminal title');
  assert.ok(reopened.id);
});

test('stop releases the terminal even if recording the state throws', async () => {
  const r = rig();
  const session = await start(r);
  const internal = r.manager as unknown as { registry: { terminalClosed: () => never } };
  internal.registry.terminalClosed = () => { throw new Error('synthetic failure'); };
  assert.throws(() => r.manager.stop(session.id), /synthetic failure/);
  assert.equal(r.terminals[0].disposed, 1, 'the terminal was still disposed');
  assert.throws(() => r.manager.focus(session.id), { code: 'terminal-not-open' });
});

// ---- review follow-up: a start already in progress when initialize runs -------------------

test('initialize is refused while a start is already past the load gate; its session stays managed and nothing is overwritten', async () => {
  const store = new MemoryStore();
  store.saved = [identityRecord('old-1')];
  let loads = 0;
  const original = store.load.bind(store);
  store.load = async () => { loads += 1; return original(); };
  const hold = deferred<{ repoId: string }>();
  const r = rig({ resolveProject: () => hold.promise }, store);
  const starting = start(r, { name: 'Early' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(r.manager.initialize(), (error: { code?: string }) => error.code === 'sessions-exist');
  assert.equal(loads, 0, 'the refusal happens up front: the stored snapshot is not even read');
  hold.resolve({ repoId: 'repo-1' });
  const created = await starting;
  assert.equal(r.manager.focus(created.id).terminalOpen, true, 'the early session is still managed');
  assert.equal(r.manager.stop(created.id).state, 'terminal-closed');
  assert.equal(store.saves, 0, 'nothing was read, so nothing was written');
  assert.deepEqual(store.saved?.map((record) => record.id), ['old-1']);
});

test('a start and an initialize called back to back: the restore is refused rather than replacing the new session', async () => {
  const store = new MemoryStore();
  store.saved = [identityRecord('old-1')];
  const gate = deferred<unknown>();
  store.load = () => gate.promise;
  let blocked = 0;
  const r = rig({ onPersistenceBlocked: () => { blocked += 1; } }, store);
  const starting = start(r, { name: 'Racing' });
  const initializing = r.manager.initialize();
  await new Promise((resolve) => setTimeout(resolve, 10));
  gate.resolve(JSON.parse(JSON.stringify(store.saved)));
  await assert.rejects(initializing, (error: { code?: string }) => error.code === 'sessions-exist');
  const created = await starting;
  assert.deepEqual(r.manager.list().map((s) => s.id), [created.id], 'the restored registry did not replace the new session');
  assert.equal(r.manager.focus(created.id).terminalOpen, true);
  assert.equal(store.saves, 0, 'saving stays off after a refused restore');
  assert.equal(blocked, 1);
  await start(r, { name: 'Later' });
  assert.equal(store.saves, 0, 'a session started after the refused restore is not saved over the unread snapshot either');
  assert.deepEqual(store.saved?.map((record) => record.id), ['old-1']);
});

test('cleanName rejects control, C1, separator and bidirectional characters but keeps ordinary and joiner-using names', () => {
  const cp = (...codes: number[]) => String.fromCodePoint(...codes);
  for (const bad of [`safe${cp(0x202e)}txt.exe`, `a${cp(0x85)}b`, `a${cp(0x2028)}b`, `a${cp(0x2029)}b`, `a${cp(0x200b)}b`, `a${cp(0x200e)}b`, `a${cp(0xfeff)}b`, `a${cp(0x2066)}b`, 'a\nb', 'a\tb', `a${cp(0)}b`, '', '   ', 'x'.repeat(81)]) {
    assert.equal(cleanName(bad), null, JSON.stringify(bad));
  }
  assert.equal(cleanName('  PM review  '), 'PM review');
  assert.equal(cleanName('代理 1'), '代理 1');
  assert.equal(cleanName(`می${cp(0x200c)}خواهم`), `می${cp(0x200c)}خواهم`, 'ZWNJ is needed by Persian');
  assert.equal(cleanName(`👩${cp(0x200d)}💻 dev`), `👩${cp(0x200d)}💻 dev`, 'ZWJ is needed by emoji sequences');
});

test('starting or reopening with an id that is already in use fails before any terminal is created and never disturbs the live session', async () => {
  const r = rig();
  const live = await start(r, { id: 'dup' });
  assert.equal(live.terminalOpen, true);
  const before = r.terminals.length;
  const stateBefore = r.manager.list().find((entry) => entry.id === 'dup')?.state;
  await rejectsWithCode(start(r, { id: 'dup' }), 'session-exists');
  assert.equal(r.terminals.length, before, 'no second terminal was even created');
  assert.equal(r.terminals[0].disposed, 0, 'the live session\'s terminal is untouched');
  const after = r.manager.list().find((entry) => entry.id === 'dup');
  assert.equal(after?.terminalOpen, true);
  assert.equal(after?.state, stateBefore, 'its state is exactly what it was');
  // The live session can still be stopped normally afterwards.
  assert.equal(r.manager.stop('dup').terminalOpen, false);
  assert.equal(r.terminals[0].disposed, 1);

  const r2 = rig();
  const first = await start(r2, { id: 'first' });
  const second = await start(r2, { id: 'second', name: 'Worker 2' });
  r2.manager.stop(first.id);
  await rejectsWithCode(r2.manager.reopen(first.id, { newId: second.id }), 'session-exists');
  assert.equal(r2.manager.list().find((entry) => entry.id === second.id)?.terminalOpen, true, 'the other live session survives a reopen that reuses its id');
});

// A plan whose created file cannot be removed (its folder is read-only), so cleaning it up throws.
const cannotRemove = process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0);
function stuckPlan(t: { after(fn: () => void): void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-stuck-plan-'));
  const file = path.join(dir, 'instructions.md');
  fs.writeFileSync(file, 'x');
  const stat = fs.lstatSync(file, { bigint: true });
  fs.chmodSync(dir, 0o500);
  t.after(() => { fs.chmodSync(dir, 0o700); fs.rmSync(dir, { recursive: true, force: true }); });
  return { plan: { created: [{ kind: 'file', path: file, identity: { dev: stat.dev, ino: stat.ino }, size: 1, digest: createHash('sha256').update('x').digest('hex') }] }, file };
}
const withPlan = (plan: unknown) => ({ plan, digest: 'd', method: 'file', argv: [], injectionState: 'prepared' as const, injectionStatusLabel: 'prepared' });

test('stopping a session releases its terminal and records the stop even when the instruction file cannot be removed', { skip: cannotRemove }, async (t) => {
  const r = rig();
  await r.manager.initialize();
  const { plan, file } = stuckPlan(t);
  const session = await r.manager.start({ provider: 'claude', name: 'Stuck', cwd: '/synthetic/project', instructions: withPlan(plan) });
  const stopped = r.manager.stop(session.id);
  assert.equal(r.terminals[0].disposed, 1, 'the terminal is closed');
  assert.equal(stopped.terminalOpen, false, 'the stop is recorded');
  assert.match(stopped.instructionStatusLabel ?? '', /could not be removed/i);
  assert.equal(JSON.stringify(stopped).includes(file), false, 'the private path is not exposed');
});

test('a CLI that exited does not claim its instruction file was cleaned up when removing it failed', { skip: cannotRemove }, async (t) => {
  const r = rig();
  await r.manager.initialize();
  const stuck = stuckPlan(t);
  const failed = await r.manager.start({ provider: 'claude', name: 'Stuck', cwd: '/synthetic/project', instructions: withPlan(stuck.plan) });
  const view = r.manager.cliExited(failed.id);
  assert.equal(view.state, 'cli-exited');
  assert.match(view.instructionStatusLabel ?? '', /could not be removed/i);
  assert.doesNotMatch(view.instructionStatusLabel ?? '', /cleaned up/i);
  assert.equal(JSON.stringify(view).includes(stuck.file), false);
  const fine = await r.manager.start({ provider: 'claude', name: 'Fine', cwd: '/synthetic/project', instructions: withPlan({ created: [] }) });
  assert.match(r.manager.cliExited(fine.id).instructionStatusLabel ?? '', /cleaned up/, 'a successful cleanup still says so');
});

test('a terminal closed by the user is recorded as closed even when the instruction file cannot be removed', { skip: cannotRemove }, async (t) => {
  const r = rig();
  await r.manager.initialize();
  const { plan } = stuckPlan(t);
  const session = await r.manager.start({ provider: 'claude', name: 'Stuck', cwd: '/synthetic/project', instructions: withPlan(plan) });
  assert.equal(r.manager.handleTerminalClosed(r.terminals[0]), session.id);
  assert.equal(r.manager.get(session.id)?.terminalOpen, false);
  assert.equal(r.manager.handleTerminalClosed(r.terminals[0]), null, 'handled once');
});

test('a failed start reports its own error, not the cleanup failure', { skip: cannotRemove }, async (t) => {
  const r = rig({ terminals: { create: () => { throw new Error('terminal-creation-failed'); } } });
  await r.manager.initialize();
  const { plan } = stuckPlan(t);
  await assert.rejects(
    r.manager.start({ provider: 'claude', name: 'Stuck', cwd: '/synthetic/project', instructions: withPlan(plan) }),
    { message: 'terminal-creation-failed' }
  );
  assert.deepEqual(r.manager.list(), [], 'nothing is left behind');
});

test('Claude Code is started with its own attribution switched off, in start and reopen; no other provider is claimed to have a switch', async () => {
  assert.deepEqual(JSON.parse(CLAUDE_ATTRIBUTION_SETTINGS), { attribution: { commit: '', pr: '', sessionUrl: false } });
  assert.deepEqual(attributionArguments('claude', ATTRIBUTION_FILE), ['--settings', ATTRIBUTION_FILE]);
  for (const provider of ['codex', 'agy', 'opencode', 'custom-x', '']) assert.deepEqual(attributionArguments(provider), [], provider);
  const r = rig();
  await r.manager.start({ provider: 'claude', name: 'C', cwd: '/synthetic/project' });
  await r.manager.start({ provider: 'codex', name: 'X', cwd: '/synthetic/project' });
  assert.deepEqual(r.terminals.map((terminal) => terminal.sent[0]?.text), [`claude ${ATTRIBUTION}`, 'codex']);
});

test('Claude Code is not started without its attribution settings: no terminal, no text, no session', async () => {
  for (const attributionFile of [undefined, '', 'relative.json']) {
    const r = rig();
    await assert.rejects(r.manager.start({ provider: 'claude', name: 'C', cwd: '/synthetic/project', attributionFile }), { code: 'attribution-settings-unavailable' });
    assert.equal(r.terminals.length, 0, 'no terminal was created');
    assert.deepEqual(r.manager.list(), []);
  }
  assert.throws(() => attributionArguments('claude'), /attribution-settings-unavailable/);
  const r = rig();
  const first = await r.manager.start({ provider: 'claude', name: 'First', cwd: '/synthetic/project', launch: false });
  r.manager.stop(first.id);
  await assert.rejects(r.manager.reopen(first.id, { attributionFile: undefined }), { code: 'attribution-settings-unavailable' });
  // A shell opened without launching a CLI types nothing, so it needs no switch.
  await r.manager.start({ provider: 'claude', name: 'Shell only', cwd: '/synthetic/project', launch: false, attributionFile: undefined });
});

test('the settings file is private, holds only the attribution switch and is rewritten on every launch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-attr-'));
  try {
    const target = path.join(dir, 'attribution');
    const file = writeClaudeSettings(target, 'session-aaaa1111');
    assert.equal(file, path.join(target, 'claude-settings-session-aaaa1111.json'));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { attribution: { commit: '', pr: '', sessionUrl: false } }, 'without a role group: the attribution switch only, no permissions key');
    if (process.platform !== 'win32') { assert.equal(fs.statSync(file).mode & 0o077, 0); assert.equal(fs.statSync(target).mode & 0o077, 0); }
    fs.writeFileSync(file, '{"attribution":{"commit":"x"}}');
    assert.equal(writeClaudeSettings(target, 'session-aaaa1111'), file);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).attribution.commit, '', 'an edited copy does not survive a launch');
    for (const bad of ['relative', '', undefined as unknown as string]) assert.throws(() => writeClaudeSettings(bad, 'session-aaaa1111'), /attribution-settings-unavailable/);
    for (const bad of ['', 'short', '../../escape1', 'has space 1234', undefined as unknown as string]) assert.throws(() => writeClaudeSettings(target, bad), /attribution-settings-unavailable/, String(bad));
    // With a role group the same one document also carries its permissions: deny and ask rules, never allow.
    const pmFile = writeClaudeSettings(target, 'session-pm-00001', { shell: 'allow', fileWrite: 'deny', network: 'ask', gitPush: 'deny' });
    const pmDocument = JSON.parse(fs.readFileSync(pmFile, 'utf8'));
    assert.deepEqual(pmDocument.attribution, { commit: '', pr: '', sessionUrl: false });
    assert.ok(pmDocument.permissions.deny.includes('Edit') && pmDocument.permissions.deny.includes('Bash(git push *)'));
    assert.ok(pmDocument.permissions.ask.includes('WebFetch'));
    assert.equal(Object.hasOwn(pmDocument.permissions, 'allow'), false);
    assert.notEqual(pmFile, file, 'one file per session');
    removeClaudeSettings(pmFile);
    removeClaudeSettings(file);
    assert.equal(fs.existsSync(file), false, 'the file goes when the session ends');
    removeClaudeSettings(file);
    removeClaudeSettings(path.join(dir, 'precious.json'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const AUTO = { args: ['--permission-mode', 'auto'], label: 'Auto mode: on (synthetic)' };

test('auto mode arguments follow the attribution settings and precede the model; the wrap receives them all, in start and reopen', async () => {
  const r = rig();
  const wrapped: string[][] = [];
  const wrap = (executable: string, args: string[]) => { wrapped.push(args); return { executable, args }; };
  await r.manager.start({ provider: 'claude', name: 'A', cwd: '/synthetic/project', requestedModel: 'sonnet', autoMode: AUTO, wrap });
  assert.deepEqual(wrapped[0], ['--settings', ATTRIBUTION_FILE, '--permission-mode', 'auto', '--model', 'sonnet']);
  assert.equal(r.terminals[0].sent[0].text, `claude ${ATTRIBUTION} --permission-mode auto --model sonnet`);
  const first = await r.manager.start({ provider: 'claude', name: 'B', cwd: '/synthetic/project', launch: false });
  r.manager.stop(first.id);
  await r.manager.reopen(first.id, { autoMode: AUTO });
  assert.equal(r.terminals[r.terminals.length - 1].sent[0].text, `claude ${ATTRIBUTION} --permission-mode auto`);
});

test('no auto mode, or a shell opened without a CLI, adds no argument; the view says what was requested', async () => {
  const r = rig();
  const off = await r.manager.start({ provider: 'claude', name: 'A', cwd: '/synthetic/project', autoMode: { args: [], label: 'Auto mode: off (synthetic)' } });
  assert.equal(r.terminals[0].sent[0].text, `claude ${ATTRIBUTION}`);
  assert.equal(off.autoModeLabel, 'Auto mode: off (synthetic)');
  const none = await r.manager.start({ provider: 'claude', name: 'B', cwd: '/synthetic/project' });
  assert.equal(r.terminals[1].sent[0].text, `claude ${ATTRIBUTION}`);
  assert.match(String(none.autoModeLabel), /unknown/);
  const shell = await r.manager.start({ provider: 'claude', name: 'C', cwd: '/synthetic/project', launch: false, autoMode: AUTO });
  assert.deepEqual(r.terminals[2].sent, [], 'nothing is typed');
  assert.match(String(shell.autoModeLabel), /not applicable/);
  const on = await r.manager.start({ provider: 'codex', name: 'D', cwd: '/synthetic/project', autoMode: { args: ['--sandbox', 'workspace-write', '--ask-for-approval', 'never'], label: 'Auto mode: on (codex)' } });
  assert.equal(r.terminals[3].sent[0].text, 'codex --sandbox workspace-write --ask-for-approval never');
  assert.equal(on.autoModeLabel, 'Auto mode: on (codex)');
});

test('a prompt is typed into a running session\'s terminal as one line and Enter; nothing else can be typed', async () => {
  const r = rig();
  const started = await r.manager.start({ provider: 'claude', name: 'Worker', cwd: '/synthetic/project' });
  r.manager.sendPrompt(started.id, '[Administrator broadcast, created 2026-10-21T09:00:00.000Z] Run the tests first.');
  assert.deepEqual(r.terminals[0].sent.slice(1), [{ text: '[Administrator broadcast, created 2026-10-21T09:00:00.000Z] Run the tests first.', newline: true }]);
  for (const prompt of ['', 'no bracket', '/clear', '[a\nb]', '[a\u001b[31m]', '[a\rb]', `[${'x'.repeat(3000)}]`, 5 as unknown as string]) {
    assert.throws(() => r.manager.sendPrompt(started.id, prompt), { code: 'prompt-invalid' }, JSON.stringify(prompt).slice(0, 20));
  }
  assert.equal(r.terminals[0].sent.length, 2, 'only the one good prompt was typed');
});

test('a prompt is not typed into a shell without a CLI, a stopped session or an unknown one', async () => {
  const r = rig();
  const shell = await r.manager.start({ provider: 'claude', name: 'Shell', cwd: '/synthetic/project', launch: false });
  assert.throws(() => r.manager.sendPrompt(shell.id, '[ok] hello'), { code: 'cli-not-running' });
  assert.deepEqual(r.terminals[0].sent, [], 'nothing was typed into the shell');
  const running = await r.manager.start({ provider: 'claude', name: 'Running', cwd: '/synthetic/project' });
  r.manager.stop(running.id);
  assert.throws(() => r.manager.sendPrompt(running.id, '[ok] hello'), { code: 'terminal-not-open' });
  assert.throws(() => r.manager.sendPrompt('no-such-session', '[ok] hello'), { code: 'session-not-found' });
});

test('a role group\'s sandbox arguments replace the auto mode\'s sandbox and keep the rest, in start and reopen (issue #310)', async () => {
  const r = rig({ providers: { claude: 'claude', codex: 'codex' } });
  const auto = { args: ['--sandbox', 'workspace-write', '--ask-for-approval', 'never'], label: 'Auto mode: on (codex)' };
  await r.manager.start({ provider: 'codex', name: 'PM', cwd: '/synthetic/project', autoMode: auto, permissionArgs: ['--sandbox', 'read-only'] });
  assert.equal(r.terminals[0].sent[0].text, 'codex --ask-for-approval never --sandbox read-only');
  await r.manager.start({ provider: 'codex', name: 'Worker', cwd: '/synthetic/project', autoMode: auto, permissionArgs: [] });
  assert.equal(r.terminals[1].sent[0].text, 'codex --sandbox workspace-write --ask-for-approval never');
  await r.manager.start({ provider: 'codex', name: 'No auto', cwd: '/synthetic/project', permissionArgs: ['--sandbox', 'read-only'] });
  assert.equal(r.terminals[2].sent[0].text, 'codex --sandbox read-only');
  const shell = await r.manager.start({ provider: 'codex', name: 'Shell', cwd: '/synthetic/project', launch: false, permissionArgs: ['--sandbox', 'read-only'] });
  assert.deepEqual(r.terminals[3].sent, [], 'a shell with no CLI types nothing');
  r.manager.stop(shell.id);
  const first = r.manager.list()[0];
  r.manager.stop(first.id);
  await r.manager.reopen(first.id, { autoMode: auto, permissionArgs: ['--sandbox', 'read-only'] });
  assert.equal(r.terminals[r.terminals.length - 1].sent[0].text, 'codex --ask-for-approval never --sandbox read-only');
});

test('a codename is shown with its session, saved with it, restored after a restart, and moved to the new session on reopen (issue #342)', async () => {
  const r = rig();
  await r.manager.initialize();
  const session = await r.manager.start({ provider: 'claude', name: 'Coder', cwd: '/synthetic/project', codename: 'Worker-01' });
  assert.equal(session.codename, 'Worker-01');
  assert.equal(r.store.saved?.find((record) => record.id === session.id)?.codename, 'Worker-01', 'saved with the session record');
  const other = await r.manager.start({ provider: 'claude', name: 'Plain', cwd: '/synthetic/project' });
  assert.equal(other.codename, null, 'a session started without one has none');
  assert.equal(r.store.saved?.find((record) => record.id === other.id)?.codename, undefined);
  r.manager.stop(session.id);
  const reopened = await r.manager.reopen(session.id, { codename: 'Worker-01' });
  assert.equal(reopened.codename, 'Worker-01');
  assert.equal(r.manager.get(session.id)?.codename, null, 'the old record is history and no longer holds it');
  const restored = rig({}, r.store);
  await restored.manager.initialize();
  assert.equal(restored.manager.get(reopened.id)?.codename, 'Worker-01', 'kept after a restart');
  assert.equal(restored.manager.get(session.id)?.codename, null);
});

test('a codename that is not one is refused before any terminal exists, in start and reopen (issue #342)', async () => {
  const r = rig();
  await r.manager.initialize();
  for (const codename of ['worker-01', 'Worker-1', 'PM-01\n', '']) {
    await assert.rejects(r.manager.start({ provider: 'claude', name: 'Bad', cwd: '/synthetic/project', codename }), { code: 'invalid-codename' }, codename);
  }
  assert.equal(r.terminals.length, 0);
  const session = await r.manager.start({ provider: 'claude', name: 'Ok', cwd: '/synthetic/project', codename: 'Worker-01' });
  r.manager.stop(session.id);
  await assert.rejects(r.manager.reopen(session.id, { codename: 'Worker_01' }), { code: 'invalid-codename' });
  assert.equal(r.terminals.length, 1, 'the refused reopen made no terminal');
  assert.equal(r.manager.get(session.id)?.codename, 'Worker-01', 'and took nothing from the old session');
});


test('after a restart, a saved codename the codename store no longer lists for that session is dropped; one it cannot check is kept (issue #342)', async () => {
  const r = rig();
  await r.manager.initialize();
  const kept = await r.manager.start({ provider: 'claude', name: 'Kept', cwd: '/synthetic/project', codename: 'Worker-03' });
  const pruned = await r.manager.start({ provider: 'claude', name: 'Pruned', cwd: '/synthetic/project', codename: 'Worker-01' });
  const unknown = await r.manager.start({ provider: 'claude', name: 'Unknown', cwd: '/synthetic/project', codename: 'Worker-02' });
  const restored = rig({}, r.store);
  await restored.manager.initialize();
  const answers: Record<string, string | null | undefined> = { [kept.id]: 'Worker-03', [pruned.id]: null, [unknown.id]: undefined };
  assert.equal(await restored.manager.reconcileCodenames((_repo, id) => answers[id]), 1);
  assert.equal(restored.manager.get(kept.id)?.codename, 'Worker-03');
  assert.equal(restored.manager.get(pruned.id)?.codename, null, 'the store no longer lists it: it is not shown');
  assert.equal(restored.manager.get(unknown.id)?.codename, 'Worker-02', 'a store that could not answer changes nothing');
  assert.equal(r.store.saved?.find((record) => record.id === pruned.id)?.codename, undefined, 'and the snapshot agrees');
  assert.equal(await restored.manager.reconcileCodenames((_repo, id) => (id === kept.id ? 'Worker-09' : answers[id])), 1, 'a different codename in the store wins as well');
  assert.equal(restored.manager.get(kept.id)?.codename, null);
});

test('the session\'s gh wrapper folder is put first on PATH in the typed command, in start and reopen, in every supported shell; a folder cmd.exe would misread starts nothing (issue #342)', async () => {
  let shell: 'posix' | 'powershell' | 'cmd' = 'posix';
  const r = rig({ detectShellType: () => shell });
  await r.manager.initialize();
  const session = await r.manager.start({ provider: 'claude', name: 'Wrapped', cwd: '/synthetic/project', pathPrefix: '/private/gh wrapper/s1' });
  assert.deepEqual(r.terminals[0].sent, [{ text: `PATH='/private/gh wrapper/s1':"$PATH" claude ${ATTRIBUTION}`, newline: true }]);
  r.manager.stop(session.id);
  shell = 'powershell';
  await r.manager.reopen(session.id, { pathPrefix: 'C:\\priv\\s2' });
  assert.match(r.terminals[1].sent[0].text, /^\$env:PSExecutionPolicyPreference = 'RemoteSigned'; \$env:PATH = 'C:\\priv\\s2;' \+ \$env:PATH; claude /);
  shell = 'cmd';
  await r.manager.start({ provider: 'claude', name: 'Cmd', cwd: '/synthetic/project', pathPrefix: 'C:\\priv\\s3' });
  assert.match(r.terminals[r.terminals.length - 1].sent[0].text, /^set "PATH=C:\\priv\\s3;%PATH%" && set "PSExecutionPolicyPreference=RemoteSigned" && /, 'the Windows default terminal (cmd.exe in CI) starts the agent too');
  const before = r.terminals.length;
  await assert.rejects(r.manager.start({ provider: 'claude', name: 'Cmd bad', cwd: '/synthetic/project', pathPrefix: 'C:\\100%\\s4' }), { code: 'unsupported-shell' });
  assert.equal(r.terminals.length, before, 'no terminal was made for a folder cmd.exe would read differently');
  const shellOnly = await r.manager.start({ provider: 'claude', name: 'Shell', cwd: '/synthetic/project', launch: false, pathPrefix: '/private/s4' });
  assert.equal(shellOnly.state, 'terminal-open', 'a shell-only terminal types nothing, so it needs no prefix');
});

test('a launch note clears the screen before the command and prints it; without one the command is typed exactly as before (#357)', async () => {
  const r = rig();
  await r.manager.start({ provider: 'claude', name: 'Noted', cwd: '/synthetic/project', launchNote: 'Multiagent: starting Claude Code (Worker-01)' });
  assert.equal(r.terminals[0].sent[0].text, `clear 2>/dev/null; printf '%s\\n' 'Multiagent: starting Claude Code (Worker-01)'; claude ${ATTRIBUTION}`);
  await r.manager.start({ provider: 'claude', name: 'Plain', cwd: '/synthetic/project' });
  assert.equal(r.terminals[1].sent[0].text, `claude ${ATTRIBUTION}`);
  const shell = await r.manager.start({ provider: 'claude', name: 'Shell', cwd: '/synthetic/project', launch: false, launchNote: 'Multiagent: starting Claude Code' });
  assert.equal(r.terminals[2].sent.length, 0, 'nothing is typed into a shell-only session');
  r.manager.stop(shell.id);
  await r.manager.reopen(shell.id, { launchNote: 'Multiagent: starting Claude Code (Worker-02)' });
  assert.match(r.terminals[r.terminals.length - 1].sent[0].text, /^clear 2>\/dev\/null; printf '%s\\n' 'Multiagent: starting Claude Code \(Worker-02\)'; claude /);
});

test('forget drops a stopped session from the list and from what is saved, and refuses one whose terminal is open (#352)', async () => {
  const r = rig();
  await r.manager.initialize();
  const kept = await start(r, { name: 'Kept' });
  const replaced = await start(r, { name: 'Replaced' });
  await rejectsWithCode(r.manager.forget(replaced.id), 'session-live');
  r.manager.stop(replaced.id);
  await r.manager.forget(replaced.id);
  assert.deepEqual(r.manager.list().map((session) => session.id), [kept.id]);
  assert.deepEqual((r.store.saved ?? []).map((record) => [record.id, record.name]), [[kept.id, 'Kept']]);
  await rejectsWithCode(r.manager.forget(replaced.id), 'session-not-found');
});

test('a codename moved from another session leaves that session: two sessions never show the same codename (#352)', async () => {
  const r = rig();
  await r.manager.initialize();
  const old = await start(r, { name: 'Same Agent', codename: 'Worker-05' });
  r.manager.stop(old.id);
  const again = await start(r, { name: 'Same Agent', codename: 'Worker-05', codenameFrom: old.id });
  assert.equal(r.manager.get(again.id)?.codename, 'Worker-05');
  assert.equal(r.manager.get(old.id)?.codename, null, 'the old record no longer holds it');
  const other = await start(r, { name: 'Other', codename: 'Worker-06', codenameFrom: again.id });
  assert.equal(r.manager.get(again.id)?.codename, 'Worker-05', 'a different codename takes nothing away');
  assert.equal(r.manager.get(other.id)?.codename, 'Worker-06');
});
