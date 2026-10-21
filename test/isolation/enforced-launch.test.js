'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareEnforcedLaunch, launchSpec } = require('../../src/isolation/enforced-launch');
const { CHANNELS } = require('../../src/isolation/capabilities');
const { SANDBOX_EXEC } = require('../../src/isolation/macos');

const GOOD = { bypass: 'blocked', interaction: 'works' };
const BAD = { bypass: 'open', interaction: 'broken' };
// The profile and its folder are POSIX paths (macOS only): the folder the tests create on Windows is not one.
const posixOnly = process.platform === 'win32' ? { skip: 'macOS profile paths are POSIX paths' } : {};

function fakeHarness({ override = {}, log = [] } = {}) {
  return () => ({
    platform: 'darwin',
    probe: async (channel) => {
      if (Object.hasOwn(override, channel)) return override[channel];
      return { control: true, outcome: GOOD[CHANNELS[channel].kind] };
    },
    dispose: async () => { log.push('harness-disposed'); }
  });
}

function fakeProxy({ log = [], address = '127.0.0.1', fail = false } = {}) {
  return (options) => ({
    options,
    start: async () => { if (fail) throw new Error('listen failed'); return { address, port: 45678, url: 'http://managed:abc123@127.0.0.1:45678' }; },
    stop: async () => { log.push('proxy-stopped'); }
  });
}

const base = (extra = {}) => {
  const storageDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mas-enf-'));
  return { platform: 'darwin', allowedDomains: ['api.provider.test'], storageDir, home: '/synthetic/home', createHarness: fakeHarness(), createProxy: fakeProxy(), ...extra };
};
const leftovers = (dir) => fs.readdirSync(dir);

test('with every channel proven, the command is the sandboxed one and the environment points at the local proxy', posixOnly, async () => {
  const input = base();
  const result = await prepareEnforcedLaunch(input);
  assert.equal(result.ok, true);
  const command = result.wrapCommand('claude', ['--model', 'x']);
  assert.equal(command.executable, SANDBOX_EXEC);
  assert.equal(command.args[0], '-f');
  assert.deepEqual(command.args.slice(2), ['claude', '--model', 'x']);
  assert.equal(result.env.HTTPS_PROXY, 'http://managed:abc123@127.0.0.1:45678');
  const profile = fs.readFileSync(command.args[1], 'utf8');
  assert.match(profile, /\(deny network\*\)/);
  assert.match(profile, /localhost:45678/);
  assert.match(profile, /deny file-read\* \(subpath "\/synthetic\/home\/\.config\/gh"\)/);
  assert.match(profile, /com\.apple\.SecurityServer/);
  assert.equal(fs.statSync(command.args[1]).mode & 0o077, 0, 'the profile is readable only by the person');
  assert.equal(fs.statSync(path.dirname(command.args[1])).mode & 0o077, 0, 'so is the folder it lives in');
  assert.ok(result.summary.some((line) => line.includes('#135')), 'the screen says what is not verified');
  await result.dispose();
  assert.deepEqual(leftovers(input.storageDir), [], 'everything created is removed again');
});

test('the proxy is given only the person\'s allowed domains and the profile allows only its port', posixOnly, async () => {
  let seen;
  const result = await prepareEnforcedLaunch(base({ createProxy: (options) => { seen = options; return fakeProxy()(options); }, allowedDomains: ['api.provider.test', '*.cdn.provider.test'] }));
  assert.deepEqual(seen.allow, ['api.provider.test', '*.cdn.provider.test']);
  assert.deepEqual(launchSpec({ home: '/synthetic/home', proxyPort: 45678 }).allowLocalPorts, [45678]);
  await result.dispose();
});

test('a channel that is open, broken or whose control did not run refuses, and nothing is left behind', posixOnly, async () => {
  for (const channel of Object.keys(CHANNELS)) {
    for (const answer of [{ control: true, outcome: BAD[CHANNELS[channel].kind] }, { control: false }, undefined]) {
      const log = [];
      const input = base({ createHarness: fakeHarness({ override: { [channel]: answer }, log }), createProxy: fakeProxy({ log }) });
      const result = await prepareEnforcedLaunch(input);
      assert.equal(result.ok, false, `${channel} ${JSON.stringify(answer)}`);
      assert.equal(result.code, 'evidence-insufficient');
      assert.ok(result.reasons.some((reason) => reason.startsWith(`${channel}:`)));
      assert.ok(!log.includes('proxy-stopped'), 'the proxy was never started for a refusal on evidence');
      assert.ok(log.includes('harness-disposed'));
      assert.deepEqual(leftovers(input.storageDir), []);
    }
  }
});

test('a probe module that throws refuses', posixOnly, async () => {
  const input = base({ createHarness: () => ({ platform: 'darwin', probe: async () => { throw new Error('boom'); }, dispose: async () => {} }) });
  const result = await prepareEnforcedLaunch(input);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'evidence-insufficient');
});

test('a harness that cannot be created, a proxy that does not start or listens elsewhere refuses and cleans up', async () => {
  for (const extra of [
    { createHarness: () => { throw new Error('no harness'); } },
    { createProxy: fakeProxy({ fail: true }) },
    { createProxy: fakeProxy({ address: '0.0.0.0' }) }
  ]) {
    const log = [];
    const input = base({ createHarness: fakeHarness({ log }), ...extra });
    if (extra.createProxy) input.createProxy = extra.createProxy;
    const result = await prepareEnforcedLaunch(input);
    assert.equal(result.ok, false);
    assert.deepEqual(leftovers(input.storageDir), []);
  }
});

test('other platforms, missing or invalid allowed domains and unusable inputs refuse without probing anything', async () => {
  let probed = 0;
  const createHarness = () => { probed += 1; return fakeHarness()(); };
  for (const extra of [
    { platform: 'win32' }, { platform: 'linux' },
    { allowedDomains: [] }, { allowedDomains: undefined }, { allowedDomains: ['https://x.test/path'] }, { allowedDomains: [5] },
    { storageDir: 'relative' }, { home: 'relative' }
  ]) {
    const result = await prepareEnforcedLaunch(base({ createHarness, ...extra }));
    assert.equal(result.ok, false, JSON.stringify(extra));
  }
  assert.equal(probed, 0);
});

test('no refusal carries a path, an account or the proxy credential', async () => {
  const input = base({ createHarness: fakeHarness({ override: { 'direct-http': { control: true, outcome: 'open' } } }) });
  const result = await prepareEnforcedLaunch(input);
  const text = JSON.stringify(result);
  for (const secret of [input.storageDir, input.home, 'abc123', 'synthetic/home']) assert.ok(!text.includes(secret), secret);
});

test('a program name or arguments that are not plain are refused when the command is wrapped', posixOnly, async () => {
  const result = await prepareEnforcedLaunch(base());
  for (const [name, args] of [['../claude', []], ['a b', []], ['/bin/sh', []], ['claude', [1]], ['claude', 'x']]) assert.throws(() => result.wrapCommand(name, args), /launch-invalid/, String(name));
  await result.dispose();
});
