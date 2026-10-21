'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareEnforcedLaunch, launchSpec } = require('../../src/isolation/enforced-launch');
const { CHANNELS } = require('../../src/isolation/capabilities');
const { execFileSync } = require('node:child_process');
const { SANDBOX_EXEC, isolationSpec, gitDirectoriesFor } = require('../../src/isolation/macos');

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
  const cwd = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mas-enf-work-'));
  return { platform: 'darwin', cwd, parentEnv: { PATH: '/usr/bin:/bin' }, allowedDomains: ['api.provider.test'], storageDir, home: '/synthetic/home', createHarness: fakeHarness(), createProxy: fakeProxy(), ...extra };
};
const leftovers = (dir) => fs.readdirSync(dir);

test('with every channel proven, the command is the sandboxed one and the environment points at the local proxy', posixOnly, async () => {
  const input = base();
  const result = await prepareEnforcedLaunch(input);
  assert.equal(result.ok, true);
  const command = result.wrapCommand('claude', ['--model', 'x']);
  assert.equal(command.executable, '/usr/bin/env');
  const at = command.args.indexOf(SANDBOX_EXEC);
  assert.equal(command.args[at + 1], '-f');
  assert.deepEqual(command.args.slice(at + 3), ['claude', '--model', 'x']);
  assert.equal(result.env.HTTPS_PROXY, 'http://managed:abc123@127.0.0.1:45678');
  const profile = fs.readFileSync(command.args[at + 2], 'utf8');
  assert.match(profile, /\(deny network\*\)/);
  assert.match(profile, /localhost:45678/);
  assert.match(profile, /deny file-read\* \(subpath "\/synthetic\/home\/\.config\/gh"\)/);
  assert.match(profile, /com\.apple\.SecurityServer/);
  assert.equal(fs.statSync(command.args[at + 2]).mode & 0o077, 0, 'the profile is readable only by the person');
  assert.equal(fs.statSync(path.dirname(command.args[at + 2])).mode & 0o077, 0, 'so is the folder it lives in');
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

const git = (cwd, ...args) => execFileSync('/usr/bin/git', ['-C', cwd, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic.invalid', '-c', 'commit.gpgsign=false', ...args], { env: { PATH: '/usr/bin:/bin', HOME: os.tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: 'pipe' });

test('the profile denies writing to the folder\'s git directory, as the harness protected the one it probed', posixOnly, async () => {
  const input = base();
  git(input.cwd, 'init', '-q', '-b', 'main');
  const result = await prepareEnforcedLaunch(input);
  const command = result.wrapCommand('claude', []);
  const profile = fs.readFileSync(command.args[command.args.indexOf(SANDBOX_EXEC) + 2], 'utf8');
  assert.deepEqual(gitDirectoriesFor(input.cwd), [path.join(fs.realpathSync(input.cwd), '.git')]);
  assert.match(profile, new RegExp(`deny file-write\\* \\(subpath "${path.join(fs.realpathSync(input.cwd), '.git').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\)`));
  await result.dispose();
});

test('a linked worktree is protected too: its git directory and the common directory it names', posixOnly, async () => {
  const main = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mas-enf-main-'));
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'commit', '-q', '--allow-empty', '-m', 'initial');
  const linked = path.join(main, 'linked');
  git(main, 'worktree', 'add', '-q', '-b', 'topic', linked);
  const dirs = gitDirectoriesFor(linked);
  assert.ok(dirs.includes(path.join(fs.realpathSync(linked), '.git')));
  assert.ok(dirs.includes(path.join(fs.realpathSync(main), '.git')), 'the common directory');
  assert.ok(dirs.some((dir) => dir.includes(`${path.sep}worktrees${path.sep}`)), 'the worktree\'s own git directory');
});

test('a .git file that cannot be understood refuses to start', posixOnly, async () => {
  const input = base();
  fs.writeFileSync(path.join(input.cwd, '.git'), 'not a git file\n');
  const result = await prepareEnforcedLaunch(input);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'git-dir-unreadable');
  assert.deepEqual(leftovers(input.storageDir), []);
});

test('a folder that is not an absolute plain path refuses', posixOnly, async () => {
  for (const cwd of [undefined, 'relative', '/tmp/a(b)']) assert.equal((await prepareEnforcedLaunch(base({ cwd }))).code, 'folder-invalid');
});

const real = process.platform === 'darwin' && fs.existsSync(SANDBOX_EXEC);
const onlyMac = real ? {} : { skip: 'needs macOS and /usr/bin/sandbox-exec' };

test('the command that is really typed cannot commit in the folder or in a linked worktree (the profile that is run, not the one that was probed)', onlyMac, async () => {
  const main = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mas-enf-main-'));
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'commit', '-q', '--allow-empty', '-m', 'initial');
  const linked = path.join(main, 'linked');
  git(main, 'worktree', 'add', '-q', '-b', 'topic', linked);
  for (const folder of [main, linked]) {
    const input = base({ cwd: folder });
    const result = await prepareEnforcedLaunch(input);
    const command = result.wrapCommand('git', ['-C', folder, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'bypass']);
    const before = git(folder, 'rev-list', '--count', 'HEAD').toString().trim();
    try { execFileSync(command.executable, command.args, { env: { PATH: '/usr/bin:/bin', HOME: os.tmpdir() }, stdio: 'pipe' }); } catch { /* expected: the commit is refused */ }
    assert.equal(git(folder, 'rev-list', '--count', 'HEAD').toString().trim(), before, 'no commit was made');
    await result.dispose();
  }
});

test('GitHub credentials are removed from the terminal and from the program, also when a shell exported them', posixOnly, async () => {
  const parentEnv = { PATH: '/usr/bin:/bin', GH_TOKEN: 'synthetic-value', GITHUB_TOKEN: 'synthetic-value', GH_CUSTOM_SECRET: 'synthetic-value', SSH_AUTH_SOCK: '/synthetic.sock', KEEP_ME: '1' };
  const result = await prepareEnforcedLaunch(base({ parentEnv }));
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_CUSTOM_SECRET', 'SSH_AUTH_SOCK', 'GH_ENTERPRISE_TOKEN', 'GIT_ASKPASS']) assert.equal(result.env[name], null, `${name} is unset in the terminal`);
  assert.equal(Object.hasOwn(result.env, 'KEEP_ME'), false, 'nothing else is touched');
  const command = result.wrapCommand('claude', []);
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_CUSTOM_SECRET', 'SSH_AUTH_SOCK']) {
    const index = command.args.indexOf(name);
    assert.ok(index > 0 && command.args[index - 1] === '-u', `${name} is unset by env -u in the typed command`);
  }
  assert.ok(!command.args.includes('KEEP_ME'));
  await result.dispose();
});

test('the program really does not see a credential variable that is in its environment when it starts', onlyMac, async () => {
  const result = await prepareEnforcedLaunch(base({ parentEnv: { PATH: '/usr/bin:/bin', GH_TOKEN: 'synthetic-value' } }));
  const command = result.wrapCommand('env', []);
  const seen = execFileSync(command.executable, command.args, { env: { PATH: '/usr/bin:/bin', GH_TOKEN: 'synthetic-value', KEEP_ME: '1' }, stdio: 'pipe' }).toString();
  assert.ok(!seen.includes('GH_TOKEN'), 'removed');
  assert.ok(seen.includes('KEEP_ME=1'), 'the rest is kept');
  assert.ok(seen.includes('HTTPS_PROXY') === false, 'the proxy variables travel in the terminal environment, not through env -u');
  await result.dispose();
});

test('the harness and the launch describe the sandbox with the same function and the same shape', () => {
  const spec = isolationSpec({ home: '/synthetic/home', allowLocalPorts: [1234], gitDirs: ['/synthetic/work/.git'] });
  assert.deepEqual(launchSpec({ home: '/synthetic/home', proxyPort: 1234, gitDirs: ['/synthetic/work/.git'] }), spec);
  assert.deepEqual(Object.keys(spec).sort(), ['allowLocalPorts', 'denyMachServices', 'denyRead', 'denyWrite']);
  assert.deepEqual(spec.denyWrite, ['/synthetic/work/.git']);
});
