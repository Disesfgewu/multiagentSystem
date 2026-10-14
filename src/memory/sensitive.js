'use strict';

// Shape-based detectors. They only ever return a code, never the matched text,
// so a finding can be logged or shown without repeating the secret.
const PATTERNS = Object.freeze([
  ['private-key-block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{8,}/],
  ['api-key', /\bsk-[A-Za-z0-9]{20,}/],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ['cloud-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['bearer-token', /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i],
  ['credential-assignment', /\b(?:api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*["']?[^\s"']{8,}/i],
  ['email-address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/],
  ['home-path', /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^\s/\\]+/],
  ['uuid', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i]
]);

function scanSensitive(text) {
  const findings = [];
  for (const [code, pattern] of PATTERNS) {
    if (pattern.test(text)) findings.push({ code });
  }
  return findings;
}

module.exports = { scanSensitive };
