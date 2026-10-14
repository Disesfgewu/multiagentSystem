'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGitHubClient } = require('../src');
const { API, TOKEN, json, createFakeTransport, createClock, createFakeSleep } = require('./helpers/fake');

const makeClient = (transport, extra = {}) =>
  createGitHubClient({ transport, getToken: () => TOKEN, now: createClock(), sleep: createFakeSleep(), ...extra });

const item = (id) => ({ id });
const link = (path, page) => `<${API}${path}?per_page=100&page=${page}>; rel="next"`;

function threePages() {
  return createFakeTransport().get('/list', (call) => {
    const page = Number(call.query.page || 1);
    const headers = page < 3 ? { link: link('/list', page + 1) } : {};
    return json(200, [item(page * 10 + 1), item(page * 10 + 2)], headers);
  });
}

test('follows Link rel=next across pages and keeps order', async () => {
  const transport = threePages();
  const result = await makeClient(transport).getPaginated('/list');
  assert.equal(result.kind, 'ok');
  assert.equal(result.pages, 3);
  assert.deepEqual(result.data.map((entry) => entry.id), [11, 12, 21, 22, 31, 32]);
  assert.deepEqual(transport.calls.map((call) => call.query.page), [undefined, '2', '3']);
  assert.equal(transport.calls[0].query.per_page, '100');
});

test('duplicates that shift between pages are removed by id', async () => {
  const transport = createFakeTransport().get('/list', (call) =>
    Number(call.query.page || 1) === 1
      ? json(200, [item(1), item(2)], { link: link('/list', 2) })
      : json(200, [item(2), item(3)])
  );
  const result = await makeClient(transport).getPaginated('/list');
  assert.deepEqual(result.data.map((entry) => entry.id), [1, 2, 3]);
});

test('a failing later page returns the failure with what was read, never a complete ok', async () => {
  for (const [response, kind] of [
    [json(500, { message: 'boom' }), 'transient'],
    [json(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' }), 'rate_limited'],
    [json(404, { message: 'Not Found' }), 'not_found']
  ]) {
    const transport = createFakeTransport().get('/list', (call) =>
      Number(call.query.page || 1) === 1 ? json(200, [item(1), item(2)], { link: link('/list', 2) }) : response
    );
    const result = await makeClient(transport).getPaginated('/list');
    assert.equal(result.kind, kind);
    assert.equal(result.pagesFetched, 1);
    assert.deepEqual(result.partialData.map((entry) => entry.id), [1, 2]);
  }
});

test('going offline between pages is reported as offline with partial data', async () => {
  let calls = 0;
  const transport = async () => {
    calls += 1;
    if (calls === 1) return json(200, [item(1)], { link: link('/list', 2) });
    const error = new Error('x');
    error.code = 'ECONNRESET';
    throw error;
  };
  const result = await makeClient(transport).getPaginated('/list');
  assert.equal(result.kind, 'offline');
  assert.equal(result.partialData.length, 1);
});

test('hitting the page limit is "truncated", not ok', async () => {
  const transport = createFakeTransport().get('/list', (call) => {
    const page = Number(call.query.page || 1);
    return json(200, [item(page)], { link: link('/list', page + 1) });
  });
  const result = await makeClient(transport, { maxPages: 3 }).getPaginated('/list');
  assert.equal(result.kind, 'truncated');
  assert.equal(result.pageLimit, 3);
  assert.equal(result.partialData.length, 3);
  assert.equal(transport.calls.length, 3);
});

test('a next link pointing at another origin is refused and no credentials are sent there', async () => {
  const transport = createFakeTransport().get('/list', json(200, [item(1)], { link: '<https://evil.example.invalid/steal?page=2>; rel="next"' }));
  const result = await makeClient(transport).getPaginated('/list');
  assert.equal(result.kind, 'invalid');
  assert.equal(result.reason, 'unsafe_pagination_link');
  assert.equal(transport.calls.length, 1);
});

test('wrapped payloads (check-runs style) are unwrapped and keep first-page extras', async () => {
  const transport = createFakeTransport().get('/runs', (call) =>
    Number(call.query.page || 1) === 1
      ? json(200, { total_count: 3, check_runs: [item(1), item(2)] }, { link: link('/runs', 2) })
      : json(200, { total_count: 3, check_runs: [item(3)] })
  );
  const result = await makeClient(transport).getPaginated('/runs', {
    itemsOf: (body) => ({ items: body.check_runs, extra: { total: body.total_count } })
  });
  assert.equal(result.data.length, 3);
  assert.deepEqual(result.extra, { total: 3 });
});

test('a page whose shape is wrong is invalid', async () => {
  const transport = createFakeTransport().get('/list', json(200, { not: 'a list' }));
  assert.equal((await makeClient(transport).getPaginated('/list')).kind, 'invalid');
});

test('cancelling while paginating stops the remaining page requests', async () => {
  const controller = new AbortController();
  const transport = createFakeTransport().get('/list', (call) => {
    const page = Number(call.query.page || 1);
    if (page === 2) controller.abort();
    return json(200, [item(page)], { link: link('/list', page + 1) });
  });
  const result = await makeClient(transport).getPaginated('/list', { signal: controller.signal });
  assert.equal(result.kind, 'cancelled');
  assert.equal(transport.calls.length, 2);
});
