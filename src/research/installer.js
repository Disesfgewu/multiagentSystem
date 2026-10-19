'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { CANDIDATE_RESEARCH_TOOLS, validateCatalogItem } = require('./catalog');
const { downloadReleaseAsset } = require('./download');
const { extractEntry } = require('./archive');

/**
 * Reviewed tool requirements and required permissions for academic/research MCP tools.
 * Derived from docs/ACADEMIC_MCP_CATALOG.md and src/roles/mcp-evaluation.js.
 */
const RESEARCH_TOOL_PERMISSIONS = Object.freeze({
  'zhtw-mcp': Object.freeze([]),
  'arxiv-mcp-server': Object.freeze(['network']),
  'github-mcp-server': Object.freeze(['githubRead', 'network'])
});

/**
 * Tools strictly forbidden from agent execution.
 * Any write, modification or execution capability must never be granted to the model.
 */
const PROHIBITED_AGENT_TOOLS = Object.freeze({
  'arxiv-mcp-server': Object.freeze(['download_paper']),
  'github-mcp-server': Object.freeze(['create_issue', 'create_pull_request', 'add_comment', 'merge_pull_request'])
});

const CONSENTS_COLLECTION = 'researchConsents';

/**
 * Checks whether a candidate path is strictly inside an allowed root boundary.
 */
function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

/**
 * Formats a plain-text markdown security manifest for explicit user review and consent.
 * Must include:
 *  - Pinned source repository
 *  - Pinned commit / version
 *  - Expected SHA-256 integrity hash
 *  - Open source license
 *  - Executable command line array
 *  - Required permissions
 *  - Exposed read-only tools
 *  - Prohibited tools
 *  - Clear honesty and safety declarations
 *
 * @param {object} item Catalog item
 * @param {object} [options]
 * @returns {string}
 */
function formatConsentManifest(item, options = {}) {
  const valid = validateCatalogItem(item);
  const permissions = options.permissions || RESEARCH_TOOL_PERMISSIONS[valid.serverId] || [];
  const prohibited = PROHIBITED_AGENT_TOOLS[valid.serverId] || [];
  const envKeys = Object.keys(valid.env || {});

  const lines = [
    `# Research MCP Tool Security Manifest: ${valid.name}`,
    '',
    `**Server ID**: \`${valid.serverId}\``,
    `**Description**: ${valid.description || 'No description provided.'}`,
    '',
    '## 1. Pinned Provenance & Source',
    `- **Repository**: \`${valid.source}\``,
    `- **Version / Tag**: \`${valid.version}\``,
    `- **Integrity Digest**: \`${valid.integrity}\``,
    `- **License (SPDX)**: \`${valid.license}\``,
    '',
    '## 2. Executable Command & Environment',
    `- **Command**: \`${valid.command.join(' ')}\``,
    `- **Arguments**: \`[${valid.command.map((c) => JSON.stringify(c)).join(', ')}]\``,
    `- **Shell Execution**: **Strictly Forbidden** (Array-based execution only; no eval / shell wrappers)`,
    `- **Required Secrets**: ${envKeys.length > 0 ? envKeys.map((k) => `\`${k}\` (SecretStorage only)`).join(', ') : 'None'}`,
    '',
    '## 3. Required Permissions (declared by the catalog; this extension does not enforce them)',
    permissions.length > 0
      ? permissions.map((p) => `- \`${p}\``).join('\n')
      : '- **None** (Pure local computation; opens no external network connections)',
    '',
    '## 4. Exposed Tools (Self-Declared Read-Only)',
    ...valid.tools.map((t) => `- \`${t.name}\`: ${t.description || 'No description'}`),
    ''
  ];

  if (prohibited.length > 0) {
    lines.push(
      '## 5. Prohibited Tools (Excluded From Agent Authorization)',
      ...prohibited.map((t) => `- \`${t}\` (**Blocked**: write, execute, or local filesystem modification)`),
      ''
    );
  }

  lines.push(
    '## Security Boundaries & Honesty Declaration',
    '- **Self-Declared Schema**: `readOnly: true` is self-declared by tool metadata (`sandboxEnforced: false`).',
    '- **Untrusted Literature**: All external documents, papers, and repository contents retrieved by this tool are strictly `untrusted-data` and must NEVER be elevated to system instructions or rules.',
    '- **Consent Required**: External tools are never downloaded, installed, or executed without explicit user consent.',
    '- **Revocation**: Consent may be revoked and installed files removed at any time.'
  );

  return `${lines.join('\n')}\n`;
}

// A server id names a folder under the install root and a key in the consent store. It must be a plain
// name: no separators, no dots at the start, nothing that could climb out of the root.
const SERVER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const assertServerId = (serverId) => {
  if (typeof serverId !== 'string' || !SERVER_ID.test(serverId) || serverId.includes('..')) {
    throw Object.assign(new Error('Invalid research tool id.'), { code: 'invalid-server-id' });
  }
};

/**
 * What a person agreed to: the exact tool, version, source, integrity hash, command, license and
 * permissions. Consent is only valid while the catalog entry still produces this same fingerprint, so a
 * catalog update that changes any of them asks again instead of inheriting the old agreement.
 */
function consentFingerprint(tool) {
  const byText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
  const envKeys = Object.keys(tool.env || {}).sort(byText);
  // Everything the consent screen shows the person is part of what they agreed to: the identity and
  // text of the tool, its command, the credential keys it needs (never their values), the tools it
  // exposes with their declared read-only flags, and the permissions and exclusions that apply. Lists whose
  // order carries no meaning are sorted, so reordering them does not ask again; the command is an argv
  // and keeps its order.
  const canonical = JSON.stringify({
    format: 3,
    serverId: tool.serverId,
    name: tool.name,
    description: tool.description ?? null,
    version: tool.version,
    source: tool.source,
    integrity: tool.integrity,
    license: tool.license,
    status: tool.status ?? null,
    sandboxEnforced: tool.sandboxEnforced === true,
    command: [...tool.command],
    assets: [...(tool.assets || [])]
      .map((asset) => [asset.platform, asset.arch, asset.url, asset.format, asset.sha256, asset.entry])
      .sort((left, right) => byText(left.join('|'), right.join('|'))),
    env: envKeys.map((key) => [key, tool.env[key] && tool.env[key].secret === true]),
    tools: [...(tool.tools || [])]
      .map((item) => [item.name, item.readOnly === true, item.description ?? null])
      .sort((left, right) => byText(left[0], right[0])),
    permissions: [...(RESEARCH_TOOL_PERMISSIONS[tool.serverId] || [])].sort(byText),
    prohibited: [...(PROHIBITED_AGENT_TOOLS[tool.serverId] || [])].sort(byText)
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Retrieves consent record from private store.
 */
function getConsentRecord(serverId, store) {
  if (!store || typeof store.get !== 'function') return null;
  try {
    const found = store.get(CONSENTS_COLLECTION, serverId);
    if (!found || !found.ok || !found.value) return null;
    return found.value;
  } catch {
    return null;
  }
}

/**
 * Checks whether user consent is currently active for a tool.
 */
function isConsentActive(serverId, store, catalog = CANDIDATE_RESEARCH_TOOLS) {
  const record = getConsentRecord(serverId, store);
  if (record === null || record.status !== 'consented' || typeof record.fingerprint !== 'string') return false;
  const entry = Array.isArray(catalog) ? catalog.find((item) => item && item.serverId === serverId) : undefined;
  if (!entry) return false;
  try {
    return record.fingerprint === consentFingerprint(validateCatalogItem(entry));
  } catch {
    return false;
  }
}

/**
 * Records explicit user consent in the private store.
 */
function grantConsent(serverId, { store, catalog = CANDIDATE_RESEARCH_TOOLS, now = () => new Date() } = {}) {
  if (!store || typeof store.put !== 'function') {
    throw Object.assign(new Error('Private store is unavailable for recording consent.'), { code: 'storage-unavailable' });
  }

  const tool = catalog.find((c) => c && c.serverId === serverId);
  if (!tool) {
    throw Object.assign(new Error(`Tool '${serverId}' is not in the reviewed research catalog.`), { code: 'tool-not-in-catalog' });
  }

  const valid = validateCatalogItem(tool);
  const record = {
    serverId: valid.serverId,
    name: valid.name,
    version: valid.version,
    source: valid.source,
    integrity: valid.integrity,
    license: valid.license,
    command: [...valid.command],
    permissions: [...(RESEARCH_TOOL_PERMISSIONS[valid.serverId] || [])],
    fingerprint: consentFingerprint(valid),
    status: 'consented',
    consentedAt: now().toISOString(),
    consentedBy: 'user'
  };

  const putResult = store.put(CONSENTS_COLLECTION, valid.serverId, record);
  if (putResult && putResult.ok === false) {
    throw Object.assign(new Error(`Failed to record consent: ${putResult.reason}`), { code: putResult.reason || 'storage-write-failed' });
  }

  return { ok: true, record };
}

/**
 * Revokes consent and removes any prepared files for the tool.
 */
function revokeConsent(serverId, { store, root, now = () => new Date() } = {}) {
  if (!store || typeof store.put !== 'function') {
    throw Object.assign(new Error('Private store is unavailable for revoking consent.'), { code: 'storage-unavailable' });
  }

  assertServerId(serverId);
  const existing = getConsentRecord(serverId, store);
  const updated = {
    ...(existing || { serverId }),
    status: 'revoked',
    revokedAt: now().toISOString()
  };

  store.put(CONSENTS_COLLECTION, serverId, updated);

  // 'none': nothing was installed; 'done': the folder is gone; 'failed': it may still be on disk.
  let cleanup = 'none';
  if (root && typeof root === 'string') {
    const installDir = path.resolve(root, serverId);
    try {
      if (isInside(path.resolve(root), installDir) && fs.existsSync(installDir)) {
        fs.rmSync(installDir, { recursive: true, force: true });
        cleanup = fs.existsSync(installDir) ? 'failed' : 'done';
      }
    } catch {
      cleanup = 'failed';
    }
  }

  return { ok: true, serverId, status: 'revoked', cleanup };
}

const PREPARED_MANIFEST = '.prepared.json';
const MAX_ASSET_BYTES = 64 * 1024 * 1024;

/**
 * A prepared folder counts as ready only if it carries the manifest written when the verified bytes were
 * installed, that manifest matches the tool entry the user consented to right now, and the executable
 * is still a plain file. A folder that merely exists (or was prepared for an older entry) is not ready.
 */
function preparedState(dir, tool) {
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return 'not-installed';
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, PREPARED_MANIFEST), 'utf8'));
    const name = manifest && manifest.executable;
    if (name !== tool.command[0] && name !== `${tool.command[0]}.exe`) return 'stale';
    const executable = fs.lstatSync(path.join(dir, name));
    return manifest.schema === 1 && manifest.fingerprint === consentFingerprint(tool) && executable.isFile() && !executable.isSymbolicLink()
      ? 'ready' : 'stale';
  } catch {
    return 'stale';
  }
}

/**
 * Lists candidate research tools with their current consent and install status.
 */
function listResearchTools({ store, catalog = CANDIDATE_RESEARCH_TOOLS, root } = {}) {
  return catalog.map((raw) => {
    const tool = validateCatalogItem(raw);
    const consent = getConsentRecord(tool.serverId, store);
    const isConsented = isConsentActive(tool.serverId, store, catalog);
    const consentOutdated = !isConsented && consent !== null && consent.status === 'consented';

    let installState = 'not-installed';
    let installPath = null;
    if (root && typeof root === 'string') {
      const candidatePath = path.join(root, tool.serverId);
      installState = preparedState(candidatePath, tool);
      if (installState === 'ready') installPath = candidatePath;
    }
    const isInstalled = installState === 'ready';

    const permissions = RESEARCH_TOOL_PERMISSIONS[tool.serverId] || [];

    let statusLabel = consentOutdated ? 'Consent outdated: the tool changed since you agreed; review it again' : 'Consent not granted';
    if (installState === 'stale') {
      statusLabel = 'Prepared files do not match the current tool entry: prepare again';
    } else if (isConsented && isInstalled) {
      statusLabel = 'Consented · Prepared (hash verified when installed; not re-checked, not running)';
    } else if (isConsented) {
      statusLabel = 'Consented · Not installed';
    }

    return {
      serverId: tool.serverId,
      name: tool.name,
      description: tool.description,
      version: tool.version,
      source: tool.source,
      integrity: tool.integrity,
      license: tool.license,
      command: [...tool.command],
      permissions,
      consentStatus: isConsented ? 'consented' : consentOutdated ? 'outdated' : 'not-granted',
      consentedAt: consent?.consentedAt || null,
      installStatus: installState,
      installPath,
      statusLabel
    };
  });
}

/**
 * Prepares a research tool after verifying explicit user consent.
 * Fail-closed design:
 *  - Throws `consent-required` if user has not explicitly consented.
 *  - Enforces private storage boundary.
 *  - Throws `asset-unavailable` and writes nothing when no asset bytes are available.
 *  - Verifies the SHA-256 integrity hash of the asset bytes before anything is written.
 *  - Extracts to temporary staging dir, cleans up on any error (no half-installed artifacts).
 *  - Atomically moves to destination.
 */
async function prepareResearchTool(serverId, deps) {
  const {
    store, root, boundary, download, catalog = CANDIDATE_RESEARCH_TOOLS, now = () => new Date(), assetBytes,
    signal, progress, fetchImpl, platform = process.platform, arch = process.arch
  } = deps;

  if (!isConsentActive(serverId, store, catalog)) {
    throw Object.assign(new Error(`Consent is required before preparing tool '${serverId}'.`), { code: 'consent-required' });
  }

  if (!root || typeof root !== 'string') {
    throw Object.assign(new Error('Root directory is required.'), { code: 'invalid-root' });
  }

  if (boundary && !isInside(boundary, root)) {
    throw Object.assign(new Error('Root directory is outside allowed boundary.'), { code: 'boundary-violation' });
  }

  const tool = catalog.find((c) => c && c.serverId === serverId);
  if (!tool) {
    throw Object.assign(new Error(`Tool '${serverId}' not found in catalog.`), { code: 'tool-not-in-catalog' });
  }
  const valid = validateCatalogItem(tool);

  // The asset is fetched and verified before anything is written. Without verified bytes nothing is
  // created at all (no folder, no placeholder script), so a missing download never looks installed.
  let bytes = assetBytes;
  let executableName = valid.command[0];
  const asset = bytes ? undefined : (valid.assets || []).find((item) => item.platform === platform && item.arch === arch);
  if (asset) {
    // Production path: one pinned release archive for this platform, fetched through the restricted
    // download layer, checked against its pinned SHA-256, then reduced to the one named executable.
    let archive;
    try {
      archive = typeof download === 'function'
        ? await download(asset.url, MAX_ASSET_BYTES, signal)
        : await downloadReleaseAsset(asset, { signal, progress, fetchImpl });
    } catch (error) {
      const code = error && typeof error.code === 'string' ? error.code : 'download-failed';
      throw Object.assign(new Error(`Download of '${valid.serverId}' failed (${code}). Nothing was written.`), { code: code === 'integrity-mismatch' ? 'hash-mismatch' : code });
    }
    if (signal && signal.aborted) {
      throw Object.assign(new Error('Download was cancelled. Nothing was written.'), { code: 'download-cancelled' });
    }
    if (!(archive instanceof Uint8Array) || archive.length === 0) {
      throw Object.assign(new Error(`No verified asset is available for tool '${valid.serverId}'. Nothing was written.`), { code: 'asset-unavailable' });
    }
    const archiveHash = createHash('sha256').update(archive).digest('hex');
    if (archiveHash !== asset.sha256) {
      throw Object.assign(new Error(`Integrity hash mismatch: expected sha256:${asset.sha256}, got sha256:${archiveHash}`), { code: 'hash-mismatch', expected: `sha256:${asset.sha256}`, actual: `sha256:${archiveHash}` });
    }
    try {
      bytes = extractEntry(archive, asset.format, asset.entry);
    } catch (error) {
      throw Object.assign(new Error(`The downloaded archive for '${valid.serverId}' is not usable (${error && error.code}). Nothing was written.`), { code: 'archive-invalid' });
    }
    executableName = asset.entry;
  } else {
    if (!bytes && !(valid.assets || []).length && typeof download === 'function') {
      // Test-only legacy hook: a caller-supplied downloader for an entry without pinned assets.
      bytes = await download(valid.source, MAX_ASSET_BYTES);
    }
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
      const reason = (valid.assets || []).length === 0 ? 'The catalog has no pinned release asset for it' : `The catalog has no pinned asset for ${platform}/${arch}`;
      throw Object.assign(new Error(`No verified asset is available for tool '${valid.serverId}'. ${reason}. Nothing was written.`), { code: 'asset-unavailable' });
    }
    const computedHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (computedHash.toLowerCase() !== valid.integrity.toLowerCase()) {
      throw Object.assign(
        new Error(`Integrity hash mismatch: expected ${valid.integrity}, got ${computedHash}`),
        { code: 'hash-mismatch', expected: valid.integrity, actual: computedHash }
      );
    }
  }

  fs.mkdirSync(root, { recursive: true, mode: 0o700 });

  const stagingDir = path.join(root, '.staging', randomUUID());
  fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });

  try {
    fs.writeFileSync(path.join(stagingDir, executableName), bytes, { mode: 0o755 });
    fs.writeFileSync(path.join(stagingDir, PREPARED_MANIFEST), JSON.stringify({
      schema: 1, serverId: valid.serverId, version: valid.version, integrity: valid.integrity,
      fingerprint: consentFingerprint(valid), executable: executableName, verifiedAt: now().toISOString()
    }), { mode: 0o600 });

    if (signal && signal.aborted) {
      throw Object.assign(new Error('Preparation was cancelled before anything was installed.'), { code: 'download-cancelled' });
    }
    // Swap the old install aside first so a failed rename restores it instead of losing a good install.
    const finalDir = path.join(root, valid.serverId);
    let backup = null;
    if (fs.existsSync(finalDir)) {
      backup = `${finalDir}.old-${randomUUID()}`;
      fs.renameSync(finalDir, backup);
    }
    try {
      fs.renameSync(stagingDir, finalDir);
    } catch (error) {
      if (backup) { try { fs.renameSync(backup, finalDir); } catch { /* nothing more can be done */ } }
      throw error;
    }
    if (backup) { try { fs.rmSync(backup, { recursive: true, force: true }); } catch { /* leftover is outside the active folder */ } }

    return {
      state: 'ready',
      serverId: valid.serverId,
      version: valid.version,
      binDir: finalDir,
      executable: path.join(finalDir, executableName),
      source: valid.source,
      verifiedAt: now().toISOString()
    };
  } catch (error) {
    // Fail-closed: clean up staging folder immediately
    try {
      if (fs.existsSync(stagingDir)) {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup error
    }
    throw error;
  }
}

module.exports = {
  RESEARCH_TOOL_PERMISSIONS,
  PROHIBITED_AGENT_TOOLS,
  CONSENTS_COLLECTION,
  formatConsentManifest,
  getConsentRecord,
  isConsentActive,
  consentFingerprint,
  grantConsent,
  revokeConsent,
  listResearchTools,
  prepareResearchTool
};
