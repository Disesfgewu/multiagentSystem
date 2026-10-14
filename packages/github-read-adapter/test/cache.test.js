'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGitHubClient } = require('../src');
const { API, TOKEN, json, createFakeTransport, createClock, createFakeSleep } = require('./helpers/fake');

function setup(extra = {}) {
  const clock = createClock();
  const transport = createFakeTransport();
  const tokenRef = { value: TOKEN };
  const client = createGitHubClient({
    transport,
    getToken: () => tokenRef.value,
    now: clock,
    sleep: createFakeSleep(),
    cacheTtlMs: 30000,
    ...extra
  });
  return { clock, transport, client, tokenRef };
}

test('a fresh cached value is served without a request and keeps its original read time', async () => {
  const { clock, transport, client } = setup();
  transport.get('/x', json(200, { v: 1 }));
  const first = await client.getJson('/x');
  clock.advance(10000);
  const second = await client.getJson('/x');
  assert.equal(transport.calls.length, 1);
  assert.equal(second.source, 'cache');
  assert.equal(second.fetchedAt, first.fetchedAt);
});

test('an expired entry is revalidated with If-None-Match; 304 refreshes the read time', async () => {
  const { clock, transport, client } = setup();
  transport.get('/x', (call) => (call.headers['if-none-match'] === '"v1"' ? { status: 304, headers: {}, body: '' } : json(200, { v: 1 }, { etag: '"v1"' })));
  await client.getJson('/x');
  clock.advance(31000);
  const second = await client.getJson('/x');
  assert.equal(transport.calls.length, 2);
  assert.equal(transport.calls[1].headers['if-none-match'], '"v1"');
  assert.equal(second.source, 'revalidated');
  assert.deepEqual(second.data, { v: 1 });
  assert.equal(second.fetchedAt, '2026-10-14T12:00:31.000Z');
});

test('forceRefresh and maxAgeMs bypass a fresh entry', async () => {
  const { transport, client } = setup();
  transport.get('/x', json(200, { v: 1 }));
  await client.getJson('/x');
  await client.getJson('/x', { forceRefresh: true });
  await client.getJson('/x', { maxAgeMs: 0 });
  assert.equal(transport.calls.length, 3);
});

test('a multi-page list is never revalidated from the first page ETag', async () => {
  const { clock, transport, client } = setup();
  let generation = 1;
  transport.get('/list', (call) => {
    if (call.headers['if-none-match']) return { status: 304, headers: {}, body: '' };
    const page = Number(call.query.page || 1);
    if (page === 1) return json(200, [{ id: 1 }], { etag: '"p1"', link: `<${API}/list?per_page=100&page=2>; rel="next"` });
    return json(200, generation === 1 ? [{ id: 2 }] : [{ id: 2 }, { id: 3 }]);
  });
  const first = await client.getPaginated('/list');
  assert.equal(first.data.length, 2);
  generation = 2;
  clock.advance(31000);
  const second = await client.getPaginated('/list');
  assert.equal(second.data.length, 3, 'a new item on the last page must be picked up');
  assert.ok(transport.calls.every((call) => !call.headers['if-none-match']));
});

test('a single-page list can be revalidated', async () => {
  const { clock, transport, client } = setup();
  transport.get('/list', (call) => (call.headers['if-none-match'] ? { status: 304, headers: {}, body: '' } : json(200, [{ id: 1 }], { etag: '"e"' })));
  await client.getPaginated('/list');
  clock.advance(31000);
  const second = await client.getPaginated('/list');
  assert.equal(second.source, 'revalidated');
  assert.equal(second.data.length, 1);
});

test('entries are isolated per credential, so another account never sees cached data', async () => {
  const { transport, client, tokenRef } = setup();
  transport.get('/x', (call) => json(200, { who: call.headers.authorization }));
  const a = await client.getJson('/x');
  tokenRef.value = 'another-synthetic-token';
  const b = await client.getJson('/x');
  assert.equal(transport.calls.length, 2);
  assert.notDeepEqual(a.data, b.data);
  tokenRef.value = undefined;
  await client.getJson('/x');
  assert.equal(transport.calls.length, 3, 'anonymous access has its own cache partition');
});

test('failures are never cached, and carry the last known value only as lastKnown', async () => {
  const { clock, transport, client } = setup();
  let healthy = true;
  transport.get('/x', () => (healthy ? json(200, { v: 1 }) : json(503, {})));
  await client.getJson('/x');
  healthy = false;
  clock.advance(31000);
  const failed = await client.getJson('/x');
  assert.equal(failed.kind, 'transient');
  assert.deepEqual(failed.lastKnown.data, { v: 1 });
  assert.equal(failed.lastKnown.fetchedAt, '2026-10-14T12:00:00.000Z');
  assert.equal(failed.data, undefined, 'stale data must not look like a success payload');
  healthy = true;
  const recovered = await client.getJson('/x');
  assert.equal(recovered.kind, 'ok');
  assert.equal(recovered.source, 'network');
});

test('offline with a cached value reports offline plus lastKnown', async () => {
  const clock = createClock();
  let online = true;
  const client = createGitHubClient({
    transport: async () => {
      if (!online) {
        const error = new Error('x');
        error.code = 'ENOTFOUND';
        throw error;
      }
      return json(200, { v: 1 });
    },
    getToken: () => TOKEN,
    now: clock
  });
  await client.getJson('/x');
  online = false;
  clock.advance(31000);
  const result = await client.getJson('/x');
  assert.equal(result.kind, 'offline');
  assert.deepEqual(result.lastKnown.data, { v: 1 });
  assert.equal(result.lastKnown.fetchedAt, '2026-10-14T12:00:00.000Z');
});

test('the cache is bounded and clearCache empties it', async () => {
  const { transport, client } = setup({ maxCacheEntries: 2 });
  transport.get(/^\/e\d$/, (call) => json(200, { path: call.path }));
  await client.getJson('/e1');
  await client.getJson('/e2');
  await client.getJson('/e3');
  assert.equal(transport.calls.length, 3);
  await client.getJson('/e1');
  assert.equal(transport.calls.length, 4, 'oldest entry was evicted');
  await client.getJson('/e3');
  assert.equal(transport.calls.length, 4);
  client.clearCache();
  await client.getJson('/e3');
  assert.equal(transport.calls.length, 5);
});
