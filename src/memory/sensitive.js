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
  // Starts only where a run of local-part characters begins. Without the lookbehind every start
  // position inside a long run re-reads the rest of the run (quadratic time on a long word).
  ['email-address', /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/],
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

// The same patterns as scanSensitive, kept in one place, compiled once with the global flag so
// every occurrence can be located. Only code, offset and length are returned, never the text.
const GLOBAL_PATTERNS = PATTERNS.map(([code, pattern]) => [code, new RegExp(pattern.source, `${pattern.flags}g`)]);

function locateSensitive(text, { limitPerCode = 20 } = {}) {
  const hits = [];
  for (const [code, pattern] of GLOBAL_PATTERNS) {
    pattern.lastIndex = 0;
    let count = 0;
    let match = pattern.exec(text);
    while (match !== null) {
      hits.push({ code, index: match.index, length: match[0].length });
      count += 1;
      if (count >= limitPerCode) break;
      if (match[0].length === 0) pattern.lastIndex += 1;
      match = pattern.exec(text);
    }
    pattern.lastIndex = 0;
  }
  return hits;
}

module.exports = { scanSensitive, locateSensitive };
