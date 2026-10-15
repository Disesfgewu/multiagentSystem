'use strict';

const { builtIn } = require('../providers/registry');

// Whether a role group's rules reached the CLI. Only an evidence record can say "sent": a
// preview, a capability or a plan is never enough. Nothing in the product records such evidence
// yet, so today the answer is never "sent"; the states below say honestly why.
//
//   sent-to-cli    evidence that this launch handed the rules to the CLI (never inferred)
//   preview-only   the provider has an injection path, but it is not connected to a launch or not
//                  verified, so nothing was sent
//   unsupported    the provider has no known way to receive rules; they must be given by hand

const STATES = Object.freeze(['sent-to-cli', 'preview-only', 'unsupported']);

const LABELS = Object.freeze({
  'sent-to-cli': 'Sent to the CLI (evidence recorded)',
  'preview-only': 'Preview only: not sent to the CLI',
  unsupported: 'Not supported by this provider: give these rules to the agent by hand'
});

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * @param {{ provider: string, registry?: object, evidence?: { kind: string, provider: string, digest: string }, digest?: string }} input
 *   `evidence` must name this provider and the digest of the rules shown, or it is ignored.
 */
function injectionStatus({ provider, evidence, digest, registry = builtIn } = {}) {
  const descriptor = registry.get(provider);
  if (!descriptor) return { state: 'unsupported', label: LABELS.unsupported, reason: 'unknown-provider' };
  const capability = descriptor.capabilities.ruleInjection;
  if (capability === 'unknown' || capability === 'unsupported') {
    return { state: 'unsupported', label: LABELS.unsupported, reason: capability === 'unsupported' ? 'provider-unsupported' : 'provider-injection-unknown' };
  }
  const proven = isPlain(evidence) && evidence.kind === 'injected' && evidence.provider === provider &&
    typeof evidence.digest === 'string' && evidence.digest !== '' && evidence.digest === digest;
  if (proven && capability === 'verified') return { state: 'sent-to-cli', label: LABELS['sent-to-cli'], reason: 'evidence' };
  return { state: 'preview-only', label: LABELS['preview-only'], reason: capability === 'verified' ? 'no-launch-evidence' : 'injection-unverified' };
}

module.exports = { injectionStatus, STATES, LABELS };
