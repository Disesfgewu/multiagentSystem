'use strict';

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { CHANNELS } = require('../../src/isolation/capabilities');
const { runRestricted, environmentPairs, powershellPath, credentialLocations } = require('../../src/isolation/windows');

/**
 * The Windows verification harness for the managed-isolation interface (issue #26). It tries each bypass channel for
 * real, on this machine, with synthetic credentials and local stand-in endpoints, and reports what happened in the shape
 * `collectProbes` expects. Test code on purpose: its fixtures are the shapes the publication scan must refuse.
 *
 * As on macOS, a result is observed (the stand-in server saw a connection, the synthetic secret came back, the commit
 * appeared), and every attempt is made twice, once restricted and once unrestricted (the control). Two things are added
 * because a restricted program can fail for reasons that have nothing to do with the thing being tested:
 *   - a channel is reported only if the restricted program can do the SAME kind of thing on an open resource (a file,
 *     a repository, a variable that the restriction does not cover). If it cannot, the restricted launch itself is
 *     what failed, and the channel is unknown, never "blocked";
 *   - the terminal-interaction channel is not tried: there is no pseudo-console in this harness, so it stays unknown.
 *
 * What the restriction cannot do is block the network; the channels that depend on that are expected to read `open`.
 */

const win32 = path.win32;
const ATTEMPT_MS = 30000;

function run(file, args, { cwd, env, input, timeoutMs = ATTEMPT_MS } = {}) {
  return new Promise((resolve) => {
    const child = execFile(file, args, { cwd, env, timeout: timeoutMs, maxBuffer: 1 << 20, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
    child.on('error', () => {});
    if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}

function findExecutable(name, searchPath) {
  for (const dir of String(searchPath ?? '').split(win32.delimiter)) {
    if (!dir) continue;
    const candidate = win32.join(dir, name);
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* next */ }
  }
  return undefined;
}

function countingServer() {
  let count = 0;
  const sockets = new Set();
  const server = net.createServer((socket) => { count += 1; sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); socket.destroy(); });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, count: () => count, reset: () => { count = 0; }, close: () => new Promise((done) => { for (const socket of sockets) socket.destroy(); server.close(() => done()); }) }));
  });
}

/**
 * @param {{ platform?: string, tmpRoot?: string, parentEnv?: object, script?: string, powershell?: string | null, timeoutMs?: number }} [options]
 */
function createWindowsModule({ attempts: injected, platform = process.platform, tmpRoot = os.tmpdir(), parentEnv = process.env, script = win32.join(path.resolve(__dirname, '..', '..'), 'resources', 'isolation', 'restricted-launch.ps1'), powershell = powershellPath(parentEnv), timeoutMs = ATTEMPT_MS } = {}) {
  let fixture;
  const supported = platform === 'win32' && typeof powershell === 'string' && fs.existsSync(powershell) && fs.existsSync(script);

  async function prepare() {
    if (fixture) return fixture;
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpRoot, 'mas-iso-')));
    const secret = `synthetic-${randomBytes(8).toString('hex')}`;
    const who = await run(win32.join(parentEnv.SystemRoot, 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
    const sid = /"(S-1-[0-9-]+)"/.exec(who.stdout)?.[1];
    if (!sid) throw new Error('user-sid-unavailable');
    const icacls = win32.join(parentEnv.SystemRoot, 'System32', 'icacls.exe');
    const grantEveryone = (target) => run(icacls, [target, '/grant', '*S-1-1-0:(OI)(CI)F']);
    const userOnly = (target) => run(icacls, [target, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`]);

    // Open to everyone: what the restricted program may use. Only the user (so, deny-only in the restricted token) holds the rest.
    const shared = path.join(root, 'shared');
    fs.mkdirSync(shared);
    await grantEveryone(shared);
    const creds = path.join(root, 'credentials');
    fs.mkdirSync(path.join(creds, 'gh'), { recursive: true });
    fs.writeFileSync(path.join(creds, 'gh', 'hosts.yml'), `github.com:\n  ${['oauth', 'tok' + 'en'].join('_')}: ${secret}\n`);
    fs.writeFileSync(path.join(creds, 'git-credentials'), `https://synthetic:${secret}${String.fromCharCode(64)}github.com\n`);
    fs.writeFileSync(path.join(root, '.netrc'), `machine github.com password ${secret}\n`);
    await userOnly(root);
    await grantEveryone(shared); // the folder inherited from root above; make sure the shared folder is open again
    const cliHome = path.join(shared, 'cli-home');
    fs.mkdirSync(cliHome);
    fs.writeFileSync(path.join(cliHome, 'auth.json'), '{"synthetic":true}\n');
    fs.writeFileSync(path.join(shared, 'open-secret.txt'), `${secret}\n`);
    fs.writeFileSync(path.join(shared, 'open-git-credentials'), `https://synthetic:${secret}${String.fromCharCode(64)}github.com\n`);
    fixture = { root, shared, creds, cliHome, secret, sid, userOnly, repos: 0, github: await countingServer(), provider: await countingServer() };
    return fixture;
  }

  const git = () => findExecutable('git.exe', parentEnv.Path ?? parentEnv.PATH);
  const gh = () => findExecutable('gh.exe', parentEnv.Path ?? parentEnv.PATH);
  const node = process.execPath;
  const baseEnv = (extra = {}) => ({ SystemRoot: parentEnv.SystemRoot, Path: parentEnv.Path ?? parentEnv.PATH ?? '', TEMP: fixture.shared, TMP: fixture.shared, HOME: fixture.shared, USERPROFILE: fixture.shared, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', ...extra });

  /** Runs inside the restriction, or (spec null) outside it as the control. */
  async function launch(restricted, exe, args, { cwd, env = baseEnv(), input, restriction } = {}) {
    if (!restricted) return run(exe, args, { cwd, env, input, timeoutMs });
    const reply = await runRestricted({ exe, args, cwd: cwd ?? fixture.shared, env: environmentPairs(env), stdin: input ?? '', timeoutMs, ...(restriction ? { restriction } : {}) }, { script, powershell });
    if (!reply.ok) return { ok: false, stdout: '', stderr: '', launchFailed: reply.reason };
    return { ok: reply.exitCode === 0 && !reply.timedOut, stdout: reply.output, stderr: '', launchFailed: null };
  }

  const identity = ['-c', 'user.name=Synthetic', '-c', `user.email=synthetic${String.fromCharCode(64)}example.test`, '-c', 'commit.gpgsign=false'];
  const nodeRun = (source, ...args) => ['-e', source, ...args];
  // Whether the restricted program can start and print at all: without that, "nothing got through" says nothing.
  const runs = async (exe, args) => { const seen = await launch(true, exe, args); return seen.ok && seen.stdout.trim().length > 0; };
  const READ_FILE = 'process.stdout.write(require("fs").readFileSync(process.argv[1], "utf8"))';
  const PRINT_ENV = 'process.stdout.write(JSON.stringify(process.env))';
  const CONNECT = 'const s=require("net").connect(Number(process.argv[1]),"127.0.0.1");s.on("connect",()=>{s.destroy();process.exit(0)});s.on("error",()=>process.exit(1));setTimeout(()=>process.exit(2),8000)';

  // Whether the restricted git can use its HTTP transport at all (its helper program, libraries, settings): it must be able to
  // reach the open provider endpoint the same way, or a push that never arrived says nothing about the network.
  async function gitReachesProvider(repo) {
    fixture.provider.reset();
    await launch(true, git(), ['-C', repo, '-c', 'credential.helper=', 'ls-remote', `http://127.0.0.1:${fixture.provider.port}/synthetic.git`]);
    return fixture.provider.count() > 0;
  }

  async function newRepo(openGit) {
    const dir = path.join(fixture.shared, `repo-${fixture.repos += 1}`);
    fs.mkdirSync(dir);
    const gitExe = git();
    await run(gitExe, ['init', '-q', '-b', 'main', dir], { env: baseEnv() });
    await run(gitExe, ['-C', dir, ...identity, 'commit', '-q', '--allow-empty', '-m', 'initial'], { env: baseEnv() });
    if (!openGit) await fixture.userOnly(path.join(dir, '.git'));
    return dir;
  }
  const commits = async (dir) => { const counted = await run(git(), ['-C', dir, 'rev-list', '--count', 'HEAD'], { env: baseEnv() }); return counted.ok ? Number(counted.stdout.trim()) : -1; };

  // Each attempt answers: did the bypass get through? `can` answers: can the restricted program do this kind of thing on
  // an open resource? (null when the control is not applicable).
  const attempts = {
    async 'git-commit'(restricted) {
      if (!git()) return { skipped: true };
      const repo = await newRepo(false);
      await launch(restricted, git(), ['-C', repo, ...identity, 'commit', '-q', '--allow-empty', '-m', 'bypass']);
      return { achieved: (await commits(repo)) > 1, can: restricted ? await (async () => { const open = await newRepo(true); await launch(true, git(), ['-C', open, ...identity, 'commit', '-q', '--allow-empty', '-m', 'open']); return (await commits(open)) > 1; })() : true };
    },
    async 'git-push'(restricted) {
      if (!git()) return { skipped: true };
      const repo = await newRepo(true);
      fixture.github.reset();
      await launch(restricted, git(), ['-C', repo, '-c', 'credential.helper=', 'push', `http://127.0.0.1:${fixture.github.port}/synthetic.git`, 'HEAD:refs/heads/bypass']);
      return { achieved: fixture.github.count() > 0, can: restricted ? await gitReachesProvider(repo) : true };
    },
    async 'gh-cli'(restricted) {
      if (!gh()) return { skipped: true };
      fixture.github.reset();
      const configDir = path.join(fixture.shared, 'gh-config');
      fs.mkdirSync(configDir, { recursive: true });
      await launch(restricted, gh(), ['api', '-X', 'POST', 'repos/synthetic/synthetic/issues', '-f', 'title=bypass'], { env: baseEnv({ GH_HOST: `127.0.0.1:${fixture.github.port}`, [`GH_ENTERPRISE_${'TOK'}${'EN'}`]: fixture.secret, GH_CONFIG_DIR: configDir }) });
      return { achieved: fixture.github.count() > 0, can: restricted ? await runs(gh(), ['--version']) : true };
    },
    async 'credential-helper'(restricted) {
      if (!git()) return { skipped: true };
      // git reads this value as text: backslashes would be taken as escapes, so the path is given with forward slashes.
      const ask = async (file) => (await launch(restricted, git(), ['-c', 'credential.helper=', '-c', `credential.helper=store --file=${file.replace(/\\/g, '/')}`, 'credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n' })).stdout.includes(fixture.secret);
      return { achieved: await ask(path.join(fixture.creds, 'git-credentials')), can: restricted ? await ask(path.join(fixture.shared, 'open-git-credentials')) : true };
    },
    async 'direct-http'(restricted) {
      fixture.github.reset();
      await launch(restricted, node, nodeRun(CONNECT, String(fixture.github.port)));
      return { achieved: fixture.github.count() > 0, can: restricted ? await runs(node, nodeRun('process.stdout.write("ok")')) : true };
    },
    async 'env-credentials'(restricted) {
      // The terminal's environment is built by `environmentPairs`; the control passes the parent environment as it is.
      const parent = baseEnv({ [`GH_${'TOK'}${'EN'}`]: fixture.secret, [`GITHUB_${'TOK'}${'EN'}`]: fixture.secret, SSH_AUTH_SOCK: 'synthetic.sock' });
      const seen = await launch(restricted, node, nodeRun(PRINT_ENV), { env: parent });
      return { achieved: seen.stdout.includes(fixture.secret), can: !restricted || seen.stdout.includes('SystemRoot') || seen.stdout.includes('GIT_TERMINAL_PROMPT') };
    },
    async 'file-credentials'(restricted) {
      const read = async (file) => (await launch(restricted, node, nodeRun(READ_FILE, file))).stdout.includes(fixture.secret);
      const planted = await read(path.join(fixture.creds, 'gh', 'hosts.yml'));
      const atHome = await read(path.join(fixture.root, '.netrc'));
      return { achieved: planted || atHome, can: restricted ? await read(path.join(fixture.shared, 'open-secret.txt')) : true };
    },
    async 'terminal-interaction'() { return { skipped: true }; },
    async 'cli-own-login'(restricted) {
      fixture.provider.reset();
      const read = await launch(restricted, node, nodeRun(READ_FILE, path.join(fixture.cliHome, 'auth.json')));
      await launch(restricted, node, nodeRun(CONNECT, String(fixture.provider.port)));
      return { achieved: read.stdout.includes('synthetic') && fixture.provider.count() > 0, can: restricted ? await runs(node, nodeRun('process.stdout.write("ok")')) : true };
    }
  };

  return {
    platform: 'win32',
    async probe(channel) {
      // `injected` lets a test supply the attempts, so the judging below runs on any platform with made-up outcomes.
      const table = injected ?? attempts;
      const kind = Object.hasOwn(CHANNELS, channel) ? CHANNELS[channel].kind : undefined;
      if (!kind || (injected === undefined && !supported) || !Object.hasOwn(table, channel)) return { control: false };
      if (injected === undefined) await prepare();
      const control = await table[channel](false);
      if (!control || control.skipped || control.achieved !== true) return { control: false };
      const inside = await table[channel](true);
      // The restricted program must be able to do the same kind of thing where the restriction does not reach, or the
      // restricted launch (not the channel) is what failed.
      if (!inside || inside.skipped || inside.can !== true) return { control: false };
      if (kind === 'bypass') return { control: true, outcome: inside.achieved ? 'open' : 'blocked' };
      return { control: true, outcome: inside.achieved ? 'works' : 'broken' };
    },
    /** What the restricted launch can do at all, for the log: one line per question. Secrets and SIDs are never printed. */
    async describe() {
      await prepare();
      const lines = [];
      const clean = (text) => String(text).replace(/S-1-5-21-[0-9-]+/g, 'S-1-5-21-…').split(fixture.secret).join('<secret>').replace(/\s+/g, ' ').slice(0, 220);
      const versions = await launch(true, node, nodeRun('process.stdout.write(process.version)'));
      lines.push(`restricted launch of node: ${versions.launchFailed ? `failed (${versions.launchFailed})` : versions.ok ? `ok (${versions.stdout})` : 'program failed'}`);
      const whoami = win32.join(parentEnv.SystemRoot, 'System32', 'whoami.exe');
      for (const restricted of [false, true]) {
        const groups = await launch(restricted, whoami, ['/groups', '/fo', 'csv', '/nh']);
        const rows = groups.stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
        lines.push(`whoami /groups (${restricted ? 'restricted' : 'control'}): ${groups.launchFailed ? `failed (${groups.launchFailed})` : `${rows.length} row(s), ${rows.filter((line) => /deny only/i.test(line)).length} deny-only`}`);
        for (const row of rows.slice(0, 14)) lines.push(`  ${clean(row.split('","').map((part) => part.replace(/"/g, '')).filter((_, index) => index !== 2).join(' | '))}`);
      }
      const pipes = await launch(true, node, nodeRun('const r=require("child_process").spawnSync(process.argv[1],["/d","/c","echo ok"],{encoding:"utf8"});process.stdout.write(JSON.stringify({status:r.status,error:r.error&&r.error.code,out:(r.stdout||"").trim()}))', win32.join(parentEnv.SystemRoot, 'System32', 'cmd.exe')));
      lines.push(`restricted node spawning a child over pipes: ${pipes.launchFailed ? `failed (${pipes.launchFailed})` : clean(pipes.stdout || `exit failed`)}`);
      const priv = await launch(true, whoami, ['/priv', '/fo', 'csv', '/nh']);
      lines.push(`whoami /priv (restricted): ${priv.launchFailed ? `failed (${priv.launchFailed})` : clean(priv.stdout)}`);
      if (git()) {
        const repo = await newRepo(true);
        fixture.provider.reset();
        const lsRemote = await launch(true, git(), ['-C', repo, '-c', 'credential.helper=', 'ls-remote', `http://127.0.0.1:${fixture.provider.port}/synthetic.git`]);
        lines.push(`restricted git ls-remote to the open endpoint: reached=${fixture.provider.count() > 0} ok=${lsRemote.ok} launchFailed=${lsRemote.launchFailed} output=${clean(lsRemote.stdout || lsRemote.stderr)}`);
        const ask = await launch(false, git(), ['-c', 'credential.helper=', '-c', `credential.helper=store --file=${path.join(fixture.creds, 'git-credentials').replace(/\\/g, '/')}`, 'credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n' });
        lines.push(`control git credential fill: ok=${ask.ok} output=${clean(ask.stdout || ask.stderr)}`);
      }
      return lines;
    },
    /** Which part of the restriction keeps git (or a program that makes pipes) from working, one line per variant. */
    async diagnoseVariants() {
      await prepare();
      const variants = [
        ['none', { denyUser: false, denyAdmins: false, dropPrivileges: false }],
        ['none, no job', { denyUser: false, denyAdmins: false, dropPrivileges: false, useJob: false }],
        ['none, job allows breakaway', { denyUser: false, denyAdmins: false, dropPrivileges: false, breakawayOk: true }],
        ['full, job allows breakaway', { breakawayOk: true }],
        ['full, no job', { useJob: false }],
        ['privileges only', { denyUser: false, denyAdmins: false, dropPrivileges: true }],
        ['administrators only', { denyUser: false, denyAdmins: true, dropPrivileges: false }],
        ['user only', { denyUser: true, denyAdmins: false, dropPrivileges: false }],
        ['user and administrators', { denyUser: true, denyAdmins: true, dropPrivileges: false }],
        ['full', undefined]
      ];
      const lines = [];
      const cmdExe = win32.join(parentEnv.SystemRoot, 'System32', 'cmd.exe');
      for (const [name, restriction] of variants) {
        const pipes = await launch(true, node, nodeRun('const r=require("child_process").spawnSync(process.argv[1],["/d","/c","echo ok"],{encoding:"utf8"});process.stdout.write(JSON.stringify({status:r.status,error:r.error&&r.error.code,out:(r.stdout||"").trim()}))', cmdExe), { restriction });
        let git1 = 'no git';
        if (git()) {
          const repo = await newRepo(true);
          fixture.provider.reset();
          const out = await launch(true, git(), ['-C', repo, '-c', 'credential.helper=', 'ls-remote', `http://127.0.0.1:${fixture.provider.port}/synthetic.git`], { restriction });
          git1 = `reached=${fixture.provider.count() > 0} ${String(out.launchFailed ?? out.stdout ?? '').replace(/\s+/g, ' ').slice(0, 100)}`;
        }
        lines.push(`variant ${name}: node spawn over pipes ${pipes.launchFailed ? `launch failed (${pipes.launchFailed})` : String(pipes.stdout).replace(/\s+/g, ' ').slice(0, 120)} | git ls-remote ${git1}`);
      }
      return lines;
    },
    /** What a program can do for itself under the launcher (pipes, named pipes, child processes, files), unrestricted and under the plainest launch. */
    async diagnoseFacilities() {
      await prepare();
      const cmdExe = win32.join(parentEnv.SystemRoot, 'System32', 'cmd.exe');
      const probe = `
        const cp=require('child_process'),net=require('net'),fs=require('fs'),os=require('os'),path=require('path');
        const out={};
        const cmd=process.argv[1];
        let r=cp.spawnSync(cmd,['/d','/c','echo ok'],{stdio:'ignore'}); out.spawnNoPipes=r.error?r.error.code:r.status;
        r=cp.spawnSync(cmd,['/d','/c','echo ok'],{encoding:'utf8'}); out.spawnPipes=r.error?r.error.code:r.status;
        try{const s=net.createServer();s.on('error',e=>{out.namedPipe=e.code;finish()});const B=String.fromCharCode(92);s.listen(B+B+'.'+B+'pipe'+B+'mas-diag-'+process.pid,()=>{out.namedPipe='ok';s.close(finish)});}catch(e){out.namedPipe='throw '+e.code;finish()}
        try{fs.writeFileSync(path.join(os.tmpdir(),'mas-diag-'+process.pid),'x');fs.unlinkSync(path.join(os.tmpdir(),'mas-diag-'+process.pid));out.tmpWrite='ok'}catch(e){out.tmpWrite=e.code}
        function finish(){process.stdout.write(JSON.stringify(out))}
      `.replace(/\s+/g, ' ');
      const lines = [];
      const control = await launch(false, node, ['-e', probe, cmdExe]);
      lines.push(`facilities (control, unrestricted): ${JSON.stringify(String(control.stdout || control.stderr).slice(-300))}`);
      for (const [name, restriction] of [['none, no job', { denyUser: false, denyAdmins: false, dropPrivileges: false, useJob: false }], ['full', undefined]]) {
        const seen = await launch(true, node, ['-e', probe, cmdExe], { restriction });
        lines.push(`facilities (${name}): ${seen.launchFailed ? `launch failed (${seen.launchFailed})` : JSON.stringify(String(seen.stdout).slice(-300))}`);
      }
      return lines;
    },
    async dispose() {
      if (!fixture) return;
      const { root, github, provider } = fixture;
      fixture = undefined;
      await Promise.all([github.close(), provider.close()]);
      try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* a temporary folder; the runner cleans up */ }
    },
    credentialLocationsFor: () => credentialLocations(fixture ? fixture.root : ''),
    supported
  };
}

module.exports = { createWindowsModule };
