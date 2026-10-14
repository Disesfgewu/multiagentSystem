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
