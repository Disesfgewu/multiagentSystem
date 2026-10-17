import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, TestContext } from 'node:test';
import { gzipSync } from 'fflate';
import { CodexRelease, ManagedCodex } from '../../src/setup/managedCodex';

const { CODEX_ASSETS, codexRelease } = require('../../src/setup/tool-manifest') as {
  CODEX_ASSETS: Record<string, Omit<CodexRelease, 'tool' | 'version' | 'platform' | 'arch'>>;
  codexRelease(platform?: string, arch?: string): CodexRelease | null;
};

const sha = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
const binary = new TextEncoder().encode('synthetic codex binary, never executed');

function tar(name: string, value: Uint8Array): Uint8Array {
  const header = new Uint8Array(512);
  header.set(new TextEncoder().encode(name), 0);
  header.set(new TextEncoder().encode('0000755\0'), 100);
  header.set(new TextEncoder().encode('0000000\0'), 108);
  header.set(new TextEncoder().encode('0000000\0'), 116);
  header.set(new TextEncoder().encode(`${value.byteLength.toString(8).padStart(11, '0')}\0`), 124);
  header.set(new TextEncoder().encode('00000000000\0'), 136);
  header.fill(32, 148, 156);
  header[156] = 48;
  header.set(new TextEncoder().encode('ustar\0'), 257);
  const checksum = header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0');
  header.set(new TextEncoder().encode(`${checksum}\0 `), 148);
  const padded = Math.ceil(value.byteLength / 512) * 512;
  const output = new Uint8Array(512 + padded + 1024);
  output.set(header); output.set(value, 512);
  return output;
}

const entry = 'codex-aarch64-apple-darwin';
const archive = gzipSync(tar(entry, binary));
const release = (over: Partial<CodexRelease> = {}): CodexRelease => ({
  tool: 'codex', version: '0.163.0', platform: 'darwin', arch: 'arm64',
  url: 'https://github.com/openai/codex/releases/download/rust-v0.163.0/codex-aarch64-apple-darwin.tar.gz',
  sha256: sha(archive), format: 'tar.gz', entry, executable: 'codex', ...over
});
const world = (t: TestContext): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-codex-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};

test('the production manifest pins all four official Codex assets and no unsupported target', () => {
  const expected = {
    'darwin-x64': ['562a1aea0e5686283a467687d268ae33705f02fd4d40f1bc4110a415c5c1c7b1', 'tar.gz', 'codex-x86_64-apple-darwin'],
    'darwin-arm64': ['61c4d9a92521bdb42b0c1d9f87c673f6da628a06de5945cbdd9a0010632f6d10', 'tar.gz', 'codex-aarch64-apple-darwin'],
    'win32-x64': ['2692c8c7bb2cf8b0aefe638741fc90236f4b824c59578ce84994f9de58200993', 'raw', null],
    'win32-arm64': ['babd1ee5a76e4299d18f7ef99aa39d330e176e837566d3e2325d9b6b64e1ca61', 'raw', null]
  } as const;
  assert.deepEqual(Object.keys(CODEX_ASSETS).sort(), Object.keys(expected).sort());
  for (const [target, values] of Object.entries(expected)) {
    const [platform, arch] = target.split('-');
    const found = codexRelease(platform, arch);
    assert.ok(found);
    assert.deepEqual([found.version, found.sha256, found.format, found.entry], ['0.163.0', ...values]);
    assert.match(found.url, /^https:\/\/github\.com\/openai\/codex\/releases\/download\/rust-v0\.163\.0\//);
  }
  assert.equal(codexRelease('linux', 'x64'), null);
});

test('the pinned macOS tar.gz installs only its exact Codex executable and reuses verified state', async (t) => {
  const root = world(t); let downloads = 0;
  const manager = new ManagedCodex({ root, release: release(), download: async () => { downloads += 1; return archive; }, newId: () => 'mac', now: () => new Date('2026-10-17T00:00:00Z') });
  assert.deepEqual(await manager.status(), { state: 'missing', reason: 'not-prepared' });
  const ready = await manager.prepare();
  assert.equal(ready.state, 'ready');
  if (ready.state !== 'ready') return;
  assert.equal(fs.readFileSync(ready.executable, 'utf8'), 'synthetic codex binary, never executed');
  assert.equal(downloads, 1);
  assert.equal((await manager.prepare()).state, 'ready');
  assert.equal(downloads, 1);
  assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(path.join(root, 'current.json'), 'utf8'))).includes(root), false);
});

test('the pinned Windows executable is accepted as a raw asset without archive guessing', async (t) => {
  const raw = new TextEncoder().encode('synthetic PE fixture');
  const windows = release({
    platform: 'win32', arch: 'x64', format: 'raw', entry: null, executable: 'codex.exe', sha256: sha(raw),
    url: 'https://github.com/openai/codex/releases/download/rust-v0.163.0/codex-x86_64-pc-windows-msvc.exe'
  });
  const manager = new ManagedCodex({ root: world(t), release: windows, download: async () => raw, newId: () => 'windows' });
  const ready = await manager.prepare();
  assert.equal(ready.state, 'ready');
  if (ready.state === 'ready') assert.equal(path.basename(ready.executable), 'codex.exe');
});

test('digest mismatch, unavailable network and a missing tar entry fail closed, then retry succeeds', async (t) => {
  const root = world(t); let mode: 'offline' | 'wrong' | 'missing' | 'good' = 'offline';
  const manager = new ManagedCodex({ root, release: release(), download: async () => {
    if (mode === 'offline') throw new Error('synthetic network detail');
    if (mode === 'wrong') return new Uint8Array([1, 2, 3]);
    return mode === 'missing' ? gzipSync(tar('some-other-file', binary)) : archive;
  }, newId: () => mode });
  assert.deepEqual(await manager.prepare(), { state: 'missing', reason: 'download-or-install-failed' });
  mode = 'wrong';
  assert.deepEqual(await manager.prepare(), { state: 'missing', reason: 'archive-integrity-failed' });
  mode = 'missing';
  const missing = gzipSync(tar('some-other-file', binary));
  const malformed = new ManagedCodex({ root, release: release({ sha256: sha(missing) }), download: async () => missing, newId: () => 'missing' });
  assert.deepEqual(await malformed.prepare(), { state: 'missing', reason: 'archive-invalid' });
  assert.equal(fs.existsSync(path.join(root, 'current.json')), false);
  mode = 'good';
  assert.equal((await manager.prepare()).state, 'ready');
});

test('changing the retained asset or installed binary invalidates ready state', async (t) => {
  const root = world(t);
  const manager = new ManagedCodex({ root, release: release(), download: async () => archive, newId: () => 'tamper' });
  const ready = await manager.prepare();
  assert.equal(ready.state, 'ready');
  if (ready.state !== 'ready') return;
  fs.writeFileSync(ready.executable, 'changed');
  assert.deepEqual(await manager.status(), { state: 'corrupt', reason: 'managed-binary-changed' });
  fs.writeFileSync(ready.executable, binary);
  const asset = path.join(path.dirname(ready.binDir), 'asset.bin');
  fs.rmSync(asset);
  fs.writeFileSync(asset, 'changed asset');
  assert.deepEqual(await manager.status(), { state: 'corrupt', reason: 'managed-archive-changed' });
});

test('a tampered install record cannot use a loose JavaScript date as verification evidence', async (t) => {
  const root = world(t);
  const manager = new ManagedCodex({ root, release: release(), download: async () => archive, newId: () => 'record' });
  assert.equal((await manager.prepare()).state, 'ready');
  const pointerPath = path.join(root, 'current.json');
  const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
  pointer.verifiedAt = '0';
  fs.writeFileSync(pointerPath, JSON.stringify(pointer));
  assert.deepEqual(await manager.status(), { state: 'corrupt', reason: 'invalid-install-record' });
});

test('a replaced installs directory cannot redirect a later Codex install', async (t) => {
  const root = world(t); const outside = world(t);
  const first = new ManagedCodex({ root, release: release(), download: async () => archive, newId: () => 'first' });
  assert.equal((await first.prepare()).state, 'ready');
  const installs = path.join(root, 'installs');
  fs.rmSync(installs, { recursive: true, force: true });
  fs.symlinkSync(outside, installs, process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(await first.status(), { state: 'corrupt', reason: 'managed-path-replaced' });
  const second = new ManagedCodex({ root, release: release(), download: async () => archive, newId: () => 'second' });
  assert.deepEqual(await second.prepare(), { state: 'missing', reason: 'managed-folder-replaced' });
  assert.equal(fs.readdirSync(outside).length, 0);
});

test('unsupported platforms, mismatched format and non-OpenAI sources never download', async (t) => {
  let downloaded = false;
  const bad: Array<CodexRelease | null> = [
    null,
    release({ platform: 'linux' }),
    release({ url: 'https://example.test/codex.tar.gz' }),
    release({ url: 'https://github.com/openai/codex/releases/download/rust-v0.163.0/codex-x86_64-apple-darwin.tar.gz' }),
    release({ platform: 'darwin', format: 'raw', entry: null, executable: 'codex.exe' })
  ];
  for (const item of bad) {
    const manager = new ManagedCodex({ root: world(t), release: item, download: async () => { downloaded = true; return archive; } });
    assert.deepEqual(await manager.prepare(), { state: 'unsupported', reason: 'platform-or-source-unverified' });
  }
  assert.equal(downloaded, false);
});
