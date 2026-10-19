'use strict';

// Independent download layer for research tool release assets (Refs #107).
//
// It fetches ONE pinned https URL, nothing else. It never executes, extracts or writes what it
// downloads: it returns verified bytes (or throws) and leaves every filesystem decision to the caller.
//
//  - Source: the asset URL must be a GitHub release download of one of the three repositories the user
//    named, with the tag in the URL equal to the pinned version. Any other owner, repo, fork or host is
//    refused before a request is made.
//  - Redirects: followed by hand through the shared allowed-redirect helper (https only, exact host
//    allowlist per hop, no userinfo, no port, at most 3 hops).
//  - Size: a declared Content-Length above the cap is refused, and the streamed body is cut off at the
//    cap, whichever the server claims.
//  - Integrity: SHA-256 of the full body must equal the pinned digest before bytes are returned.
//  - Cancellation: an AbortSignal (and a hard timeout) stops the request and the body read.

const { createHash } = require('node:crypto');
const { fetchWithAllowedRedirects, GITHUB_RELEASE_HOSTS } = require('../setup/allowedRedirects');

const ALLOWED_REPOSITORIES = Object.freeze([
  'sysprog21/zhtw-mcp',
  'blazickjp/arxiv-mcp-server',
  'github/github-mcp-server'
]);

const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const SHA256 = /^[a-f0-9]{64}$/;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

class DownloadError extends Error {
  constructor(code) {
    super(code);
    this.name = 'DownloadError';
    this.code = code;
  }
}

/**
 * Parses a release asset URL into its parts, or returns null when it is not exactly
 * https://github.com/<owner>/<repo>/releases/download/<tag>/<file> for an allowed repository.
 */
function parseReleaseAssetUrl(value) {
  if (typeof value !== 'string' || value.length > 2000) return null;
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) return null;
  const parts = parsed.pathname.split('/');
  // ['', owner, repo, 'releases', 'download', tag, file]
  if (parts.length !== 7 || parts[0] !== '' || parts[3] !== 'releases' || parts[4] !== 'download') return null;
  const [owner, repo, tag, file] = [parts[1], parts[2], parts[5], parts[6]];
  if (![owner, repo, tag, file].every((part) => SEGMENT.test(part) && part !== '.' && part !== '..')) return null;
  const repository = `${owner}/${repo}`;
  if (!ALLOWED_REPOSITORIES.includes(repository)) return null;
  return Object.freeze({ repository, tag, file, url: parsed.href });
}

/**
 * Downloads one pinned asset and returns its bytes after the size and SHA-256 checks.
 *
 * @param {{ url: string, sha256: string }} asset
 * @param {{ signal?: AbortSignal, maxBytes?: number, timeoutMs?: number, fetchImpl?: Function,
 *           progress?: (value: { received: number, total: number | null }) => void }} [options]
 * @returns {Promise<Uint8Array>}
 */
async function downloadReleaseAsset(asset, { signal, maxBytes = MAX_ASSET_BYTES, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl, progress } = {}) {
  if (!asset || typeof asset !== 'object' || !SHA256.test(String(asset.sha256))) throw new DownloadError('asset-invalid');
  if (!parseReleaseAssetUrl(asset.url)) throw new DownloadError('source-refused');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ASSET_BYTES) throw new DownloadError('asset-invalid');
  if (signal?.aborted) throw new DownloadError('download-cancelled');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let reader;
  try {
    let response;
    try {
      response = await fetchWithAllowedRedirects(asset.url, {
        allowedHosts: GITHUB_RELEASE_HOSTS,
        init: { signal: controller.signal, headers: { accept: 'application/octet-stream' } },
        ...(fetchImpl ? { fetchImpl } : {})
      });
    } catch (error) {
      if (signal?.aborted) throw new DownloadError('download-cancelled');
      if (error instanceof Error && ['source-refused', 'too-many-redirects'].includes(error.message)) throw new DownloadError(error.message);
      throw new DownloadError('download-failed');
    }
    if (!response.ok || !response.body) throw new DownloadError('download-failed');
    const header = response.headers.get('content-length');
    const declared = header === null ? NaN : Number(header);
    if (Number.isFinite(declared) && declared > maxBytes) throw new DownloadError('download-too-large');

    const chunks = [];
    let received = 0;
    reader = response.body.getReader();
    for (;;) {
      if (signal?.aborted) throw new DownloadError('download-cancelled');
      const next = await reader.read();
      if (next.done) break;
      received += next.value.byteLength;
      if (received > maxBytes) throw new DownloadError('download-too-large');
      chunks.push(next.value);
      if (progress) progress({ received, total: Number.isFinite(declared) && declared >= 0 ? declared : null });
    }
    if (signal?.aborted) throw new DownloadError('download-cancelled');
    if (received < 1) throw new DownloadError('download-failed');
    const out = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
    if (createHash('sha256').update(out).digest('hex') !== asset.sha256) throw new DownloadError('integrity-mismatch');
    return out;
  } catch (error) {
    if (reader) { try { await reader.cancel(); } catch { /* the body is already closed */ } }
    if (error instanceof DownloadError) throw error;
    throw new DownloadError(signal?.aborted ? 'download-cancelled' : 'download-failed');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

module.exports = { ALLOWED_REPOSITORIES, MAX_ASSET_BYTES, DownloadError, parseReleaseAssetUrl, downloadReleaseAsset };
