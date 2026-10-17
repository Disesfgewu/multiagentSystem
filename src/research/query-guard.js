'use strict';

// Outbound query guard for the researcher role (#61, item 3).
//
// A query string or URL sent to an academic MCP server or a web endpoint is an outbound message:
// it can carry private text out of the machine. This module decides, before anything is sent,
// whether a query may leave. It is a pure decision: it sends nothing, reads nothing and opens no
// connection. The caller sends only when `allowed` is true.
//
// Rules:
//  - Fails closed: bad input, an oversized query, a scanner that throws or answers in an unexpected
//    shape, an incomplete scan and any finding all mean "not allowed".
//  - The result never contains the query or any matched text, only fixed reason codes and the
//    finding code and category. Finding detail from the scanner (hints, positions) is dropped.
//  - The content scan is the same scanner used for GitHub publication (`scanPublication`). It is a
//    shape and verbatim detector: it cannot see a paraphrase or an encoded secret, so a clear scan
//    is not proof that a query is safe. `limitations` says so in every result.
//  - A query that is a URL must be https, carry no credentials and name a host by DNS name. When
//    `allowedHosts` is supplied the host must match one entry exactly (no wildcards, no suffixes).

const { scanPublication } = require('../publish/scan');

const MAX_QUERY_CHARS = 500;
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const HAS_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
// A plain DNS name: dot separated labels of letters, digits and inner hyphens. Wildcards and any
// other character are refused even when an allow list names them.
const DNS_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const LIMITATIONS = Object.freeze([
  'paraphrase-not-detected',
  'translation-not-detected',
  'split-or-encoded-not-detected',
  'unknown-secret-formats-not-detected',
  'human-review-still-required'
]);

const REASONS = Object.freeze([
  'query-invalid',
  'query-too-long',
  'query-control-characters',
  'url-not-allowed',
  'host-not-allowed',
  'scan-blocked',
  'scan-incomplete',
  'scanner-failed',
  'allowed'
]);

const result = (allowed, reason, categories = []) => Object.freeze({
  allowed,
  reason,
  findings: Object.freeze(categories),
  limitations: LIMITATIONS
});
const refuse = (reason, findings) => result(false, reason, findings);

function urlProblem(text, allowedHosts) {
  let url;
  try {
    url = new URL(text);
  } catch {
    return 'url-not-allowed';
  }
  if (url.protocol !== 'https:') return 'url-not-allowed';
  if (url.username !== '' || url.password !== '') return 'url-not-allowed';
  const host = url.hostname;
  // A bare address or a bracketed IPv6 literal bypasses DNS-name based policy, so it is refused.
  if (host === '' || IPV4.test(host) || host.startsWith('[') || host === 'localhost' || host.endsWith('.localhost')) return 'url-not-allowed';
  if (!DNS_NAME.test(host)) return 'url-not-allowed';
  if (allowedHosts !== undefined) {
    if (!Array.isArray(allowedHosts) || !allowedHosts.every((entry) => typeof entry === 'string')) return 'host-not-allowed';
    if (!allowedHosts.includes(host)) return 'host-not-allowed';
  }
  return null;
}

/**
 * @param {unknown} query the text that is about to be sent
 * @param {object} [options]
 * @param {string[]} [options.allowedHosts] exact host names a URL query may name
 * @param {Array<{ id: string, content: string }>} [options.memories] private memory to match against
 * @param {Array<{ id: string, text: string }>} [options.rules] private rule text to match against
 * @param {Array<{ id: string, value: string }>} [options.knownValues] values known to be private
 * @param {number} [options.maxChars] length limit (cannot exceed the module limit)
 * @param {Function} [options.scan] replaces the scanner, for tests
 * @returns {{ allowed: boolean, reason: string, findings: Array<{ code: string, category: string }>, limitations: string[] }}
 */
function guardOutboundQuery(query, options = {}) {
  try {
    const opts = options !== null && typeof options === 'object' ? options : {};
    if (typeof query !== 'string' || query.trim() === '') return refuse('query-invalid');
    const limit = Number.isInteger(opts.maxChars) && opts.maxChars > 0 ? Math.min(opts.maxChars, MAX_QUERY_CHARS) : MAX_QUERY_CHARS;
    if (query.length > limit) return refuse('query-too-long');
    if (CONTROL.test(query)) return refuse('query-control-characters');

    const text = query.trim();
    if (HAS_SCHEME.test(text)) {
      const problem = urlProblem(text, opts.allowedHosts);
      if (problem) return refuse(problem);
    }

    const scan = typeof opts.scan === 'function' ? opts.scan : scanPublication;
    const scanned = scan([{ kind: 'broker-payload', text }], {
      memories: opts.memories,
      rules: opts.rules,
      knownValues: opts.knownValues
    });
    if (!scanned || typeof scanned !== 'object' || typeof scanned.status !== 'string' || !Array.isArray(scanned.findings)) {
      return refuse('scanner-failed');
    }
    const findings = scanned.findings
      .filter((finding) => finding && typeof finding.code === 'string' && typeof finding.category === 'string')
      .map((finding) => Object.freeze({ code: finding.code, category: finding.category }));
    if (scanned.status === 'error') return refuse('scanner-failed');
    if (scanned.status === 'blocked' || scanned.findings.length > 0) return refuse('scan-blocked', findings);
    if (scanned.status === 'incomplete') return refuse('scan-incomplete', findings);
    if (scanned.status !== 'clear' || scanned.blocked !== false) return refuse('scanner-failed');
    return result(true, 'allowed');
  } catch {
    // Never pass on an error, and never include its message (it could hold the query).
    return refuse('scanner-failed');
  }
}

module.exports = { guardOutboundQuery, MAX_QUERY_CHARS, LIMITATIONS, REASONS };
