'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureToolFolder } = require('../../src/research/private-dir');

const posix = process.platform !== 'win32';
const sandbox = (t) => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mas-tool-dir-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
};

test('a missing folder is created private, with its tmp folder; asking again changes nothing', (t) => {
  const base = sandbox(t);
  const made = ensureToolFolder({ base, serverId: 'arxiv-mcp-server' });
  assert.deepEqual(made, { ok: true, dir: path.join(base, 'research-tools', 'arxiv-mcp-server'), tmp: path.join(base, 'research-tools', 'arxiv-mcp-server', 'tmp') });
  for (const level of [path.join(base, 'research-tools'), made.dir, made.tmp]) {
    assert.equal(fs.lstatSync(level).isDirectory(), true);
    if (posix) assert.equal(fs.lstatSync(level).mode & 0o077, 0, level);
  }
  fs.writeFileSync(path.join(made.dir, 'kept.txt'), 'x');
  assert.equal(ensureToolFolder({ base, serverId: 'arxiv-mcp-server' }).ok, true);
  assert.equal(fs.existsSync(path.join(made.dir, 'kept.txt')), true);
});

test('a link in place of any level is refused, whether it points outside or at a real folder', (t) => {
  for (const level of ['research-tools', 'research-tools/tool-a', 'research-tools/tool-a/tmp']) {
    const base = sandbox(t);
    const outside = path.join(base, 'outside');
    fs.mkdirSync(outside);
    const link = path.join(base, level);
    fs.mkdirSync(path.dirname(link), { recursive: true, mode: 0o700 });
    try { fs.symlinkSync(outside, link); } catch (error) { if (error.code === 'EPERM') return; throw error; }
    assert.deepEqual(ensureToolFolder({ base, serverId: 'tool-a' }), { ok: false, reason: 'storage-is-link' }, level);
    assert.deepEqual(fs.readdirSync(outside), [], 'nothing was written through the link');
  }
});

test('a file in place of a folder is refused', (t) => {
  const base = sandbox(t);
  fs.mkdirSync(path.join(base, 'research-tools'), { mode: 0o700 });
  fs.writeFileSync(path.join(base, 'research-tools', 'tool-a'), 'x');
  assert.deepEqual(ensureToolFolder({ base, serverId: 'tool-a' }), { ok: false, reason: 'storage-not-a-folder' });
});

test('an existing folder that others can read or write is refused and left as it is', { skip: !posix }, (t) => {
  for (const mode of [0o777, 0o755, 0o750, 0o770, 0o707]) {
    const base = sandbox(t);
    const dir = path.join(base, 'research-tools', 'tool-a');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, mode);
    assert.deepEqual(ensureToolFolder({ base, serverId: 'tool-a' }), { ok: false, reason: 'storage-too-open' }, mode.toString(8));
    assert.equal(fs.lstatSync(dir).mode & 0o777, mode, 'the permissions are not changed for someone else');
  }
});

test('a folder owned by another user is refused (simulated with an injected stat)', { skip: !posix }, (t) => {
  const base = sandbox(t);
  ensureToolFolder({ base, serverId: 'tool-a' });
  const real = fs.lstatSync(path.join(base, 'research-tools'));
  const fsImpl = { ...fs, lstatSync: (target) => { const info = fs.lstatSync(target); return Object.assign(Object.create(Object.getPrototypeOf(info)), info, { uid: info.uid + 1 }); } };
  assert.deepEqual(ensureToolFolder({ base, serverId: 'tool-a', fsImpl, uid: real.uid }), { ok: false, reason: 'storage-not-owned' });
});

test('failures to read or create are refused, and bad input never touches the disk', (t) => {
  const base = sandbox(t);
  const denied = { ...fs, lstatSync: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } };
  assert.deepEqual(ensureToolFolder({ base, serverId: 'tool-a', fsImpl: denied }), { ok: false, reason: 'storage-unreadable' });
  const cannotCreate = { ...fs, mkdirSync: () => { throw new Error('x'); } };
  assert.deepEqual(ensureToolFolder({ base, serverId: 'tool-a', fsImpl: cannotCreate }), { ok: false, reason: 'storage-create-failed' });
  for (const serverId of ['', '../x', 'a/b', 'A', '.hidden', 'x'.repeat(65), undefined, 5]) assert.equal(ensureToolFolder({ base, serverId }).reason, 'storage-input-invalid', String(serverId));
  for (const badBase of ['relative', '', undefined]) assert.equal(ensureToolFolder({ base: badBase, serverId: 'tool-a' }).reason, 'storage-input-invalid');
  assert.equal(fs.existsSync(path.join(base, 'research-tools', 'x')), false);
});
