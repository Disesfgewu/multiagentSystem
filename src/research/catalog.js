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

const { parseReleaseAssetUrl } = require('./download');

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TOOL_NAME = /^[a-z0-9_]{1,64}$/;
const PINNED_VERSION = /^(?:v)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const INTEGRITY_HASH = /^sha256:[a-f0-9]{64}$/i;
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const hasUnsafe = (value) => /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);

// A command argument that stands for the tool's private working folder, chosen at start (never a shared folder like /tmp).
const STORAGE_PLACEHOLDER = '{storage}';

const ALLOWED_LICENSES = Object.freeze(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC']);

// Disallowed command tokens: shells, package downloaders, and dangerous tools
const FORBIDDEN_SHELL_NAMES = Object.freeze([
  'sh', 'bash', 'zsh', 'csh', 'ksh', 'fish', 'dash',
  'cmd', 'powershell', 'pwsh'
]);

// Windows normally exposes commands through these suffixes. Normalize them in one place before
// every executable-name comparison so `bash.exe`, `npx.cmd` or `pip.bat` cannot bypass a rule that
// correctly rejects the corresponding bare name. Repeating suffixes are removed too because a
// command file may itself have a name such as `bash.exe.cmd`.
const EXECUTABLE_SUFFIX = /\.(?:exe|cmd|bat|ps1)$/i;
function executableName(value) {
  let name = value.toLowerCase().split(/[/\\]/).pop();
  while (EXECUTABLE_SUFFIX.test(name)) name = name.replace(EXECUTABLE_SUFFIX, '');
  return name;
}

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

const ASSET_PLATFORMS = Object.freeze({ darwin: ['x64', 'arm64'], win32: ['x64', 'arm64'] });
const ASSET_FORMATS = Object.freeze(['tar.gz', 'zip']);
const ASSET_SHA256 = /^[a-f0-9]{64}$/;

const LIMITS = Object.freeze({
  assets: 8,
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
    // The only placeholder is the whole argument `{storage}`: the lifecycle replaces it with the tool's own private folder.
    if (/[{}]/.test(part) && part !== STORAGE_PLACEHOLDER) fail('command-invalid');
    cleanArgs.push(part.trim());
  }

  const execBasename = executableName(cleanArgs[0]);

  if (FORBIDDEN_SHELL_NAMES.includes(execBasename)) {
    fail('shell-executable-forbidden');
  }
  if (FORBIDDEN_DYNAMIC_RUNNERS.includes(execBasename)) {
    fail('dynamic-package-runner-forbidden');
  }

  for (let i = 0; i < cleanArgs.length; i++) {
    const token = cleanArgs[i].toLowerCase();
    const tokenExecutableName = executableName(token);

    // Check forbidden eval flags (e.g. node -e, python -c)
    if (FORBIDDEN_EVAL_FLAGS.includes(token)) {
      fail('eval-flag-forbidden');
    }

    for (const forbidden of FORBIDDEN_COMMAND_TOKENS) {
      if (token === forbidden || tokenExecutableName === forbidden || token.includes(`@${forbidden}`)) {
        fail('command-token-forbidden');
      }
    }
  }

  return Object.freeze(cleanArgs);
}

/**
 * Validates the pinned release assets of one catalog item. An item with no assets is valid but not
 * installable. Each asset must be a GitHub release download of the item's own repository at its own
 * pinned tag, with the SHA-256 of that exact archive and the archive path of the one executable.
 */
function validateAssets(rawAssets, { source, version, command }) {
  if (rawAssets === undefined || rawAssets === null) return Object.freeze([]);
  if (!Array.isArray(rawAssets) || rawAssets.length > LIMITS.assets) fail('assets-invalid');
  const repoMatch = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(source);
  if (!repoMatch) fail('assets-invalid');
  const seen = new Set();
  const out = [];
  for (const raw of rawAssets) {
    if (!isPlain(raw)) fail('asset-invalid');
    const arches = ASSET_PLATFORMS[raw.platform];
    if (!arches || !arches.includes(raw.arch)) fail('asset-platform-invalid');
    if (!ASSET_FORMATS.includes(raw.format)) fail('asset-format-invalid');
    if (typeof raw.sha256 !== 'string' || !ASSET_SHA256.test(raw.sha256)) fail('asset-hash-invalid');
    const parsed = parseReleaseAssetUrl(raw.url);
    if (!parsed || parsed.repository !== repoMatch[1] || parsed.tag !== version) fail('asset-source-invalid');
    const key = `${raw.platform}/${raw.arch}`;
    if (seen.has(key)) fail('asset-duplicate');
    seen.add(key);
    const expectedName = raw.platform === 'win32' ? `${command[0]}.exe` : command[0];
    if (typeof raw.entry !== 'string' || raw.entry !== expectedName) fail('asset-entry-invalid');
    out.push(Object.freeze({ platform: raw.platform, arch: raw.arch, url: parsed.url, format: raw.format, sha256: raw.sha256, entry: raw.entry }));
  }
  return Object.freeze(out);
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

  const assets = validateAssets(raw.assets, { source, version, command });

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
    assets,
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

/**
 * Pinned candidate academic and research MCP tools from reviewed sources (docs/ACADEMIC_MCP_CATALOG.md).
 * Strict boundaries:
 *  - Pinned commit / version and SHA-256 integrity hash.
 *  - Allowed open-source licenses (MIT, Apache-2.0).
 *  - Shell and eval commands strictly forbidden.
 *  - Self-declared read-only tools only (write tools prohibited).
 *  - Secrets declared with secret: true only.
 */
const CANDIDATE_RESEARCH_TOOLS = Object.freeze([
  validateCatalogItem({
    serverId: 'zhtw-mcp',
    name: 'Traditional Chinese Semantics & Terminology MCP Server',
    description: 'Traditional Chinese text correction and terminology verification',
    version: '0.1.0',
    integrity: 'sha256:a0b555fb47253e580eb095d438368c6af0018cf90fffa0dbb979f081e28d084a',
    source: 'https://github.com/sysprog21/zhtw-mcp.git',
    license: 'MIT',
    // NOT INSTALLABLE (no `assets`): the only release is the rolling `latest` tag whose assets are
    // rebuilt in place (this digest, of the darwin-arm64 asset, can change), there is no pinned tag, and no
    // macOS x64 asset was found. `version` is the crate version, not a release tag.
    command: ['zhtw-mcp'],
    tools: [
      { name: 'zhtw', readOnly: true, description: 'Traditional Chinese text correction and terminology verification' }
    ],
    env: {}
  }),
  validateCatalogItem({
    serverId: 'arxiv-mcp-server',
    name: 'arXiv Research MCP Server',
    description: 'Literature tool for arXiv search and paper section reading',
    version: 'v0.8.2',
    integrity: 'sha256:17f2eda9e3a8c38fe12b9055ac07459fe031af346f465b3d3025ff551010608d',
    source: 'https://github.com/blazickjp/arxiv-mcp-server.git',
    license: 'Apache-2.0',
    // NOT INSTALLABLE (no `assets`): the v0.8.2 release only ships macOS .mcpb bundles (no Windows asset),
    // and how to run one is not verified. `integrity` is the GitHub-reported digest of the darwin-arm64
    // .mcpb (metadata only, not downloaded here); it replaces an earlier value that was a commit SHA
    // extended with unexplained characters and matched no release asset.
    command: ['arxiv-mcp-server', '--storage-path', '{storage}'],
    tools: [
      { name: 'search_papers', readOnly: true, description: 'Search arXiv papers by query' },
      { name: 'get_abstract', readOnly: true, description: 'Get official arXiv paper abstract and metadata' },
      { name: 'search_paper_text', readOnly: true, description: 'Search cached paper text' },
      { name: 'read_paper', readOnly: true, description: 'Read paper full text from cache' },
      { name: 'get_paper_outline', readOnly: true, description: 'Get paper outline from cache' },
      { name: 'read_paper_section', readOnly: true, description: 'Read paper section from cache' }
    ],
    env: {}
  }),
  validateCatalogItem({
    serverId: 'github-mcp-server',
    name: 'GitHub Research MCP Server',
    description: 'Read-only repository query and file content retrieval',
    version: 'v2.0.2',
    integrity: 'sha256:5d9b38511bffc84d2272eb6189129eb721c8900e45784d8ea7eaf25f8d3dd835',
    source: 'https://github.com/github/github-mcp-server.git',
    license: 'MIT',
    command: ['github-mcp-server', 'stdio'],
    // Each sha256 below was computed in this review from the downloaded official v2.0.2 release asset and
    // matches the release's own github-mcp-server_2.0.2_checksums.txt.
    assets: [
      { platform: 'darwin', arch: 'arm64', url: 'https://github.com/github/github-mcp-server/releases/download/v2.0.2/github-mcp-server_Darwin_arm64.tar.gz', format: 'tar.gz', sha256: '5d9b38511bffc84d2272eb6189129eb721c8900e45784d8ea7eaf25f8d3dd835', entry: 'github-mcp-server' },
      { platform: 'darwin', arch: 'x64', url: 'https://github.com/github/github-mcp-server/releases/download/v2.0.2/github-mcp-server_Darwin_x86_64.tar.gz', format: 'tar.gz', sha256: '7ac4d549e0bf37ad9efee7be7913cae4ad50cea8d9d5be1afa9a6dbcee9d1f2c', entry: 'github-mcp-server' },
      { platform: 'win32', arch: 'x64', url: 'https://github.com/github/github-mcp-server/releases/download/v2.0.2/github-mcp-server_Windows_x86_64.zip', format: 'zip', sha256: '4ae64087501650752f21c9d5af5378107a5116d94ee1cf37786b22b8c4bd99df', entry: 'github-mcp-server.exe' },
      { platform: 'win32', arch: 'arm64', url: 'https://github.com/github/github-mcp-server/releases/download/v2.0.2/github-mcp-server_Windows_arm64.zip', format: 'zip', sha256: '2156aeb05e76006ea379269c786de86b00e66a99009227331432068f81ceb684', entry: 'github-mcp-server.exe' }
    ],
    tools: [
      { name: 'get_file_contents', readOnly: true, description: 'Read file contents from repository' },
      { name: 'search_code', readOnly: true, description: 'Search code across repositories' },
      { name: 'search_repositories', readOnly: true, description: 'Search repositories' }
    ],
    env: {
      GITHUB_PERSONAL_ACCESS_TOKEN: { secret: true }
    }
  })
]);

module.exports = {
  validateCatalogItem,
  validateCatalog,
  filterAuthorizedTools,
  CANDIDATE_RESEARCH_TOOLS,
  CatalogError,
  ALLOWED_LICENSES,
  LIMITS
};
