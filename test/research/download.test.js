'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { zipSync } = require('fflate');

const { downloadReleaseAsset, parseReleaseAssetUrl, ALLOWED_REPOSITORIES } = require('../../src/research/download');
const { extractEntry } = require('../../src/research/archive');
const { validateCatalogItem, CANDIDATE_RESEARCH_TOOLS } = require('../../src/research/catalog');
const { grantConsent, prepareResearchTool, listResearchTools } = require('../../src/research/installer');

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const REPO = 'github/github-mcp-server';
const ASSET_URL = `https://github.com/${REPO}/releases/download/v2.0.2/github-mcp-server_Darwin_arm64.tar.gz`;

function tarGz(files) {
  const blocks = [];
  for (const [name, content] of Object.entries(files)) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 'utf8');
    header.write('0000755\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.write('        ', 148);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, Buffer.from(content), Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

// A local server stands in for github.com and its release CDN. fetchImpl rewrites the https URLs the
// download layer insists on into requests to this server, so redirects, streaming and cancellation
// behave like real HTTP while nothing leaves the machine.
async function withServer(routes, run) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const route = routes[req.url];
    if (!route) { res.writeHead(404); res.end(); return; }
    route(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const contacted = [];
  const fetchImpl = (url, init) => {
    const parsed = new URL(url);
    contacted.push(parsed.hostname);
    const prefix = parsed.hostname === 'github.com' ? '/gh' : '/cdn';
    return fetch(`http://127.0.0.1:${port}${prefix}${parsed.pathname}`, init);
  };
  try { return await run({ fetchImpl, hits, contacted }); }
  finally { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
}

const redirectTo = (location) => (_req, res) => { res.writeHead(302, { location }); res.end(); };
const sendBody = (body) => (_req, res) => { res.writeHead(200, { 'content-length': body.length }); res.end(body); };
const PATH = `/gh/${REPO}/releases/download/v2.0.2/github-mcp-server_Darwin_arm64.tar.gz`;

test('source URLs: only the three named repositories, https, exact release path, no userinfo, port or query', () => {
  assert.deepEqual([...ALLOWED_REPOSITORIES], ['sysprog21/zhtw-mcp', 'blazickjp/arxiv-mcp-server', 'github/github-mcp-server']);
  assert.ok(parseReleaseAssetUrl(ASSET_URL));
  for (const bad of [
    'http://github.com/github/github-mcp-server/releases/download/v2.0.2/a.tar.gz',
    'https://github.com.evil.example/github/github-mcp-server/releases/download/v2.0.2/a.tar.gz',
    'https://user:pw@github.com/github/github-mcp-server/releases/download/v2.0.2/a.tar.gz',
    'https://github.com:444/github/github-mcp-server/releases/download/v2.0.2/a.tar.gz',
    'https://github.com/github/github-mcp-server/releases/download/v2.0.2/a.tar.gz?x=1',
    'https://github.com/some-fork/github-mcp-server/releases/download/v2.0.2/a.tar.gz',
    'https://github.com/modelcontextprotocol/servers/releases/download/v2.0.2/a.tar.gz',
    'https://github.com/github/github-mcp-server/archive/refs/tags/v2.0.2.tar.gz',
    'https://github.com/github/github-mcp-server/releases/download/v2.0.2/../a.tar.gz',
    'https://github.com/github/github-mcp-server/releases/latest/download/a.tar.gz',
    'https://raw.githubusercontent.com/github/github-mcp-server/v2.0.2/a.tar.gz',
    'https://github.com/github/github-mcp-server/releases/download/v2.0.2/a%20b.tar.gz',
    'https://github.com/github/github-mcp-server/releases/download/v2%2e0/a.tar.gz',
    'https://github.com/github/github-mcp-server/releases/download/v2.0.2/-a.tar.gz'
  ]) assert.equal(parseReleaseAssetUrl(bad), null, bad);
});

test('downloads through a release redirect and returns the bytes only when the pinned SHA-256 matches', async () => {
  const body = Buffer.from('release-bytes');
  await withServer({
    [PATH]: redirectTo('https://release-assets.githubusercontent.com/blob/one'),
    '/cdn/blob/one': sendBody(body)
  }, async ({ fetchImpl, contacted }) => {
    const out = await downloadReleaseAsset({ url: ASSET_URL, sha256: sha(body) }, { fetchImpl });
    assert.deepEqual(Buffer.from(out), body);
    assert.deepEqual(contacted, ['github.com', 'release-assets.githubusercontent.com']);
    await assert.rejects(downloadReleaseAsset({ url: ASSET_URL, sha256: sha('other') }, { fetchImpl }), { code: 'integrity-mismatch' });
  });
});

test('a redirect to a host outside the allowlist, to http, with userinfo or a port is refused before any request to it', async () => {
  for (const location of [
    'https://evil.example/blob',
    'http://release-assets.githubusercontent.com/blob',
    'https://user:pw@release-assets.githubusercontent.com/blob',
    'https://release-assets.githubusercontent.com:8443/blob'
  ]) {
    await withServer({ [PATH]: redirectTo(location) }, async ({ fetchImpl, contacted }) => {
      await assert.rejects(downloadReleaseAsset({ url: ASSET_URL, sha256: sha('x') }, { fetchImpl }), { code: 'source-refused' }, location);
      assert.deepEqual(contacted, ['github.com'], location);
    });
  }
});

test('a redirect loop stops after three hops', async () => {
  await withServer({
    [PATH]: redirectTo('https://objects.githubusercontent.com/a'),
    '/cdn/a': redirectTo('https://objects.githubusercontent.com/b'),
    '/cdn/b': redirectTo('https://objects.githubusercontent.com/c'),
    '/cdn/c': redirectTo('https://objects.githubusercontent.com/d'),
    '/cdn/d': sendBody(Buffer.from('x'))
  }, async ({ fetchImpl }) => {
    await assert.rejects(downloadReleaseAsset({ url: ASSET_URL, sha256: sha('x') }, { fetchImpl }), { code: 'too-many-redirects' });
  });
});

test('size cap: a declared length over the cap and an undeclared stream over the cap are both cut off', async () => {
  const big = Buffer.alloc(4096, 1);
  await withServer({
    [PATH]: sendBody(big),
    '/gh/chunked': (_req, res) => { res.writeHead(200); res.write(big); res.end(big); }
  }, async ({ fetchImpl }) => {
    await assert.rejects(downloadReleaseAsset({ url: ASSET_URL, sha256: sha(big) }, { fetchImpl, maxBytes: 1024 }), { code: 'download-too-large' });
  });
  const chunkedPath = `/gh/${REPO}/releases/download/v2.0.2/chunked.tar.gz`;
  await withServer({
    [chunkedPath]: (_req, res) => { res.writeHead(200); res.write(big); res.end(big); }
  }, async ({ fetchImpl }) => {
    await assert.rejects(downloadReleaseAsset({ url: `https://github.com/${REPO}/releases/download/v2.0.2/chunked.tar.gz`, sha256: sha(big) }, { fetchImpl, maxBytes: 4096 }), { code: 'download-too-large' });
  });
});

test('a declared length over the cap is refused before any body is read', async () => {
  await withServer({ [PATH]: (_req, res) => { res.writeHead(200, { 'content-length': 10 * 1024 * 1024 }); res.flushHeaders(); } }, async ({ fetchImpl }) => {
    await assert.rejects(downloadReleaseAsset({ url: ASSET_URL, sha256: sha('x') }, { fetchImpl, maxBytes: 1024, timeoutMs: 3000 }), { code: 'download-too-large' });
  });
});

test('aborting while the server sends nothing still cancels', async () => {
  await withServer({ [PATH]: (_req, res) => { res.writeHead(200); res.flushHeaders(); } }, async ({ fetchImpl }) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    await assert.rejects(downloadReleaseAsset({ url: ASSET_URL, sha256: sha('x') }, { fetchImpl, signal: controller.signal, timeoutMs: 5000 }), { code: 'download-cancelled' });
    assert.ok(Date.now() - started < 2000, 'cancelled by the signal, not by the timeout');
  });
});

test('cancelling stops a slow download with download-cancelled, and a pre-aborted signal never makes a request', async () => {
  await withServer({
    [PATH]: (_req, res) => { res.writeHead(200); res.write(Buffer.alloc(64, 1)); /* never finishes */ }
  }, async ({ fetchImpl, hits }) => {
    const controller = new AbortController();
    const pending = downloadReleaseAsset({ url: ASSET_URL, sha256: sha('x') }, { fetchImpl, signal: controller.signal, progress: () => controller.abort() });
    await assert.rejects(pending, { code: 'download-cancelled' });
    const before = hits.length;
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(downloadReleaseAsset({ url: ASSET_URL, sha256: sha('x') }, { fetchImpl, signal: aborted.signal }), { code: 'download-cancelled' });
    assert.equal(hits.length, before);
  });
});

test('non-200 and empty responses fail, and a non-allowed URL is refused without any request', async () => {
  await withServer({ [PATH]: (_req, res) => { res.writeHead(500); res.end(); } }, async ({ fetchImpl, hits }) => {
    await assert.rejects(downloadReleaseAsset({ url: ASSET_URL, sha256: sha('x') }, { fetchImpl }), { code: 'download-failed' });
    hits.length = 0;
    await assert.rejects(downloadReleaseAsset({ url: 'https://github.com/evil/fork/releases/download/v1/a.tar.gz', sha256: sha('x') }, { fetchImpl }), { code: 'source-refused' });
    await assert.rejects(downloadReleaseAsset({ url: ASSET_URL, sha256: 'not-a-hash' }, { fetchImpl }), { code: 'asset-invalid' });
    assert.equal(hits.length, 0);
  });
});

test('archive extraction returns exactly the named regular file and rejects missing, duplicate and malformed archives', () => {
  const tgz = tarGz({ LICENSE: 'mit', 'github-mcp-server': 'binary-bytes' });
  assert.equal(Buffer.from(extractEntry(tgz, 'tar.gz', 'github-mcp-server')).toString(), 'binary-bytes');
  assert.throws(() => extractEntry(tgz, 'tar.gz', 'other'), { code: 'archive-entry-missing' });
  assert.throws(() => extractEntry(tarGz({ x: 'a', 'github-mcp-server': 'a' }).subarray(0, 20), 'tar.gz', 'x'), { code: 'archive-invalid' });
  assert.throws(() => extractEntry(Buffer.from('not an archive'), 'tar.gz', 'x'), { code: 'archive-invalid' });
  const dup = tarGz({ 'github-mcp-server': 'one' });
  const twice = zlib.gzipSync(Buffer.concat([zlib.gunzipSync(dup).subarray(0, 1024), zlib.gunzipSync(dup)]));
  assert.throws(() => extractEntry(twice, 'tar.gz', 'github-mcp-server'), { code: 'archive-entry-duplicate' });
  const zip = Buffer.from(zipSync({ 'github-mcp-server.exe': Buffer.from('exe-bytes'), 'README.md': Buffer.from('r') }));
  assert.equal(Buffer.from(extractEntry(zip, 'zip', 'github-mcp-server.exe')).toString(), 'exe-bytes');
  assert.throws(() => extractEntry(zip, 'zip', 'github-mcp-server'), { code: 'archive-entry-missing' });
  assert.throws(() => extractEntry(tgz, 'rar', 'x'), { code: 'archive-format-unsupported' });
});

// ---- catalog assets + installer integration -------------------------------------------------------

const fixtureTool = (archive, overrides = {}) => ({
  serverId: 'github-mcp-server',
  name: 'GitHub Research MCP Server',
  description: 'fixture',
  version: 'v2.0.2',
  integrity: `sha256:${sha(archive)}`,
  source: 'https://github.com/github/github-mcp-server.git',
  license: 'MIT',
  command: ['github-mcp-server', 'stdio'],
  assets: [{ platform: 'darwin', arch: 'arm64', url: ASSET_URL, format: 'tar.gz', sha256: sha(archive), entry: 'github-mcp-server' }],
  tools: [{ name: 'get_file_contents', readOnly: true, description: 'read' }],
  env: { GITHUB_PERSONAL_ACCESS_TOKEN: { secret: true } },
  ...overrides
});

class Store {
  constructor() { this.m = new Map(); }
  get(c, k) { const v = this.m.get(`${c}/${k}`); return v ? { ok: true, value: v } : { ok: false }; }
  put(c, k, v) { this.m.set(`${c}/${k}`, JSON.parse(JSON.stringify(v))); return { ok: true }; }
}

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-dl-'));
  return { dir, root: path.join(dir, 'managed-tools', 'research'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const leftovers = (root) => (fs.existsSync(root) ? fs.readdirSync(root).filter((name) => name !== 'github-mcp-server') : []);
const stagingEntries = (root) => (fs.existsSync(path.join(root, '.staging')) ? fs.readdirSync(path.join(root, '.staging')) : []);

test('catalog assets must be the item\'s own repo at its own pinned tag, with real shapes; bad ones fail closed', () => {
  const archive = tarGz({ 'github-mcp-server': 'b' });
  assert.equal(validateCatalogItem(fixtureTool(archive)).assets.length, 1);
  const bad = (patch, code) => assert.throws(() => validateCatalogItem(fixtureTool(archive, patch)), { code });
  const asset = fixtureTool(archive).assets[0];
  bad({ assets: [{ ...asset, url: 'https://github.com/blazickjp/arxiv-mcp-server/releases/download/v2.0.2/a.tar.gz' }] }, 'asset-source-invalid');
  bad({ assets: [{ ...asset, url: ASSET_URL.replace('v2.0.2', 'v9.9.9') }] }, 'asset-source-invalid');
  bad({ assets: [{ ...asset, sha256: 'abc' }] }, 'asset-hash-invalid');
  bad({ assets: [{ ...asset, sha256: sha(archive).toUpperCase() }] }, 'asset-hash-invalid');
  bad({ assets: [{ ...asset, platform: 'linux' }] }, 'asset-platform-invalid');
  bad({ assets: [{ ...asset, format: 'exe' }] }, 'asset-format-invalid');
  bad({ assets: [{ ...asset, entry: '../escape' }] }, 'asset-entry-invalid');
  bad({ assets: [{ ...asset, platform: 'win32' }] }, 'asset-entry-invalid');
  bad({ assets: [asset, asset] }, 'asset-duplicate');
  bad({ assets: 'x' }, 'assets-invalid');
});

test('a catalog entry that has no pinned asset is not installable: consent alone writes nothing', async () => {
  const env = sandbox();
  try {
    const archive = tarGz({ 'github-mcp-server': 'b' });
    const catalog = [fixtureTool(archive, { assets: undefined })];
    const store = new Store();
    grantConsent('github-mcp-server', { store, catalog });
    await assert.rejects(prepareResearchTool('github-mcp-server', { store, root: env.root, catalog, platform: 'darwin', arch: 'arm64' }), { code: 'asset-unavailable' });
    assert.equal(fs.existsSync(env.root), false);
  } finally { env.cleanup(); }
});

test('prepareResearchTool downloads, verifies, extracts and installs the pinned executable; the manifest names it', async () => {
  const env = sandbox();
  try {
    const archive = tarGz({ LICENSE: 'mit', 'github-mcp-server': 'binary-bytes' });
    const catalog = [fixtureTool(archive)];
    const store = new Store();
    grantConsent('github-mcp-server', { store, catalog });
    await withServer({ [PATH]: redirectTo('https://release-assets.githubusercontent.com/blob/gh'), '/cdn/blob/gh': sendBody(archive) }, async ({ fetchImpl }) => {
      const outcome = await prepareResearchTool('github-mcp-server', { store, root: env.root, boundary: env.dir, catalog, platform: 'darwin', arch: 'arm64', fetchImpl });
      assert.equal(outcome.state, 'ready');
      assert.equal(fs.readFileSync(outcome.executable, 'utf8'), 'binary-bytes');
      assert.deepEqual(stagingEntries(env.root), []);
      assert.equal(listResearchTools({ store, catalog, root: env.root })[0].installStatus, 'ready');
    });
    // The same entry on a platform with no pinned asset stays not installable.
    await assert.rejects(prepareResearchTool('github-mcp-server', { store, root: path.join(env.dir, 'other'), catalog, platform: 'win32', arch: 'x64' }), { code: 'asset-unavailable' });
  } finally { env.cleanup(); }
});

test('a failed or cancelled download keeps the existing verified install and leaves no staging', async () => {
  const env = sandbox();
  try {
    const good = tarGz({ 'github-mcp-server': 'good-v1' });
    const catalog = [fixtureTool(good)];
    const store = new Store();
    grantConsent('github-mcp-server', { store, catalog });
    await withServer({ [PATH]: sendBody(good) }, async ({ fetchImpl }) => {
      await prepareResearchTool('github-mcp-server', { store, root: env.root, catalog, platform: 'darwin', arch: 'arm64', fetchImpl });
    });
    const installed = path.join(env.root, 'github-mcp-server');
    const snapshot = () => ({ exe: fs.readFileSync(path.join(installed, 'github-mcp-server'), 'utf8'), manifest: fs.readFileSync(path.join(installed, '.prepared.json'), 'utf8') });
    const before = snapshot();

    const attempt = (routes, extra = {}) => withServer(routes, ({ fetchImpl }) =>
      prepareResearchTool('github-mcp-server', { store, root: env.root, catalog, platform: 'darwin', arch: 'arm64', fetchImpl, ...extra }));

    // tampered bytes at the pinned URL
    await assert.rejects(attempt({ [PATH]: sendBody(tarGz({ 'github-mcp-server': 'EVIL' })) }), { code: 'hash-mismatch' });
    // server error
    await assert.rejects(attempt({ [PATH]: (_req, res) => { res.writeHead(503); res.end(); } }), { code: 'download-failed' });
    // redirect off the allowlist
    await assert.rejects(attempt({ [PATH]: redirectTo('https://evil.example/x') }), { code: 'source-refused' });
    // cancellation mid-stream
    const controller = new AbortController();
    await assert.rejects(attempt({ [PATH]: (_req, res) => { res.writeHead(200); res.write(Buffer.alloc(32)); } }, { signal: controller.signal, progress: () => controller.abort() }), { code: 'download-cancelled' });

    assert.deepEqual(snapshot(), before);
    assert.deepEqual(stagingEntries(env.root), []);
    assert.deepEqual(leftovers(env.root).filter((name) => name !== '.staging'), []);
    assert.equal(listResearchTools({ store, catalog, root: env.root })[0].installStatus, 'ready');
  } finally { env.cleanup(); }
});

test('the installer re-checks the archive hash itself, and a cancel during staging installs nothing', async () => {
  const env = sandbox();
  try {
    const good = tarGz({ 'github-mcp-server': 'good' });
    const catalog = [fixtureTool(good)];
    const store = new Store();
    grantConsent('github-mcp-server', { store, catalog });
    const base = { store, root: env.root, catalog, platform: 'darwin', arch: 'arm64' };
    await assert.rejects(prepareResearchTool('github-mcp-server', { ...base, download: async () => tarGz({ 'github-mcp-server': 'EVIL' }) }), { code: 'hash-mismatch' });
    assert.equal(fs.existsSync(env.root), false);
    const controller = new AbortController();
    await assert.rejects(prepareResearchTool('github-mcp-server', { ...base, download: async () => good, signal: controller.signal, now: () => { controller.abort(); return new Date(); } }), { code: 'download-cancelled' });
    assert.equal(fs.existsSync(path.join(env.root, 'github-mcp-server')), false);
    assert.deepEqual(stagingEntries(env.root), []);
  } finally { env.cleanup(); }
});

test('an archive without the pinned entry is rejected with nothing written and the old install kept', async () => {
  const env = sandbox();
  try {
    const wrong = tarGz({ 'something-else': 'x' });
    const catalog = [fixtureTool(wrong)];
    const store = new Store();
    grantConsent('github-mcp-server', { store, catalog });
    await withServer({ [PATH]: sendBody(wrong) }, async ({ fetchImpl }) => {
      await assert.rejects(prepareResearchTool('github-mcp-server', { store, root: env.root, catalog, platform: 'darwin', arch: 'arm64', fetchImpl }), { code: 'archive-invalid' });
    });
    assert.equal(fs.existsSync(env.root), false);
  } finally { env.cleanup(); }
});

test('production catalog: github-mcp-server has pinned darwin and win32 assets; zhtw-mcp and arxiv-mcp-server are not installable', () => {
  const by = Object.fromEntries(CANDIDATE_RESEARCH_TOOLS.map((tool) => [tool.serverId, tool]));
  const platforms = by['github-mcp-server'].assets.map((asset) => `${asset.platform}/${asset.arch}`).sort();
  assert.deepEqual(platforms, ['darwin/arm64', 'darwin/x64', 'win32/arm64', 'win32/x64']);
  assert.equal(by['zhtw-mcp'].assets.length, 0);
  assert.equal(by['arxiv-mcp-server'].assets.length, 0);
});
