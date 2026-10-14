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
function createFetchTransport(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new TypeError('a fetch implementation is required');
  return async function fetchTransport({ method, url, headers, body, signal }) {
    try {
      const response = await fetchImpl(url, { method, headers, body, signal, redirect: 'manual' });
      const text = await response.text();
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

module.exports = { TransportError, createFetchTransport, isOfflineError, errorCode };
