'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { seatbeltProfile, scrubEnvironment, safeProfilePath, credentialLocations, KEYCHAIN_SERVICES, HOME_CREDENTIAL_PATHS, SANDBOX_EXEC } = require('../../src/isolation/macos');
const { createMacosModule } = require('./macos-harness');
const { CHANNELS, collectProbes, assessIsolation, decideLaunch } = require('../../src/isolation/capabilities');

const real = process.platform === 'darwin' && fs.existsSync(SANDBOX_EXEC);
const onlyMac = real ? {} : { skip: 'needs macOS and /usr/bin/sandbox-exec' };
const BYPASS = Object.keys(CHANNELS).filter((channel) => CHANNELS[channel].kind === 'bypass');

test('the profile denies the network, lists the allowed local ports, and denies each given path', () => {
  const text = seatbeltProfile({ denyRead: ['/a/b'], denyWrite: ['/a/b/.git'], allowLocalPorts: [8080] });
  assert.equal(text, '(version 1)\n(allow default)\n(deny network*)\n(allow network-outbound (remote ip "localhost:8080"))\n(deny file-read* (subpath "/a/b"))\n(deny file-write* (subpath "/a/b/.git"))\n');
  assert.match(seatbeltProfile(), /\(deny network\*\)/, 'the network is denied even with no options');
});

test('a path or port that could change the profile is refused: no profile is made', () => {
  for (const bad of ['relative/path', '/a/../b', '/a/./b', '/a//b', '/a/b/', '', '/x"(allow default)', '/x\\y', '/x(y)', '/x\ny', '/x‮y', '/x\u0085y', '/x y', 5, null, '/' + 'a'.repeat(1100)]) {
    assert.equal(safeProfilePath(bad), false, JSON.stringify(bad));
    assert.throws(() => seatbeltProfile({ denyRead: [bad] }), /isolation-profile-path-invalid/);
    assert.throws(() => seatbeltProfile({ denyWrite: [bad] }), /isolation-profile-path-invalid/);
  }
  assert.throws(() => seatbeltProfile({ denyRead: 'not a list' }), /isolation-profile-path-invalid/);
  for (const bad of [0, 65536, 1.5, '80', NaN, null]) assert.throws(() => seatbeltProfile({ allowLocalPorts: [bad] }), /isolation-profile-port-invalid/, String(bad));
  assert.throws(() => seatbeltProfile({ allowLocalPorts: 80 }), /isolation-profile-port-invalid/);
  assert.equal(safeProfilePath('/home/名前/project with space'), true);
});

test('the scrubbed environment has no GitHub credential, askpass program, agent socket or injected git config, and keeps the rest', () => {
  const env = { PATH: '/usr/bin', HOME: '/h', LANG: 'en_US.UTF-8', GH_TOKEN: 'x', GITHUB_TOKEN: 'x', gh_token: 'x', GH_ENTERPRISE_TOKEN: 'x', GITHUB_ENTERPRISE_TOKEN: 'x', GITHUB_PAT_SECRET: 'x', GIT_ASKPASS: '/p', SSH_ASKPASS: '/p', SSH_AUTH_SOCK: '/s', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '!x', GIT_CONFIG_GLOBAL: '/g', GIT_CONFIG_PARAMETERS: "'credential.helper=!x'", GH_HOST: 'github.com', NOT_A_STRING: undefined };
  assert.deepEqual(scrubEnvironment(env), { PATH: '/usr/bin', HOME: '/h', LANG: 'en_US.UTF-8', GH_HOST: 'github.com' });
  assert.deepEqual(scrubEnvironment(undefined), {});
});

test('off macOS, or without the sandbox command, nothing is probed and every channel stays unknown', async () => {
  for (const options of [{ platform: 'linux' }, { platform: 'win32' }, { platform: 'darwin', sandboxExec: '/nonexistent/sandbox-exec' }]) {
    const module = createMacosModule(options);
    const { probes } = await collectProbes(module, { timeoutMs: 2000 });
    const assessment = assessIsolation({ platform: 'darwin', probes });
    assert.equal(assessment.mode, 'advisory');
    assert.ok(assessment.channels.every((entry) => entry.state === 'unknown' && entry.reason === 'control-did-not-run'), JSON.stringify(options));
    assert.equal(decideLaunch({ assessment, requested: 'enforced' }).allowed, false, 'enforcement is refused, not downgraded');
    await module.dispose();
  }
  const unknown = createMacosModule({ platform: 'linux' });
  assert.deepEqual(await unknown.probe('not-a-channel'), { control: false });
});

test('on this Mac every bypass is blocked and both interaction channels work, each against a control that got through', onlyMac, async () => {
  const module = createMacosModule();
  try {
    const { probes } = await collectProbes(module, { timeoutMs: 60000 });
    const assessment = assessIsolation({ platform: 'darwin', probes });
    const states = Object.fromEntries(assessment.channels.map((entry) => [entry.channel, `${entry.state}:${entry.reason}`]));
    // `gh` may be missing on a machine: that channel is then unknown (control did not run), and the rest must still hold.
    for (const entry of assessment.channels) {
      if (entry.channel === 'gh-cli' && entry.reason === 'control-did-not-run') continue;
      assert.equal(entry.state, 'enforced', `${entry.channel}: ${states[entry.channel]}`);
    }
  } finally { await module.dispose(); }
});

test('with no sandbox at all, every bypass is reported open, never blocked; the probes can tell the difference', onlyMac, async () => {
  const module = createMacosModule({ shapeSandbox: () => null, scrub: (env) => env });
  try {
    const { probes } = await collectProbes(module, { timeoutMs: 60000 });
    for (const channel of BYPASS) {
      if (channel === 'gh-cli' && !probes[channel]?.control) continue;
      assert.deepEqual({ control: probes[channel].control, outcome: probes[channel].outcome }, { control: true, outcome: 'open' }, channel);
    }
    const assessment = assessIsolation({ platform: 'darwin', probes });
    assert.equal(assessment.mode, 'advisory');
    assert.equal(decideLaunch({ assessment, requested: 'enforced' }).allowed, false);
  } finally { await module.dispose(); }
});

test('each channel is judged on its own: without the file rule only the credential file and the credential helper are open', onlyMac, async () => {
  const module = createMacosModule({ shapeSandbox: (spec) => ({ ...spec, denyRead: [] }) });
  try {
    const outcomes = {};
    for (const channel of ['file-credentials', 'credential-helper', 'direct-http', 'git-commit']) outcomes[channel] = (await module.probe(channel)).outcome;
    assert.deepEqual(outcomes, { 'file-credentials': 'open', 'credential-helper': 'open', 'direct-http': 'blocked', 'git-commit': 'blocked' });
  } finally { await module.dispose(); }
});

test('a sandbox that also cuts the CLI off from its own endpoint reads as broken, which is not enforced', onlyMac, async () => {
  const module = createMacosModule({ shapeSandbox: (spec) => ({ ...spec, allowLocalPorts: [] }) });
  try {
    const result = await module.probe('cli-own-login');
    assert.deepEqual({ control: result.control, outcome: result.outcome }, { control: true, outcome: 'broken' });
    const assessment = assessIsolation({ platform: 'darwin', probes: { 'cli-own-login': { ...result, observedAt: new Date().toISOString() } } });
    assert.equal(assessment.channels.find((entry) => entry.channel === 'cli-own-login').state, 'open');
  } finally { await module.dispose(); }
});

test('disposing removes the temporary folder with the synthetic credentials', onlyMac, async () => {
  const before = new Set(fs.readdirSync(require('node:os').tmpdir()).filter((name) => name.startsWith('mas-iso-')));
  const module = createMacosModule();
  await module.probe('file-credentials');
  const during = fs.readdirSync(require('node:os').tmpdir()).filter((name) => name.startsWith('mas-iso-') && !before.has(name));
  assert.equal(during.length, 1);
  await module.dispose();
  assert.equal(fs.existsSync(require('node:path').join(require('node:os').tmpdir(), during[0])), false);
  await module.dispose();
});

test('the keychain service is refused by name in the profile, and only a valid service name can be put there', () => {
  assert.deepEqual(KEYCHAIN_SERVICES, ['com.apple.SecurityServer']);
  assert.ok(seatbeltProfile({ denyMachServices: KEYCHAIN_SERVICES }).includes('(deny mach-lookup (global-name "com.apple.SecurityServer"))'));
  assert.equal(seatbeltProfile().includes('mach-lookup'), false, 'nothing is added unless asked for');
  for (const bad of ['', 'a"b', 'a b', 'a)b', '(allow default)', 'a\nb', 'x'.repeat(129), '.x', 5, null]) assert.throws(() => seatbeltProfile({ denyMachServices: [bad] }), /isolation-profile-service-invalid/, String(bad));
  assert.throws(() => seatbeltProfile({ denyMachServices: 'x' }), /isolation-profile-service-invalid/);
});

test('the real credential locations under a home folder are all in the profile\'s read denials', () => {
  const home = '/home/someone';
  const locations = credentialLocations(home);
  assert.deepEqual(locations, ['/home/someone/.git-credentials', '/home/someone/.config/git/credentials', '/home/someone/.config/gh', '/home/someone/.netrc', '/home/someone/.ssh', '/home/someone/Library/Keychains']);
  assert.equal(HOME_CREDENTIAL_PATHS.length, 6);
  const text = seatbeltProfile({ denyRead: locations });
  for (const location of locations) assert.ok(text.includes(`(deny file-read* (subpath "${location}"))`), location);
  for (const bad of ['relative', '/h"ome', '/h)ome', '', undefined]) assert.throws(() => credentialLocations(bad), /isolation-profile-path-invalid/);
});

test('under a temporary home, every credential location is unreadable inside the sandbox and readable outside it', onlyMac, async () => {
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mas-home-')));
  try {
    const files = credentialLocations(home).map((location) => (/\.(git-credentials|netrc)$|credentials$/.test(location) ? location : path.join(location, 'file')));
    for (const file of files) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'synthetic'); }
    const profile = path.join(home, 'p.sb');
    fs.writeFileSync(profile, seatbeltProfile({ denyRead: credentialLocations(home) }));
    for (const file of files) {
      assert.equal(spawnSync('/bin/cat', [file]).stdout.toString(), 'synthetic', `control: ${path.relative(home, file)}`);
      const inside = spawnSync(SANDBOX_EXEC, ['-f', profile, '/bin/cat', file]);
      assert.notEqual(inside.status, 0, path.relative(home, file));
      assert.equal(inside.stdout.toString(), '');
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('a control that could not run is never reported as blocked: without gh on the path the gh channel is unknown and enforcement is refused', onlyMac, async () => {
  const module = createMacosModule({ parentEnv: { PATH: '/usr/bin:/bin' } });
  try {
    const probe = await module.probe('gh-cli');
    assert.deepEqual(probe, { control: false });
    const assessment = assessIsolation({ platform: 'darwin', probes: { 'gh-cli': { ...probe, observedAt: new Date().toISOString() } } });
    assert.equal(assessment.channels.find((entry) => entry.channel === 'gh-cli').reason, 'control-did-not-run');
    assert.notEqual(assessment.mode, 'enforced');
    const { probes } = await collectProbes(module, { timeoutMs: 60000 });
    const full = assessIsolation({ platform: 'darwin', probes });
    assert.equal(full.channels.find((entry) => entry.channel === 'gh-cli').state, 'unknown');
    assert.equal(full.mode, 'advisory', 'one channel without a control keeps the whole assessment from being enforced');
  } finally { await module.dispose(); }
});

test('a keychain item is out of reach inside the sandbox and in reach without the service rule: the rule is what closes it', onlyMac, async () => {
  const closed = createMacosModule();
  const open = createMacosModule({ shapeSandbox: (spec) => ({ ...spec, denyMachServices: [] }) });
  try {
    const withRule = await closed.probe('credential-helper');
    const without = await open.probe('credential-helper');
    assert.deepEqual(withRule, { control: true, outcome: 'blocked' });
    assert.deepEqual(without, { control: true, outcome: 'open' }, 'with the service reachable, the keychain item comes back');
  } finally { await closed.dispose(); await open.dispose(); }
});
