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
  assert.match(text, /Integrity Digest.*sha256:572e301bb3198962c025d5ed5e14becb86868daae477454fcda4e1ece0202a0c/);
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

test('prepareResearchTool installs atomically when hash matches', async () => {
  const store = new FakeStore();
  grantConsent('zhtw-mcp', { store });

  const tool = CANDIDATE_RESEARCH_TOOLS.find((t) => t.serverId === 'zhtw-mcp');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-mcp-test-'));

  // Synthetic valid asset matching tool.integrity
  // Tool integrity: sha256:a0b555fb47253e580eb095d438368c6af0018cf90fffa0dbb979f081e28d084a
  // In synthetic test without raw assetBytes, it writes a mock script
  try {
    const outcome = await prepareResearchTool('zhtw-mcp', { store, root: tmpRoot });
    assert.equal(outcome.state, 'ready');
    assert.equal(outcome.serverId, 'zhtw-mcp');
    assert.equal(fs.existsSync(outcome.executable), true);

    const listed = listResearchTools({ store, root: tmpRoot });
    const zhtw = listed.find((t) => t.serverId === 'zhtw-mcp');
    assert.equal(zhtw.consentStatus, 'consented');
    assert.equal(zhtw.installStatus, 'ready');
    assert.match(zhtw.statusLabel, /Consented/);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
