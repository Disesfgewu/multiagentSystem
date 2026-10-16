'use strict';

// Research Tools Catalog: pinned, verified, read-only MCP specifications.
//
// Shaped by four security principles:
//  1. Pinned versions and integrity hashes: no dynamic 'latest' downloads or arbitrary scripts.
//  2. Static command arrays: commands must be argument arrays, never shell strings.
//  3. Strict read-only constraint: tools provided by research servers must be marked read-only.
//     Any write, execute, or modification tools are rejected immediately.
//  4. Credential hygiene: environment specifications only declare key names. Real secrets
//     must come from SecretStorage and must never be stored in catalog definitions.

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TOOL_NAME = /^[a-z0-9_]{1,64}$/;
const PINNED_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const INTEGRITY_HASH = /^sha256:[a-f0-9]{64}$/i;
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const hasUnsafe = (value) => /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);

const ALLOWED_LICENSES = Object.freeze(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC']);
const FORBIDDEN_COMMAND_TOKENS = Object.freeze(['latest', 'next', 'curl', 'wget', 'bash', 'sh', 'powershell', 'cmd.exe', 'postinstall']);

const LIMITS = Object.freeze({
  serverId: 64,
  name: 120,
  description: 500,
  url: 2000,
  commandArgs: 30,
  toolCount: 50
});

class CatalogError extends TypeError {
  constructor(code) {
    super(code);
    this.name = 'CatalogError';
    this.code = code;
  }
}

const fail = (code) => { throw new CatalogError(code); };
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const clean = (value) => value.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();

function limitedText(value, limit, code, { optional = false } = {}) {
  if (value === undefined || value === null) return optional ? null : fail(code);
  if (typeof value !== 'string') fail(code);
  const cleaned = clean(value);
  if (cleaned === '') return optional ? null : fail(code);
  if (cleaned.length > limit) fail(code);
  return cleaned;
}

/**
 * Validates a single tool definition inside an MCP server entry.
 * All tools must be read-only; write, publish or execution tools are strictly prohibited.
 */
function validateTool(tool) {
  if (!isPlain(tool)) fail('tool-invalid');
  if (typeof tool.name !== 'string' || !TOOL_NAME.test(tool.name)) fail('tool-name-invalid');
  const description = limitedText(tool.description, LIMITS.description, 'tool-description-invalid', { optional: true });
  if (tool.readOnly !== true) fail('write-tool-forbidden');

  return Object.freeze({
    name: tool.name,
    readOnly: true,
    description
  });
}

/**
 * Validates an MCP catalog item against security rules:
 * - Pinned version and valid SHA-256 integrity hash.
 * - Allowed open-source license.
 * - Array-based command execution (no shell string拼接, no forbidden dynamic flags).
 * - All declared tools must be read-only.
 * - Secret keys must only declare names, never inline credentials.
 *
 * @param {object} raw
 */
function validateCatalogItem(raw) {
  if (!isPlain(raw)) fail('item-invalid');

  if (typeof raw.serverId !== 'string' || !NAME.test(raw.serverId)) fail('server-id-invalid');
  const serverId = raw.serverId;
  const name = limitedText(raw.name, LIMITS.name, 'name-invalid');
  const description = limitedText(raw.description, LIMITS.description, 'description-invalid', { optional: true });

  if (typeof raw.version !== 'string' || !PINNED_VERSION.test(raw.version)) fail('version-invalid');
  if (raw.version.includes('latest') || raw.version.includes('next')) fail('dynamic-version-forbidden');
  const version = raw.version;

  if (typeof raw.integrity !== 'string' || !INTEGRITY_HASH.test(raw.integrity)) fail('integrity-hash-invalid');
  const integrity = raw.integrity.toLowerCase();

  if (typeof raw.source !== 'string') fail('source-invalid');
  let source;
  try {
    const parsed = new URL(raw.source);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || raw.source.length > LIMITS.url || hasUnsafe(raw.source)) {
      fail('source-invalid');
    }
    source = parsed.href;
  } catch (error) {
    if (error instanceof CatalogError) throw error;
    fail('source-invalid');
  }

  if (typeof raw.license !== 'string' || !ALLOWED_LICENSES.includes(raw.license)) fail('license-invalid');
  const license = raw.license;

  if (!Array.isArray(raw.command) || raw.command.length === 0 || raw.command.length > LIMITS.commandArgs) fail('command-invalid');
  const command = [];
  for (const part of raw.command) {
    if (typeof part !== 'string' || part.trim() === '' || hasUnsafe(part)) fail('command-invalid');
    const lower = part.toLowerCase();
    for (const forbidden of FORBIDDEN_COMMAND_TOKENS) {
      if (lower === forbidden || lower.includes(`@${forbidden}`)) fail('command-token-forbidden');
    }
    command.push(part.trim());
  }

  if (!Array.isArray(raw.tools) || raw.tools.length === 0 || raw.tools.length > LIMITS.toolCount) fail('tools-invalid');
  const seenToolNames = new Set();
  const tools = [];
  for (const t of raw.tools) {
    const validated = validateTool(t);
    if (seenToolNames.has(validated.name)) fail('duplicate-tool-name');
    seenToolNames.add(validated.name);
    tools.push(validated);
  }

  const env = {};
  if (raw.env !== undefined && raw.env !== null) {
    if (!isPlain(raw.env)) fail('env-invalid');
    for (const [key, meta] of Object.entries(raw.env)) {
      if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key)) fail('env-key-invalid');
      if (!isPlain(meta) || typeof meta.secret !== 'boolean') fail('env-meta-invalid');
      if (meta.value !== undefined) fail('env-inline-secret-forbidden');
      env[key] = Object.freeze({ secret: meta.secret });
    }
  }

  return Object.freeze({
    serverId,
    name,
    description,
    version,
    integrity,
    source,
    license,
    command: Object.freeze(command),
    tools: Object.freeze(tools),
    env: Object.freeze(env),
    status: 'unverified'
  });
}

/**
 * Validates a collection of catalog items.
 * Ensures serverIds are unique across the catalog.
 *
 * @param {Array<object>} rawList
 */
function validateCatalog(rawList) {
  if (!Array.isArray(rawList)) fail('catalog-invalid');
  const items = [];
  const seenIds = new Set();

  for (const raw of rawList) {
    const item = validateCatalogItem(raw);
    if (seenIds.has(item.serverId)) fail('duplicate-server-id');
    seenIds.add(item.serverId);
    items.push(item);
  }

  return Object.freeze(items);
}

/**
 * Filters catalog tools based on role allowlist.
 * Deny by default: if serverId or tool is not in the allowlist, it is omitted.
 *
 * @param {Array<object>} catalog
 * @param {object} allowlist `{ [serverId]: Array<string> }`
 */
function filterAuthorizedTools(catalog, allowlist) {
  if (!Array.isArray(catalog) || !isPlain(allowlist)) fail('allowlist-invalid');

  const authorized = [];
  for (const item of catalog) {
    const allowedToolNames = allowlist[item.serverId];
    if (!Array.isArray(allowedToolNames) || allowedToolNames.length === 0) continue;

    const matchedTools = item.tools.filter((t) => allowedToolNames.includes(t.name));
    if (matchedTools.length > 0) {
      authorized.push(Object.freeze({
        serverId: item.serverId,
        tools: Object.freeze(matchedTools.map((t) => t.name))
      }));
    }
  }

  return Object.freeze(authorized);
}

module.exports = {
  validateCatalogItem,
  validateCatalog,
  filterAuthorizedTools,
  CatalogError,
  ALLOWED_LICENSES,
  LIMITS
};
