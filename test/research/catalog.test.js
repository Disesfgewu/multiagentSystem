'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateCatalogItem,
  validateCatalog,
  filterAuthorizedTools,
  CatalogError
} = require('../../src/research/catalog');

const SAMPLE_GITHUB_ITEM = {
  serverId: 'github-mcp-server',
  name: 'GitHub MCP Server',
  description: 'Official GitHub MCP Server providing repository and search tools',
  version: 'v2.0.2',
  integrity: 'sha256:5d9b38511bffc84d2272eb6189129eb721c8900e45784d8ea7eaf25f8d3dd835',
  source: 'https://github.com/github/github-mcp-server',
  license: 'MIT',
  command: ['github-mcp-server', 'stdio'],
  tools: [
    { name: 'search_repositories', readOnly: true, description: 'Search repos' },
    { name: 'get_file_contents', readOnly: true, description: 'Read file contents' }
  ],
  env: {
    GITHUB_PERSONAL_ACCESS_TOKEN: { secret: true }
  }
};

const SAMPLE_ARXIV_ITEM = {
  serverId: 'arxiv-mcp-server',
  name: 'arXiv MCP Server',
  description: 'Literature tool for arXiv search and section reading',
  version: 'v0.8.2',
  integrity: 'sha256:572e301bb3198962c025d5ed5e14becb86868daae477454fcda4e1ece0202a0c',
  source: 'https://github.com/blazickjp/arxiv-mcp-server',
  license: 'Apache-2.0',
  command: ['arxiv-mcp-server', '--storage-path', '/tmp/arxiv'],
  tools: [
    { name: 'search_papers', readOnly: true, description: 'Search papers' },
    { name: 'get_abstract', readOnly: true, description: 'Read abstract' }
  ]
};

test('validates a compliant item and ensures explicit unverified and non-enforced status', () => {
  const item = validateCatalogItem(SAMPLE_GITHUB_ITEM);
  assert.equal(item.serverId, 'github-mcp-server');
  assert.equal(item.version, 'v2.0.2');
  assert.equal(item.status, 'unverified');
  assert.equal(item.sandboxEnforced, false);
  assert.equal(item.tools.length, 2);
  assert.equal(Object.isFrozen(item), true);
  assert.equal(Object.isFrozen(item.tools), true);
  assert.equal(Object.isFrozen(item.command), true);
});

test('validates secret declaration and enforces secret: true only', () => {
  const item = validateCatalogItem(SAMPLE_GITHUB_ITEM);
  assert.equal(item.env.GITHUB_PERSONAL_ACCESS_TOKEN.secret, true);
  assert.equal(item.env.GITHUB_PERSONAL_ACCESS_TOKEN.value, undefined);

  // Rejects secret: false
  assert.throws(
    () => validateCatalogItem({
      ...SAMPLE_GITHUB_ITEM,
      env: {
        PUBLIC_VAR: { secret: false }
      }
    }),
    (err) => err instanceof CatalogError && err.code === 'env-non-secret-meta-forbidden'
  );
});

test('rejects items with dynamic version tags like latest or next', () => {
  assert.throws(
    () => validateCatalogItem({ ...SAMPLE_GITHUB_ITEM, version: '1.0.0-latest' }),
    (err) => err instanceof CatalogError && err.code === 'dynamic-version-forbidden'
  );
  assert.throws(
    () => validateCatalogItem({ ...SAMPLE_GITHUB_ITEM, version: 'latest' }),
    (err) => err instanceof CatalogError && err.code === 'version-invalid'
  );
});

test('rejects items with invalid or missing SHA-256 integrity hash', () => {
  assert.throws(
    () => validateCatalogItem({ ...SAMPLE_GITHUB_ITEM, integrity: 'md5:123456' }),
    (err) => err instanceof CatalogError && err.code === 'integrity-hash-invalid'
  );
  assert.throws(
    () => validateCatalogItem({ ...SAMPLE_GITHUB_ITEM, integrity: 'sha256:too-short' }),
    (err) => err instanceof CatalogError && err.code === 'integrity-hash-invalid'
  );
});

test('rejects non-SPDX or unapproved licenses', () => {
  assert.throws(
    () => validateCatalogItem({ ...SAMPLE_GITHUB_ITEM, license: 'Proprietary' }),
    (err) => err instanceof CatalogError && err.code === 'license-invalid'
  );
});

test('rejects shell executables (/bin/bash, sh, powershell)', () => {
  assert.throws(
    () => validateCatalogItem({ ...SAMPLE_GITHUB_ITEM, command: ['/bin/bash', '-c', 'malicious.sh'] }),
    (err) => err instanceof CatalogError && err.code === 'shell-executable-forbidden'
  );
  assert.throws(
    () => validateCatalogItem({ ...SAMPLE_GITHUB_ITEM, command: ['sh', 'script.sh'] }),
    (err) => err instanceof CatalogError && err.code === 'shell-executable-forbidden'
  );
  assert.throws(
    () => validateCatalogItem({ ...SAMPLE_GITHUB_ITEM, command: ['powershell.exe', '-Command', 'dir'] }),
    (err) => err instanceof CatalogError && err.code === 'shell-executable-forbidden'
  );
});

test('rejects eval flags like node -e or python -c', () => {
  assert.throws(
    () => validateCatalogItem({ ...SAMPLE_GITHUB_ITEM, command: ['node', '-e', 'console.log("pwned")'] }),
    (err) => err instanceof CatalogError && err.code === 'eval-flag-forbidden'
  );
  assert.throws(
    () => validateCatalogItem({ ...SAMPLE_GITHUB_ITEM, command: ['python3', '-c', 'import os'] }),
    (err) => err instanceof CatalogError && err.code === 'eval-flag-forbidden'
  );
});

test('rejects dynamic package runners (npx -y)', () => {
  assert.throws(
    () => validateCatalogItem({ ...SAMPLE_GITHUB_ITEM, command: ['npx', '-y', 'some-package'] }),
    (err) => err instanceof CatalogError && err.code === 'dynamic-package-runner-forbidden'
  );
});

test('rejects forbidden tokens in command to avoid downloads or arbitrary scripts', () => {
  assert.throws(
    () => validateCatalogItem({ ...SAMPLE_GITHUB_ITEM, command: ['curl', 'https://example.com'] }),
    (err) => err instanceof CatalogError && err.code === 'command-token-forbidden'
  );
  assert.throws(
    () => validateCatalogItem({ ...SAMPLE_GITHUB_ITEM, command: ['node', 'index.js', '@latest'] }),
    (err) => err instanceof CatalogError && err.code === 'command-token-forbidden'
  );
});

test('strictly forbids write or execution tools', () => {
  assert.throws(
    () => validateCatalogItem({
      ...SAMPLE_GITHUB_ITEM,
      tools: [
        { name: 'search_repositories', readOnly: true },
        { name: 'create_issue', readOnly: false }
      ]
    }),
    (err) => err instanceof CatalogError && err.code === 'write-tool-forbidden'
  );

  assert.throws(
    () => validateCatalogItem({
      ...SAMPLE_GITHUB_ITEM,
      tools: [{ name: 'modify_code' }]
    }),
    (err) => err instanceof CatalogError && err.code === 'write-tool-forbidden'
  );
});

test('rejects duplicate tool names within an item', () => {
  assert.throws(
    () => validateCatalogItem({
      ...SAMPLE_GITHUB_ITEM,
      tools: [
        { name: 'search_repositories', readOnly: true },
        { name: 'search_repositories', readOnly: true }
      ]
    }),
    (err) => err instanceof CatalogError && err.code === 'duplicate-tool-name'
  );
});

test('rejects inline secret values in env declaration', () => {
  assert.throws(
    () => validateCatalogItem({
      ...SAMPLE_GITHUB_ITEM,
      env: {
        SECRET_TOKEN: { secret: true, value: 'ghp_leak12345' }
      }
    }),
    (err) => err instanceof CatalogError && err.code === 'env-inline-secret-forbidden'
  );
});

test('validates an entire catalog and catches duplicate serverId', () => {
  const catalog = validateCatalog([SAMPLE_GITHUB_ITEM, SAMPLE_ARXIV_ITEM]);
  assert.equal(catalog.length, 2);
  assert.equal(Object.isFrozen(catalog), true);

  assert.throws(
    () => validateCatalog([SAMPLE_GITHUB_ITEM, SAMPLE_GITHUB_ITEM]),
    (err) => err instanceof CatalogError && err.code === 'duplicate-server-id'
  );
});

test('filters authorized tools with deny-by-default behavior', () => {
  const catalog = validateCatalog([SAMPLE_GITHUB_ITEM, SAMPLE_ARXIV_ITEM]);

  // Allowlist only grants search_repositories on github-mcp-server
  const allowlist = {
    'github-mcp-server': ['search_repositories']
  };

  const filtered = filterAuthorizedTools(catalog, allowlist);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].serverId, 'github-mcp-server');
  assert.deepEqual(filtered[0].tools, ['search_repositories']);

  // Unlisted serverId returns empty authorized list
  const empty = filterAuthorizedTools(catalog, { 'unknown-server': ['some_tool'] });
  assert.equal(empty.length, 0);
});
