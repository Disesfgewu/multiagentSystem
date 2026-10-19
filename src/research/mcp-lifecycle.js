'use strict';

// MCP server allowlist, lifecycle and tool authorization (#61, item 6).
//
// A pure, injectable module. Everything with side effects arrives through `deps`: spawn, clock,
// private store, secret reader, workspace-trust check, executable resolver. Nothing here reads a
// workspace file to decide what runs. Rules:
//  - The allowlist and the enabled/revoked flags live only in the user-level private store. Workspace
//    MCP config files are detected and reported as ignored; they are never parsed or adopted.
//  - Starting fails closed: untrusted workspace (or a trust check that throws or answers anything but
//    `true`), revoked, no active consent, missing confirmation, missing executable, missing secret.
//  - A tool call is authorized by exact server id and exact tool name, per role group. Names that are
//    not their own NFKC form, not plain ASCII identifiers, or only prefix/case variants are refused.
//  - Secrets are read at start and placed only in the target server's environment. They never appear
//    in status objects, error codes or results.
//  - Every public function returns a decision object with a reason code and does not throw.
//  - Enforcement is honest: this only controls what the extension launches and calls. A CLI that has
//    its own MCP settings can bypass it; there is no isolation evidence, so that is NOT ENFORCED.

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { validateCatalogItem, CANDIDATE_RESEARCH_TOOLS } = require('./catalog');
const { PROHIBITED_AGENT_TOOLS, isConsentActive, getConsentRecord } = require('./installer');
const { guardOutboundQuery } = require('./query-guard');

const ALLOWLIST_COLLECTION = 'mcpAllowlist';
const ALLOWLIST_KEY = 'v1';
const STATE_COLLECTION = 'mcpLifecycle';
const GRANTABLE_ROLES = Object.freeze(['researcher']);
const SERVER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TOOL_NAME = /^[a-z0-9_]{1,64}$/;
const WORKSPACE_MCP_FILES = Object.freeze(['.mcp.json', '.vscode/mcp.json', '.cursor/mcp.json', '.claude/mcp.json', '.gemini/settings.json', '.codex/config.toml']);
const BASE_ENV_KEYS = Object.freeze(['PATH', 'SystemRoot', 'TMPDIR', 'TEMP', 'TMP', 'LANG']);
const MAX_LINE = 1024 * 1024;
const MAX_ARG_STRINGS = 20;

const ENFORCEMENT = 'extension-launch-only';
const ENFORCEMENT_NOTICE = 'NOT ENFORCED against the CLI: this controls only the MCP servers and tools this extension launches and calls. A CLI with its own MCP settings can bypass the allowlist, and there is no isolation evidence.';

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const no = (code, extra = {}) => ({ ok: false, code, ...extra });

/** A name matches only if it is already a plain ASCII identifier equal to its own NFKC form. */
function nameProblem(value, pattern) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return 'name-invalid';
  if (value.normalize('NFKC') !== value) return 'name-not-normalized';
  if (!pattern.test(value)) return 'name-invalid';
  return null;
}

/** Workspace MCP config is reported, never read. */
function scanWorkspaceMcpConfig(folders, { exists = (p) => fs.existsSync(p) } = {}) {
  const ignored = [];
  try {
    for (const folder of Array.isArray(folders) ? folders : []) {
      if (typeof folder !== 'string') continue;
      for (const rel of WORKSPACE_MCP_FILES) {
        let found = false;
        try { found = exists(path.join(folder, ...rel.split('/'))) === true; } catch { found = false; }
        if (found && !ignored.includes(rel)) ignored.push(rel);
      }
    }
  } catch { /* report what was found */ }
  return {
    ignored,
    notice: ignored.length > 0
      ? `Ignored MCP configuration found in the workspace (${ignored.join(', ')}). It is never loaded: MCP servers come only from user-level settings.`
      : null
  };
}

/** Keeps only well-formed grants for grantable roles; anything else is dropped. */
function normalizeAllowlist(raw, catalog = CANDIDATE_RESEARCH_TOOLS) {
  const grants = new Map();
  if (!isPlain(raw) || raw.schema !== 1 || !isPlain(raw.grants)) return grants;
  for (const role of GRANTABLE_ROLES) {
    if (!own(raw.grants, role) || !isPlain(raw.grants[role])) continue;
    const servers = new Map();
    for (const serverId of Object.keys(raw.grants[role])) {
      const checked = checkGrant(role, serverId, raw.grants[role][serverId], catalog);
      if (checked.ok) servers.set(serverId, new Set(checked.tools));
    }
    grants.set(role, servers);
  }
  return grants;
}

function checkGrant(role, serverId, tools, catalog) {
  if (!GRANTABLE_ROLES.includes(role)) return no('role-not-allowed');
  if (nameProblem(serverId, SERVER_ID)) return no('server-id-invalid');
  let item;
  try {
    item = validateCatalogItem((Array.isArray(catalog) ? catalog : []).find((c) => c && c.serverId === serverId));
  } catch { return no('not-in-catalog'); }
  if (!Array.isArray(tools) || tools.length === 0 || tools.length > 50) return no('tools-invalid');
  const prohibited = own(PROHIBITED_AGENT_TOOLS, serverId) ? PROHIBITED_AGENT_TOOLS[serverId] : [];
  const out = [];
  for (const tool of tools) {
    if (nameProblem(tool, TOOL_NAME)) return no('tool-name-invalid');
    if (prohibited.includes(tool)) return no('tool-prohibited');
    if (!item.tools.some((t) => t.name === tool && t.readOnly === true)) return no('tool-not-in-catalog');
    if (!out.includes(tool)) out.push(tool);
  }
  return { ok: true, tools: out };
}

function createMcpLifecycle(deps = {}) {
  const {
    store,
    catalog = CANDIDATE_RESEARCH_TOOLS,
    spawn = (file, args, options) => childProcess.spawn(file, args, options),
    now = () => new Date(),
    readSecret,
    isWorkspaceTrusted,
    resolveExecutable,
    guard = guardOutboundQuery,
    scanOptions = () => ({}),
    baseEnv = process.env,
    startTimeoutMs = 5000,
    callTimeoutMs = 15000,
    stopTimeoutMs = 2000
  } = deps;

  const running = new Map(); // serverId -> { child, pending, nextId, buffer, exited }
  const failures = new Map(); // serverId -> code
  const stopped = new Set();

  const read = (collection, key) => {
    try {
      const found = store.get(collection, key);
      return found && found.ok && isPlain(found.value) ? found.value : null;
    } catch { return null; }
  };
  const write = (collection, key, value) => {
    try { const r = store.put(collection, key, value); return !(r && r.ok === false); } catch { return false; }
  };

  const persisted = (serverId) => read(STATE_COLLECTION, serverId) || {};
  const allowlist = () => normalizeAllowlist(read(ALLOWLIST_COLLECTION, ALLOWLIST_KEY), catalog);

  function saveAllowlist(map) {
    const grants = {};
    for (const [role, servers] of map) {
      grants[role] = {};
      for (const [id, tools] of servers) grants[role][id] = [...tools];
    }
    return write(ALLOWLIST_COLLECTION, ALLOWLIST_KEY, { schema: 1, grants });
  }

  function entry(serverId) {
    if (nameProblem(serverId, SERVER_ID)) return null;
    try {
      const raw = (Array.isArray(catalog) ? catalog : []).find((c) => c && c.serverId === serverId);
      return raw ? validateCatalogItem(raw) : null;
    } catch { return null; }
  }

  function trusted() {
    try { return typeof isWorkspaceTrusted === 'function' && isWorkspaceTrusted() === true; } catch { return false; }
  }

  function onData(state, chunk) {
    state.buffer += chunk.toString('utf8');
    if (state.buffer.length > MAX_LINE * 2) { state.buffer = ''; failAll(state, 'response-too-large'); return; }
    let index;
    while ((index = state.buffer.indexOf('\n')) >= 0) {
      const line = state.buffer.slice(0, index).trim();
      state.buffer = state.buffer.slice(index + 1);
      if (line === '' || line.length > MAX_LINE) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (!isPlain(message) || !own(message, 'id') || !state.pending.has(message.id)) continue;
      const waiter = state.pending.get(message.id);
      state.pending.delete(message.id);
      waiter(message);
    }
  }

  function failAll(state, code) {
    for (const waiter of state.pending.values()) waiter({ transportError: code });
    state.pending.clear();
  }

  function request(state, method, params, timeoutMs) {
    return new Promise((resolve) => {
      const id = state.nextId++;
      const timer = setTimeout(() => { state.pending.delete(id); resolve({ transportError: 'timeout' }); }, timeoutMs);
      state.pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
      try {
        state.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch {
        clearTimeout(timer); state.pending.delete(id); resolve({ transportError: 'write-failed' });
      }
    });
  }

  function kill(state) {
    return new Promise((resolve) => {
      if (state.exited) return resolve(true);
      const timer = setTimeout(() => resolve(state.exited), stopTimeoutMs);
      state.child.once('exit', () => { clearTimeout(timer); resolve(true); });
      try { state.child.kill(); } catch { /* reported through the result */ }
    });
  }

  async function startServer(serverId, { confirmed, grantTools }) {
    const tool = entry(serverId);
    if (!tool) return no('not-in-catalog');
    if (!trusted()) return no('workspace-untrusted');
    if (running.has(serverId)) return no('already-running');
    const saved = persisted(serverId);
    if (saved.revoked === true) {
      const consent = getConsentRecord(serverId, store);
      const reconsented = consent && consent.status === 'consented' && typeof consent.consentedAt === 'string'
        && typeof saved.revokedAt === 'string' && consent.consentedAt > saved.revokedAt;
      if (!reconsented) return no('revoked');
    }
    if (!isConsentActive(serverId, store, catalog)) return no('consent-required');
    if (confirmed !== true) return no('confirmation-required');
    let grant = null;
    if (grantTools !== undefined) {
      grant = checkGrant('researcher', serverId, grantTools, catalog);
      if (!grant.ok) return no(grant.code);
    }
    let executable = null;
    try { executable = typeof resolveExecutable === 'function' ? await resolveExecutable(serverId, tool) : null; } catch { executable = null; }
    if (typeof executable !== 'string' || executable === '') return no('not-installed');

    const env = {};
    for (const key of BASE_ENV_KEYS) if (typeof baseEnv[key] === 'string') env[key] = baseEnv[key];
    for (const key of Object.keys(tool.env)) {
      let value = null;
      try { value = typeof readSecret === 'function' ? await readSecret(serverId, key) : null; } catch { value = null; }
      if (typeof value !== 'string' || value === '') return no('secret-missing', { secretKey: key });
      env[key] = value;
    }

    // Re-check after the awaits: trust or a revoke may have changed while secrets were read.
    if (!trusted()) return no('workspace-untrusted');
    if (persisted(serverId).revoked === true && saved.revoked !== true) return no('revoked');
    if (running.has(serverId)) return no('already-running');

    let child;
    try {
      child = spawn(executable, tool.command.slice(1), { env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch { failures.set(serverId, 'spawn-failed'); return no('spawn-failed'); }
    if (!child || !child.stdin || !child.stdout) { failures.set(serverId, 'spawn-failed'); return no('spawn-failed'); }

    const state = { child, pending: new Map(), nextId: 1, buffer: '', exited: false };
    running.set(serverId, state);
    stopped.delete(serverId);
    failures.delete(serverId);
    child.stdout.on('data', (chunk) => onData(state, chunk));
    if (child.stderr) child.stderr.on('data', () => { /* drained and dropped: never logged */ });
    child.stdin.on('error', () => {});
    child.on('error', () => { failures.set(serverId, 'spawn-failed'); failAll(state, 'process-error'); });
    child.on('exit', () => {
      state.exited = true;
      failAll(state, 'process-exited');
      if (running.get(serverId) === state) { running.delete(serverId); if (!stopped.has(serverId) && !failures.has(serverId)) failures.set(serverId, 'process-exited'); }
    });

    const reply = await request(state, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'multiagentSystem', version: '0' } }, startTimeoutMs);
    if (reply.transportError || reply.error || !isPlain(reply.result)) {
      running.delete(serverId);
      await kill(state);
      failures.set(serverId, 'handshake-failed');
      return no('handshake-failed');
    }
    try { state.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`); } catch { /* ignore */ }

    if (grant) {
      const map = allowlist();
      if (!map.has('researcher')) map.set('researcher', new Map());
      map.get('researcher').set(serverId, new Set(grant.tools));
      if (!saveAllowlist(map)) {
        running.delete(serverId); await kill(state);
        return no('persist-failed');
      }
    }
    if (!write(STATE_COLLECTION, serverId, { serverId, enabled: true, revoked: false, enabledAt: now().toISOString() })) {
      running.delete(serverId); await kill(state);
      return no('persist-failed');
    }
    return { ok: true, serverId, state: 'running' };
  }

  async function enable(serverId, options = {}) {
    try {
      const opts = isPlain(options) ? options : {};
      return await startServer(serverId, { confirmed: opts.confirmed, grantTools: opts.tools });
    } catch { return no('internal-error'); }
  }

  async function stop(serverId) {
    try {
      if (entry(serverId) === null) return no('not-in-catalog');
      const state = running.get(serverId);
      stopped.add(serverId);
      failures.delete(serverId);
      const wasRunning = Boolean(state);
      let terminated = true;
      if (state) { running.delete(serverId); terminated = await kill(state); }
      const saved = persisted(serverId);
      const persistedOk = write(STATE_COLLECTION, serverId, { ...saved, serverId, enabled: false, stoppedAt: now().toISOString() });
      if (!terminated) return no('kill-unconfirmed', { wasRunning });
      return persistedOk ? { ok: true, serverId, state: 'stopped', wasRunning } : no('persist-failed', { wasRunning });
    } catch { return no('internal-error'); }
  }

  async function revoke(serverId) {
    try {
      if (entry(serverId) === null) return no('not-in-catalog');
      // Persist first so a crash after this point can never resume the server.
      const saved = persisted(serverId);
      const persistedOk = write(STATE_COLLECTION, serverId, { ...saved, serverId, enabled: false, revoked: true, revokedAt: now().toISOString() });
      const state = running.get(serverId);
      stopped.add(serverId);
      failures.delete(serverId);
      let terminated = true;
      if (state) { running.delete(serverId); terminated = await kill(state); }
      let grantsCleared = true;
      const map = allowlist();
      for (const servers of map.values()) servers.delete(serverId);
      grantsCleared = saveAllowlist(map);
      if (!persistedOk) return no('persist-failed', { terminated });
      if (!terminated) return no('kill-unconfirmed');
      return { ok: true, serverId, state: 'revoked', grantsCleared };
    } catch { return no('internal-error'); }
  }

  async function stopAll() {
    const ids = [...running.keys()];
    const states = ids.map((id) => running.get(id));
    for (const id of ids) { running.delete(id); stopped.add(id); }
    await Promise.all(states.map((s) => kill(s)));
    return { ok: true, stopped: ids.length };
  }

  /** Authorization only. Never throws; never reveals more than a reason code. */
  function authorize({ role, serverId, tool } = {}) {
    try {
      const deny = (reason) => ({ allowed: false, reason });
      if (typeof role !== 'string' || !GRANTABLE_ROLES.includes(role)) return deny('role-not-allowed');
      if (nameProblem(serverId, SERVER_ID)) return deny('server-id-invalid');
      if (nameProblem(tool, TOOL_NAME)) return deny(nameProblem(tool, TOOL_NAME) === 'name-not-normalized' ? 'tool-name-not-normalized' : 'tool-name-invalid');
      const servers = allowlist().get(role);
      if (!servers || !servers.has(serverId)) return deny('server-not-allowlisted');
      if (!servers.get(serverId).has(tool)) return deny('tool-not-allowlisted');
      if (persisted(serverId).revoked === true) return deny('revoked');
      if (!trusted()) return deny('workspace-untrusted');
      if (!running.has(serverId)) return deny('server-not-running');
      return { allowed: true, reason: 'allowed' };
    } catch { return { allowed: false, reason: 'internal-error' }; }
  }

  function collectStrings(value, out, depth = 0) {
    if (depth > 6 || out.length > MAX_ARG_STRINGS) return false;
    if (typeof value === 'string') { out.push(value); return true; }
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return true;
    if (Array.isArray(value)) return value.every((v) => collectStrings(v, out, depth + 1));
    if (isPlain(value)) {
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
      return Object.keys(value).every((k) => { out.push(k); return collectStrings(value[k], out, depth + 1); });
    }
    return false;
  }

  /** Controlled call path: authorize, scan every outbound string, call, wrap the reply as untrusted data. */
  async function callTool({ role, serverId, tool, args = {} } = {}) {
    try {
      const decision = authorize({ role, serverId, tool });
      if (!decision.allowed) return no(decision.reason);
      if (!isPlain(args)) return no('args-invalid');
      const strings = [];
      if (!collectStrings(args, strings) || strings.length > MAX_ARG_STRINGS) return no('args-invalid');
      for (const text of strings) {
        if (text.trim() === '') continue;
        const verdict = guard(text, scanOptions());
        if (!verdict || verdict.allowed !== true) return no('query-blocked', { guardReason: verdict && typeof verdict.reason === 'string' ? verdict.reason : 'scanner-failed' });
      }
      const state = running.get(serverId);
      if (!state) return no('server-not-running');
      const reply = await request(state, 'tools/call', { name: tool, arguments: args }, callTimeoutMs);
      if (reply.transportError) return no(`transport-${reply.transportError}`);
      if (reply.error) return no('server-error');
      if (!isPlain(reply.result)) return no('bad-response');
      return {
        ok: true,
        untrusted: true,
        source: { serverId, tool, receivedAt: now().toISOString() },
        content: reply.result
      };
    } catch { return no('internal-error'); }
  }

  function status(serverId) {
    const tool = entry(serverId);
    if (!tool) return { serverId: typeof serverId === 'string' ? serverId.slice(0, 64) : null, state: 'not-installed', enforced: ENFORCEMENT, enforcementNotice: ENFORCEMENT_NOTICE, reason: 'not-in-catalog' };
    const saved = persisted(serverId);
    let state;
    if (saved.revoked === true) state = 'revoked';
    else if (running.has(serverId)) state = 'running';
    else if (failures.has(serverId)) state = 'failed';
    else if (stopped.has(serverId)) state = 'stopped';
    else if (saved.enabled === true) state = 'enabled';
    else state = 'installed';
    const servers = allowlist().get('researcher');
    return {
      serverId,
      state,
      enabled: saved.enabled === true,
      revoked: saved.revoked === true,
      failure: failures.get(serverId) || null,
      allowedTools: servers && servers.has(serverId) ? [...servers.get(serverId)] : [],
      requiredSecretKeys: Object.keys(tool.env),
      workspaceTrusted: trusted(),
      enforced: ENFORCEMENT,
      enforcementNotice: ENFORCEMENT_NOTICE
    };
  }

  async function statusAll() {
    const out = [];
    for (const raw of Array.isArray(catalog) ? catalog : []) {
      let state = status(raw && raw.serverId);
      if (state.state === 'installed' && typeof resolveExecutable === 'function') {
        let exe = null;
        try { exe = await resolveExecutable(raw.serverId, entry(raw.serverId)); } catch { exe = null; }
        if (typeof exe !== 'string' || exe === '') state = { ...state, state: 'not-installed' };
      }
      out.push(state);
    }
    return out;
  }

  return { enable, stop, revoke, stopAll, authorize, callTool, status, statusAll };
}

function statusText(s) {
  const lines = [`${s.serverId}: ${s.state}`];
  if (s.failure) lines.push(`Last failure: ${s.failure}`);
  lines.push(`Allowed tools: ${s.allowedTools && s.allowedTools.length ? s.allowedTools.join(', ') : 'none'}`);
  lines.push(`Enforcement: ${s.enforced}. ${s.enforcementNotice}`);
  return lines.join('\n');
}

module.exports = {
  createMcpLifecycle,
  scanWorkspaceMcpConfig,
  normalizeAllowlist,
  checkGrant,
  statusText,
  GRANTABLE_ROLES,
  WORKSPACE_MCP_FILES,
  ENFORCEMENT,
  ENFORCEMENT_NOTICE,
  ALLOWLIST_COLLECTION,
  STATE_COLLECTION
};
