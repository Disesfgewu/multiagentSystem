'use strict';

const { createClaudeSessionEvidenceAdapter } = require('./claude');
const { createCodexSessionEvidenceAdapter } = require('./codex');
const { createAgySessionEvidenceAdapter, createFallbackSessionEvidenceAdapter } = require('./agy');

/**
 * Creates the appropriate session observation evidence adapter for a provider.
 * Follows #58 provider registry capability mapping:
 * - claude: Claude session evidence adapter
 * - codex: Codex app-server notification adapter
 * - agy: agy universal fallback adapter (all unknown, fails closed)
 * - other: fallback adapter (all unknown, fails closed)
 */
function createSessionEvidenceAdapter(providerId, options = {}) {
  if (typeof providerId !== 'string' || providerId.length === 0) {
    throw new TypeError('providerId is required');
  }
  switch (providerId) {
    case 'claude':
      return createClaudeSessionEvidenceAdapter(options);
    case 'codex':
      return createCodexSessionEvidenceAdapter(options);
    case 'agy':
      return createAgySessionEvidenceAdapter(options);
    default:
      return createFallbackSessionEvidenceAdapter({ ...options, provider: providerId });
  }
}

module.exports = {
  createSessionEvidenceAdapter
};
