'use strict';

const AGY_SOURCE = 'agy-fallback-adapter';
const FALLBACK_SOURCE = 'fallback-unsupported-v1';

/**
 * Universal fallback adapter for providers without verified status/usage reporting (such as agy).
 * Fails closed: all states and usage fields are rejected, keeping snapshot observations strictly
 * unknown.
 *
 * Rules:
 * - Does not accept shell presence or process existence as evidence of model working.
 * - Does not guess or parse terminal stdout/stderr.
 * - Snapshots remain explicitly unknown for state, model, and all usage metrics.
 */
function createFallbackSessionEvidenceAdapter({
  core,
  sessionId,
  accountProfileId,
  provider = 'unsupported'
} = {}) {
  if (!core || typeof core.ingest !== 'function') throw new TypeError('core.ingest is required');
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw new TypeError('sessionId is required');
  if (typeof accountProfileId !== 'string' || accountProfileId.length === 0) throw new TypeError('accountProfileId is required');
  if (typeof provider !== 'string' || provider.length === 0) throw new TypeError('provider is required');

  const source = provider === 'agy' ? AGY_SOURCE : FALLBACK_SOURCE;

  return Object.freeze({
    provider,
    source,
    acceptedStates: Object.freeze([]),
    acceptedUsageFields: Object.freeze([]),
    accept(input) {
      if (input !== null && typeof input === 'object' && ('shellAlive' in input || 'terminalOpen' in input)) {
        return { ok: false, reason: 'shell-presence-is-not-working-evidence' };
      }
      return { ok: false, reason: 'unsupported-provider' };
    }
  });
}

function createAgySessionEvidenceAdapter({ core, sessionId, accountProfileId } = {}) {
  return createFallbackSessionEvidenceAdapter({
    core,
    sessionId,
    accountProfileId,
    provider: 'agy'
  });
}

module.exports = {
  createAgySessionEvidenceAdapter,
  createFallbackSessionEvidenceAdapter,
  AGY_SOURCE,
  FALLBACK_SOURCE
};
