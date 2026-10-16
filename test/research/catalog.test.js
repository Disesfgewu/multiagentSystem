'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateCatalogItem,
  validateCatalog,
  filterAuthorizedTools,
  CatalogError
} = require('../../src/research/catalog');

const SAMPLE_ARXIV_ITEM = {
  serverId: 'arxiv-mcp',
  name: 'arXiv MCP Server',
  description: 'Read-only tool for searching arXiv preprints and retrieving metadata',
  version: '0.6.2',
  integrity: 'sha256:7e8a9f2bc43d1a89c34e62bf5d098e721a3df290bca11894a4c59d7b42ef0132',
  source: 'https://github.com/modelcontextprotocol/servers/tree/main/src/arxiv',
  license: 'MIT',
  command: ['node', 'dist/index.js'],
  tools: [
    { name: 'search_papers', readOnly: true, description: 'Search arXiv papers' },
    { name: 'get_paper_metadata', readOnly: true, description: 'Get paper metadata' }
  ]
};

const SAMPLE_GITHUB_READONLY_ITEM = {
  serverId: 'github-readonly-mcp',
  name: 'GitHub Read-Only MCP',
  description: 'Read-only access to repository files and code search',
  version: '0.6.2',
  integrity: 'sha256:91ca7b823e4125b7a0f671234dca9b8e1f5432109876543210abcdef01234567',
  source: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
  license: 'MIT',
  command: ['node', 'dist/index.js'],
  tools: [
    { name: 'search_repositories', readOnly: true, description: 'Search repos' },
    { name: 'get_file_contents', readOnly: true, description: 'Read file contents' }
  ],
  env: {
    GITHUB_PERSONAL_ACCESS_TOKEN: { secret: true }
  }
};

test('validates a compliant read-only catalog item', () => {
  const item = validateCatalogItem(SAMPLE_ARXIV_ITEM);
  assert.equal(item.serverId, 'arxiv-mcp');
  assert.equal(item.version, '0.6.2');
  assert.equal(item.status, 'unverified');
  assert.equal(item.tools.length, 2);
  assert.equal(Object.isFrozen(item), true);
  assert.equal(Object.isFrozen(item.tools), true);
  assert.equal(Object.isFrozen(item.command), true);
});

test('validates item with credential declaration without inline secrets', () => {
  const item = validateCatalogItem(SAMPLE_GITHUB_READONLY_ITEM);
  assert.equal(item.serverId, 'github-readonly-mcp');
  assert.equal(item.env.GITHUB_PERSONAL_ACCESS_TOKEN.secret, true);
  assert.equal(item.env.GITHUB_PERSONAL_ACCESS_TOKEN.value, undefined);
});

test('rejects items with dynamic version tags like latest or next', () => {
  assert.throws(
    () => validateCatalogItem({ ...SAMPLE_ARXIV_ITEM, version: '1.0.0-latest' }),
    (err) => err instanceof CatalogError && err.code === 'dynamic-version-forbidden'
  );
  assert.throws(
    () => validateCatalogItem({ ...SAMPLE_ARXIV_ITEM, version: 'latest' }),
    (err) => err instanceof CatalogError && err.code === 'version-invalid'
  );
});

test('rejects items with invalid or missing SHA-256 integrity hash', () => {
  assert.throws(
    () => validateCatalogItem({ ...SAMPLE_ARXIV_ITEM, integrity: 'md5:123456' }),
    (err) => err instanceof CatalogError && err.code === 'integrity-hash-invalid'
  );
  assert.throws(
    () => validateCatalogItem({ ...SAMPLE_ARXIV_ITEM, integrity: 'sha256:too-short' }),
    (err) => err instanceof CatalogError && err.code === 'integrity-hash-invalid'
  );
});

test('rejects non-SPDX or unapproved licenses', () => {
  assert.throws(
    () => validateCatalogItem({ ...SAMPLE_ARXIV_ITEM, license: 'Proprietary' }),
    (err) => err instanceof CatalogError && err.code === 'license-invalid'
  );
});

test('rejects non-array command execution', () => {
  assert.throws(
    () => validateCatalogItem({ ...SAMPLE_ARXIV_ITEM, command: 'node dist/index.js' }),
    (err) => err instanceof CatalogError && err.code === 'command-invalid'
  );
});

test('rejects forbidden tokens in command to avoid shell injection or dynamic downloads', () => {
  assert.throws(
    () => validateCatalogItem({ ...SAMPLE_ARXIV_ITEM, command: ['bash', '-c', 'script.sh'] }),
    (err) => err instanceof CatalogError && err.code === 'command-token-forbidden'
  );
  assert.throws(
    () => validateCatalogItem({ ...SAMPLE_ARXIV_ITEM, command: ['npx', '@latest'] }),
    (err) => err instanceof CatalogError && err.code === 'command-token-forbidden'
  );
  assert.throws(
    () => validateCatalogItem({ ...SAMPLE_ARXIV_ITEM, command: ['curl', 'https://example.com'] }),
    (err) => err instanceof CatalogError && err.code === 'command-token-forbidden'
  );
});

test('strictly forbids write or execution tools', () => {
  assert.throws(
    () => validateCatalogItem({
      ...SAMPLE_ARXIV_ITEM,
      tools: [
        { name: 'search_papers', readOnly: true },
        { name: 'create_issue', readOnly: false }
      ]
    }),
    (err) => err instanceof CatalogError && err.code === 'write-tool-forbidden'
  );

  assert.throws(
    () => validateCatalogItem({
      ...SAMPLE_ARXIV_ITEM,
      tools: [{ name: 'modify_code' }]
    }),
    (err) => err instanceof CatalogError && err.code === 'write-tool-forbidden'
  );
});

test('rejects duplicate tool names within an item', () => {
  assert.throws(
    () => validateCatalogItem({
      ...SAMPLE_ARXIV_ITEM,
      tools: [
        { name: 'search_papers', readOnly: true },
        { name: 'search_papers', readOnly: true }
      ]
    }),
    (err) => err instanceof CatalogError && err.code === 'duplicate-tool-name'
  );
});

test('rejects inline secret values in env declaration', () => {
  assert.throws(
    () => validateCatalogItem({
      ...SAMPLE_ARXIV_ITEM,
      env: {
        SECRET_TOKEN: { secret: true, value: 'ghp_leak12345' }
      }
    }),
    (err) => err instanceof CatalogError && err.code === 'env-inline-secret-forbidden'
  );
});

test('validates an entire catalog and catches duplicate serverId', () => {
  const catalog = validateCatalog([SAMPLE_ARXIV_ITEM, SAMPLE_GITHUB_READONLY_ITEM]);
  assert.equal(catalog.length, 2);
  assert.equal(Object.isFrozen(catalog), true);

  assert.throws(
    () => validateCatalog([SAMPLE_ARXIV_ITEM, SAMPLE_ARXIV_ITEM]),
    (err) => err instanceof CatalogError && err.code === 'duplicate-server-id'
  );
});

test('filters authorized tools with deny-by-default behavior', () => {
  const catalog = validateCatalog([SAMPLE_ARXIV_ITEM, SAMPLE_GITHUB_READONLY_ITEM]);

  // Allowlist only grants search_papers on arxiv-mcp
  const allowlist = {
    'arxiv-mcp': ['search_papers']
  };

  const filtered = filterAuthorizedTools(catalog, allowlist);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].serverId, 'arxiv-mcp');
  assert.deepEqual(filtered[0].tools, ['search_papers']);

  // Unlisted serverId returns empty authorized list
  const empty = filterAuthorizedTools(catalog, { 'unknown-server': ['some_tool'] });
  assert.equal(empty.length, 0);
});
