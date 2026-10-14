'use strict';

const API = 'https://api.github.com';
const TOKEN = 'synthetic-test-credential-0000';

function json(status, body, headers = {}) {
  return { status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) };
}

/**
 * Router-style fake transport. Handlers are matched in registration order by method and
 * path (the part after the API origin, without the query). Unmatched requests answer 404 and
 * are recorded in `calls` like all others.
 */
function createFakeTransport() {
  const routes = [];
  const calls = [];
  async function transport(request) {
    const url = new URL(request.url);
    const call = {
      method: request.method,
      url: request.url,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: request.headers,
      body: request.body,
      signal: request.signal
    };
    calls.push(call);
    for (const route of routes) {
      if (route.method === request.method && route.matches(call.path)) {
        return route.handler(call, calls.length);
      }
    }
    return json(404, { message: 'Not Found' });
  }
  transport.calls = calls;
  transport.on = (method, path, handler) => {
    const matches = path instanceof RegExp ? (value) => path.test(value) : (value) => value === path;
    routes.push({ method, matches, handler: typeof handler === 'function' ? handler : () => handler });
    return transport;
  };
  transport.get = (path, handler) => transport.on('GET', path, handler);
  transport.post = (path, handler) => transport.on('POST', path, handler);
  return transport;
}

/** Serves a sequence of responses for one route (the last one repeats). */
function sequence(...responses) {
  let index = 0;
  return () => {
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return typeof response === 'function' ? response() : response;
  };
}

function createClock(start = Date.parse('2026-10-14T12:00:00Z')) {
  let current = start;
  const now = () => current;
  now.advance = (ms) => {
    current += ms;
  };
  return now;
}

/** A sleep that records requested delays and returns immediately. */
function createFakeSleep() {
  const delays = [];
  const sleep = async (ms) => {
    delays.push(ms);
  };
  sleep.delays = delays;
  return sleep;
}

module.exports = { API, TOKEN, json, createFakeTransport, sequence, createClock, createFakeSleep };
