'use strict';

// Research Tools Catalog: pinned, verified, read-only MCP specifications.
//
// Shaped by five security principles:
//  1. Pinned versions: a dynamic 'latest'/'next' version string is rejected. The integrity field must
//     be shaped like a sha256 digest (`sha256:` + 64 hex chars); this module checks only that shape,
//     never whether the digest is genuine or matches the actual published asset — a fabricated digest
//     of the right shape passes here and must be checked against the real release before any install.
//  2. Shell and code execution prevention: commands must be argument arrays, strictly forbidding
//     shell binaries, eval/code flags (-c, -e), and unpinned dynamic package runners.
//  3. Strict read-only constraint: tools provided by research servers must be marked read-only.
//     Any write, execute, or modification tools are rejected immediately.
//  4. Credential hygiene: environment specifications only declare key names with `secret: true`.
//     Real secrets must come from SecretStorage and must never be stored in catalog definitions.
//  5. Honest enforcement declarations: schema-level read-only flags are self-declared by the tool
//     and are explicitly marked `sandboxEnforced: false` until runtime isolation is verified.

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TOOL_NAME = /^[a-z0-9_]{1,64}$/;
const PINNED_VERSION = /^(?:v)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const INTEGRITY_HASH = /^sha256:[a-f0-9]{64}$/i;
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const hasUnsafe = (value) => /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);

const ALLOWED_LICENSES = Object.freeze(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC']);

// Disallowed command tokens: shells, package downloaders, and dangerous tools
const FORBIDDEN_SHELL_NAMES = Object.freeze([
  'sh', 'bash', 'zsh', 'csh', 'ksh', 'fish', 'dash',
  'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'
]);

const FORBIDDEN_EVAL_FLAGS = Object.freeze(['-c', '-e', '--eval', '/c']);

// A dynamic package runner resolves and fetches its target package at the moment it is invoked,
// not at the moment this catalog item was reviewed: `npx some-package` with no `-y` still resolves
// whatever version the registry currently serves under that name, exactly like `npx -y`. There is no
// flag that makes a runner invocation pinned; only a command that names a locally present, hash-
// verified executable directly is. The whole category is rejected, not just the `-y`/`--yes` shortcut.
const FORBIDDEN_DYNAMIC_RUNNERS = Object.freeze(['npx', 'uvx']);

const FORBIDDEN_COMMAND_TOKENS = Object.freeze([
  'latest', 'next', 'curl', 'wget', 'fetch', 'postinstall',
  'install', 'pip', 'cargo'
]);

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
 * Validates command array:
 *  - Executable must not be a shell or script interpreter wrapper.
 *  - Must not contain eval flags (-c, -e).
 *  - Package runners like npx or uvx must not use dynamic -y or unpinned invocations.
 */
function validateCommand(commandArray) {
  if (!Array.isArray(commandArray) || commandArray.length === 0 || commandArray.length > LIMITS.commandArgs) {
    fail('command-invalid');
  }

  const cleanArgs = [];
  for (let i = 0; i < commandArray.length; i++) {
    const part = commandArray[i];
    if (typeof part !== 'string' || part.trim() === '' || hasUnsafe(part)) fail('command-invalid');
    cleanArgs.push(part.trim());
  }

  const executable = cleanArgs[0].toLowerCase();
  const execBasename = executable.split(/[/\\]/).pop();

  if (FORBIDDEN_SHELL_NAMES.includes(execBasename)) {
    fail('shell-executable-forbidden');
  }
  if (FORBIDDEN_DYNAMIC_RUNNERS.includes(execBasename)) {
    fail('dynamic-package-runner-forbidden');
  }

  for (let i = 0; i < cleanArgs.length; i++) {
    const token = cleanArgs[i].toLowerCase();

    // Check forbidden eval flags (e.g. node -e, python -c)
    if (FORBIDDEN_EVAL_FLAGS.includes(token)) {
      fail('eval-flag-forbidden');
    }

    for (const forbidden of FORBIDDEN_COMMAND_TOKENS) {
      if (token === forbidden || token.includes(`@${forbidden}`)) {
        fail('command-token-forbidden');
      }
    }
  }

  return Object.freeze(cleanArgs);
}

/**
 * Validates a single tool definition inside an MCP server entry.
 * All tools must be self-declared read-only; write, publish or execution tools are strictly prohibited.
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
 * - Array-based command execution with shell/eval filtering.
 * - Self-declared read-only tools only.
 * - Environment specifications only allow `secret: true`.
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

  const command = validateCommand(raw.command);

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
      if (!isPlain(meta)) fail('env-meta-invalid');
      // Secret hygiene: only secret: true is accepted. Non-secret env declarations must not appear in secret specifications.
      if (meta.secret !== true) fail('env-non-secret-meta-forbidden');
      if (meta.value !== undefined) fail('env-inline-secret-forbidden');
      env[key] = Object.freeze({ secret: true });
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
    command,
    tools: Object.freeze(tools),
    env: Object.freeze(env),
    status: 'unverified',
    sandboxEnforced: false
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
