'use strict';

const { validateCatalogItem } = require('../research/catalog');

// A static policy preview of which MCP tools a role group's own settings would allow.
//
// This is NOT a runtime permission. Nothing here is sent to a CLI, nothing is enforced, and whether
// a CLI honors it is unknown. Catalog entries are always `unverified` (their hashes and versions are
// only shape checked). The text it produces says so, and never calls a tool "effective" or
// "permitted".
//
// What each tool needs is NOT guessed from its name. `REVIEWED_TOOL_REQUIREMENTS` lists, for an exact
// server id and exact tool name, the role permissions that tool would use. It is written from the
// reviewed candidate list in docs/ACADEMIC_MCP_CATALOG.md. A tool that is not listed is of unknown
// capability and is never shown as allowed, whatever its name looks like or its catalog entry says.

const REVIEWED_TOOL_REQUIREMENTS = Object.freeze({
  'zhtw-mcp': Object.freeze({
    zhtw: Object.freeze([])
  }),
  'arxiv-mcp-server': Object.freeze({
    search_papers: Object.freeze(['network']),
    get_abstract: Object.freeze(['network']),
    // These read the local cache that `download_paper` fills; they open no connection themselves.
    search_paper_text: Object.freeze([]),
    read_paper: Object.freeze([]),
    get_paper_outline: Object.freeze([]),
    read_paper_section: Object.freeze([]),
    download_paper: Object.freeze(['network', 'fileWrite'])
  }),
  'github-mcp-server': Object.freeze({
    get_file_contents: Object.freeze(['githubRead', 'network']),
    search_code: Object.freeze(['githubRead', 'network']),
    search_repositories: Object.freeze(['githubRead', 'network'])
  })
});

const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const MAX_SHOWN = 64;
const cleanText = (val) => (typeof val === 'string' ? val.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_SHOWN) : '');
const isPlain = (val) => val !== null && typeof val === 'object' && !Array.isArray(val);

/**
 * The level a role group's settings give one permission: 'deny' | 'ask' | 'allow'.
 * Accepts the permissions array from previewEffectiveRules (`[{ tool, effective }]`) or a
 * `toolPermissions` object. Anything missing or unrecognized is 'deny'.
 */
function getEffectiveLevel(permissions, name) {
  let level;
  if (Array.isArray(permissions)) {
    const entry = permissions.find((p) => p && p.tool === name);
    level = entry ? entry.effective : undefined;
  } else if (isPlain(permissions) && Object.hasOwn(permissions, name)) {
    level = permissions[name];
  }
  return level === 'allow' || level === 'ask' ? level : 'deny';
}

const requirementsFor = (serverId, tool) => (
  Object.hasOwn(REVIEWED_TOOL_REQUIREMENTS, serverId) && Object.hasOwn(REVIEWED_TOOL_REQUIREMENTS[serverId], tool)
    ? REVIEWED_TOOL_REQUIREMENTS[serverId][tool]
    : null
);

/**
 * Evaluates an MCP catalog and an allowlist against role group settings. Pure; never throws.
 *
 * @param {unknown} rawCatalog catalog entries (checked here with the catalog validator)
 * @param {unknown} rawAllowlist `{ [serverId]: string[] }`
 * @param {object} [options]
 * @param {Array|object} [options.permissions] preview permissions array or toolPermissions object
 * @returns {{ ok: boolean, reason?: string, invalidEntries: object[], allowed: object[], confirm: object[], blocked: object[] }}
 *   `allowed` means "allowed by these role settings, in a static preview" and nothing more.
 */
function evaluateMcpTools(rawCatalog, rawAllowlist, options = {}) {
  const empty = { invalidEntries: [], allowed: [], confirm: [], blocked: [] };
  if (!Array.isArray(rawCatalog)) return { ok: false, reason: 'catalog-not-array', ...empty };

  const allowlist = isPlain(rawAllowlist) ? rawAllowlist : {};
  const permissions = options && options.permissions !== undefined ? options.permissions : {};
  const invalidEntries = [];
  const validItems = [];

  rawCatalog.forEach((raw, index) => {
    if (!isPlain(raw)) {
      invalidEntries.push({ index, serverId: 'unknown', reason: 'invalid-catalog-item' });
      return;
    }
    try {
      validItems.push(validateCatalogItem(raw));
    } catch (err) {
      invalidEntries.push({ index, serverId: cleanText(raw.serverId) || 'unknown', reason: typeof err.code === 'string' ? err.code : 'invalid-catalog-item' });
    }
  });

  const requestedFor = (serverId) => {
    const list = Object.hasOwn(allowlist, serverId) && Array.isArray(allowlist[serverId]) ? allowlist[serverId] : [];
    return list.filter((name) => typeof name === 'string');
  };

  const allowed = [];
  const confirm = [];
  const blocked = [];
  const block = (serverId, tool, reason) => blocked.push({ serverId, tool, reason });

  // A tool requested for an entry that failed validation stays blocked: nothing about it is trusted.
  for (const invalid of invalidEntries) {
    for (const tool of requestedFor(invalid.serverId)) block(invalid.serverId, cleanText(tool) || 'unknown', `catalog invalid (${invalid.reason})`);
  }

  for (const item of validItems) {
    const requested = requestedFor(item.serverId);
    for (const tool of item.tools) {
      if (!requested.includes(tool.name)) {
        block(item.serverId, tool.name, 'not in the requested list');
        continue;
      }
      const needs = requirementsFor(item.serverId, tool.name);
      if (needs === null) {
        block(item.serverId, tool.name, 'capability not reviewed (unknown): treated as not allowed');
        continue;
      }
      const levels = needs.map((permission) => [permission, getEffectiveLevel(permissions, permission)]);
      const denied = levels.find(([, level]) => level === 'deny');
      if (denied) {
        block(item.serverId, tool.name, `role setting ${denied[0]}: deny`);
        continue;
      }
      const asked = levels.filter(([, level]) => level === 'ask').map(([permission]) => permission);
      if (asked.length > 0) {
        confirm.push({ serverId: item.serverId, tool: tool.name, because: asked });
        continue;
      }
      allowed.push({ serverId: item.serverId, tool: tool.name });
    }
    for (const name of requested) {
      if (!item.tools.some((tool) => tool.name === name)) block(item.serverId, cleanText(name) || 'unknown', 'not found in the catalog entry');
    }
  }

  for (const serverId of Object.keys(allowlist)) {
    const known = validItems.some((item) => item.serverId === serverId) || invalidEntries.some((entry) => entry.serverId === serverId);
    if (known) continue;
    for (const name of requestedFor(serverId)) block(cleanText(serverId) || 'unknown', cleanText(name) || 'unknown', 'server not found in the catalog');
  }

  return { ok: true, invalidEntries, allowed, confirm, blocked };
}

const HEADER = 'MCP tool preview (static policy check only: not sent to any CLI, not enforced, runtime authorization unknown, catalog sources unverified):';

/** Formats an evaluation as plain lines. `bullet` is the list marker the caller's view uses. */
function formatMcpLines(evaluation, { bullet = '•' } = {}) {
  if (!evaluation || typeof evaluation !== 'object') return [];
  if (evaluation.ok !== true) return [HEADER, `  ${bullet} (catalog could not be read: ${cleanText(evaluation.reason) || 'invalid'})`];

  const lines = [HEADER];
  for (const invalid of evaluation.invalidEntries) lines.push(`  ${bullet} catalog entry ${invalid.serverId}: rejected (${invalid.reason})`);

  if (evaluation.allowed.length === 0) {
    lines.push(`  ${bullet} (no MCP tool is allowed by these role settings)`);
  } else {
    const byServer = new Map();
    for (const entry of evaluation.allowed) {
      if (!byServer.has(entry.serverId)) byServer.set(entry.serverId, []);
      byServer.get(entry.serverId).push(entry.tool);
    }
    for (const [serverId, tools] of byServer) lines.push(`  ${bullet} ${serverId}: ${tools.join(', ')} -> allowed by role settings (preview only, not a runtime permission)`);
  }

  if (evaluation.confirm.length > 0) {
    lines.push('', 'Needs your confirmation (role setting: ask):');
    for (const entry of evaluation.confirm) lines.push(`  ${bullet} ${entry.serverId}/${entry.tool} -> ask before use (${entry.because.join(', ')})`);
  }
  if (evaluation.blocked.length > 0) {
    lines.push('', 'Blocked MCP tools:');
    for (const entry of evaluation.blocked) lines.push(`  ${bullet} ${entry.serverId}/${entry.tool} -> blocked (${entry.reason})`);
  }
  return lines;
}

module.exports = { evaluateMcpTools, formatMcpLines, getEffectiveLevel, REVIEWED_TOOL_REQUIREMENTS };
