'use strict';

const http = require('node:http');
const net = require('node:net');
const dns = require('node:dns');
const { randomBytes, timingSafeEqual } = require('node:crypto');

/**
 * A local forward proxy that lets a managed agent CLI reach its own provider and nothing else (issues #25 and #26).
 *
 * Why it exists: the managed-isolation profiles can only say "which addresses and ports", not "which host names", so a CLI
 * that must reach its provider's API but must not reach GitHub cannot be given the network directly. The profile allows
 * one local port (this proxy); the CLI is told to use it (`HTTPS_PROXY`); this proxy decides by host NAME.
 *
 * What it does, in this order, for every request, and refuses (with a short status, never an explanation of its rules) at
 * the first step that fails:
 *   1. the caller must present this proxy's own random credential (a local program that does not have it gets nothing);
 *   2. only the `CONNECT host:port` method is served: plain HTTP through a proxy is never forwarded;
 *   3. the host must be a plain DNS name (no IP literal, nothing but letters, digits, dots and hyphens) and the port one
 *      of the allowed ones (443 by default);
 *   4. a host on the deny list (GitHub and the hosts GitHub serves its files from) is refused even if it is also on the
 *      allow list: the deny list wins;
 *   5. the host must match the allow list (exactly, or `*.example.com` for any name below example.com);
 *   6. the name is resolved here, and every address must be a public one (not loopback, private, link-local, metadata,
 *      carrier-grade NAT, multicast or unspecified): a name that points into the local network is refused, and the
 *      connection is made to the address that was checked, not to a second lookup.
 * Only then are bytes copied in both directions. The proxy does not look inside the tunnel (it is TLS) and keeps no log of
 * hosts beyond counters.
 *
 * What it does not do: it cannot know what a CLI sends to an allowed host; it does not stop a program that ignores the
 * proxy setting (the sandbox profile does that by allowing only this port); and it is only as good as the allow list.
 */

const DEFAULT_DENIED = Object.freeze([
  'github.com', '*.github.com', 'githubusercontent.com', '*.githubusercontent.com', 'githubassets.com', '*.githubassets.com',
  'ghcr.io', '*.ghcr.io', 'github.io', '*.github.io', 'githubapp.com', '*.githubapp.com', 'github.dev', '*.github.dev'
]);
const HOST_CHARS = /^[a-z0-9.-]+$/;
const MAX_HOST = 253;
const MAX_LABEL = 63;
const MAX_ALLOW_ENTRIES = 64;
const MAX_HEADER_BYTES = 8192;

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A DNS name in the one spelling compared here, or null. IP literals (v4, v6, numeric shortcuts), empty labels and odd characters are not names. */
function normalizeHost(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_HOST + 1) return null;
  const host = (value.endsWith('.') ? value.slice(0, -1) : value).toLowerCase();
  if (host.length === 0 || host.length > MAX_HOST || !HOST_CHARS.test(host)) return null;
  const labels = host.split('.');
  if (labels.some((label) => label.length === 0 || label.length > MAX_LABEL || label.startsWith('-') || label.endsWith('-'))) return null;
  // `1.2.3.4`, `0x7f.1`, `2130706433`: a name whose last label is all digits or looks like a hex number is an address in some resolvers.
  const last = labels[labels.length - 1];
  if (/^[0-9]+$/.test(last) || /^0x[0-9a-f]*$/.test(last)) return null;
  if (labels.length < 2) return null;
  return host;
}

/** An allow or deny entry: `name` or `*.name`. Anything else is refused when the proxy is made, never ignored. */
function parsePattern(entry) {
  if (typeof entry !== 'string' || entry.endsWith('.')) return null;
  const wildcard = entry.startsWith('*.');
  const host = normalizeHost(wildcard ? entry.slice(2) : entry);
  return host === null ? null : { host, wildcard };
}

function matches(host, pattern) {
  return pattern.wildcard ? host.endsWith(`.${pattern.host}`) : host === pattern.host;
}

/** Whether an IP address text is one that must never be reached through the proxy. */
function isPrivateAddress(address) {
  if (typeof address !== 'string') return true;
  const family = net.isIP(address);
  if (family === 4) return isPrivateV4(address);
  if (family === 6) {
    const lower = address.toLowerCase();
    // IPv4 written inside IPv6 (::ffff:10.0.0.1, ::10.0.0.1): judged by the IPv4 part.
    const mapped = /^(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateV4(mapped[1]);
    const hexMapped = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
    if (hexMapped) {
      const high = parseInt(hexMapped[1], 16); const low = parseInt(hexMapped[2], 16);
      return isPrivateV4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    if (lower === '::' || lower === '::1') return true;
    const first = parseInt(lower.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
    if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 site local (deprecated)
    if ((first & 0xff00) === 0xff00) return true; // multicast
    if (lower.startsWith('2001:db8')) return true; // documentation
    if (lower.startsWith('64:ff9b:1:')) return true; // local-use NAT64
    return false;
  }
  return true; // not an address at all
}

function isPrivateV4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 169 && b === 254) return true; // link local and cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

const defaultLookup = (host) => new Promise((resolve, reject) => {
  dns.lookup(host, { all: true, verbatim: true }, (error, addresses) => (error ? reject(error) : resolve(addresses.map((entry) => entry.address))));
});
const defaultConnect = (address, port) => new Promise((resolve, reject) => {
  const socket = net.connect({ host: address, port });
  socket.once('connect', () => { socket.removeAllListeners('error'); resolve(socket); });
  socket.once('error', (error) => { socket.destroy(); reject(error); });
});

/**
 * @param {{ allow: string[], deny?: string[], ports?: number[], maxConnections?: number, idleMs?: number, connectMs?: number,
 *   lookup?: (host: string) => Promise<string[]>, connect?: (address: string, port: number) => Promise<import('node:net').Socket> }} options
 *   `lookup` and `connect` exist so a test can use local stand-ins; their defaults are the real resolver and TCP connect.
 */
function createFilterProxy({ allow, deny = DEFAULT_DENIED, ports = [443], maxConnections = 32, idleMs = 120_000, connectMs = 10_000, lookup = defaultLookup, connect = defaultConnect } = {}) {
  if (!Array.isArray(allow) || allow.length === 0 || allow.length > MAX_ALLOW_ENTRIES) throw new TypeError('allow must be a non-empty list');
  const allowed = allow.map(parsePattern);
  if (allowed.some((entry) => entry === null)) throw new TypeError('allow holds an entry that is not a host name or *.name');
  const denied = (Array.isArray(deny) ? deny : []).map(parsePattern);
  if (denied.some((entry) => entry === null)) throw new TypeError('deny holds an entry that is not a host name or *.name');
  if (!Array.isArray(ports) || ports.length === 0 || !ports.every((port) => Number.isInteger(port) && port >= 1 && port <= 65535)) throw new TypeError('ports must be a list of ports');

  const credential = randomBytes(24).toString('hex');
  const expected = Buffer.from(`Basic ${Buffer.from(`managed:${credential}`).toString('base64')}`);
  const counters = { allowed: 0, denied: 0, failed: 0, unauthorized: 0 };
  const sockets = new Set();
  let active = 0;
  let server = null;

  const authorized = (header) => {
    if (typeof header !== 'string') return false;
    const given = Buffer.from(header);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  const refuse = (clientSocket, status, text) => {
    try { clientSocket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* already closed */ }
  };

  async function decide(host, port) {
    if (!ports.includes(port)) return { ok: false, status: 403 };
    if (denied.some((pattern) => matches(host, pattern))) return { ok: false, status: 403 };
    if (!allowed.some((pattern) => matches(host, pattern))) return { ok: false, status: 403 };
    let addresses;
    try { addresses = await lookup(host); } catch { return { ok: false, status: 502 }; }
    if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some(isPrivateAddress)) return { ok: false, status: 403 };
    return { ok: true, address: addresses[0] };
  }

  function onConnect(request, clientSocket, head) {
    sockets.add(clientSocket);
    clientSocket.once('close', () => sockets.delete(clientSocket));
    clientSocket.on('error', () => {});
    if (active >= maxConnections) { counters.denied += 1; refuse(clientSocket, 503, 'Busy'); return; }
    if (!authorized(request.headers['proxy-authorization'])) { counters.unauthorized += 1; clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="managed"\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
    const match = /^([^:\s]+):(\d{1,5})$/.exec(typeof request.url === 'string' ? request.url : '');
    const host = match ? normalizeHost(match[1]) : null;
    const port = match ? Number(match[2]) : NaN;
    if (host === null || !Number.isInteger(port)) { counters.denied += 1; refuse(clientSocket, 400, 'Bad Request'); return; }
    active += 1;
    let released = false;
    const release = () => { if (!released) { released = true; active -= 1; } };
    clientSocket.once('close', release);
    decide(host, port).then(async (decision) => {
      if (!decision.ok) { counters.denied += 1; refuse(clientSocket, decision.status, decision.status === 502 ? 'Bad Gateway' : 'Forbidden'); return; }
      let upstream;
      try {
        upstream = await Promise.race([connect(decision.address, port), new Promise((_, reject) => setTimeout(() => reject(new Error('connect-timeout')), connectMs).unref())]);
      } catch { counters.failed += 1; refuse(clientSocket, 502, 'Bad Gateway'); return; }
      if (clientSocket.destroyed) { upstream.destroy(); return; }
      counters.allowed += 1;
      sockets.add(upstream);
      upstream.once('close', () => sockets.delete(upstream));
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) upstream.write(head);
      clientSocket.setTimeout(idleMs, () => { clientSocket.destroy(); upstream.destroy(); });
      upstream.setTimeout(idleMs, () => { clientSocket.destroy(); upstream.destroy(); });
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
      upstream.once('close', () => clientSocket.destroy());
      clientSocket.once('close', () => upstream.destroy());
    }).catch(() => { counters.failed += 1; refuse(clientSocket, 502, 'Bad Gateway'); });
  }

  return {
    /** Starts listening on a free port of the loopback address only. */
    async start() {
      if (server) throw new Error('already started');
      server = http.createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (request, response) => {
        // Anything that is not CONNECT (plain HTTP through the proxy, health probes, ...) is not forwarded.
        counters.denied += 1;
        response.writeHead(405, { Connection: 'close', 'Content-Length': '0' });
        response.end();
      });
      server.on('connect', onConnect);
      server.on('clientError', (_error, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch { /* gone */ } });
      server.headersTimeout = 10_000;
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const { port } = server.address();
      return { port, url: `http://managed:${credential}@127.0.0.1:${port}` };
    },
    /** Counters only: no host names, no addresses. */
    stats: () => ({ ...counters, active }),
    async stop() {
      const closing = server;
      server = null;
      if (!closing) return;
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => closing.close(() => resolve()));
    }
  };
}

module.exports = { createFilterProxy, normalizeHost, parsePattern, matches, isPrivateAddress, DEFAULT_DENIED };
