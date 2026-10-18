import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, TestContext } from 'node:test';
import { ClaudeRelease, ManagedClaude } from '../../src/setup/managedClaude';

const { CLAUDE_ASSETS, claudeRelease } = require('../../src/setup/tool-manifest') as {
  CLAUDE_ASSETS: Record<string, Omit<ClaudeRelease, 'tool' | 'version' | 'platform' | 'arch'>>;
  claudeRelease(platform?: string, arch?: string): ClaudeRelease | null;
};

const sha = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
const binary = new TextEncoder().encode('synthetic claude binary, never executed');

const release = (over: Partial<ClaudeRelease> = {}): ClaudeRelease => ({
  tool: 'claude', version: '2.1.89', platform: 'darwin', arch: 'arm64',
  url: 'https://downloads.claude.ai/claude-code-releases/2.1.89/darwin-arm64/claude',
  sha256: sha(binary), format: 'raw', entry: null, executable: 'claude', ...over
});

const world = (t: TestContext): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-claude-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};

test('the production manifest pins all four official Claude Code assets and no unsupported target', () => {
  const expected = {
    'darwin-x64': ['1322c5eecec8047e9cd7114f7d547ef6a9596563d6bbc7e594167d0f8bc8b406', 'raw', null, 'claude'],
    'darwin-arm64': ['f903a5e53f845b1ac5566296b713193827665f28da16300fdca7539cb0669a7f', 'raw', null, 'claude'],
    'win32-x64': ['2e312000b538f11d13f1dfc52d4131996895b9a07bd8897d8f9153635d4ea092', 'raw', null, 'claude.exe'],
    'win32-arm64': ['5f1d597c542aac3a11f557e12c92d0c49220ab77e741014b0599a572d81ca679', 'raw', null, 'claude.exe']
  } as const;
  assert.deepEqual(Object.keys(CLAUDE_ASSETS).sort(), Object.keys(expected).sort());
  for (const [target, values] of Object.entries(expected)) {
    const [platform, arch] = target.split('-');
    const found = claudeRelease(platform, arch);
    assert.ok(found);
    assert.deepEqual([found.version, found.sha256, found.format, found.entry, found.executable], ['2.1.89', ...values]);
    assert.match(found.url, /^https:\/\/downloads\.claude\.ai\/claude-code-releases\/2\.1\.89\//);
  }
  assert.equal(claudeRelease('linux', 'x64'), null);
});

test('the pinned macOS binary installs only its exact Claude executable and reuses verified state', async (t) => {
  const root = world(t); let downloads = 0;
  const manager = new ManagedClaude({ root, release: release(), download: async () => { downloads += 1; return binary; }, newId: () => 'mac', now: () => new Date('2026-10-18T00:00:00Z') });
  assert.deepEqual(await manager.status(), { state: 'missing', reason: 'not-prepared' });
  const ready = await manager.prepare();
  assert.equal(ready.state, 'ready');
  if (ready.state !== 'ready') return;
  assert.equal(fs.readFileSync(ready.executable, 'utf8'), 'synthetic claude binary, never executed');
  assert.equal(downloads, 1);
  assert.equal((await manager.prepare()).state, 'ready');
  assert.equal(downloads, 1);
  assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(path.join(root, 'current.json'), 'utf8'))).includes(root), false);
});

test('the pinned Windows executable is accepted as a raw binary asset', async (t) => {
  const raw = new TextEncoder().encode('synthetic claude PE fixture');
  const windows = release({
    platform: 'win32', arch: 'x64', format: 'raw', entry: null, executable: 'claude.exe', sha256: sha(raw),
    url: 'https://downloads.claude.ai/claude-code-releases/2.1.89/win32-x64/claude.exe'
  });
  const manager = new ManagedClaude({ root: world(t), release: windows, download: async () => raw, newId: () => 'windows' });
  const ready = await manager.prepare();
  assert.equal(ready.state, 'ready');
  if (ready.state === 'ready') assert.equal(path.basename(ready.executable), 'claude.exe');
});

test('digest mismatch and unavailable network fail closed, then retry succeeds', async (t) => {
  const root = world(t); let mode: 'offline' | 'wrong' | 'good' = 'offline';
  const manager = new ManagedClaude({ root, release: release(), download: async () => {
    if (mode === 'offline') throw new Error('synthetic network detail');
    if (mode === 'wrong') return new Uint8Array([1, 2, 3]);
    return binary;
  }, newId: () => mode });
  assert.deepEqual(await manager.prepare(), { state: 'missing', reason: 'download-or-install-failed' });
  mode = 'wrong';
  assert.deepEqual(await manager.prepare(), { state: 'missing', reason: 'archive-integrity-failed' });
  assert.equal(fs.existsSync(path.join(root, 'current.json')), false);
  mode = 'good';
  assert.equal((await manager.prepare()).state, 'ready');
});

test('changing the retained asset or installed binary invalidates ready state', async (t) => {
  const root = world(t);
  const manager = new ManagedClaude({ root, release: release(), download: async () => binary, newId: () => 'tamper' });
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
  const manager = new ManagedClaude({ root, release: release(), download: async () => binary, newId: () => 'record' });
  assert.equal((await manager.prepare()).state, 'ready');
  const pointerPath = path.join(root, 'current.json');
  const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
  pointer.verifiedAt = '0';
  fs.writeFileSync(pointerPath, JSON.stringify(pointer));
  assert.deepEqual(await manager.status(), { state: 'corrupt', reason: 'invalid-install-record' });
});

test('a replaced installs directory cannot redirect a later Claude install', async (t) => {
  const root = world(t); const outside = world(t);
  const first = new ManagedClaude({ root, release: release(), download: async () => binary, newId: () => 'first' });
  assert.equal((await first.prepare()).state, 'ready');
  const installs = path.join(root, 'installs');
  fs.rmSync(installs, { recursive: true, force: true });
  fs.symlinkSync(outside, installs, process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(await first.status(), { state: 'corrupt', reason: 'managed-path-replaced' });
  const second = new ManagedClaude({ root, release: release(), download: async () => binary, newId: () => 'second' });
  assert.deepEqual(await second.prepare(), { state: 'missing', reason: 'managed-folder-replaced' });
  assert.equal(fs.readdirSync(outside).length, 0);
});

test('unsupported platforms, mismatched format and non-Anthropic sources never download', async (t) => {
  let downloaded = false;
  const bad: Array<ClaudeRelease | null> = [
    null,
    release({ platform: 'linux' }),
    release({ url: 'https://example.test/claude' }),
    release({ url: 'https://downloads.claude.ai/claude-code-releases/2.1.89/darwin-x64/claude' }), // mismatched platform with arm64
    release({ platform: 'darwin', format: 'invalid' as any })
  ];
  for (const item of bad) {
    const manager = new ManagedClaude({ root: world(t), release: item, download: async () => { downloaded = true; return binary; } });
    assert.deepEqual(await manager.prepare(), { state: 'unsupported', reason: 'platform-or-source-unverified' });
  }
  assert.equal(downloaded, false);
});

test('prepare() rejects an oversized download on its own, independent of the injected downloader\'s limit', async (t) => {
  // The real downloader aborts mid-stream past maxBytes, but prepare() is also reachable with any
  // downloader a caller supplies, so its own size check must not rely on that. No matching digest is
  // needed: the size is checked before the hash is compared, and nothing may be installed.
  const root = world(t);
  const limit = 384 * 1024 * 1024;
  let askedFor = 0;
  const oversized = new Uint8Array(limit + 1);
  const manager = new ManagedClaude({ root, release: release(), download: async (_url, maxBytes) => { askedFor = maxBytes; return oversized; }, newId: () => 'oversized' });
  assert.deepEqual(await manager.prepare(), { state: 'missing', reason: 'download-or-install-failed' });
  assert.equal(askedFor, limit, 'the downloader is told the same cap that prepare() enforces');
  assert.equal(fs.existsSync(path.join(root, 'current.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'installs')), false, 'nothing was installed from the oversized download');
});

test('a repair after the retained archive was damaged removes the broken install once it is old enough, and keeps a working one', async (t) => {
  const root = world(t); let n = 0;
  const manager = new ManagedClaude({ root, release: release(), download: async () => binary, newId: () => `try${n++}` });
  const first = await manager.prepare();
  assert.equal(first.state, 'ready');
  if (first.state !== 'ready') return;
  const installs = path.join(root, 'installs');
  const [firstId] = fs.readdirSync(installs);
  fs.chmodSync(path.join(installs, firstId, 'asset.bin'), 0o600); // it is retained read-only; simulate someone altering it
  fs.writeFileSync(path.join(installs, firstId, 'asset.bin'), 'damaged after verification');
  const old = new Date(Date.now() - 24 * 60 * 60_000);
  fs.utimesSync(path.join(installs, firstId), old, old);
  assert.equal((await manager.status()).state, 'corrupt');
  const repaired = await manager.prepare();
  assert.equal(repaired.state, 'ready');
  assert.deepEqual(fs.readdirSync(installs).filter((name) => name === firstId), [], 'the broken install is gone');
  assert.equal(fs.readdirSync(installs).length, 1);
  assert.equal((await manager.status()).state, 'ready');
});

test('two managers preparing at once on the same root never delete each other\'s valid install, and the final pointer is readable', async (t) => {
  const root = world(t); let n = 0;
  const make = () => new ManagedClaude({ root, release: release(), download: async () => binary, newId: () => `concurrent${n++}` });
  const [a, b] = [make(), make()];
  const results = await Promise.all([a.prepare(), b.prepare()]);
  for (const result of results) assert.equal(result.state, 'ready', JSON.stringify(result));
  assert.equal((await a.status()).state, 'ready');
  assert.equal((await b.status()).state, 'ready');
  const ids = fs.readdirSync(path.join(root, 'installs'));
  assert.ok(ids.length >= 1);
  const pointer = JSON.parse(fs.readFileSync(path.join(root, 'current.json'), 'utf8'));
  assert.ok(ids.includes(pointer.installId), 'the pointer names an install that still exists');
  for (const result of results) if (result.state === 'ready') assert.equal(fs.existsSync(result.executable), true, 'each prepare\'s executable is still there');
});
