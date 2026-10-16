'use strict';

const { builtIn, CAPABILITIES } = require('./registry');

// What the account screen says about a provider's abilities, from the registry only. Nothing here is a
// claim that something works: "verified" would need the CLI's own documentation and a run on a real
// machine, and the words say exactly what each status means.

const NAMES = Object.freeze({
  terminalLaunch: 'Start in a native terminal',
  accountIsolation: 'Keep accounts apart',
  identityVerification: 'Confirm who is signed in',
  usageObservation: 'Read usage and limits',
  ruleInjection: 'Receive role rules',
  resume: 'Resume a session',
  statusEvents: 'Report what it is doing',
  webSearch: 'Search the web',
  mcp: 'Use MCP servers'
});

const MEANING = Object.freeze({
  verified: 'verified on a real machine',
  unverified: 'the extension has code for it, not yet checked on a real machine',
  unsupported: 'not supported',
  unknown: 'unknown'
});

/** @returns {string[]} lines for one provider; an unknown provider gets one honest line */
function describeProviderCapabilities(providerId, registry = builtIn) {
  const provider = registry.get(providerId);
  if (!provider) return ['Provider abilities: unknown provider.', 'Model in use: unknown (no source reports it).'];
  const lines = [`Provider abilities (${provider.support === 'dedicated' ? 'dedicated support' : 'terminal start only'}):`];
  for (const name of CAPABILITIES) {
    const status = provider.capabilities[name];
    lines.push(`  - ${NAMES[name] ?? name}: ${Object.hasOwn(MEANING, status) ? MEANING[status] : 'unknown'}`);
  }
  lines.push('Model in use: unknown (no source reports which model a session uses).');
  return lines;
}

module.exports = { describeProviderCapabilities, NAMES, MEANING };
