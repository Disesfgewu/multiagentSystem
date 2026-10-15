'use strict';

const { byCodeUnit } = require('../memory/order');

// The provider registry: every CLI agent provider is one validated description, and modules ask
// the registry instead of keeping a list of provider names of their own.
//
// This module is pure. It starts nothing, reads no setting and imports no `vscode`. The
// executables of the built-in providers are written here and are never read from a setting, a
// workspace file or a project file; a launch uses an argument array, never a shell string.
//
// Capabilities are honest. Each one is `verified`, `unverified`, `unsupported` or `unknown`, and
// anything not stated is `unknown`. `verified` needs the CLI's official documentation and a run on
// a real machine; CI and synthetic data are not that evidence. A capability only says whether a
// feature has been verified. It never means the feature is allowed: permission comes from the
// role group, not from the provider.

const CAPABILITIES = Object.freeze([
  'terminalLaunch',
  'accountIsolation',
  'identityVerification',
  'usageObservation',
  'ruleInjection',
  'resume',
  'statusEvents',
  'webSearch',
  'mcp'
]);
const STATUSES = Object.freeze(['verified', 'unverified', 'unsupported', 'unknown']);
const SUPPORT = Object.freeze(['dedicated', 'terminal-only']);

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const EXECUTABLE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ARGUMENT = /^[A-Za-z0-9._=:/@+-]{1,256}$/;
const MAX_ARGUMENTS = 32;
const MAX_LABEL = 64;
const FIELDS = ['id', 'label', 'executable', 'args', 'support', 'capabilities'];
// Control, format (bidirectional overrides, zero-width) and line or paragraph separator characters.
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

class ProviderError extends TypeError {
  constructor(code) {
    super(code);
    this.name = 'ProviderError';
    this.code = code;
  }
}
const reject = (code) => { throw new ProviderError(code); };

/**
 * Validates one description and returns a frozen copy. A problem throws a ProviderError whose
 * code names the field and never carries the rejected value.
 */
function describeProvider(input) {
  if (!isPlain(input)) reject('provider-not-object');
  for (const key of Object.keys(input)) if (!FIELDS.includes(key)) reject('provider-unknown-field');
  if (typeof input.id !== 'string' || !ID.test(input.id)) reject('provider-invalid-id');
  if (typeof input.label !== 'string' || input.label.trim() === '' || input.label.length > MAX_LABEL || UNSAFE_TEXT.test(input.label)) reject('provider-invalid-label');
  if (typeof input.executable !== 'string' || !EXECUTABLE.test(input.executable)) reject('provider-invalid-executable');
  const args = input.args === undefined ? [] : input.args;
  if (!Array.isArray(args) || args.length > MAX_ARGUMENTS || args.some((arg) => typeof arg !== 'string' || !ARGUMENT.test(arg))) reject('provider-invalid-args');
  if (!SUPPORT.includes(input.support)) reject('provider-invalid-support');

  const given = input.capabilities === undefined ? {} : input.capabilities;
  if (!isPlain(given)) reject('provider-invalid-capabilities');
  for (const [name, status] of Object.entries(given)) {
    if (!CAPABILITIES.includes(name)) reject('provider-unknown-capability');
    if (!STATUSES.includes(status)) reject('provider-invalid-capability-status');
  }
  const capabilities = Object.fromEntries(CAPABILITIES.map((name) => [name, Object.hasOwn(given, name) ? given[name] : 'unknown']));

  return Object.freeze({
    id: input.id,
    label: input.label.trim(),
    executable: input.executable,
    args: Object.freeze([...args]),
    support: input.support,
    capabilities: Object.freeze(capabilities)
  });
}

// Nothing below is `verified`: no built-in capability has yet been checked against the CLI's
// official documentation on a real macOS and Windows machine. `unverified` means the product has
// code for it that no such check has confirmed; `unknown` means nothing is known.
const BUILT_IN = [
  {
    id: 'claude',
    label: 'Claude Code',
    executable: 'claude',
    support: 'dedicated',
    capabilities: {
      terminalLaunch: 'unverified',
      accountIsolation: 'unverified',
      identityVerification: 'unverified',
      usageObservation: 'unverified',
      ruleInjection: 'unverified',
      resume: 'unverified',
      statusEvents: 'unverified'
    }
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    executable: 'codex',
    support: 'dedicated',
    capabilities: {
      terminalLaunch: 'unverified',
      accountIsolation: 'unverified',
      identityVerification: 'unverified',
      ruleInjection: 'unverified'
    }
  },
  // Only a terminal launch is assumed. Its flags, login, account isolation, status events, usage
  // source, rule input and resume are unknown until official documentation and a real run say
  // otherwise, so none is written here.
  {
    id: 'agy',
    label: 'agy',
    executable: 'agy',
    support: 'terminal-only',
    capabilities: { terminalLaunch: 'unverified' }
  }
];

/** @param {object[]} descriptions */
function createRegistry(descriptions) {
  if (!Array.isArray(descriptions)) reject('registry-not-list');
  const byId = new Map();
  for (const description of descriptions) {
    const provider = describeProvider(description);
    if (byId.has(provider.id)) reject('registry-duplicate-id');
    byId.set(provider.id, provider);
  }
  const ordered = Object.freeze([...byId.values()].sort((a, b) => byCodeUnit(a.id, b.id)));
  return Object.freeze({
    /** Providers in a fixed order (by id, locale free). */
    list: () => ordered,
    ids: () => ordered.map((provider) => provider.id),
    has: (id) => typeof id === 'string' && byId.has(id),
    /** The provider, or null. Never a default and never a guess. */
    get: (id) => (typeof id === 'string' ? byId.get(id) ?? null : null),
    /** The status of one capability; `unknown` for an unknown provider or capability. */
    capability: (id, name) => (typeof id === 'string' && byId.has(id) && CAPABILITIES.includes(name) ? byId.get(id).capabilities[name] : 'unknown')
  });
}

const builtIn = createRegistry(BUILT_IN);

module.exports = { createRegistry, describeProvider, builtIn, ProviderError, CAPABILITIES, STATUSES, SUPPORT };
