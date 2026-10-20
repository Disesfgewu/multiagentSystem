'use strict';

/**
 * What the managed-isolation platform modules (macOS, Windows) share about the environment a terminal is started with:
 * no GitHub credential, no program that asks for one, no agent socket, no injected git configuration. Names are compared
 * in upper case, so it holds on Windows, where variable names do not differ by case.
 */

const TOKEN_NAME = /^(GH|GITHUB)_[A-Z0-9_]*(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*$/;
const CREDENTIAL_VARIABLES = new Set(['GIT_ASKPASS', 'SSH_ASKPASS', 'SSH_AUTH_SOCK', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS']);

/** A copy of the environment without GitHub credentials, credential-asking programs and agent sockets. */
function scrubEnvironment(env) {
  const out = {};
  for (const [name, value] of Object.entries(env ?? {})) {
    if (typeof value !== 'string') continue;
    const upper = name.toUpperCase();
    if (TOKEN_NAME.test(upper) || CREDENTIAL_VARIABLES.has(upper) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(upper)) continue;
    out[name] = value;
  }
  return out;
}

module.exports = { scrubEnvironment };
