'use strict';

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { CHANNELS } = require('./capabilities');
const { seatbeltProfile, scrubEnvironment, credentialLocations, KEYCHAIN_SERVICES, SANDBOX_EXEC } = require('./macos');

/**
 * The macOS verification harness for the managed-isolation interface (issue #25). It tries every bypass channel for
 * real, on this machine, with synthetic credentials and local stand-in endpoints, and reports what happened in the
 * shape `collectProbes` expects. Test code on purpose: see `src/isolation/macos.js`.
 *
 * What counts as a result is observed, not inferred from an exit code: a bypass is "open" only when the stand-in
 * server saw a connection, or the synthetic marker came back, or the commit appeared. Each attempt is run twice, the
 * same way, once inside the sandbox and once outside as the control; a control that could not succeed (for example
 * `gh` is not installed) makes the channel unknown, never blocked.
 */

const ATTEMPT_TIMEOUT_MS = 10_000;

function findExecutable(name, searchPath = process.env.PATH ?? '') {
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return candidate; } catch { /* next */ }
  }
  return undefined;
}

function run(file, args, { cwd, env, input, signal, timeoutMs = ATTEMPT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = execFile(file, args, { cwd, env, signal, timeout: timeoutMs, maxBuffer: 1 << 20, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
    child.on('error', () => {});
    if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}

function listen(server) {
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
}

/** A TCP server that counts connections and drops them: "was this endpoint reached at all". */
async function countingServer() {
  let count = 0;
  const sockets = new Set();
  const server = net.createServer((socket) => { count += 1; sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); socket.destroy(); });
  const port = await listen(server);
  return { port, count: () => count, reset: () => { count = 0; }, close: () => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }) };
}

/**
 * `shapeSandbox` and `scrub` exist so a test can weaken the isolation on purpose and see every bypass reported as open;
 * the defaults are the real ones.
 * @param {{ platform?: string, sandboxExec?: string, tmpRoot?: string, parentEnv?: Record<string, string | undefined>, timeoutMs?: number, shapeSandbox?: (spec: object) => object, scrub?: (env: object) => object }} [options]
 * @returns {{ platform: 'darwin', probe(channel: string, context?: { signal?: AbortSignal }): Promise<{ outcome?: string, control: boolean }>, dispose(): Promise<void> }}
 */
function createMacosModule({ platform = process.platform, sandboxExec = SANDBOX_EXEC, tmpRoot = os.tmpdir(), parentEnv = process.env, timeoutMs = ATTEMPT_TIMEOUT_MS, shapeSandbox = (spec) => spec, scrub = scrubEnvironment } = {}) {
  let fixture;
  const supported = platform === 'darwin' && (() => { try { fs.accessSync(sandboxExec, fs.constants.X_OK); return true; } catch { return false; } })();

  async function prepare() {
    if (fixture) return fixture;
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpRoot, 'mas-iso-')));
    const marker = `synthetic-${randomBytes(8).toString('hex')}`;
    const creds = path.join(root, 'credentials');
    fs.mkdirSync(path.join(creds, 'home', '.config', 'gh'), { recursive: true });
    fs.writeFileSync(path.join(creds, 'home', '.config', 'gh', 'hosts.yml'), `github.com:\n  user: ${marker}\n`);
    // A file at one of the real credential locations under the fixture home: the sandbox must keep it unreadable too.
    fs.writeFileSync(path.join(root, '.netrc'), `synthetic ${marker}\n`);
    fs.writeFileSync(path.join(creds, 'git-credentials'), `https://synthetic:${marker}@github.com\n`);
    const cliHome = path.join(root, 'cli-home');
    fs.mkdirSync(cliHome);
    fs.writeFileSync(path.join(cliHome, 'auth.json'), '{"synthetic":true}\n');
    // A keychain of its own (never the person's): one synthetic internet password, readable by the `security` tool.
    // Without it (no `security` command) the keychain half of the credential-helper channel is simply not tried.
    const keychain = path.join(root, 'test.keychain-db');
    const made = await run('/usr/bin/security', ['create-keychain', '-p', 'synthetic-pw', keychain], { env: { PATH: '/usr/bin:/bin' } });
    let keychainReady = false;
    if (made.ok) {
      const unlocked = await run('/usr/bin/security', ['unlock-keychain', '-p', 'synthetic-pw', keychain], { env: { PATH: '/usr/bin:/bin' } });
      const added = await run('/usr/bin/security', ['add-internet-password', '-a', 'synthetic', '-s', 'example.test', '-w', marker, '-U', '-T', '/usr/bin/security', keychain], { env: { PATH: '/usr/bin:/bin' } });
      keychainReady = unlocked.ok && added.ok;
    }
    fixture = { root, marker, creds, cliHome, keychain: keychainReady ? keychain : null, github: await countingServer(), provider: await countingServer(), repos: 0 };
    return fixture;
  }

  const baseEnv = (extra = {}) => ({ PATH: parentEnv.PATH ?? '/usr/bin:/bin', HOME: fixture.root, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', ...extra });

  function newRepo() {
    const dir = path.join(fixture.root, `repo-${fixture.repos += 1}`);
    fs.mkdirSync(dir);
    return run('/usr/bin/git', ['init', '-q', '-b', 'main', dir], { env: baseEnv() }).then(() => run('/usr/bin/git', ['-C', dir, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'initial'], { env: baseEnv() })).then(() => dir);
  }

  /** Runs `file args` inside the sandbox described by `spec`, or directly when `spec` is null (the control). */
  function launch(spec, file, args, options) {
    if (spec === null) return run(file, args, options);
    const profile = seatbeltProfile(spec);
    const profilePath = path.join(fixture.root, `profile-${randomBytes(4).toString('hex')}.sb`);
    fs.writeFileSync(profilePath, profile);
    return run(sandboxExec, ['-f', profilePath, file, ...args], options);
  }

  // `protectRepoGit` is resolved per attempt, because each attempt works in its own repository.
  const sandboxSpec = () => ({ denyRead: [fixture.creds, ...credentialLocations(fixture.root)], allowLocalPorts: [fixture.provider.port], denyMachServices: KEYCHAIN_SERVICES, protectRepoGit: true });

  // Each attempt answers one question: did the bypass get through? `spec` is the sandbox, or null for the control.
  const attempts = {
    async 'git-commit'(spec, ctx) {
      const repo = await newRepo();
      const sandbox = spec === null ? null : { ...spec, denyWrite: spec.protectRepoGit ? [path.join(repo, '.git')] : [] };
      await launch(sandbox, '/usr/bin/git', ['-C', repo, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'bypass'], { ...ctx, env: baseEnv() });
      const counted = await run('/usr/bin/git', ['-C', repo, 'rev-list', '--count', 'HEAD'], { env: baseEnv() });
      return counted.ok && Number(counted.stdout.trim()) > 1;
    },
    async 'git-push'(spec, ctx) {
      const repo = await newRepo();
      fixture.github.reset();
      await launch(spec, '/usr/bin/git', ['-C', repo, '-c', 'credential.helper=', 'push', `http://127.0.0.1:${fixture.github.port}/synthetic.git`, 'HEAD:refs/heads/bypass'], { ...ctx, env: baseEnv() });
      return fixture.github.count() > 0;
    },
    async 'gh-cli'(spec, ctx) {
      const gh = findExecutable('gh', parentEnv.PATH);
      if (!gh) return null;
      fixture.github.reset();
      const configDir = path.join(fixture.root, 'gh-config');
      fs.mkdirSync(configDir, { recursive: true });
      await launch(spec, gh, ['api', '-X', 'POST', 'repos/synthetic/synthetic/issues', '-f', 'title=bypass'], { ...ctx, env: baseEnv({ GH_HOST: `127.0.0.1:${fixture.github.port}`, GH_ENTERPRISE_TOKEN: 'synthetic', GH_CONFIG_DIR: configDir }) });
      return fixture.github.count() > 0;
    },
    async 'credential-helper'(spec, ctx) {
      const filled = await launch(spec, '/usr/bin/git', ['-c', `credential.helper=store --file=${path.join(fixture.creds, 'git-credentials')}`, 'credential', 'fill'], { ...ctx, env: baseEnv(), input: 'protocol=https\nhost=github.com\n\n' });
      // The keychain: the system service answers `security` and `git-credential-osxkeychain`, whatever files are readable.
      let fromKeychain = false;
      if (fixture.keychain) {
        const found = await launch(spec, '/usr/bin/security', ['find-internet-password', '-s', 'example.test', '-w', fixture.keychain], { ...ctx, env: baseEnv() });
        fromKeychain = found.stdout.includes(fixture.marker);
      }
      return filled.stdout.includes(fixture.marker) || fromKeychain;
    },
    async 'direct-http'(spec, ctx) {
      fixture.github.reset();
      await launch(spec, '/usr/bin/curl', ['-s', '-m', '5', '-o', '/dev/null', `http://127.0.0.1:${fixture.github.port}/`], { ...ctx, env: baseEnv() });
      return fixture.github.count() > 0;
    },
    async 'env-credentials'(spec, ctx) {
      // The terminal's environment is built by `scrubEnvironment`; the control passes the parent environment as it is.
      const parent = { ...baseEnv(), GH_TOKEN: fixture.marker, GITHUB_TOKEN: fixture.marker, SSH_AUTH_SOCK: '/synthetic.sock' };
      const seen = await launch(spec, '/usr/bin/env', [], { ...ctx, env: spec === null ? parent : scrub(parent) });
      return seen.stdout.includes(fixture.marker);
    },
    async 'file-credentials'(spec, ctx) {
      const planted = await launch(spec, '/bin/cat', [path.join(fixture.creds, 'home', '.config', 'gh', 'hosts.yml')], { ...ctx, env: baseEnv() });
      const atHome = await launch(spec, '/bin/cat', [path.join(fixture.root, '.netrc')], { ...ctx, env: baseEnv() });
      return planted.stdout.includes(fixture.marker) || atHome.stdout.includes(fixture.marker);
    },
    // The two interaction channels answer "does it still work", so `true` here means working.
    async 'terminal-interaction'(spec, ctx) {
      const script = 'IFS= read -r line; echo "echo:$line"; sleep 30';
      const argv = spec === null ? ['/bin/sh', '-c', script] : [sandboxExec, '-f', writeProfile(spec), '/bin/sh', '-c', script];
      return interactive(argv, ctx.signal, timeoutMs);
    },
    async 'cli-own-login'(spec, ctx) {
      fixture.provider.reset();
      const read = await launch(spec, '/bin/cat', [path.join(fixture.cliHome, 'auth.json')], { ...ctx, env: baseEnv() });
      await launch(spec, '/usr/bin/curl', ['-s', '-m', '5', '-o', '/dev/null', `http://127.0.0.1:${fixture.provider.port}/`], { ...ctx, env: baseEnv() });
      return read.stdout.includes('synthetic') && fixture.provider.count() > 0;
    }
  };

  function writeProfile(spec) {
    const profilePath = path.join(fixture.root, `profile-${randomBytes(4).toString('hex')}.sb`);
    fs.writeFileSync(profilePath, seatbeltProfile(spec));
    return profilePath;
  }

  return {
    platform: 'darwin',
    async probe(channel, { signal } = {}) {
      const kind = Object.hasOwn(CHANNELS, channel) ? CHANNELS[channel].kind : undefined;
      if (!kind || !supported || !Object.hasOwn(attempts, channel)) return { control: false };
      await prepare();
      const ctx = { signal };
      const control = await attempts[channel](null, ctx);
      // The control must achieve the thing the sandbox is supposed to stop (or, for interaction, must work).
      if (control !== true) return { control: false };
      const inside = await attempts[channel](shapeSandbox(sandboxSpec()), ctx);
      if (inside === null) return { control: false };
      if (kind === 'bypass') return { control: true, outcome: inside ? 'open' : 'blocked' };
      return { control: true, outcome: inside ? 'works' : 'broken' };
    },
    async dispose() {
      if (!fixture) return;
      const { root, github, provider } = fixture;
      fixture = undefined;
      await Promise.all([github.close(), provider.close()]);
      if (fixture === undefined && root) await run('/usr/bin/security', ['delete-keychain', path.join(root, 'test.keychain-db')], { env: { PATH: '/usr/bin:/bin' } });
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

const PTY_DRIVER = [
  'import os, pty, select, sys, time',
  'pid, fd = pty.fork()',
  'if pid == 0:',
  '    os.execv(sys.argv[1], sys.argv[1:])',
  'time.sleep(0.3)',
  'os.write(fd, b"synthetic-input\\n")',
  'seen = b""; answered = False; end = time.time() + float(os.environ["MAS_LIMIT"])',
  'while time.time() < end:',
  '    ready, _, _ = select.select([fd], [], [], 0.2)',
  '    if ready:',
  '        try: chunk = os.read(fd, 4096)',
  '        except OSError: chunk = b""',
  '        seen += chunk',
  '        if not answered and b"echo:synthetic-input" in seen:',
  '            answered = True; os.write(fd, b"\\x03")',
  '    done, _ = os.waitpid(pid, os.WNOHANG)',
  '    if done:',
  '        sys.exit(0 if answered else 1)',
  'try: os.kill(pid, 9)',
  'except OSError: pass',
  'sys.exit(1)'
].join('\n');

/**
 * Types a line into a program on a real pseudo-terminal and checks that it answers and that Ctrl-C ends it.
 * Python's `pty` supplies the terminal (it is the only one the system offers without a dependency); no Python means
 * the control cannot run and the channel is unknown. Resolves true only when both happened before the time limit.
 */
function interactive(argv, signal, timeoutMs) {
  return run('/usr/bin/python3', ['-I', '-c', PTY_DRIVER, ...argv], { signal, timeoutMs: timeoutMs + 2000, env: { PATH: '/usr/bin:/bin', MAS_LIMIT: String(Math.max(1, Math.floor(timeoutMs / 1000) - 1)) } }).then((result) => result.ok);
}

module.exports = { createMacosModule };
