import { test, TestContext } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createStorageHandle } from '../../src/storage/extensionStorage';
import { PrivateSessionSnapshot, sessionWorkspaceKey } from '../../src/sessions/privateSnapshot';
import { SessionManager, SessionRecord } from '../../src/sessions/manager';

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-session-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'workspace');
  fs.mkdirSync(repo);
  const handle = createStorageHandle({
    context: { globalStorageUri: { fsPath: path.join(root, 'editor-storage') }, secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} } },
    workspaceFolders: () => [repo]
  });
  let key: string | null = sessionWorkspaceKey([repo]);
  const access = { workspaceKey: () => key, use: () => handle.use() };
  return { root, repo, handle, access, setKey: (next: string | null) => { key = next; }, adapter: () => new PrivateSessionSnapshot(access) };
}
const record = (id: string): SessionRecord => ({ id, repoId: 'synthetic', roleGroupId: 'pm', provider: 'claude', accountProfileId: 'profile-one', worktree: '/synthetic/worktree', name: id, requestedModel: 'sonnet' });

test('actual private store restores fixed session settings as unknown without opening terminals', async (t) => {
  const f = fixture(t);
  let terminals = 0;
  const deps = {
    terminals: { create: () => { terminals++; return { show() {}, sendText() {}, dispose() {} }; } },
    providers: { claude: 'claude' }, resolveProject: async () => ({ repoId: 'synthetic' }), directoryExists: () => true
  };
  const first = new SessionManager({ ...deps, store: f.adapter() });
  await first.initialize();
  const started = await first.start({ provider: 'claude', roleGroupId: 'pm', accountProfileId: 'profile-one', name: 'Saved choice', cwd: f.repo, requestedModel: 'sonnet', launch: false });
  assert.equal(terminals, 1);
  const second = new SessionManager({ ...deps, store: f.adapter() });
  await second.initialize();
  const restored = second.get(started.id)!;
  assert.equal(terminals, 1, 'restoration never creates a terminal');
  assert.deepEqual([restored.name, restored.roleGroupId, restored.accountProfileId, restored.worktree, restored.requestedModel], ['Saved choice', 'pm', 'profile-one', f.repo, 'sonnet']);
  assert.deepEqual([restored.state, restored.terminalOpen, restored.observedAt], ['unknown', false, null]);
  const opened = await f.handle.use();
  assert.ok(opened.ok);
  const saved = opened.store.list('sessions') as any;
  assert.equal(saved.items.length, 1);
  assert.deepEqual(Object.keys(saved.items[0].value.records[0]).sort(), ['accountProfileId', 'id', 'name', 'provider', 'repoId', 'requestedModel', 'roleGroupId', 'worktree'].sort());
  assert.deepEqual(fs.readdirSync(f.repo), [], 'no snapshot appears in the project');
});

test('concurrent saves from one writer stay ordered and copy their input before waiting', async (t) => {
  const f = fixture(t);
  const writer = f.adapter();
  await writer.load();
  const records = [record('first')];
  const first = writer.save(records);
  records[0].name = 'mutated after save call';
  await first;
  assert.deepEqual(await f.adapter().load(), [record('first')], 'save copies its input before an asynchronous storage check');
  const second = writer.save([record('first'), record('second')]);
  const third = writer.save([record('first'), record('second'), record('third')]);
  await Promise.all([second, third]);
  assert.deepEqual(await f.adapter().load(), [record('first'), record('second'), record('third')]);
});

test('two windows cannot overwrite a snapshot loaded before the other writer saved', async (t) => {
  const f = fixture(t);
  const one = f.adapter(), two = f.adapter();
  await Promise.all([one.load(), two.load()]);
  await one.save([record('first')]);
  await assert.rejects(two.save([record('second')]), { code: 'session-snapshot-conflict' });
  await assert.rejects(two.save([]), { code: 'session-persistence-blocked' });
  assert.deepEqual(await f.adapter().load(), [record('first')]);
});

test('workspace changes isolate scopes and reject saves from the old window', async (t) => {
  const f = fixture(t);
  const one = f.adapter();
  await one.load();
  await one.save([record('first')]);
  const oldKey = f.access.workspaceKey();
  f.setKey(sessionWorkspaceKey(['other-workspace']));
  await assert.rejects(one.save([]), { code: 'session-workspace-changed' });
  assert.equal(await f.adapter().load(), undefined);
  f.setKey(oldKey);
  assert.deepEqual(await f.adapter().load(), [record('first')]);
  assert.notEqual(sessionWorkspaceKey(['one', 'two']), sessionWorkspaceKey(['two', 'one']));
  assert.notEqual(sessionWorkspaceKey(['one'], 'file-a'), sessionWorkspaceKey(['one'], 'file-b'));
});

test('a workspace change while private storage is awaited cannot return another scope', async (t) => {
  const f = fixture(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const writer = new PrivateSessionSnapshot({ workspaceKey: f.access.workspaceKey, use: async () => { await gate; return f.handle.use(); } });
  const pending = writer.load();
  f.setKey('other');
  release();
  await assert.rejects(pending, { code: 'session-workspace-changed' });
});

test('corrupt records stay untouched and prevent both restoration and later saves', async (t) => {
  const f = fixture(t);
  const opened = await f.handle.use();
  assert.ok(opened.ok);
  const id = `workspace-${f.access.workspaceKey()}`;
  const damaged = { scope: f.access.workspaceKey(), revision: 'bad', records: [] };
  assert.equal(opened.store.put('sessions', id, damaged).ok, true);
  const writer = f.adapter();
  await assert.rejects(writer.load(), { code: 'invalid-session-snapshot' });
  await assert.rejects(writer.save([]), { code: 'session-persistence-blocked' });
  assert.deepEqual((opened.store.get('sessions', id) as any).value, damaged);
});

test('runtime fields and malformed models never enter the private snapshot', async (t) => {
  const f = fixture(t);
  for (const bad of [{ ...record('x'), state: 'cli-observed' }, { ...record('x'), env: {} }, { ...record('x'), requestedModel: 'bad\n' }, { ...record('x'), name: '' }]) {
    const writer = f.adapter();
    await writer.load();
    await assert.rejects(writer.save([bad]), { code: 'invalid-session-snapshot' });
  }
  const opened = await f.handle.use();
  assert.ok(opened.ok);
  assert.equal((opened.store.list('sessions') as any).items.length, 0);
});

test('unavailable private storage has no fallback; an empty window does not bind a later folder', async () => {
  const unavailable = new PrivateSessionSnapshot({ workspaceKey: () => 'synthetic', use: async () => ({ ok: false }) });
  await assert.rejects(unavailable.load(), { code: 'session-storage-unavailable' });
  await assert.rejects(unavailable.save([]), { code: 'session-persistence-blocked' });
  let key: string | null = null;
  const empty = new PrivateSessionSnapshot({ workspaceKey: () => key, use: async () => { throw new Error('must not be called'); } });
  assert.equal(await empty.load(), undefined);
  key = 'opened-later';
  await assert.rejects(empty.save([]), { code: 'session-workspace-changed' });
});

test('a restored snapshot with a relative path, control characters or oversized fields is refused, untouched, and blocks saving', async (t) => {
  const bad: Array<[string, Partial<SessionRecord>]> = [
    ['relative worktree', { worktree: 'relative/project' }],
    ['dot-dot worktree', { worktree: '../outside' }],
    ['newline in worktree', { worktree: '/synthetic/a\nb' }],
    ['oversized worktree', { worktree: `/${'a'.repeat(1100)}` }],
    ['control character in account id', { accountProfileId: 'acct\u0085x' }],
    ['oversized id', { id: 'x'.repeat(101) }],
    ['bidi override in name', { name: `safe${String.fromCodePoint(0x202e)}txt` }]
  ];
  for (const [label, change] of bad) {
    const f = fixture(t);
    const opened = await f.handle.use();
    assert.ok(opened.ok);
    const id = `workspace-${f.access.workspaceKey()}`;
    const damaged = { scope: f.access.workspaceKey(), revision: 1, records: [{ ...record('one'), ...change }] };
    assert.equal(opened.store.put('sessions', id, damaged).ok, true);
    const writer = f.adapter();
    await assert.rejects(writer.load(), { code: 'invalid-session-snapshot' }, label);
    await assert.rejects(writer.save([]), { code: 'session-persistence-blocked' }, label);
    assert.deepEqual((opened.store.get('sessions', id) as any).value, damaged, `${label}: the original record is not overwritten`);
  }
});
