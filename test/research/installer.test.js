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
    assert.match(entry.statusLabel, /hash verified when installed; not re-checked, not running/);
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
