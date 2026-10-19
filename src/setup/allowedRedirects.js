'use strict';

// The managed tool downloaders pin an exact https URL on one host, but `redirect: 'follow'` would let a
// response send the request anywhere. Redirects are therefore followed by hand: every hop must be
// https and on a host this download is known to use, and only a few hops are allowed. The downloaded
// bytes are still checked against a pinned SHA-256 afterwards; this keeps the request itself (and the
// bytes it makes the client buffer) on hosts that belong to the vendor.
//
// Observed 2026-10-18 with a HEAD request per pinned URL: github.com release assets answer 302 to
// release-assets.githubusercontent.com; downloads.claude.ai answers 200 with no redirect.
const GITHUB_RELEASE_HOSTS = Object.freeze([
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com'
]);
const CLAUDE_HOSTS = Object.freeze(['downloads.claude.ai']);
const MAX_HOPS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * @param {string} url the pinned https URL
 * @param {{ allowedHosts: readonly string[], init?: object, fetchImpl?: Function, maxHops?: number }} options
 * @returns {Promise<Response>} the final, non-redirect response
 */
async function fetchWithAllowedRedirects(url, { allowedHosts, init = {}, fetchImpl = globalThis.fetch, maxHops = MAX_HOPS } = {}) {
  let current = url;
  for (let hop = 0; ; hop += 1) {
    let parsed;
    try { parsed = new URL(current); } catch { throw new Error('source-refused'); }
    if (parsed.protocol !== 'https:' || !allowedHosts.includes(parsed.hostname) || parsed.username || parsed.password || parsed.port) {
      throw new Error('source-refused');
    }
    const response = await fetchImpl(current, { ...init, redirect: 'manual' });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    try { await response.body?.cancel(); } catch { /* nothing to cancel */ }
    if (hop >= maxHops) throw new Error('too-many-redirects');
    const location = response.headers.get('location');
    if (!location) throw new Error('source-refused');
    try { current = new URL(location, current).toString(); } catch { throw new Error('source-refused'); }
  }
}

module.exports = { fetchWithAllowedRedirects, GITHUB_RELEASE_HOSTS, CLAUDE_HOSTS, MAX_HOPS };
