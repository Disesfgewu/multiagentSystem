'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const os = require('node:os');
const { createFilterProxy, defaultConnect, normalizeHost, parsePattern, matches, isPrivateAddress, DEFAULT_DENIED } = require('../../src/isolation/filter-proxy');

const PUBLIC = '93.184.216.34';

// Under load (several test runs on one machine) an event can arrive before a listener is attached. Waiting for 'close' on a socket that
// already closed never ends, so a wait on a socket checks first, and every wait has a limit that turns a stuck await into a failure.
const WAIT_MS = 15000;
const closedOf = (socket) => (socket.destroyed ? Promise.resolve() : new Promise((resolve) => socket.once('close', resolve)));
function bounded(promise, what, ms = WAIT_MS) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/** A local echo server standing in for a provider: what it receives it sends back upper-cased. */
async function echoServer(t) {
  const received = [];
  const open = new Set();
  const server = net.createServer((socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    socket.on('data', (chunk) => { received.push(chunk.toString()); socket.write(chunk.toString().toUpperCase()); });
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { for (const socket of open) socket.destroy(); server.close(() => resolve()); setTimeout(resolve, 2000).unref(); }));
  return { port: server.address().port, received };
}

async function proxyFor(t, options = {}) {
  const echo = await echoServer(t);
  const connected = [];
  const looked = [];
  const proxy = createFilterProxy({
    allow: ['api.provider.test', '*.cdn.provider.test'],
    lookup: async (host) => { looked.push(host); return options.addresses ?? [PUBLIC]; },
    connect: async (address, port) => { connected.push([address, port]); return net.connect({ host: '127.0.0.1', port: echo.port }); },
    ...options.proxy
  });
  const started = await proxy.start();
  t.after(() => proxy.stop());
  t.after(() => { for (const socket of clients) socket.destroy(); });
  const credential = new URL(started.url).password;
  return { proxy, started, echo, connected, looked, credential };
}

/** Sends one CONNECT and returns the status line, and the socket for more. */
const clients = new Set();
function connectThrough(started, target, { header, credential, raw } = {}) {
  return bounded(new Promise((resolve, reject) => {
    const socket = net.connect(started.port, '127.0.0.1');
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf('\r\n\r\n');
      if (end !== -1) { socket.removeAllListeners('data'); resolve({ status: buffer.slice(0, buffer.indexOf('\r\n')), socket, rest: buffer.slice(end + 4) }); }
    });
    // A connection that closes without a complete reply ends the wait with whatever status line there was (maybe none).
    socket.on('close', () => { if (buffer.indexOf('\r\n\r\n') === -1) resolve({ status: buffer.split('\r\n')[0], socket, rest: '' }); });
    const auth = header ?? (credential === undefined ? '' : `Proxy-Authorization: Basic ${Buffer.from(`managed:${credential}`).toString('base64')}\r\n`);
    socket.write(raw ?? `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`);
  }), `the proxy's reply to CONNECT ${target}`);
}

const statusOf = (reply) => Number(/^HTTP\/1\.1 (\d{3})/.exec(reply.status)?.[1]);

test('an allowed host is tunnelled both ways, to the address that was checked, and only after the checks', async (t) => {
  const { started, echo, connected, looked, credential } = await proxyFor(t);
  const reply = await connectThrough(started, 'api.provider.test:443', { credential });
  assert.equal(statusOf(reply), 200);
  assert.deepEqual(looked, ['api.provider.test']);
  assert.deepEqual(connected, [[PUBLIC, 443]], 'the connection goes to the address that was looked at');
  const answer = await bounded(new Promise((resolve) => { reply.socket.once('data', (chunk) => resolve(chunk.toString())); reply.socket.write('hello'); }), 'the echo through the tunnel');
  assert.equal(answer, 'HELLO');
  assert.deepEqual(echo.received, ['hello']);
  reply.socket.destroy();
});

test('a subdomain matches a wildcard entry, the bare name does not, and case and a trailing dot do not matter', async (t) => {
  const { started, credential, connected } = await proxyFor(t);
  assert.equal(statusOf(await connectThrough(started, 'EU.CDN.provider.test.:443', { credential })), 200);
  assert.equal(statusOf(await connectThrough(started, 'cdn.provider.test:443', { credential })), 403, 'the wildcard is for names below it');
  assert.equal(statusOf(await connectThrough(started, 'evil-cdn.provider.test:443', { credential })), 403);
  assert.equal(statusOf(await connectThrough(started, 'api.provider.test.evil.example:443', { credential })), 403);
  assert.equal(connected.length, 1);
});

test('GitHub and the hosts it serves files from are refused even when they are on the allow list', async (t) => {
  const { started, credential, connected, looked } = await proxyFor(t, { proxy: { allow: ['api.provider.test', 'github.com', '*.github.com', '*.githubusercontent.com', 'ghcr.io', 'raw.githubusercontent.com', '*.ghe.com', 'githubcopilot.com', '*.githubcopilot.com'] } });
  for (const host of ['github.com', 'api.github.com', 'gist.github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com', 'ghcr.io', 'pkg.ghcr.io', 'user.github.io', 'GitHub.com.', 'a.b.github.com']) {
    assert.equal(statusOf(await connectThrough(started, `${host}:443`, { credential })), 403, host);
  }
  assert.deepEqual([connected.length, looked.length], [0, 0], 'refused before any lookup or connection');
  for (const entry of DEFAULT_DENIED) assert.ok(parsePattern(entry), entry);
  for (const host of ['x.ghe.com', 'api.githubcopilot.com', 'githubcopilot.com']) assert.equal(statusOf(await connectThrough(started, `${host}:443`, { credential })), 403, host);
});

test('what is not on the allow list, a port that is not allowed, and a name that is not a name are refused before any lookup', async (t) => {
  const { started, credential, connected, looked } = await proxyFor(t);
  const refused = ['example.com:443', 'api.provider.test:80', 'api.provider.test:22', 'api.provider.test:8443', '127.0.0.1:443', '[::1]:443', '10.0.0.1:443', '2130706433:443', '0x7f.1:443', 'localhost:443', 'api.provider.test:0', 'api.provider.test:99999'];
  for (const target of refused) {
    const reply = await connectThrough(started, target, { credential });
    assert.ok([400, 403].includes(statusOf(reply)), `${target}: ${reply.status}`);
  }
  assert.deepEqual([connected.length, looked.length], [0, 0]);
});

test('a name that resolves to anything but public addresses is refused, even if only one of its addresses is private', async (t) => {
  for (const addresses of [['127.0.0.1'], ['10.1.2.3'], ['172.16.0.9'], ['192.168.1.1'], ['169.254.169.254'], ['100.64.0.1'], ['0.0.0.0'], ['224.0.0.1'], ['::1'], ['fd00::1'], ['fe80::1'], ['::ffff:10.0.0.1'], ['::ffff:7f00:1'], [PUBLIC, '10.0.0.5'], ['10.0.0.5', PUBLIC], [], ['not-an-address']]) {
    const { started, credential, connected } = await proxyFor(t, { addresses });
    assert.equal(statusOf(await connectThrough(started, 'api.provider.test:443', { credential })), addresses.length === 0 ? 403 : 403, JSON.stringify(addresses));
    assert.equal(connected.length, 0, JSON.stringify(addresses));
  }
  const failing = await proxyFor(t, { proxy: { lookup: async () => { throw new Error('nxdomain'); } } });
  assert.equal(statusOf(await connectThrough(failing.started, 'api.provider.test:443', { credential: failing.credential })), 502);
  const unreachable = await proxyFor(t, { proxy: { connect: async () => { throw new Error('refused'); } } });
  assert.equal(statusOf(await connectThrough(unreachable.started, 'api.provider.test:443', { credential: unreachable.credential })), 502);
});

test('without the proxy\'s own credential nothing is served: none, wrong, another scheme', async (t) => {
  const { started, credential, connected, looked } = await proxyFor(t);
  assert.equal(statusOf(await connectThrough(started, 'api.provider.test:443', {})), 407);
  assert.equal(statusOf(await connectThrough(started, 'api.provider.test:443', { credential: 'wrong' })), 407);
  assert.equal(statusOf(await connectThrough(started, 'api.provider.test:443', { header: `Proxy-Authorization: Bearer ${credential}\r\n` })), 407);
  assert.equal(statusOf(await connectThrough(started, 'api.provider.test:443', { header: `Proxy-Authorization: Basic ${Buffer.from(`managed:${credential}x`).toString('base64')}\r\n` })), 407);
  assert.deepEqual([connected.length, looked.length], [0, 0]);
  assert.deepEqual([started.url.startsWith('http://managed:'), credential.length], [true, 48]);
  assert.equal(statusOf(await connectThrough(started, 'api.provider.test:443', { credential })), 200);
  assert.equal((await proxyFor(t)).credential === credential, false, 'every proxy has its own credential');
});

test('plain HTTP through the proxy, other methods and malformed requests are never forwarded', async (t) => {
  const { started, credential, connected } = await proxyFor(t);
  const send = (text) => bounded(new Promise((resolve) => {
    const socket = net.connect(started.port, '127.0.0.1');
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { buffer += chunk; });
    socket.on('close', () => resolve(buffer.split('\r\n')[0]));
    socket.on('error', () => resolve(buffer.split('\r\n')[0]));
    socket.write(text);
    setTimeout(() => socket.end(), 150);
  }), 'the proxy to answer a plain request');
  assert.match(await send('GET http://api.provider.test/ HTTP/1.1\r\nHost: api.provider.test\r\n\r\n'), /^HTTP\/1\.1 405/);
  assert.match(await send(`POST http://api.provider.test/ HTTP/1.1\r\nHost: api.provider.test\r\nProxy-Authorization: Basic ${Buffer.from(`managed:${credential}`).toString('base64')}\r\nContent-Length: 0\r\n\r\n`), /^HTTP\/1\.1 405/);
  assert.match(await send('this is not http\r\n\r\n'), /^HTTP\/1\.1 400/);
  assert.equal(connected.length, 0);
  assert.ok(started.port > 0);
});

test('the number of connections is capped, an unlimited flood is refused with busy, and a stopped proxy closes what is open', async (t) => {
  const { proxy, started, credential } = await proxyFor(t, { proxy: { maxConnections: 2 } });
  const first = await connectThrough(started, 'api.provider.test:443', { credential });
  const second = await connectThrough(started, 'api.provider.test:443', { credential });
  assert.deepEqual([statusOf(first), statusOf(second)], [200, 200]);
  assert.equal(statusOf(await connectThrough(started, 'api.provider.test:443', { credential })), 503);
  assert.equal(proxy.stats().active >= 2, true);
  const closed = closedOf(first.socket);
  await bounded(proxy.stop(), 'the proxy to stop');
  await bounded(closed, 'the open tunnel to close');
  assert.equal(first.socket.destroyed, true);
  await proxy.stop();
});

test('the counters hold numbers only: no host names and no addresses', async (t) => {
  const { proxy, started, credential } = await proxyFor(t);
  await connectThrough(started, 'api.provider.test:443', { credential });
  await connectThrough(started, 'github.com:443', { credential });
  await connectThrough(started, 'api.provider.test:443', {});
  const stats = proxy.stats();
  assert.deepEqual(Object.keys(stats).sort(), ['active', 'allowed', 'denied', 'failed', 'unauthorized']);
  assert.deepEqual([stats.allowed, stats.denied, stats.unauthorized], [1, 1, 1]);
  assert.equal(JSON.stringify(stats).includes('provider'), false);
});

test('it listens on the loopback address only: the address it reports is 127.0.0.1, and no other address of this machine reaches it', async (t) => {
  const { started } = await proxyFor(t);
  assert.equal(started.address, '127.0.0.1');
  const others = Object.values(os.networkInterfaces()).flat().filter((entry) => entry && entry.family === 'IPv4' && !entry.internal).map((entry) => entry.address);
  for (const address of others.slice(0, 3)) {
    const outcome = await bounded(new Promise((resolve) => {
      const socket = net.connect({ host: address, port: started.port });
      socket.on('connect', () => { socket.destroy(); resolve('connected'); });
      socket.on('error', (error) => resolve(error.code));
      setTimeout(() => { socket.destroy(); resolve('timeout'); }, 2000);
    }), `an attempt on ${address}`);
    assert.notEqual(outcome, 'connected', `${address} reaches the proxy`);
  }
});

test('an upstream that connects after the time limit is destroyed and its later error cannot crash anything; the slot is given back', async (t) => {
  const late = new net.Socket();
  let destroyed = false;
  late.on('close', () => { destroyed = true; });
  const { proxy, started, credential } = await proxyFor(t, { proxy: { connectMs: 100, connect: () => new Promise((resolve) => setTimeout(() => resolve(late), 400)) } });
  const reply = await connectThrough(started, 'api.provider.test:443', { credential });
  assert.equal(statusOf(reply), 502, 'the client was told at the time limit');
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(destroyed, true, 'the socket that arrived late was destroyed');
  late.emit('error', new Error('read ECONNRESET')); // would have been an uncaught exception
  reply.socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(proxy.stats().active, 0);
  assert.equal(proxy.stats().failed, 1);
});

test('the real connect function: a reset after it connected, or a connect that never finishes, is an error value, never an unhandled error', async (t) => {
  const resetting = net.createServer((socket) => { socket.on('error', () => {}); setTimeout(() => socket.resetAndDestroy(), 50); });
  await new Promise((resolve) => resetting.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { resetting.close(() => resolve()); setTimeout(resolve, 2000).unref(); }));
  const socket = await defaultConnect('127.0.0.1', resetting.address().port, 1000);
  await bounded(closedOf(socket), 'the reset to close the socket'); // the reset arrives; there must be no 'uncaughtException'
  assert.equal(socket.destroyed, true);
  // An address nothing answers on (TEST-NET, never routed): refused by time, not left waiting.
  const started = Date.now();
  await assert.rejects(defaultConnect('192.0.2.1', 9, 300), /connect-timeout|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|EADDRNOTAVAIL/);
  assert.ok(Date.now() - started < 3000);
});

test('a name that takes too long to resolve is refused at the limit and the slot is given back', async (t) => {
  const { proxy, started, credential } = await proxyFor(t, { proxy: { lookupMs: 100, lookup: () => new Promise(() => {}) } });
  const reply = await connectThrough(started, 'api.provider.test:443', { credential });
  assert.equal(statusOf(reply), 502);
  reply.socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(proxy.stats().active, 0);
});

test('an IPv6 address is judged the same however it is written', () => {
  for (const address of ['0:0:0:0:0:ffff:7f00:1', '0000:0000:0000:0000:0000:ffff:0a00:0001', '::FFFF:7F00:1', '::ffff:127.0.0.1', '0:0:0:0:0:0:0:1', '0:0:0:0:0:0:0:0', 'FE80:0:0:0:0:0:0:1', 'FD00::1', '::127.0.0.1', '0:0:0:0:0:ffff:c0a8:101', '64:ff9b::a00:1']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ['2606:2800:0220:0001:0000:0000:0000:0001', '2001:4860:4860:0:0:0:0:8888', '0:0:0:0:0:ffff:808:808']) assert.equal(isPrivateAddress(address), false, address);
});

test('hosts and patterns: only plain DNS names are names; an address in any spelling is not', () => {
  for (const good of ['api.provider.test', 'A.B.C.example.com', 'xn--fiq228c.example', 'host-1.example.org.']) assert.ok(normalizeHost(good), good);
  assert.equal(normalizeHost('Host.Example.COM.'), 'host.example.com');
  for (const bad of ['', 'localhost', 'a', '127.0.0.1', '1.2.3', '2130706433', '0x7f.0x0.0x0.0x1', '0x7f.1', 'a..b.com', '-a.com', 'a-.com', 'a b.com', 'a_b.com', 'a/b.com', 'a:443.com', '[::1]', '::1', 'ünïcode.example', 'x'.repeat(64) + '.com', `${'a.'.repeat(130)}com`, undefined, null, 5, '.example.com']) assert.equal(normalizeHost(bad), null, String(bad));
  assert.deepEqual(parsePattern('*.example.com'), { host: 'example.com', wildcard: true });
  assert.deepEqual(parsePattern('Example.com'), { host: 'example.com', wildcard: false });
  for (const bad of ['*', '*.', '**.example.com', 'a.*.com', '*example.com', 'example.com.', '*.example.com.', '127.0.0.1', '*.127.0.0.1', '', undefined]) assert.equal(parsePattern(bad), null, String(bad));
  assert.equal(matches('a.example.com', parsePattern('*.example.com')), true);
  assert.equal(matches('example.com', parsePattern('*.example.com')), false);
  assert.equal(matches('xexample.com', parsePattern('*.example.com')), false);
  assert.equal(matches('example.com', parsePattern('example.com')), true);
});

test('which addresses count as private: loopback, private, link-local, metadata, shared, multicast, reserved and IPv4 inside IPv6', () => {
  for (const address of ['0.0.0.0', '127.0.0.1', '127.255.255.254', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254', '100.64.0.1', '100.127.255.255', '198.18.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1', '255.255.255.255', '::', '::1', 'fc00::1', 'fd12::1', 'fe80::1', 'fec0::1', 'ff02::1', '2001:db8::1', '::ffff:127.0.0.1', '::ffff:192.168.1.1', '::ffff:7f00:1', '::ffff:a00:1', '64:ff9b::a00:1', 'not an address', '', undefined, null, 5, '1.2.3', '256.1.1.1']) {
    assert.equal(isPrivateAddress(address), true, String(address));
  }
  for (const address of ['93.184.216.34', '8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '169.253.0.1', '2606:2800:220:1::1', '2001:4860:4860::8888', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test('the proxy refuses to be made with an allow list that is empty, too long, or holds something that is not a host pattern', () => {
  for (const allow of [undefined, [], 'example.com', ['*'], ['127.0.0.1'], ['example.com.'], [5], Array.from({ length: 65 }, (_, index) => `h${index}.example.com`)]) assert.throws(() => createFilterProxy({ allow }), TypeError, JSON.stringify(allow)?.slice(0, 40));
  assert.throws(() => createFilterProxy({ allow: ['a.example.com'], deny: ['127.0.0.1'] }), TypeError);
  for (const ports of [[], [0], [70000], ['443'], 443]) assert.throws(() => createFilterProxy({ allow: ['a.example.com'], ports }), TypeError);
  assert.ok(createFilterProxy({ allow: ['a.example.com'] }));
});
