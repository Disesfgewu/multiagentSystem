import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, TestContext } from 'node:test';
import { zipSync } from 'fflate';
import { GhRelease, ManagedGh, prependPath } from '../../src/setup/managedGh';

const binary = new TextEncoder().encode('synthetic gh binary, never executed');
const entry = 'gh_2.102.0_macOS_arm64/bin/gh';
const archive = zipSync({ [entry]: binary });
const sha = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
const release = (over: Partial<GhRelease> = {}): GhRelease => ({
  tool: 'gh', version: '2.102.0', platform: 'darwin', arch: 'arm64',
  url: 'https://github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_macOS_arm64.zip',
  sha256: sha(archive), entry, executable: 'gh', ...over
});

const world = (t: TestContext) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-gh-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};

test('a fixed official archive is hash checked, one expected file is installed, and a verified pointer is reused', async (t) => {
  const root = world(t);
  let downloads = 0;
  const manager = new ManagedGh({ root, release: release(), download: async (_url, max, progress) => {
    downloads += 1; assert.ok(archive.byteLength < max); progress?.({ received: archive.byteLength, total: archive.byteLength }); return archive;
  }, newId: () => 'one', now: () => new Date('2026-10-16T00:00:00Z') });
  assert.deepEqual(await manager.status(), { state: 'missing', reason: 'not-prepared' });
  const ready = await manager.prepare();
  assert.equal(ready.state, 'ready');
  if (ready.state !== 'ready') return;
  assert.equal(downloads, 1);
  assert.equal(fs.readFileSync(ready.executable, 'utf8'), 'synthetic gh binary, never executed');
  assert.equal(path.dirname(ready.executable), ready.binDir);
  assert.equal((await manager.prepare()).state, 'ready');
  assert.equal(downloads, 1, 'a verified installation is not downloaded again');
  const pointer = JSON.parse(fs.readFileSync(path.join(root, 'current.json'), 'utf8'));
  assert.equal(pointer.archiveSha256, sha(archive));
  assert.equal(JSON.stringify(pointer).includes(root), false, 'the record has no local path');
  assert.equal(fs.readFileSync(path.join(path.dirname(ready.binDir), 'archive.zip')).length, archive.byteLength, 'the verified archive is retained for status() to re-derive the binary from');
});

test('hash mismatch, offline interruption and malformed archives fail closed and can be retried', async (t) => {
  const root = world(t);
  let mode: 'offline' | 'wrong' | 'bad-zip' | 'good' = 'offline';
  const manager = new ManagedGh({ root, release: release(), download: async () => {
    if (mode === 'offline') throw new Error('offline with private details');
    if (mode === 'wrong') return new Uint8Array([1, 2, 3]);
    if (mode === 'bad-zip') return zipSync({ 'other/file': binary });
    return archive;
  }, newId: () => mode });
  assert.deepEqual(await manager.prepare(), { state: 'missing', reason: 'download-or-install-failed' });
  assert.equal(fs.existsSync(path.join(root, 'current.json')), false);
  mode = 'wrong';
  assert.deepEqual(await manager.prepare(), { state: 'missing', reason: 'archive-integrity-failed' });
  // Give the wrong-shaped ZIP its own matching digest: it is still refused because the exact entry is absent.
  mode = 'bad-zip';
  const bad = zipSync({ 'other/file': binary });
  const malformed = new ManagedGh({ root, release: release({ sha256: sha(bad) }), download: async () => bad, newId: () => 'badzip' });
  assert.deepEqual(await malformed.prepare(), { state: 'missing', reason: 'archive-invalid' });
  assert.equal(fs.existsSync(path.join(root, 'current.json')), false);
  mode = 'good';
  assert.equal((await manager.prepare()).state, 'ready', 'retry recovers without using an incomplete staging directory');
});

test('a replaced binary or symlink is unknown/corrupt and never accepted from the pointer alone', async (t) => {
  const root = world(t);
  const manager = new ManagedGh({ root, release: release(), download: async () => archive, newId: () => 'replace' });
  const ready = await manager.prepare();
  assert.equal(ready.state, 'ready');
  if (ready.state !== 'ready') return;
  fs.writeFileSync(ready.executable, 'changed after verification');
  assert.deepEqual(await manager.status(), { state: 'corrupt', reason: 'managed-binary-changed' });
  fs.rmSync(ready.executable);
  fs.symlinkSync(path.join(root, 'elsewhere'), ready.executable);
  assert.deepEqual(await manager.status(), { state: 'corrupt', reason: 'managed-path-replaced' });
});

test('the binary is never trusted from a scalar the pointer asserts: there is no such field left to tamper, and status() re-derives it from the archive instead', async (t) => {
  const root = world(t);
  const manager = new ManagedGh({ root, release: release(), download: async () => archive, newId: () => 'swap' });
  const ready = await manager.prepare();
  assert.equal(ready.state, 'ready');
  if (ready.state !== 'ready') return;
  const pointer = JSON.parse(fs.readFileSync(path.join(root, 'current.json'), 'utf8'));
  assert.equal('binarySha256' in pointer, false, 'the pointer no longer carries a self-asserted binary hash to tamper with');
  // Swapping the live binary alone (the archive is untouched) is still caught: status() re-extracts
  // the expected binary from the retained, hash-anchored archive on every check.
  fs.writeFileSync(ready.executable, 'forged binary, nothing left in the pointer agrees with it');
  assert.deepEqual(await manager.status(), { state: 'corrupt', reason: 'managed-binary-changed' });
});

test('the retained archive is itself re-checked against the hardcoded release digest, not just re-used', async (t) => {
  const root = world(t);
  const manager = new ManagedGh({ root, release: release(), download: async () => archive, newId: () => 'tamper-archive' });
  const ready = await manager.prepare();
  assert.equal(ready.state, 'ready');
  if (ready.state !== 'ready') return;
  const archivePath = path.join(path.dirname(ready.binDir), 'archive.zip');
  // Replacing a read-only file: deletion only needs write access to the containing directory, not to
  // the file itself, so this is how an attacker with filesystem access would actually do it.
  fs.rmSync(archivePath);
  fs.writeFileSync(archivePath, zipSync({ [entry]: new TextEncoder().encode('a different, still well-formed archive') }));
  assert.deepEqual(await manager.status(), { state: 'corrupt', reason: 'managed-archive-changed' });
  fs.rmSync(archivePath);
  fs.symlinkSync(path.join(root, 'elsewhere'), archivePath);
  assert.deepEqual(await manager.status(), { state: 'corrupt', reason: 'managed-path-replaced' });
});

test('"installs" being replaced by a symlink is refused on every status() check, not only while prepare() first creates it', async (t) => {
  const root = world(t);
  const manager = new ManagedGh({ root, release: release(), download: async () => archive, newId: () => 'first' });
  const ready = await manager.prepare();
  assert.equal(ready.state, 'ready');
  if (ready.state !== 'ready') return;
  const installsDir = path.join(root, 'installs');
  const outside = world(t);
  fs.rmSync(installsDir, { recursive: true, force: true });
  fs.symlinkSync(outside, installsDir, process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(await manager.status(), { state: 'corrupt', reason: 'managed-path-replaced' });
  // A later prepare() for a different install must not silently write through the symlink either.
  const second = new ManagedGh({ root, release: release(), download: async () => archive, newId: () => 'second' });
  const result = await second.prepare();
  assert.deepEqual(result, { state: 'missing', reason: 'managed-folder-replaced' });
  assert.equal(fs.existsSync(path.join(outside, `gh-2-102-0-darwin-arm64-second`)), false, 'nothing was written through the symlinked installs directory');
});

test('a symlinked parent below the storage boundary is refused before anything is created outside', async (t) => {
  const boundary = world(t);
  const outside = world(t);
  const managedParent = path.join(boundary, 'managed-tools');
  fs.symlinkSync(outside, managedParent, process.platform === 'win32' ? 'junction' : 'dir');
  const manager = new ManagedGh({
    boundary,
    root: path.join(managedParent, 'gh'),
    release: release(),
    download: async () => archive,
    newId: () => 'escape'
  });
  assert.deepEqual(await manager.prepare(), { state: 'corrupt', reason: 'managed-folder-replaced' });
  assert.equal(fs.existsSync(path.join(outside, 'gh')), false, 'the rejected parent is never followed by mkdir');
});

test('unsupported platforms and invalid sources download nothing, and PATH is prepended without losing the user value', async (t) => {
  const root = world(t);
  let downloaded = false;
  for (const bad of [null, release({ platform: 'linux' }), release({ url: 'https://example.test/gh.zip' }), release({ entry: '../gh' })]) {
    const manager = new ManagedGh({ root, release: bad, download: async () => { downloaded = true; return archive; } });
    assert.deepEqual(await manager.prepare(), { state: 'unsupported', reason: 'platform-or-source-unverified' });
  }
  assert.equal(downloaded, false);
  const managedPosix = path.posix.join(path.posix.sep, 'managed', 'bin');
  const userPosix = path.posix.join(path.posix.sep, 'user', 'bin');
  assert.deepEqual(prependPath(managedPosix, { PATH: userPosix }, 'darwin'), { PATH: `${managedPosix}${path.delimiter}${userPosix}` });
  const drive = ['C', ':', path.win32.sep].join('');
  const managedWindows = path.win32.join(drive, 'managed');
  const userWindows = path.win32.join(drive, 'user');
  assert.deepEqual(prependPath(managedWindows, { Path: userWindows }, 'win32'), { Path: `${managedWindows}${path.delimiter}${userWindows}` });
});
