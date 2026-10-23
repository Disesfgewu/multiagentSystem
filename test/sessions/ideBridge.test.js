'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findIdePort, lockFolders, readLock, describeIde, REASONS } = require('../../src/sessions/ideBridge');

const TOKEN = 'synthetic-auth-token-354';

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-ide-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ide = path.join(root, 'ide');
  fs.mkdirSync(ide);
  const write = (port, value) => fs.writeFileSync(path.join(ide, `${port}.lock`), typeof value === 'string' ? value : JSON.stringify(value));
  return { root, ide, write };
}
const lock = (folders, pid = 101) => ({ pid, workspaceFolders: folders, ideName: 'Visual Studio Code', transport: 'ws', runningInWindows: false, authToken: TOKEN });
const alive = (pid) => pid !== 999;

test('the port of the one running window that has this folder open is chosen; the auth token is never returned', (t) => {
  const { ide, write } = setup(t);
  write(40001, lock(['/work/other']));
  write(40002, lock(['/work/project']));
  const result = findIdePort({ folders: [ide], workspaceFolders: ['/work/project/'], platform: 'linux', alive });
  assert.deepEqual(result, { ok: true, port: 40002 });
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.equal(describeIde(result), "VS Code: connected through this window's Claude Code port (40002)");
});

test('readLock keeps only the port, the folders and the process id', (t) => {
  const { ide, write } = setup(t);
  write(40003, lock(['/a', 7, '/b']));
  const read = readLock(path.join(ide, '40003.lock'));
  assert.deepEqual(read, { port: 40003, workspaceFolders: ['/a', '/b'], pid: 101 });
  assert.equal(JSON.stringify(read).includes(TOKEN), false);
});

test('a lock left behind by a VS Code that is gone is not chosen', (t) => {
  const { ide, write } = setup(t);
  write(40004, lock(['/work/project'], 999));
  write(40005, lock(['/work/project'], 101));
  assert.deepEqual(findIdePort({ folders: [ide], workspaceFolders: ['/work/project'], platform: 'linux', alive }), { ok: true, port: 40005 });
  fs.rmSync(path.join(ide, '40005.lock'));
  assert.equal(findIdePort({ folders: [ide], workspaceFolders: ['/work/project'], platform: 'linux', alive }).reason, 'no-match');
});

test('two running windows with this folder open: no port is guessed', (t) => {
  const { ide, write } = setup(t);
  write(40006, lock(['/work/project'], 101));
  write(40007, lock(['/work/project'], 102));
  const result = findIdePort({ folders: [ide], workspaceFolders: ['/work/project'], platform: 'linux', alive });
  assert.deepEqual(result, { ok: false, reason: 'ambiguous', text: REASONS.ambiguous });
  assert.match(describeIde(result), /^VS Code: not connected \(more than one running VS Code window/);
});

test('the same port in the home folder and the account folder counts once', (t) => {
  const { root, ide, write } = setup(t);
  write(40008, lock(['/work/project']));
  const second = path.join(root, 'account', 'ide');
  fs.mkdirSync(second, { recursive: true });
  fs.writeFileSync(path.join(second, '40008.lock'), JSON.stringify(lock(['/work/project'])));
  assert.deepEqual(findIdePort({ folders: [ide, second], workspaceFolders: ['/work/project'], platform: 'linux', alive }), { ok: true, port: 40008 });
});

test('folders compare without case on macOS and Windows, with case on Linux', (t) => {
  const { ide, write } = setup(t);
  write(40009, lock(['/Work/Project']));
  assert.deepEqual(findIdePort({ folders: [ide], workspaceFolders: ['/work/project'], platform: 'darwin', alive }), { ok: true, port: 40009 });
  assert.equal(findIdePort({ folders: [ide], workspaceFolders: ['/work/project'], platform: 'linux', alive }).reason, 'no-match');
});

test('each reason is given, with what to do, and no port', (t) => {
  const { root, ide, write } = setup(t);
  assert.equal(findIdePort({ folders: [path.join(root, 'missing')], workspaceFolders: ['/w'], alive }).reason, 'no-ide-folder');
  assert.equal(findIdePort({ folders: [ide], workspaceFolders: ['/w'], alive }).reason, 'no-lock');
  assert.equal(findIdePort({ folders: [ide], workspaceFolders: [], alive }).reason, 'no-workspace');
  write(40010, '{not json');
  write(40011, { pid: 101 });
  fs.writeFileSync(path.join(ide, '0.lock'), JSON.stringify(lock(['/w'])));
  fs.writeFileSync(path.join(ide, '70000.lock'), JSON.stringify(lock(['/w'])));
  fs.writeFileSync(path.join(ide, '40012.txt'), JSON.stringify(lock(['/w'])));
  fs.writeFileSync(path.join(ide, '40013.lock'), JSON.stringify({ ...lock(['/w']), pad: 'x'.repeat(70 * 1024) }));
  const result = findIdePort({ folders: [ide], workspaceFolders: ['/w'], alive });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-lock', 'malformed, misnamed, out-of-range and oversized locks are not read');
  for (const text of Object.values(REASONS)) assert.ok(text.length > 20);
  assert.equal(describeIde(undefined), 'VS Code: not connected (not checked for this session)');
});

test('lock folders: the home folder, and the account folder when one is set', () => {
  assert.deepEqual(lockFolders({ home: '/h' }), [path.resolve('/h/.claude/ide')]);
  assert.deepEqual(lockFolders({ home: '/h', configDir: '/acct' }), [path.resolve('/h/.claude/ide'), path.resolve('/acct/ide')]);
  assert.deepEqual(lockFolders({ home: '/h', configDir: '/h/.claude' }), [path.resolve('/h/.claude/ide')]);
});
