'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchWithAllowedRedirects, GITHUB_RELEASE_HOSTS, CLAUDE_HOSTS, MAX_HOPS } = require('../../src/setup/allowedRedirects');

const redirect = (location, status = 302) => ({ status, headers: new Map([['location', location]]), body: { cancel: async () => { redirect.cancelled += 1; } } });
redirect.cancelled = 0;
const ok = () => ({ status: 200, headers: new Map(), body: null });
const script = (steps) => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); const step = steps[calls.length - 1]; return typeof step === 'function' ? step(url) : step; };
  return { fetchImpl, calls };
};
const run = (steps, hosts = GITHUB_RELEASE_HOSTS, extra = {}) => {
  const s = script(steps);
  return fetchWithAllowedRedirects('https://github.com/o/r/releases/download/v1/a.zip', { allowedHosts: hosts, init: { headers: { accept: 'application/octet-stream' }, signal: 'sig' }, fetchImpl: s.fetchImpl, ...extra }).then((response) => ({ response, calls: s.calls }), (error) => ({ error, calls: s.calls }));
};

test('a redirect from github.com to its release-asset host is followed by hand, with the same init and redirect:manual on every hop', async () => {
  redirect.cancelled = 0;
  const { response, calls } = await run([redirect('https://release-assets.githubusercontent.com/github-production-release-asset/1?sig=x'), ok()]);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.init.redirect, 'manual');
    assert.equal(call.init.signal, 'sig');
    assert.deepEqual(call.init.headers, { accept: 'application/octet-stream' });
  }
  assert.equal(redirect.cancelled, 1, 'the redirect response body is not left open');
});

test('a relative Location is resolved against the current URL and still checked', async () => {
  const { response, calls } = await run([redirect('/o/r/releases/download/v1/b.zip'), ok()]);
  assert.equal(response.status, 200);
  assert.equal(calls[1].url, 'https://github.com/o/r/releases/download/v1/b.zip');
});

test('a redirect to another host, to http, with credentials, or on a port is refused before it is requested', async () => {
  for (const location of [
    'https://evil.example/a.zip', 'http://release-assets.githubusercontent.com/a', 'https://github.com.evil.example/a',
    'https://user:pw@release-assets.githubusercontent.com/a', 'https://release-assets.githubusercontent.com:8443/a',
    'https://githubusercontent.com/a', 'https://downloads.claude.ai/a', 'ftp://github.com/a', 'https://[::1]/a'
  ]) {
    const { error, calls } = await run([redirect(location), ok()]);
    assert.equal(error?.message, 'source-refused', location);
    assert.equal(calls.length, 1, `${location}: the refused hop is never fetched`);
  }
});

test('a missing or unparsable Location, and a redirect loop, are refused', async () => {
  assert.equal((await run([{ status: 302, headers: new Map(), body: null }])).error.message, 'source-refused');
  assert.equal((await run([redirect('https://')])).error.message, 'source-refused');
  const loop = Array.from({ length: MAX_HOPS + 3 }, () => redirect('https://github.com/o/r/loop'));
  const { error, calls } = await run(loop);
  assert.equal(error.message, 'too-many-redirects');
  assert.equal(calls.length, MAX_HOPS + 1);
});

test('the first URL is checked too, so a pinned URL that was changed to another host never leaves the machine', async () => {
  const s = script([ok()]);
  await assert.rejects(fetchWithAllowedRedirects('https://evil.example/a.zip', { allowedHosts: GITHUB_RELEASE_HOSTS, fetchImpl: s.fetchImpl }), { message: 'source-refused' });
  await assert.rejects(fetchWithAllowedRedirects('http://github.com/a', { allowedHosts: GITHUB_RELEASE_HOSTS, fetchImpl: s.fetchImpl }), { message: 'source-refused' });
  await assert.rejects(fetchWithAllowedRedirects('not a url', { allowedHosts: GITHUB_RELEASE_HOSTS, fetchImpl: s.fetchImpl }), { message: 'source-refused' });
  assert.equal(s.calls.length, 0);
});

test('Claude downloads accept only their own host, including for a redirect', async () => {
  const s = script([redirect('https://downloads.claude.ai/other'), ok()]);
  const response = await fetchWithAllowedRedirects('https://downloads.claude.ai/claude-code-releases/x', { allowedHosts: CLAUDE_HOSTS, fetchImpl: s.fetchImpl });
  assert.equal(response.status, 200);
  const t = script([redirect('https://release-assets.githubusercontent.com/a')]);
  await assert.rejects(fetchWithAllowedRedirects('https://downloads.claude.ai/x', { allowedHosts: CLAUDE_HOSTS, fetchImpl: t.fetchImpl }), { message: 'source-refused' });
});
