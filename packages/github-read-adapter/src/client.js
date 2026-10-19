'use strict';

const { createHash } = require('node:crypto');
const { errorCode, isOfflineError } = require('./transport');

const API_VERSION = '2022-11-28';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_MESSAGE_LENGTH = 300;

const DEFAULTS = Object.freeze({
  timeoutMs: 30000,
  cacheTtlMs: 30000,
  maxCacheEntries: 200,
  maxPages: 20,
  maxRedirects: 3,
  perPage: 100,
  retry: Object.freeze({ maxRetries: 2, baseDelayMs: 500, maxDelayMs: 8000 })
});

function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (signal) signal.addEventListener('abort', done, { once: true });
  });
}

function abortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

/** Settles when either the promise settles or the signal aborts, even if the transport hangs. */
function raceAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

function parseApiBase(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('apiBaseUrl must be an absolute URL');
  }
  if (url.protocol !== 'https:') throw new TypeError('apiBaseUrl must use https');
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError('apiBaseUrl must not contain credentials, query or fragment');
  }
  return { origin: url.origin, pathname: url.pathname.replace(/\/+$/, '') };
}

function lowerCaseHeaders(headers) {
  const out = {};
  if (headers && typeof headers === 'object') {
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value === 'string') out[name.toLowerCase()] = value;
      else if (typeof value === 'number') out[name.toLowerCase()] = String(value);
    }
  }
  return out;
}

function normalizeResponse(raw) {
  const invalid = () => {
    const error = new Error('invalid transport response');
    error.code = 'INVALID_RESPONSE';
    return error;
  };
  if (!raw || typeof raw !== 'object' || !Number.isInteger(raw.status) || raw.status < 100 || raw.status > 599) {
    throw invalid();
  }
  const body = raw.body;
  if (body !== undefined && body !== null && typeof body !== 'string' && typeof body !== 'object') throw invalid();
  return { status: raw.status, headers: lowerCaseHeaders(raw.headers), body };
}

/** Parses the body once; returns { ok: true, value } or { ok: false }. */
function parseBody(body) {
  if (body === undefined || body === null) return { ok: true, value: undefined };
  if (typeof body !== 'string') return { ok: true, value: body };
  if (body.trim() === '') return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch {
    return { ok: false };
  }
}

function bodyMessage(response) {
  const parsed = parseBody(response.body);
  if (parsed.ok && parsed.value && typeof parsed.value === 'object' && typeof parsed.value.message === 'string') {
    return parsed.value.message.slice(0, MAX_MESSAGE_LENGTH);
  }
  return undefined;
}

function parseLinkNext(header) {
  if (typeof header !== 'string') return undefined;
  const pattern = /<([^>]+)>\s*;\s*rel="?([^",;]+)"?/g;
  let match = pattern.exec(header);
  while (match) {
    if (match[2].split(/\s+/).includes('next')) return match[1];
    match = pattern.exec(header);
  }
  return undefined;
}

function parseIntegerHeader(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  // A header is untrusted input: a value beyond the safe integer range is not a usable number.
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

// No rate-limit wait longer than a week is believable; anything beyond is reported as that, not as a
// date that cannot even be represented.
const MAX_REPORTED_WAIT_MS = 7 * 24 * 60 * 60 * 1000;

function fingerprint(token) {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

/**
 * Low-level read-only GitHub REST/GraphQL client.
 *
 * Reads only: every REST call is a GET; the single POST is a fixed GraphQL query
 * document that is checked to contain no mutation. The client never reads the
 * environment, files or credential stores; the caller supplies `transport` and `getToken`.
 *
 * @param {object} options
 * @param {Function} options.transport                injectable HTTP transport (see transport.js)
 * @param {() => (string|undefined|Promise<string|undefined>)} [options.getToken]
 * @param {string} [options.apiBaseUrl]               default https://api.github.com
 * @param {string} [options.userAgent]
 * @param {() => number} [options.now]                clock (ms since epoch)
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [options.sleep]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.cacheTtlMs]
 * @param {number} [options.maxCacheEntries]
 * @param {number} [options.maxPages]
 * @param {number} [options.maxRedirects]
 * @param {{ maxRetries: number, baseDelayMs: number, maxDelayMs: number }} [options.retry]
 */
function createGitHubClient(options) {
  if (!options || typeof options.transport !== 'function') throw new TypeError('transport function is required');
  const transport = options.transport;
  const getToken = options.getToken;
  const apiBase = parseApiBase(options.apiBaseUrl === undefined ? 'https://api.github.com' : options.apiBaseUrl);
  const userAgent = options.userAgent || 'multiagent-system-github-read-adapter';
  const now = options.now || Date.now;
  const sleep = options.sleep || defaultSleep;
  const timeoutMs = options.timeoutMs === undefined ? DEFAULTS.timeoutMs : options.timeoutMs;
  const defaultTtlMs = options.cacheTtlMs === undefined ? DEFAULTS.cacheTtlMs : options.cacheTtlMs;
  const maxCacheEntries = options.maxCacheEntries === undefined ? DEFAULTS.maxCacheEntries : options.maxCacheEntries;
  const maxPages = options.maxPages === undefined ? DEFAULTS.maxPages : options.maxPages;
  const maxRedirects = options.maxRedirects === undefined ? DEFAULTS.maxRedirects : options.maxRedirects;
  const retry = { ...DEFAULTS.retry, ...(options.retry || {}) };

  const cache = new Map();
  let lastRateLimit;

  // null for a time that cannot be represented (a hostile header), never a throw.
  const isoOrNull = (ms) => {
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  };
  const iso = (ms) => isoOrNull(ms) ?? new Date(0).toISOString();
  const fail = (kind, fields) => ({ kind, observedAt: iso(now()), ...fields });

  function isInsideApi(candidate) {
    return candidate.origin === apiBase.origin && candidate.pathname.startsWith(apiBase.pathname || '/');
  }

  function buildUrl(path, query) {
    if (typeof path !== 'string' || !path.startsWith('/')) throw new TypeError('path must start with "/"');
    const params = new URLSearchParams();
    for (const key of Object.keys(query || {}).sort()) {
      const value = query[key];
      if (value !== undefined && value !== null) params.set(key, String(value));
    }
    const search = params.toString();
    return `${apiBase.origin}${apiBase.pathname}${path}${search ? `?${search}` : ''}`;
  }

  function graphqlUrl() {
    const base = apiBase.pathname.replace(/\/v3$/, '');
    return `${apiBase.origin}${base}/graphql`;
  }

  async function resolveCredential() {
    if (!getToken) return { token: undefined, id: 'anonymous' };
    let token;
    try {
      token = await getToken();
    } catch {
      return { failure: fail('denied', { reason: 'credential_unavailable' }) };
    }
    if (token === undefined || token === null || token === '') return { token: undefined, id: 'anonymous' };
    if (typeof token !== 'string' || /\s/.test(token)) {
      return { failure: fail('denied', { reason: 'credential_unavailable' }) };
    }
    return { token, id: fingerprint(token) };
  }

  function recordRateLimit(headers) {
    const limit = parseIntegerHeader(headers['x-ratelimit-limit']);
    const remaining = parseIntegerHeader(headers['x-ratelimit-remaining']);
    const reset = parseIntegerHeader(headers['x-ratelimit-reset']);
    if (limit === undefined && remaining === undefined && reset === undefined) return;
    lastRateLimit = {
      limit: limit === undefined ? null : limit,
      remaining: remaining === undefined ? null : remaining,
      resetAt: reset === undefined ? null : isoOrNull(reset * 1000),
      resource: headers['x-ratelimit-resource'] || null,
      observedAt: iso(now())
    };
  }

  function describe(response) {
    const info = { status: response.status };
    const message = bodyMessage(response);
    if (message !== undefined) info.message = message;
    if (response.headers['x-github-request-id']) info.requestId = response.headers['x-github-request-id'];
    return info;
  }

  function rateLimitFields(response) {
    const headers = response.headers;
    const remaining = parseIntegerHeader(headers['x-ratelimit-remaining']);
    const reset = parseIntegerHeader(headers['x-ratelimit-reset']);
    let retryAfterSeconds = parseIntegerHeader(headers['retry-after']);
    if (retryAfterSeconds === undefined && headers['retry-after']) {
      const date = Date.parse(headers['retry-after']);
      if (!Number.isNaN(date)) retryAfterSeconds = Math.max(0, Math.ceil((date - now()) / 1000));
    }
    const message = bodyMessage(response) || '';
    const limited =
      response.status === 429 ||
      retryAfterSeconds !== undefined ||
      remaining === 0 ||
      /rate limit|abuse/i.test(message);
    const fields = {};
    const scope = retryAfterSeconds !== undefined || /secondary rate limit|abuse/i.test(message)
      ? 'secondary' : remaining === 0 ? 'primary' : 'unknown';
    let resetAtMs;
    if (retryAfterSeconds !== undefined) resetAtMs = now() + retryAfterSeconds * 1000;
    else if (scope === 'primary' && reset !== undefined) resetAtMs = reset * 1000;
    if (resetAtMs !== undefined) {
      const resetAt = isoOrNull(resetAtMs);
      if (resetAt !== null) fields.resetAt = resetAt;
      fields.retryAfterMs = Math.min(MAX_REPORTED_WAIT_MS, Math.max(0, resetAtMs - now()));
    }
    fields.scope = scope;
    return { limited, fields };
  }

  /** Maps a non-success HTTP response to a failure result, or undefined for 2xx. */
  function classifyHttpFailure(response, authMode) {
    const status = response.status;
    if (status >= 200 && status < 300) return undefined;
    const info = describe(response);
    if (status === 401) return fail('denied', { reason: 'bad_credentials', ...info });
    if (status === 403 || status === 429) {
      const rate = rateLimitFields(response);
      if (rate.limited) return fail('rate_limited', { ...rate.fields, authMode, ...info });
      return fail('denied', {
        reason: response.headers['x-github-sso'] ? 'sso_required' : 'forbidden',
        ...info
      });
    }
    if (status === 404) return fail('not_found', { possiblyHidden: true, ...info });
    if (status === 410) return fail('not_found', { gone: true, possiblyHidden: false, ...info });
    if (status === 422 && /no commit found|not a valid sha/i.test(info.message || '')) {
      return fail('not_found', { possiblyHidden: false, ...info });
    }
    if (status === 451) return fail('denied', { reason: 'unavailable_for_legal_reasons', ...info });
    return fail('invalid', { reason: 'unexpected_status', ...info });
  }

  async function callTransport(request, callerSignal) {
    const controller = new AbortController();
    let timedOut = false;
    const onCallerAbort = () => controller.abort();
    if (callerSignal) callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    let timer;
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
    }
    try {
      const raw = await raceAbort(
        Promise.resolve().then(() => transport({ ...request, signal: controller.signal })),
        controller.signal
      );
      return { response: normalizeResponse(raw) };
    } catch (error) {
      if (callerSignal && callerSignal.aborted) return { aborted: true };
      if (timedOut) return { timedOut: true };
      if (controller.signal.aborted) return { aborted: true };
      return { error };
    } finally {
      if (timer) clearTimeout(timer);
      if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
    }
  }

  function requestHeaders(spec, token) {
    const headers = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': API_VERSION,
      'user-agent': userAgent
    };
    if (token) headers.authorization = `Bearer ${token}`;
    if (spec.etag) headers['if-none-match'] = spec.etag;
    if (spec.body !== undefined) headers['content-type'] = 'application/json';
    return headers;
  }

  /** One logical request: transport call plus retry of transient failures. */
  async function attemptRequest(spec, signal, token) {
    const headers = requestHeaders(spec, token);
    for (let attempt = 0; ; attempt += 1) {
      if (signal && signal.aborted) return { failure: fail('cancelled', { reason: 'aborted' }) };
      const outcome = await callTransport(
        { method: spec.method, url: spec.url, headers, body: spec.body },
        signal
      );
      if (outcome.aborted) return { failure: fail('cancelled', { reason: 'aborted' }) };

      let failure;
      let retryAfterMs;
      if (outcome.timedOut) {
        failure = fail('transient', { reason: 'timeout' });
      } else if (outcome.error) {
        const code = errorCode(outcome.error);
        if (code === 'INVALID_RESPONSE') return { failure: fail('invalid', { reason: 'invalid_transport_response' }) };
        if (code === 'RESPONSE_TOO_LARGE') return { failure: fail('invalid', { reason: 'response_too_large' }) };
        if (isOfflineError(outcome.error)) {
          return { failure: fail('offline', { code, attempts: attempt + 1 }) };
        }
        failure = fail('transient', { reason: 'network_error', ...(code ? { code } : {}) });
      } else {
        const { response } = outcome;
        recordRateLimit(response.headers);
        if (response.status !== 408 && response.status < 500) return { response };
        failure = fail('transient', { reason: 'server_error', ...describe(response) });
        const seconds = parseIntegerHeader(response.headers['retry-after']);
        if (seconds !== undefined) retryAfterMs = seconds * 1000;
      }

      if (attempt >= retry.maxRetries) return { failure: { ...failure, attempts: attempt + 1 } };
      const backoff = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** attempt);
      const delay = Math.min(retry.maxDelayMs, Math.max(backoff, retryAfterMs || 0));
      await sleep(delay, signal);
    }
  }

  /** attemptRequest plus same-origin redirect following (GET only). */
  async function execute(spec, signal, token) {
    let url = spec.url;
    let redirects = 0;
    for (;;) {
      const attempt = await attemptRequest({ ...spec, url }, signal, token);
      if (attempt.failure) return attempt;
      const { response } = attempt;
      if (!REDIRECT_STATUSES.has(response.status)) return { response, redirected: redirects > 0 };

      let target;
      try {
        target = new URL(response.headers.location, url);
      } catch {
        target = undefined;
      }
      if (spec.method !== 'GET' || !target || !isInsideApi(target) || redirects >= maxRedirects) {
        return { failure: fail('invalid', { reason: 'unsafe_redirect', status: response.status }) };
      }
      redirects += 1;
      url = target.href;
    }
  }

  function cacheGet(key) {
    const entry = cache.get(key);
    if (entry) {
      cache.delete(key);
      cache.set(key, entry);
    }
    return entry;
  }

  function cacheSet(key, entry) {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value);
  }

  function successFrom(entry, source) {
    const result = {
      kind: entry.empty ? 'empty' : 'ok',
      data: entry.data,
      fetchedAt: iso(entry.fetchedAtMs),
      source,
      pages: entry.pages
    };
    if (entry.extra !== undefined) result.extra = entry.extra;
    if (lastRateLimit) result.rateLimit = { ...lastRateLimit };
    return result;
  }

  function withLastKnown(failure, entry, partialData, pagesFetched) {
    const out = { ...failure };
    if (entry) out.lastKnown = { data: entry.data, ...(entry.extra !== undefined ? { extra: entry.extra } : {}), fetchedAt: iso(entry.fetchedAtMs) };
    if (partialData !== undefined && partialData.length > 0) {
      out.partialData = partialData;
      out.pagesFetched = pagesFetched;
    }
    return out;
  }

  function readPage(response, itemsOf) {
    const parsed = parseBody(response.body);
    if (!parsed.ok) return { failure: fail('invalid', { reason: 'malformed_json', status: response.status }) };
    try {
      return { value: itemsOf(parsed.value) };
    } catch {
      return { failure: fail('invalid', { reason: 'unexpected_shape', status: response.status }) };
    }
  }

  /**
   * Reads one JSON document.
   * @returns {Promise<object>} result with raw `data`
   */
  async function getJson(path, opts = {}) {
    const signal = opts.signal;
    if (signal && signal.aborted) return fail('cancelled', { reason: 'aborted' });
    const credential = await resolveCredential();
    if (credential.failure) return credential.failure;

    const url = buildUrl(path, opts.query);
    const key = `${credential.id}\n${url}`;
    const ttl = opts.maxAgeMs === undefined ? defaultTtlMs : opts.maxAgeMs;
    const entry = cacheGet(key);
    if (entry && !opts.forceRefresh && now() - entry.fetchedAtMs < ttl) return successFrom(entry, 'cache');

    const outcome = await execute(
      { method: 'GET', url, etag: entry && entry.etag },
      signal,
      credential.token
    );
    if (outcome.failure) return withLastKnown(outcome.failure, entry);
    const { response } = outcome;

    if (response.status === 304) {
      if (!entry) return fail('invalid', { reason: 'unexpected_not_modified', status: 304 });
      entry.fetchedAtMs = now();
      cacheSet(key, entry);
      return successFrom(entry, 'revalidated');
    }
    const failure = classifyHttpFailure(response, credential.token ? 'vscode-session' : 'anonymous');
    if (failure) return withLastKnown(failure, entry);

    const parsed = parseBody(response.body);
    if (!parsed.ok || parsed.value === undefined) {
      return withLastKnown(fail('invalid', { reason: 'malformed_json', status: response.status }), entry);
    }
    const fresh = {
      data: parsed.value,
      empty: false,
      pages: 1,
      etag: response.headers.etag,
      fetchedAtMs: now()
    };
    cacheSet(key, fresh);
    return { ...successFrom(fresh, 'network'), ...(outcome.redirected ? { redirected: true } : {}) };
  }

  /**
   * Reads a paginated list, following `Link: rel="next"` within the API origin.
   * `itemsOf(body)` returns the items array of one page, or { items, extra } for wrapped
   * payloads; `extra` of the first page is kept. Items are de-duplicated by `idOf`.
   */
  async function getPaginated(path, opts = {}) {
    const signal = opts.signal;
    if (signal && signal.aborted) return fail('cancelled', { reason: 'aborted' });
    const credential = await resolveCredential();
    if (credential.failure) return credential.failure;

    const itemsOf = opts.itemsOf || ((body) => body);
    const idOf = opts.idOf || ((item) => (item && item.id !== undefined ? item.id : undefined));
    const firstUrl = buildUrl(path, { per_page: DEFAULTS.perPage, ...(opts.query || {}) });
    const key = `${credential.id}\n${firstUrl}`;
    const ttl = opts.maxAgeMs === undefined ? defaultTtlMs : opts.maxAgeMs;
    const entry = cacheGet(key);
    if (entry && !opts.forceRefresh && now() - entry.fetchedAtMs < ttl) return successFrom(entry, 'cache');

    const items = [];
    let extra;
    let pages = 0;
    let url = firstUrl;
    let etag;
    for (;;) {
      // A conditional request is only sound for a single-page list: an unchanged page 1
      // says nothing about later pages (new reviews/comments land on the last page).
      const conditional = pages === 0 && entry && entry.pages === 1 ? entry.etag : undefined;
      const outcome = await execute({ method: 'GET', url, etag: conditional }, signal, credential.token);
      if (outcome.failure) return withLastKnown(outcome.failure, entry, items, pages);
      const { response } = outcome;

      if (response.status === 304 && pages === 0 && conditional) {
        entry.fetchedAtMs = now();
        cacheSet(key, entry);
        return successFrom(entry, 'revalidated');
      }
      const failure = classifyHttpFailure(response, credential.token ? 'vscode-session' : 'anonymous');
      if (failure) return withLastKnown(failure, entry, items, pages);

      const page = readPage(response, (body) => {
        const value = itemsOf(body);
        const list = Array.isArray(value) ? { items: value } : value;
        if (!list || !Array.isArray(list.items)) throw new Error('shape');
        return list;
      });
      if (page.failure) return withLastKnown(page.failure, entry, items, pages);

      if (pages === 0) {
        extra = page.value.extra;
        etag = response.headers.etag;
      }
      items.push(...page.value.items);
      pages += 1;

      const nextHeader = parseLinkNext(response.headers.link);
      if (!nextHeader) break;
      let next;
      try {
        next = new URL(nextHeader, url);
      } catch {
        next = undefined;
      }
      if (!next || !isInsideApi(next)) {
        return withLastKnown(fail('invalid', { reason: 'unsafe_pagination_link' }), entry, items, pages);
      }
      if (pages >= maxPages) {
        return withLastKnown(fail('truncated', { reason: 'page_limit', pageLimit: maxPages }), entry, items, pages);
      }
      url = next.href;
    }

    const seen = new Set();
    const unique = [];
    for (const item of items) {
      const id = idOf(item);
      if (id !== undefined) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      unique.push(item);
    }
    const fresh = {
      data: unique,
      extra,
      empty: unique.length === 0,
      pages,
      etag: pages === 1 ? etag : undefined,
      fetchedAtMs: now()
    };
    cacheSet(key, fresh);
    return successFrom(fresh, 'network');
  }

  /**
   * Runs a fixed GraphQL *query* document. Mutations and subscriptions are refused;
   * results are not cached.
   */
  async function graphql({ query, variables, signal }) {
    if (typeof query !== 'string' || !/^\s*query\b/.test(query) || /\b(mutation|subscription)\b/.test(query)) {
      throw new TypeError('only GraphQL query documents are allowed');
    }
    if (signal && signal.aborted) return fail('cancelled', { reason: 'aborted' });
    const credential = await resolveCredential();
    if (credential.failure) return credential.failure;

    const outcome = await execute(
      { method: 'POST', url: graphqlUrl(), body: JSON.stringify({ query, variables: variables || {} }) },
      signal,
      credential.token
    );
    if (outcome.failure) return outcome.failure;
    const { response } = outcome;
    const failure = classifyHttpFailure(response, credential.token ? 'vscode-session' : 'anonymous');
    if (failure) return failure;

    const parsed = parseBody(response.body);
    if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') {
      return fail('invalid', { reason: 'malformed_json', status: response.status });
    }
    const errors = Array.isArray(parsed.value.errors) ? parsed.value.errors : [];
    if (errors.length > 0) {
      const types = errors.map((error) => (error && typeof error.type === 'string' ? error.type : ''));
      const message = typeof errors[0].message === 'string' ? errors[0].message.slice(0, MAX_MESSAGE_LENGTH) : undefined;
      const base = { status: response.status, ...(message ? { message } : {}) };
      if (types.includes('NOT_FOUND')) return fail('not_found', { possiblyHidden: true, ...base });
      if (types.includes('RATE_LIMITED')) {
        return fail('rate_limited', { ...rateLimitFields({ ...response, status: 200 }).fields,
          authMode: credential.token ? 'vscode-session' : 'anonymous', ...base });
      }
      if (types.includes('FORBIDDEN') || types.includes('INSUFFICIENT_SCOPES')) {
        return fail('denied', { reason: 'forbidden', ...base });
      }
      return fail('invalid', { reason: 'graphql_error', ...base });
    }
    if (!parsed.value.data || typeof parsed.value.data !== 'object') {
      return fail('invalid', { reason: 'missing_data', status: response.status });
    }
    return { kind: 'ok', data: parsed.value.data, fetchedAt: iso(now()), source: 'network', pages: 1 };
  }

  return {
    getJson,
    getPaginated,
    graphql,
    getRateLimit: () => (lastRateLimit ? { ...lastRateLimit } : undefined),
    clearCache: () => cache.clear(),
    failure: fail
  };
}

module.exports = { createGitHubClient, DEFAULTS };
