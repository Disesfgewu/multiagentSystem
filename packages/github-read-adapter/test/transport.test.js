'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFetchTransport, createGitHubClient, TransportError } = require('../src');

function fakeResponse(status, body, headers = {}) {
  return {
    status,
    text: async () => body,
    headers: { forEach: (callback) => Object.entries(headers).forEach(([name, value]) => callback(value, name)) }
  };
}

test('the fetch transport never follows redirects itself and lower-cases header names', async () => {
  let init;
  const transport = createFetchTransport(async (url, options) => {
    init = options;
    return fakeResponse(200, '{"a":1}', { ETag: '"x"', 'X-RateLimit-Remaining': '10' });
  });
  const response = await transport({ method: 'GET', url: 'https://api.github.com/x', headers: { accept: 'a' } });
  assert.equal(init.redirect, 'manual');
  assert.equal(init.method, 'GET');
  assert.deepEqual(response, { status: 200, headers: { etag: '"x"', 'x-ratelimit-remaining': '10' }, body: '{"a":1}' });
});

test('network failures keep only an error code, never the original message', async () => {
  const cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com LOCAL_PRIVATE_MARKER'), { code: 'ENOTFOUND' });
  const transport = createFetchTransport(async () => {
    throw new TypeError('fetch failed', { cause });
  });
  await assert.rejects(
    () => transport({ method: 'GET', url: 'https://api.github.com/x', headers: {} }),
    (error) => error instanceof TransportError && error.code === 'ENOTFOUND' && !/LOCAL_PRIVATE_MARKER/.test(error.message)
  );
  const bare = createFetchTransport(async () => {
    throw new TypeError('fetch failed');
  });
  await assert.rejects(() => bare({ method: 'GET', url: 'https://api.github.com/x', headers: {} }), (error) => error.code === 'OFFLINE');
});

test('through the client, a dead network reads as offline and a body-read failure as well', async () => {
  const dead = createFetchTransport(async () => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) });
  });
  assert.equal((await createGitHubClient({ transport: dead }).getJson('/x')).kind, 'offline');
  const midBody = createFetchTransport(async () => ({
    status: 200,
    headers: { forEach() {} },
    text: async () => {
      throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    }
  }));
  assert.equal((await createGitHubClient({ transport: midBody }).getJson('/x')).kind, 'offline');
});

test('an abort is rethrown as is so the client can report cancelled', async () => {
  const controller = new AbortController();
  const transport = createFetchTransport(
    (url, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      })
  );
  const pending = createGitHubClient({ transport }).getJson('/x', { signal: controller.signal });
  setTimeout(() => controller.abort(), 5);
  assert.equal((await pending).kind, 'cancelled');
});

test('a fetch implementation is required', () => {
  assert.throws(() => createFetchTransport(null), TypeError);
});

test('a response larger than the cap is refused before or while it is read, and never buffered whole', async () => {
  const request = { method: 'GET', url: 'https://api.github.com/x', headers: {} };
  // Declared too large: refused without reading the body.
  let cancelled = false;
  const declared = new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024)); }, cancel() { cancelled = true; } }), { headers: { 'content-length': String(10 * 1024 * 1024) } });
  await assert.rejects(createFetchTransport(async () => declared, { maxBodyBytes: 1024 * 1024 })(request), (error) => error.code === 'RESPONSE_TOO_LARGE');
  assert.equal(cancelled, true, 'the stream is cancelled, not drained');

  // No content-length (chunked): stopped as soon as the cap is crossed.
  let pulled = 0;
  let streamCancelled = false;
  const endless = new Response(new ReadableStream({ pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(64 * 1024)); }, cancel() { streamCancelled = true; } }));
  await assert.rejects(createFetchTransport(async () => endless, { maxBodyBytes: 256 * 1024 })(request), (error) => error.code === 'RESPONSE_TOO_LARGE');
  assert.equal(streamCancelled, true);
  assert.ok(pulled < 10, `an endless body was read ${pulled} times before being stopped`);

  // A body under the cap is returned intact, including multi-byte characters split across chunks.
  const text = JSON.stringify({ title: '中文標題 ✓' });
  const bytes = new TextEncoder().encode(text);
  const chunked = new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 7)); controller.enqueue(bytes.slice(7)); controller.close(); } }), { status: 200 });
  const ok = await createFetchTransport(async () => chunked, { maxBodyBytes: 1024 })(request);
  assert.equal(ok.body, text);
  assert.equal(ok.status, 200);
});

test('the client reports an oversized response as invalid, once, and does not retry it', async () => {
  let calls = 0;
  const transport = async () => { calls += 1; throw new TransportError('response too large', { code: 'RESPONSE_TOO_LARGE' }); };
  const client = createGitHubClient({ transport, getToken: () => 'synthetic-token', sleep: async () => {} });
  const result = await client.getJson('/x');
  assert.equal(result.kind, 'invalid');
  assert.equal(result.reason, 'response_too_large');
  assert.equal(calls, 1);
});
