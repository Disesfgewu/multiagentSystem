'use strict';

/**
 * A transport is `async ({ method, url, headers, body, signal }) => { status, headers, body }`.
 * `headers` of the response should use lower-case names; `body` is the raw text or an
 * already parsed JSON value. Throw to signal that no HTTP response was obtained.
 */
class TransportError extends Error {
  /** @param {string} message @param {{ code?: string }} [details] */
  constructor(message, details = {}) {
    super(message);
    this.name = 'TransportError';
    this.code = details.code;
  }
}

const OFFLINE_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'OFFLINE'
]);

function errorCode(error) {
  if (!error || typeof error !== 'object') return undefined;
  if (typeof error.code === 'string') return error.code;
  if (error.cause && typeof error.cause.code === 'string') return error.cause.code;
  return undefined;
}

/** True when the failure means "cannot reach the server" rather than "server misbehaved". */
function isOfflineError(error) {
  const code = errorCode(error);
  return code !== undefined && OFFLINE_CODES.has(code);
}

/**
 * Transport backed by a WHATWG `fetch`. Redirects are never followed here: the client
 * follows same-origin redirects itself so the Authorization header cannot leak to another host.
 * Only the error `code` is kept from network failures (messages can carry local details).
 */
// One API page is far below this; the cap exists so a hostile or broken server cannot make the client
// buffer and parse an unbounded body (pagination can read up to 20 pages, and parsed pages are cached).
const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;

async function readCapped(response, maxBytes) {
  const declared = typeof response.headers?.get === 'function' ? Number(response.headers.get('content-length')) : Number.NaN;
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await response.body?.cancel(); } catch { /* nothing to cancel */ }
    throw new TransportError('response too large', { code: 'RESPONSE_TOO_LARGE' });
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new TransportError('response too large', { code: 'RESPONSE_TOO_LARGE' });
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let received = 0;
  let text = '';
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    received += next.value.byteLength;
    if (received > maxBytes) {
      try { await reader.cancel(); } catch { /* already closed */ }
      throw new TransportError('response too large', { code: 'RESPONSE_TOO_LARGE' });
    }
    text += decoder.decode(next.value, { stream: true });
  }
  return text + decoder.decode();
}

function createFetchTransport(fetchImpl = globalThis.fetch, { maxBodyBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('a fetch implementation is required');
  return async function fetchTransport({ method, url, headers, body, signal }) {
    try {
      const response = await fetchImpl(url, { method, headers, body, signal, redirect: 'manual' });
      const text = await readCapped(response, maxBodyBytes);
      const responseHeaders = {};
      response.headers.forEach((value, name) => {
        responseHeaders[name.toLowerCase()] = value;
      });
      return { status: response.status, headers: responseHeaders, body: text };
    } catch (error) {
      if (signal && signal.aborted) throw error;
      // fetch failures surface as TypeError('fetch failed') whose cause holds the system code;
      // a failure without any code is still "no response obtained", i.e. offline-like.
      const code = errorCode(error) || (error instanceof TypeError ? 'OFFLINE' : 'NETWORK_ERROR');
      throw new TransportError('network request failed', { code });
    }
  };
}

module.exports = { TransportError, createFetchTransport, isOfflineError, errorCode, DEFAULT_MAX_BODY_BYTES };
