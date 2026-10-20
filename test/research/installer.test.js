'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');

const {
  CANDIDATE_RESEARCH_TOOLS,
  validateCatalogItem
} = require('../../src/research/catalog');

const {
  RESEARCH_TOOL_PERMISSIONS,
  PROHIBITED_AGENT_TOOLS,
  formatConsentManifest,
  getConsentRecord,
  isConsentActive,
  consentFingerprint,
  grantConsent,
  revokeConsent,
  listResearchTools,
  resolveLaunchExecutable,
  primeHashCacheForTests,
  prepareResearchTool
} = require('../../src/research/installer');

class FakeStore {
  constructor() {
    this.data = new Map();
  }
  get(collection, key) {
    const col = this.data.get(collection);
    if (!col || !col.has(key)) return { ok: false, reason: 'not-found' };
    return { ok: true, value: col.get(key) };
  }
  put(collection, key, value) {
    if (!this.data.has(collection)) this.data.set(collection, new Map());
    this.data.get(collection).set(key, JSON.parse(JSON.stringify(value)));
    return { ok: true };
  }
  delete(collection, key) {
    const col = this.data.get(collection);
    if (col) col.delete(key);
    return { ok: true };
  }
}

test('all candidate research tools validate cleanly against security catalog rules', () => {
  assert.equal(CANDIDATE_RESEARCH_TOOLS.length, 3);
  for (const tool of CANDIDATE_RESEARCH_TOOLS) {
    const validated = validateCatalogItem(tool);
    assert.equal(validated.serverId, tool.serverId);
    assert.equal(validated.status, 'unverified');
    assert.equal(validated.sandboxEnforced, false);
    assert.match(validated.integrity, /^sha256:[a-f0-9]{64}$/i);
    assert.ok(Array.isArray(validated.command));
    assert.ok(validated.command.length > 0);
  }
});

test('formatConsentManifest includes pinned repository, commit/version, SHA-256 hash, license, command, and permissions', () => {
  const arxiv = CANDIDATE_RESEARCH_TOOLS.find((t) => t.serverId === 'arxiv-mcp-server');
  assert.ok(arxiv);
  const text = formatConsentManifest(arxiv);

  assert.match(text, /# Research MCP Tool Security Manifest: arXiv Research MCP Server/);
  assert.match(text, /Repository.*https:\/\/github\.com\/blazickjp\/arxiv-mcp-server\.git/);
  assert.match(text, /Version.*v0\.8\.2/);
  assert.match(text, /Integrity Digest.*sha256:17f2eda9e3a8c38fe12b9055ac07459fe031af346f465b3d3025ff551010608d/);
  assert.match(text, /License.*Apache-2\.0/);
  assert.match(text, /Command.*arxiv-mcp-server/);
  assert.match(text, /Required Permissions/);
  assert.match(text, /network/);
  assert.match(text, /Prohibited Tools/);
  assert.match(text, /download_paper/);
  assert.match(text, /sandboxEnforced: false/);
  assert.match(text, /untrusted-data/);
  assert.equal(/[\u200B-\u200D\uFEFF]/.test(text), false, 'no zero-width or hidden characters in manifest');
});

test('grantConsent records explicit user consent with timestamp in private store and validates catalog membership', () => {
  const store = new FakeStore();
  const now = () => new Date('2026-10-17T12:00:00Z');

  // Unknown tool fails fast
  assert.throws(
    () => grantConsent('malicious-mcp', { store }),
    (err) => err.code === 'tool-not-in-catalog'
  );

  const result = grantConsent('zhtw-mcp', { store, now });
  assert.equal(result.ok, true);
  assert.equal(result.record.serverId, 'zhtw-mcp');
  assert.equal(result.record.status, 'consented');
  assert.equal(result.record.consentedAt, '2026-10-17T12:00:00.000Z');

  assert.equal(isConsentActive('zhtw-mcp', store), true);
  assert.equal(isConsentActive('arxiv-mcp-server', store), false);

  const found = getConsentRecord('zhtw-mcp', store);
  assert.equal(found.serverId, 'zhtw-mcp');
  assert.equal(found.source, 'https://github.com/sysprog21/zhtw-mcp.git');
});

test('revokeConsent updates record status to revoked and cleans up installed directory', () => {
  const store = new FakeStore();
  grantConsent('github-mcp-server', { store });
  assert.equal(isConsentActive('github-mcp-server', store), true);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-mcp-test-'));
  const fakeInstallDir = path.join(tmpRoot, 'github-mcp-server');
  fs.mkdirSync(fakeInstallDir, { recursive: true });
  fs.writeFileSync(path.join(fakeInstallDir, 'github-mcp-server'), 'mock');

  assert.equal(fs.existsSync(fakeInstallDir), true);

  const revoked = revokeConsent('github-mcp-server', { store, root: tmpRoot });
  assert.equal(revoked.ok, true);
  assert.equal(isConsentActive('github-mcp-server', store), false);
  assert.equal(fs.existsSync(fakeInstallDir), false, 'installed folder must be removed upon consent revocation');

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('prepareResearchTool strictly requires consent (throws consent-required if unconsented)', async () => {
  const store = new FakeStore();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-mcp-test-'));

  try {
    await assert.rejects(
      prepareResearchTool('zhtw-mcp', { store, root: tmpRoot }),
      (err) => err.code === 'consent-required'
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('prepareResearchTool fails closed on hash mismatch: cleans up staging folder without leaving partial artifacts', async () => {
  const store = new FakeStore();
  grantConsent('zhtw-mcp', { store });

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-mcp-test-'));
  const corruptedBytes = Buffer.from('corrupted executable payload');

  try {
    await assert.rejects(
      prepareResearchTool('zhtw-mcp', { store, root: tmpRoot, assetBytes: corruptedBytes }),
      (err) => err.code === 'hash-mismatch'
    );

    // Verify staging directory was cleaned up and final directory does not exist
    const finalDir = path.join(tmpRoot, 'zhtw-mcp');
    assert.equal(fs.existsSync(finalDir), false, 'final directory must not exist when verification fails');
    const stagingDir = path.join(tmpRoot, '.staging');
    if (fs.existsSync(stagingDir)) {
      assert.equal(fs.readdirSync(stagingDir).length, 0, 'staging directory must be empty after failure');
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('prepareResearchTool without a verified asset writes nothing, not even a placeholder (Refs #192)', async () => {
  const store = new FakeStore();
  grantConsent('zhtw-mcp', { store });
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-mcp-test-'));
  const root = path.join(parent, 'research');
  try {
    for (const deps of [{}, { download: async () => undefined }, { download: async () => new Uint8Array(0) }, { assetBytes: 'not bytes' }]) {
      await assert.rejects(
        prepareResearchTool('zhtw-mcp', { store, root, ...deps }),
        (err) => err.code === 'asset-unavailable'
      );
    }
    assert.equal(fs.existsSync(root), false, 'the tool folder is not even created');
    await assert.rejects(prepareResearchTool('zhtw-mcp', { store, root, assetBytes: Buffer.from('wrong') }), (err) => err.code === 'hash-mismatch');
    assert.equal(fs.existsSync(root), false, 'a mismatching asset writes nothing either');
    assert.equal(listResearchTools({ store, root }).find((t) => t.serverId === 'zhtw-mcp').installStatus, 'not-installed');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('prepareResearchTool installs atomically when hash matches', async () => {
  const store = new FakeStore();

  const tool = CANDIDATE_RESEARCH_TOOLS.find((t) => t.serverId === 'zhtw-mcp');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-mcp-test-'));

  // A synthetic asset and a copy of the catalog entry pinned to its digest: the real asset is not
  // downloaded in tests, and no placeholder is ever written in its place.
  const bytes = Buffer.from('#!/bin/sh\necho synthetic zhtw asset\n');
  const catalog = [validateCatalogItem({ ...tool, integrity: `sha256:${createHash('sha256').update(bytes).digest('hex')}` })];
  grantConsent('zhtw-mcp', { store, catalog });
  try {
    const outcome = await prepareResearchTool('zhtw-mcp', { store, root: tmpRoot, catalog, assetBytes: bytes });
    assert.equal(outcome.state, 'ready');
    assert.equal(outcome.serverId, 'zhtw-mcp');
    assert.equal(fs.existsSync(outcome.executable), true);
    assert.deepEqual(fs.readFileSync(outcome.executable), bytes, 'the verified bytes, not a placeholder');

    const listed = listResearchTools({ store, root: tmpRoot, catalog });
    const zhtw = listed.find((t) => t.serverId === 'zhtw-mcp');
    assert.equal(zhtw.consentStatus, 'consented');
    assert.equal(zhtw.installStatus, 'ready');
    assert.match(zhtw.statusLabel, /Consented/);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('revoking cannot delete outside the install root: a tool id is a plain name, and nothing is written for a bad one', () => {
  const store = new FakeStore();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-mcp-revoke-'));
  const root = path.join(base, 'root');
  const victim = path.join(base, 'victim');
  fs.mkdirSync(path.join(root, 'zhtw-mcp'), { recursive: true });
  fs.mkdirSync(victim);
  fs.writeFileSync(path.join(victim, 'precious'), 'keep');
  try {
    for (const bad of ['../victim', '../../victim', 'a/../../victim', '/etc', '..', '.', '', 'UPPER', 'a/b', 'x\\y', 'a\0b', undefined, null, 7]) {
      assert.throws(() => revokeConsent(bad, { store, root }), (error) => error.code === 'invalid-server-id', String(bad));
    }
    assert.equal(fs.readFileSync(path.join(victim, 'precious'), 'utf8'), 'keep');
    assert.equal(fs.existsSync(path.join(root, 'zhtw-mcp')), true);
    assert.equal(store.data.get('researchConsents')?.size ?? 0, 0, 'no consent record is written under a bad id');
    grantConsent('zhtw-mcp', { store });
    assert.equal(revokeConsent('zhtw-mcp', { store, root }).ok, true);
    assert.equal(fs.existsSync(path.join(root, 'zhtw-mcp')), false, 'a real tool id still cleans its own folder');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('consent belongs to the exact tool entry: a changed version, source, hash, command or permissions asks again', async () => {
  const store = new FakeStore();
  const tool = CANDIDATE_RESEARCH_TOOLS.find((t) => t.serverId === 'zhtw-mcp');
  grantConsent('zhtw-mcp', { store });
  assert.equal(isConsentActive('zhtw-mcp', store), true);
  const changes = {
    version: 'v9.9.9',
    source: 'https://example.invalid/other.git',
    integrity: `sha256:${'0'.repeat(64)}`,
    command: ['other-binary']
  };
  for (const [field, value] of Object.entries(changes)) {
    let catalog;
    try { catalog = [validateCatalogItem({ ...tool, [field]: value })]; } catch { continue; }
    assert.equal(isConsentActive('zhtw-mcp', store, catalog), false, `${field} changed`);
    const listed = listResearchTools({ store, catalog })[0];
    assert.equal(listed.consentStatus, 'outdated', field);
    assert.match(listed.statusLabel, /Consent outdated/);
    await assert.rejects(prepareResearchTool('zhtw-mcp', { store, root: os.tmpdir(), catalog, assetBytes: Buffer.from('x') }), (error) => error.code === 'consent-required', field);
  }
  assert.equal(isConsentActive('zhtw-mcp', store, []), false, 'a tool no longer in the catalog has no active consent');
  store.put('researchConsents', 'zhtw-mcp', { serverId: 'zhtw-mcp', status: 'consented' });
  assert.equal(isConsentActive('zhtw-mcp', store), false, 'a record without a fingerprint (older format) is not trusted');
});

test('"ready" needs the manifest written at prepare time, matching the current entry; a bare folder or an older entry is only stale', async () => {
  const store = new FakeStore();
  const tool = CANDIDATE_RESEARCH_TOOLS.find((t) => t.serverId === 'zhtw-mcp');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-mcp-ready-'));
  const bytes = Buffer.from('#!/bin/sh\necho synthetic\n');
  const catalog = [validateCatalogItem({ ...tool, integrity: `sha256:${createHash('sha256').update(bytes).digest('hex')}` })];
  try {
    grantConsent('zhtw-mcp', { store, catalog });
    fs.mkdirSync(path.join(root, 'zhtw-mcp'));
    fs.writeFileSync(path.join(root, 'zhtw-mcp', 'zhtw-mcp'), 'planted');
    let entry = listResearchTools({ store, root, catalog })[0];
    assert.equal(entry.installStatus, 'stale', 'a folder that merely exists is not ready');
    assert.equal(entry.installPath, null);
    assert.match(entry.statusLabel, /do not match the current tool entry/);
    fs.rmSync(path.join(root, 'zhtw-mcp'), { recursive: true });

    await prepareResearchTool('zhtw-mcp', { store, root, catalog, assetBytes: bytes });
    entry = listResearchTools({ store, root, catalog })[0];
    assert.equal(entry.installStatus, 'ready');
    assert.match(entry.statusLabel, /the program hash matches what was verified when installed; not running/);
    assert.doesNotMatch(entry.statusLabel, /Ready/);

    const newer = [validateCatalogItem({ ...catalog[0], version: 'v9.9.9' })];
    assert.equal(listResearchTools({ store, root, catalog: newer })[0].installStatus, 'stale', 'prepared for an older entry');
    fs.rmSync(path.join(root, 'zhtw-mcp', 'zhtw-mcp'));
    assert.equal(listResearchTools({ store, root, catalog })[0].installStatus, 'stale', 'the executable is gone');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a failed swap during prepare restores the previous good install instead of losing it', async () => {
  const store = new FakeStore();
  const tool = CANDIDATE_RESEARCH_TOOLS.find((t) => t.serverId === 'zhtw-mcp');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-mcp-swap-'));
  const bytes = Buffer.from('#!/bin/sh\necho v1\n');
  const catalog = [validateCatalogItem({ ...tool, integrity: `sha256:${createHash('sha256').update(bytes).digest('hex')}` })];
  const realRename = fs.renameSync;
  try {
    grantConsent('zhtw-mcp', { store, catalog });
    await prepareResearchTool('zhtw-mcp', { store, root, catalog, assetBytes: bytes });
    const final = path.join(root, 'zhtw-mcp');
    fs.renameSync = (from, to) => {
      if (String(from).includes(`${path.sep}.staging${path.sep}`) && to === final) throw new Error('synthetic rename failure');
      return realRename(from, to);
    };
    await assert.rejects(prepareResearchTool('zhtw-mcp', { store, root, catalog, assetBytes: bytes }), /synthetic rename failure/);
    fs.renameSync = realRename;
    assert.equal(listResearchTools({ store, root, catalog })[0].installStatus, 'ready', 'the earlier verified install is still in place');
    assert.deepEqual(fs.readdirSync(root).filter((name) => name.includes('.old-')), [], 'no backup folder is left behind');
  } finally { fs.renameSync = realRename; fs.rmSync(root, { recursive: true, force: true }); }
});

test('revoke reports whether the installed files were really removed', () => {
  const store = new FakeStore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-mcp-cleanup-'));
  try {
    grantConsent('zhtw-mcp', { store });
    assert.equal(revokeConsent('zhtw-mcp', { store, root }).cleanup, 'none');
    grantConsent('zhtw-mcp', { store });
    fs.mkdirSync(path.join(root, 'zhtw-mcp'));
    assert.equal(revokeConsent('zhtw-mcp', { store, root }).cleanup, 'done');
    grantConsent('zhtw-mcp', { store });
    fs.mkdirSync(path.join(root, 'zhtw-mcp'));
    const realRm = fs.rmSync;
    fs.rmSync = () => { throw new Error('synthetic EBUSY'); };
    try { assert.equal(revokeConsent('zhtw-mcp', { store, root }).cleanup, 'failed'); } finally { fs.rmSync = realRm; }
    assert.equal(isConsentActive('zhtw-mcp', store), false, 'consent is revoked even when cleanup failed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('consent is outdated when the credentials a tool needs or the tools it exposes change, and stays valid when only the order changes', () => {
  const store = new FakeStore();
  const base = CANDIDATE_RESEARCH_TOOLS.find((t) => t.serverId === 'github-mcp-server');
  const withChange = (change) => [validateCatalogItem({ ...base, ...change })];
  grantConsent('github-mcp-server', { store });
  assert.equal(isConsentActive('github-mcp-server', store), true);

  const changes = {
    'a new secret credential key': { env: { ...base.env, NEW_PRIVATE_KEY: { secret: true } } },
    'a credential key removed': { env: {} },
    'a credential key renamed': { env: { OTHER_TOKEN_NAME: { secret: true } } },
    'a different tool list': { tools: [{ name: 'other_tool', readOnly: true, description: 'x' }] },
    'a tool added': { tools: [...base.tools, { name: 'list_issues', readOnly: true, description: 'Lists issues' }] },
    'a tool removed': { tools: base.tools.slice(1) },
    'a tool description changed': { tools: base.tools.map((tool, index) => (index === 0 ? { ...tool, description: 'Does something else now' } : tool)) },
    'the tool name text changed': { name: 'Renamed Research Server' },
    'the tool description text changed': { description: 'A different promise' },
    'the argument order changed': { command: [...base.command].reverse(), assets: [] },
    'a pinned asset hash changed': { assets: base.assets.map((asset, index) => (index === 0 ? { ...asset, sha256: '0'.repeat(64) } : asset)) },
    'a pinned asset removed': { assets: base.assets.slice(1) }
  };
  for (const [label, change] of Object.entries(changes)) {
    const catalog = withChange(change); // every case must be a valid catalog entry: an invalid one fails loudly
    assert.equal(isConsentActive('github-mcp-server', store, catalog), false, label);
  }

  // The same meaning in a different order is the same agreement.
  const reorderedTools = withChange({ tools: [...base.tools].reverse() });
  const reorderedEnv = withChange({ env: Object.fromEntries(Object.entries({ ...base.env, EXTRA_KEY: { secret: true } }).reverse()) });
  assert.equal(isConsentActive('github-mcp-server', store, reorderedTools), true, 'tools listed in another order');
  assert.equal(consentFingerprint(reorderedTools[0]), consentFingerprint(validateCatalogItem(base)));
  assert.notEqual(consentFingerprint(reorderedEnv[0]), consentFingerprint(validateCatalogItem(base)), 'an extra key is a change, order aside');
  const a = validateCatalogItem({ ...base, env: { A_KEY: { secret: true }, B_KEY: { secret: true } } });
  const b = validateCatalogItem({ ...base, env: { B_KEY: { secret: true }, A_KEY: { secret: true } } });
  assert.equal(consentFingerprint(a), consentFingerprint(b), 'env keys in another order');
  assert.equal(JSON.stringify(consentFingerprint(a)).includes('secret'), false);
});

test('a prepared program is only ready while its bytes still hash to what was verified: edited, replaced, truncated, swapped for a link, or an older install all read stale', async () => {
  const store = new FakeStore();
  const tool = CANDIDATE_RESEARCH_TOOLS.find((t) => t.serverId === 'zhtw-mcp');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-mcp-exe-'));
  const bytes = Buffer.from('#!/bin/sh\necho verified\n');
  const catalog = [validateCatalogItem({ ...tool, integrity: `sha256:${createHash('sha256').update(bytes).digest('hex')}` })];
  const state = () => listResearchTools({ store, root, catalog })[0];
  const exe = path.join(root, 'zhtw-mcp', 'zhtw-mcp');
  const manifestPath = path.join(root, 'zhtw-mcp', '.prepared.json');
  const reinstall = () => prepareResearchTool('zhtw-mcp', { store, root, catalog, assetBytes: bytes });
  try {
    grantConsent('zhtw-mcp', { store, catalog });
    await reinstall();
    const recorded = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(recorded.schema, 2);
    assert.equal(recorded.executableSha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(state().installStatus, 'ready');

    // One changed byte, same length.
    fs.writeFileSync(exe, Buffer.from('#!/bin/sh\necho verifieD\n'), { mode: 0o755 });
    assert.equal(state().installStatus, 'stale');
    assert.equal(state().installPath, null);
    // Truncated.
    fs.writeFileSync(exe, bytes.subarray(0, 5), { mode: 0o755 });
    assert.equal(state().installStatus, 'stale');
    // A reinstall puts the verified bytes back.
    await reinstall();
    assert.equal(state().installStatus, 'ready');

    // A link to a program with the same content is still not the installed file.
    const elsewhere = path.join(root, 'elsewhere');
    fs.writeFileSync(elsewhere, bytes, { mode: 0o755 });
    fs.rmSync(exe);
    try { fs.symlinkSync(elsewhere, exe); assert.equal(state().installStatus, 'stale'); } catch (error) { if (error.code !== 'EPERM') throw error; }
    await reinstall();

    // The record is not trusted on its own: a hash that is missing, malformed or for other bytes is not ready.
    for (const executableSha256 of [undefined, 'abc', 'X'.repeat(64), createHash('sha256').update('other').digest('hex'), 5]) {
      fs.writeFileSync(manifestPath, JSON.stringify({ ...recorded, executableSha256 }));
      assert.equal(state().installStatus, 'stale', String(executableSha256));
    }
    // A record in another schema is not read, even with a matching hash.
    fs.writeFileSync(manifestPath, JSON.stringify({ ...recorded, schema: 1 }));
    assert.equal(state().installStatus, 'stale');
    fs.writeFileSync(manifestPath, JSON.stringify({ ...recorded, schema: 3 }));
    assert.equal(state().installStatus, 'stale');
    // An install made before the program's hash was recorded (schema 1) must be prepared again.
    const { executableSha256: _dropped, ...older } = recorded;
    fs.writeFileSync(manifestPath, JSON.stringify({ ...older, schema: 1 }));
    assert.equal(state().installStatus, 'stale');
    await reinstall();
    assert.equal(state().installStatus, 'ready');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// A prepared folder as the installer writes it, with the program under the given recorded name (`.exe` on Windows).
function writePrepared(root, tool, name, bytes) {
  const dir = path.join(root, tool.serverId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), bytes, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, '.prepared.json'), JSON.stringify({
    schema: 2, serverId: tool.serverId, version: tool.version, integrity: tool.integrity, fingerprint: consentFingerprint(tool),
    executable: name, executableSha256: createHash('sha256').update(bytes).digest('hex'), verifiedAt: new Date().toISOString()
  }));
  return path.join(dir, name);
}

test('the program to run is the file name recorded at install, including .exe on Windows, never command[0] by itself', () => {
  const store = new FakeStore();
  const base = CANDIDATE_RESEARCH_TOOLS.find((t) => t.serverId === 'zhtw-mcp');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-mcp-exe-name-'));
  try {
    const tool = validateCatalogItem(base);
    for (const name of [tool.command[0], `${tool.command[0]}.exe`]) {
      fs.rmSync(path.join(root, tool.serverId), { recursive: true, force: true });
      const file = writePrepared(root, tool, name, Buffer.from(`program ${name}`));
      const entry = listResearchTools({ store, root, catalog: [tool] })[0];
      assert.equal(entry.installStatus, 'ready', name);
      assert.equal(entry.installExecutable, file, name);
      assert.equal(path.basename(entry.installExecutable), name);
    }
    // Not ready: no executable path is offered at all.
    fs.writeFileSync(path.join(root, tool.serverId, `${tool.command[0]}.exe`), 'changed program bytes');
    const stale = listResearchTools({ store, root, catalog: [tool], fullCheck: true })[0];
    assert.deepEqual([stale.installStatus, stale.installExecutable, stale.installPath], ['stale', null, null]);
    // Some other name in the record is refused.
    writePrepared(root, tool, 'other-name', Buffer.from('x'));
    assert.equal(listResearchTools({ store, root, catalog: [tool] })[0].installStatus, 'stale');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('showing a status may use a remembered hash while size, time and file are unchanged; a start (fullCheck) always reads the bytes', () => {
  const store = new FakeStore();
  const tool = validateCatalogItem(CANDIDATE_RESEARCH_TOOLS.find((t) => t.serverId === 'zhtw-mcp'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-mcp-hash-cache-'));
  try {
    const file = writePrepared(root, tool, tool.command[0], Buffer.from('AAAAAAAA'));
    const fixed = 1_700_000_000; // a whole second, so the modified time can be put back exactly
    const put = (text) => { fs.writeFileSync(file, Buffer.from(text)); fs.utimesSync(file, fixed, fixed); };
    const show = () => listResearchTools({ store, root, catalog: [tool] })[0].installStatus;
    const start = () => listResearchTools({ store, root, catalog: [tool], fullCheck: true })[0].installStatus;
    put('AAAAAAAA');
    assert.equal(show(), 'ready');
    // Same length and same modified time, different bytes: only what reads the bytes can see it.
    put('BBBBBBBB');
    assert.equal(start(), 'stale', 'a start reads the bytes');
    assert.equal(show(), 'stale', 'and what a start read is what is remembered next');
    // The quick check does notice a different length even when the modified time is put back.
    put('AAAAAAAA');
    assert.equal(start(), 'ready', 'a start re-reads and refreshes what is remembered');
    assert.equal(show(), 'ready');
    put('AAAA');
    assert.equal(show(), 'stale');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a start re-reads the program: with the status list\'s remembered hash filled in and the stat put back, a swapped program is still not started', () => {
  const store = new FakeStore();
  const tool = validateCatalogItem(CANDIDATE_RESEARCH_TOOLS.find((t) => t.serverId === 'zhtw-mcp'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-mcp-launch-'));
  try {
    const file = writePrepared(root, tool, tool.command[0], Buffer.from('AAAAAAAA'));
    const fixed = 1_700_000_000;
    fs.utimesSync(file, fixed, fixed);
    const status = () => listResearchTools({ store, root, catalog: [tool] })[0].installStatus;
    const launch = () => resolveLaunchExecutable({ store, root, serverId: tool.serverId, catalog: [tool] });
    assert.equal(status(), 'ready', 'the remembered hash is filled in');
    assert.equal(launch(), file);
    // The program is swapped, and the remembered hash is made to match the file's size, times and identity as they are now
    // (what a restored modified time would look like to the quick check). Only reading the bytes can tell.
    const original = createHash('sha256').update('AAAAAAAA').digest('hex');
    fs.writeFileSync(file, Buffer.from('BBBBBBBB'));
    primeHashCacheForTests(file, original);
    assert.equal(status(), 'ready', 'the quick status trusts what it remembers (that is what it is for)');
    assert.equal(launch(), null, 'a start does not use the remembered hash: the swapped program is not started');
    // Unknown tool, missing root and not-installed all give null, never a guess.
    assert.equal(resolveLaunchExecutable({ store, root, serverId: 'nope', catalog: [tool] }), null);
    assert.equal(resolveLaunchExecutable({ store, serverId: tool.serverId, catalog: [tool] }), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a recorded program name that is a path is refused', () => {
  const store = new FakeStore();
  const tool = validateCatalogItem(CANDIDATE_RESEARCH_TOOLS.find((t) => t.serverId === 'zhtw-mcp'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-mcp-basename-'));
  try {
    writePrepared(root, tool, tool.command[0], Buffer.from('x'));
    const manifestPath = path.join(root, tool.serverId, '.prepared.json');
    const recorded = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    for (const name of [`./${tool.command[0]}`, `sub/${tool.command[0]}`, `../${tool.command[0]}`]) {
      fs.writeFileSync(manifestPath, JSON.stringify({ ...recorded, executable: name }));
      assert.equal(listResearchTools({ store, root, catalog: [tool] })[0].installStatus, 'stale', name);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the quick status does not trust a remembered hash once the file\'s change time moved, even if its size and modified time look the same', { skip: process.platform === 'win32' }, () => {
  const store = new FakeStore();
  const tool = validateCatalogItem(CANDIDATE_RESEARCH_TOOLS.find((t) => t.serverId === 'zhtw-mcp'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-mcp-ctime-'));
  try {
    const file = writePrepared(root, tool, tool.command[0], Buffer.from('AAAAAAAA'));
    const status = () => listResearchTools({ store, root, catalog: [tool] })[0].installStatus;
    primeHashCacheForTests(file, 'f'.repeat(64));
    assert.equal(status(), 'stale', 'a remembered hash that does not match is believed while nothing about the file moved');
    // A permission change moves the change time (and nothing else a restored modified time could hide).
    const before = fs.statSync(file);
    fs.chmodSync(file, before.mode & 0o777 ^ 0o001);
    fs.chmodSync(file, before.mode & 0o777);
    assert.equal(status(), 'ready', 'the file is read again once its change time moved');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
