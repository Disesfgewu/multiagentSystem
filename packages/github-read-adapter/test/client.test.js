'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGitHubClient, TransportError } = require('../src');
const { API, TOKEN, json, createFakeTransport, sequence, createClock, createFakeSleep } = require('./helpers/fake');

function makeClient(transport, extra = {}) {
  return createGitHubClient({
    transport,
    getToken: () => TOKEN,
    now: createClock(),
    sleep: createFakeSleep(),
    ...extra
  });
}

test('200 with data is ok and carries read time and source', async () => {
  const transport = createFakeTransport().get('/x', json(200, { a: 1 }));
  const result = await makeClient(transport).getJson('/x');
  assert.equal(result.kind, 'ok');
  assert.deepEqual(result.data, { a: 1 });
  assert.equal(result.source, 'network');
  assert.equal(result.fetchedAt, '2026-10-14T12:00:00.000Z');
});

test('200 with an empty list is "empty", distinct from every failure', async () => {
  const transport = createFakeTransport().get('/list', json(200, []));
  const result = await makeClient(transport).getPaginated('/list');
  assert.equal(result.kind, 'empty');
  assert.deepEqual(result.data, []);
});

test('404 is not_found and says the resource may be hidden from this credential', async () => {
  const transport = createFakeTransport().get('/x', json(404, { message: 'Not Found' }));
  const result = await makeClient(transport).getJson('/x');
  assert.equal(result.kind, 'not_found');
  assert.equal(result.possiblyHidden, true);
  assert.equal(result.status, 404);
});

test('410 is not_found with gone=true', async () => {
  const transport = createFakeTransport().get('/x', json(410, { message: 'Issues are disabled for this repo' }));
  const result = await makeClient(transport).getJson('/x');
  assert.equal(result.kind, 'not_found');
  assert.equal(result.gone, true);
});

test('401 is denied/bad_credentials', async () => {
  const transport = createFakeTransport().get('/x', json(401, { message: 'Bad credentials' }));
  const result = await makeClient(transport).getJson('/x');
  assert.equal(result.kind, 'denied');
  assert.equal(result.reason, 'bad_credentials');
});

test('403 without a rate-limit signal is denied/forbidden, with SSO called out', async () => {
  const forbidden = createFakeTransport().get('/x', json(403, { message: 'Resource not accessible by integration' }));
  const a = await makeClient(forbidden).getJson('/x');
  assert.equal(a.kind, 'denied');
  assert.equal(a.reason, 'forbidden');

  const sso = createFakeTransport().get('/x', json(403, { message: 'Resource protected by organization SAML enforcement' }, { 'x-github-sso': 'required; url=https://example.invalid' }));
  const b = await makeClient(sso).getJson('/x');
  assert.equal(b.reason, 'sso_required');
});

test('403 with remaining=0 is a primary rate limit with reset time', async () => {
  const clock = createClock();
  const reset = Math.floor(clock() / 1000) + 90;
  const transport = createFakeTransport().get('/x', json(403, { message: 'API rate limit exceeded' }, {
    'x-ratelimit-remaining': '0',
    'x-ratelimit-limit': '60',
    'x-ratelimit-reset': String(reset)
  }));
  const result = await makeClient(transport, { now: clock }).getJson('/x');
  assert.equal(result.kind, 'rate_limited');
  assert.equal(result.scope, 'primary');
  assert.equal(result.resetAt, new Date(reset * 1000).toISOString());
  assert.equal(result.retryAfterMs, 90000);
});

test('secondary rate limit (retry-after) and 429 are rate_limited, and are not retried', async () => {
  const secondary = createFakeTransport().get('/x', json(403, { message: 'You have exceeded a secondary rate limit.' }, { 'retry-after': '30' }));
  const sleep = createFakeSleep();
  const a = await makeClient(secondary, { sleep }).getJson('/x');
  assert.equal(a.kind, 'rate_limited');
  assert.equal(a.scope, 'secondary');
  assert.equal(a.retryAfterMs, 30000);
  assert.equal(secondary.calls.length, 1);
  assert.deepEqual(sleep.delays, []);

  const tooMany = createFakeTransport().get('/x', json(429, { message: 'slow down' }));
  assert.equal((await makeClient(tooMany).getJson('/x')).kind, 'rate_limited');
});

test('5xx is retried with exponential backoff and then reported as transient', async () => {
  const transport = createFakeTransport().get('/x', json(503, { message: 'unavailable' }));
  const sleep = createFakeSleep();
  const result = await makeClient(transport, { sleep }).getJson('/x');
  assert.equal(result.kind, 'transient');
  assert.equal(result.reason, 'server_error');
  assert.equal(result.attempts, 3);
  assert.equal(transport.calls.length, 3);
  assert.deepEqual(sleep.delays, [500, 1000]);
});

test('a transient failure that recovers inside the retry budget yields ok', async () => {
  const transport = createFakeTransport().get('/x', sequence(json(502, {}), json(200, { fine: true })));
  const result = await makeClient(transport).getJson('/x');
  assert.equal(result.kind, 'ok');
  assert.equal(transport.calls.length, 2);
});

test('retry honours Retry-After on 503 but caps it at maxDelayMs', async () => {
  const transport = createFakeTransport().get('/x', sequence(json(503, {}, { 'retry-after': '3' }), json(503, {}, { 'retry-after': '999' }), json(200, {})));
  const sleep = createFakeSleep();
  await makeClient(transport, { sleep }).getJson('/x');
  assert.deepEqual(sleep.delays, [3000, 8000]);
});

test('network failure is offline and is not retried', async () => {
  const sleep = createFakeSleep();
  let attempts = 0;
  const transport = async () => {
    attempts += 1;
    throw new TransportError('x', { code: 'ENOTFOUND' });
  };
  const result = await makeClient(transport, { sleep }).getJson('/x');
  assert.equal(result.kind, 'offline');
  assert.equal(result.code, 'ENOTFOUND');
  assert.equal(attempts, 1);
});

test('an unclassified transport exception is transient (retried), not offline', async () => {
  let attempts = 0;
  const transport = async () => {
    attempts += 1;
    throw new Error('boom with LOCAL_PRIVATE_MARKER');
  };
  const result = await makeClient(transport).getJson('/x');
  assert.equal(result.kind, 'transient');
  assert.equal(attempts, 3);
  assert.doesNotMatch(JSON.stringify(result), /LOCAL_PRIVATE_MARKER/);
});

test('malformed JSON and unexpected statuses are invalid', async () => {
  const bad = createFakeTransport().get('/x', { status: 200, headers: {}, body: '{not json' });
  assert.equal((await makeClient(bad).getJson('/x')).kind, 'invalid');
  const teapot = createFakeTransport().get('/x', json(418, {}));
  assert.equal((await makeClient(teapot).getJson('/x')).kind, 'invalid');
  const garbage = async () => 'not a response';
  const result = await makeClient(garbage).getJson('/x');
  assert.equal(result.kind, 'invalid');
  assert.equal(result.reason, 'invalid_transport_response');
});

test('a caller abort before the request is cancelled without touching the transport', async () => {
  const transport = createFakeTransport().get('/x', json(200, {}));
  const controller = new AbortController();
  controller.abort();
  const result = await makeClient(transport).getJson('/x', { signal: controller.signal });
  assert.equal(result.kind, 'cancelled');
  assert.equal(transport.calls.length, 0);
});

test('aborting during a request cancels it even when the transport ignores the signal', async () => {
  const transport = () => new Promise(() => {});
  const controller = new AbortController();
  const pending = makeClient(transport).getJson('/x', { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  assert.equal((await pending).kind, 'cancelled');
});

test('aborting during retry backoff stops further attempts', async () => {
  const controller = new AbortController();
  const transport = createFakeTransport().get('/x', json(500, {}));
  const sleep = async () => controller.abort();
  const result = await makeClient(transport, { sleep }).getJson('/x', { signal: controller.signal });
  assert.equal(result.kind, 'cancelled');
  assert.equal(transport.calls.length, 1);
});

test('a hung request times out as transient/timeout and the transport sees an aborted signal', async () => {
  let seen;
  const transport = ({ signal }) => {
    seen = signal;
    return new Promise(() => {});
  };
  const result = await makeClient(transport, { timeoutMs: 15, retry: { maxRetries: 0 } }).getJson('/x');
  assert.equal(result.kind, 'transient');
  assert.equal(result.reason, 'timeout');
  assert.equal(seen.aborted, true);
});

test('the token is sent only as an Authorization header and never appears in any result', async () => {
  const transport = createFakeTransport()
    .get('/ok', json(200, { fine: true }))
    .get('/denied', json(403, { message: 'Forbidden' }))
    .get('/missing', json(404, { message: 'Not Found' }));
  const client = makeClient(transport);
  const results = [await client.getJson('/ok'), await client.getJson('/denied'), await client.getJson('/missing')];
  assert.equal(transport.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  for (const result of results) assert.doesNotMatch(JSON.stringify(result), new RegExp(TOKEN));
});

test('without a token requests are anonymous; an unusable token is reported without leaking it', async () => {
  const transport = createFakeTransport().get('/x', json(200, {}));
  const anonymous = createGitHubClient({ transport, getToken: () => undefined });
  await anonymous.getJson('/x');
  assert.equal(transport.calls[0].headers.authorization, undefined);

  const broken = createGitHubClient({ transport, getToken: () => { throw new Error('secret store exploded: ' + TOKEN); } });
  const result = await broken.getJson('/x');
  assert.equal(result.kind, 'denied');
  assert.equal(result.reason, 'credential_unavailable');
  assert.doesNotMatch(JSON.stringify(result), /exploded|synthetic-test/);

  const spaced = createGitHubClient({ transport, getToken: () => 'bad token\nX-Injected: 1' });
  assert.equal((await spaced.getJson('/x')).reason, 'credential_unavailable');
});

test('same-origin redirects (renamed repository) are followed; cross-origin ones are refused', async () => {
  const moved = createFakeTransport()
    .get('/repos/old/name', { status: 301, headers: { location: `${API}/repositories/42` }, body: '' })
    .get('/repositories/42', json(200, { id: 42 }));
  const ok = await makeClient(moved).getJson('/repos/old/name');
  assert.equal(ok.kind, 'ok');
  assert.equal(ok.redirected, true);

  const evil = createFakeTransport().get('/x', { status: 302, headers: { location: 'https://evil.example.invalid/steal' }, body: '' });
  const refused = await makeClient(evil).getJson('/x');
  assert.equal(refused.kind, 'invalid');
  assert.equal(refused.reason, 'unsafe_redirect');
  assert.equal(evil.calls.length, 1, 'the redirect target must never be requested');

  const loop = createFakeTransport().get('/x', { status: 302, headers: { location: `${API}/x` }, body: '' });
  assert.equal((await makeClient(loop).getJson('/x')).reason, 'unsafe_redirect');
});

test('the client is read-only: REST is GET only and GraphQL accepts queries only', async () => {
  const transport = createFakeTransport().get('/x', json(200, {})).post('/graphql', json(200, { data: { ok: true } }));
  const client = makeClient(transport);
  await client.getJson('/x');
  await client.getPaginated('/x', { itemsOf: () => [] });
  await client.graphql({ query: 'query Q { viewer { login } }' });
  assert.deepEqual([...new Set(transport.calls.map((call) => call.method))].sort(), ['GET', 'POST']);
  for (const call of transport.calls.filter((c) => c.method === 'POST')) {
    assert.equal(call.path, '/graphql');
    assert.doesNotMatch(call.body, /mutation/);
  }
  await assert.rejects(() => client.graphql({ query: 'mutation M { addStar(input: {}) { clientMutationId } }' }), TypeError);
  await assert.rejects(() => client.graphql({ query: 'query Q { a } mutation M { b }' }), TypeError);
  await assert.rejects(() => client.graphql({ query: 'subscription S { a }' }), TypeError);
});

test('GraphQL errors map to the same result kinds', async () => {
  const cases = [
    [{ errors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }] }, 'not_found'],
    [{ errors: [{ type: 'FORBIDDEN', message: 'nope' }] }, 'denied'],
    [{ errors: [{ type: 'RATE_LIMITED', message: 'slow' }] }, 'rate_limited'],
    [{ errors: [{ type: 'SOMETHING', message: 'odd' }], data: { partial: true } }, 'invalid'],
    [{ data: null }, 'invalid']
  ];
  for (const [body, kind] of cases) {
    const transport = createFakeTransport().post('/graphql', json(200, body));
    assert.equal((await makeClient(transport).graphql({ query: 'query Q { a }' })).kind, kind);
  }
  const unauth = createFakeTransport().post('/graphql', json(401, { message: 'Requires authentication' }));
  assert.equal((await makeClient(unauth).graphql({ query: 'query Q { a }' })).kind, 'denied');
});

test('rate limit headers from successful responses are exposed', async () => {
  const clock = createClock();
  const transport = createFakeTransport().get('/x', json(200, {}, { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': String(Math.floor(clock() / 1000) + 3600), 'x-ratelimit-resource': 'core' }));
  const client = makeClient(transport, { now: clock });
  const result = await client.getJson('/x');
  assert.equal(result.rateLimit.remaining, 4999);
  assert.equal(client.getRateLimit().limit, 5000);
});

test('apiBaseUrl must be https without credentials', () => {
  const transport = async () => json(200, {});
  assert.throws(() => createGitHubClient({ transport, apiBaseUrl: 'http://api.example.invalid' }), TypeError);
  assert.throws(() => createGitHubClient({ transport, apiBaseUrl: 'https://user:pw@api.example.invalid' }), TypeError);
  assert.throws(() => createGitHubClient({}), TypeError);
});

test('an enterprise api base path is kept for REST and mapped for GraphQL', async () => {
  const transport = createFakeTransport().get('/api/v3/x', json(200, {})).post('/api/graphql', json(200, { data: {} }));
  const client = makeClient(transport, { apiBaseUrl: 'https://ghe.example.invalid/api/v3' });
  assert.equal((await client.getJson('/x')).kind, 'ok');
  assert.equal((await client.graphql({ query: 'query Q { a }' })).kind, 'ok');
});

test('a hung request still times out when nothing else keeps the process alive', () => {
  // Regression: an unref()ed timeout timer let the process exit before the timeout fired.
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const script = `
    const { createGitHubClient } = require(${JSON.stringify(path.join(__dirname, '..', 'src'))});
    const client = createGitHubClient({ transport: () => new Promise(() => {}), timeoutMs: 50, retry: { maxRetries: 0 } });
    client.getJson('/x').then((result) => console.log(result.kind + ':' + result.reason));
  `;
  const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 });
  assert.equal(run.stdout.trim(), 'transient:timeout');
});

test('hostile rate-limit headers never make the client throw: out-of-range numbers are ignored and waits are capped', async () => {
  const cases = [
    ['a huge reset header on a success', json(200, { v: 1 }, { 'x-ratelimit-reset': '99999999999999' }), (result) => assert.equal(result.kind, 'ok')],
    ['a huge retry-after on a 429', json(429, { message: 'x' }, { 'retry-after': '99999999999999' }), (result) => {
      assert.equal(result.kind, 'rate_limited');
      assert.equal(result.retryAfterMs, 7 * 24 * 60 * 60 * 1000, 'the reported wait is capped at a week');
      assert.equal(result.resetAt, undefined, 'a date that cannot exist is not reported');
    }],
    ['a 20-digit reset with remaining=0', json(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '99999999999999999999' }), (result) => {
      assert.equal(result.kind, 'rate_limited');
      assert.equal(result.resetAt, undefined);
    }]
  ];
  for (const [name, response, check] of cases) {
    const transport = createFakeTransport().get('/x', response);
    const result = await makeClient(transport).getJson('/x');
    assert.ok(result && typeof result === 'object', name);
    check(result);
  }
});
