'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { requestFor, parseReply, runRestricted, environmentPairs, powershellPath, launchScriptPath, credentialLocations, HOME_CREDENTIAL_PATHS } = require('../../src/isolation/windows');
const { createWindowsModule } = require('./windows-harness');
const { CHANNELS, collectProbes, assessIsolation, describeAssessment, decideLaunch } = require('../../src/isolation/capabilities');

const onWindows = process.platform === 'win32';
const onlyWindows = onWindows ? {} : { skip: 'needs native Windows' };
const SCRIPT = path.resolve(__dirname, '..', '..', 'resources', 'isolation', 'restricted-launch.ps1');
const GOOD = { exe: 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'echo hi'], cwd: 'C:\\Windows', env: ['A=1'], stdin: '', timeoutMs: 5000 };

test('a request is checked before the script sees it: program, arguments, folder, environment, input and time limit', () => {
  const made = requestFor(GOOD);
  assert.equal(made.ok, true);
  assert.deepEqual(JSON.parse(Buffer.from(made.encoded, 'base64').toString('utf8')), { exe: GOOD.exe, args: GOOD.args, cwd: GOOD.cwd, env: GOOD.env, stdin: '', timeoutMs: 5000 });
  const bad = (over, reason) => assert.equal(requestFor({ ...GOOD, ...over }).reason, reason, JSON.stringify(over).slice(0, 80));
  for (const exe of ['cmd.exe', 'relative\\cmd.exe', '', undefined, 5, 'C:\\a\\b\u0000.exe', `C:\\${'x'.repeat(600)}.exe`]) bad({ exe }, 'program-invalid');
  for (const args of ['x', [5], ['a\u0000b'], Array.from({ length: 65 }, () => 'a'), ['x'.repeat(4097)]]) bad({ args }, 'argument-invalid');
  for (const cwd of ['relative', 5, 'C:\\a\u0001']) bad({ cwd }, 'cwd-invalid');
  for (const env of ['A=1', ['NOEQUALS'], ['=x'], ['A B=1'], ['A=1\u0000'], [5], Array.from({ length: 257 }, (_, index) => `V${index}=1`)]) bad({ env }, 'environment-invalid');
  for (const stdin of [5, 'x'.repeat(65537)]) bad({ stdin }, 'stdin-invalid');
  for (const timeoutMs of [0, 99, 120001, 1.5, '5000', NaN]) bad({ timeoutMs }, 'timeout-invalid');
  assert.equal(requestFor({ exe: GOOD.exe }).ok, true, 'only the program is required');
});

test('every switch the script reads can be sent in a request, and nothing else can', () => {
  const text = fs.readFileSync(SCRIPT, 'utf8');
  const hash = /\$switches = @\{([^}]*)\}/.exec(text)[1];
  const names = [...hash.matchAll(/(\w+) = \$(?:true|false)/g)].map((match) => match[1]);
  assert.ok(names.length >= 8, names.join(','));
  for (const name of names) assert.equal(requestFor({ ...GOOD, restriction: { [name]: true } }).ok, true, name);
  for (const bad of ['unknownSwitch', '__proto__', 'constructor']) assert.equal(requestFor({ ...GOOD, restriction: { [bad]: true } }).reason, 'restriction-invalid', bad);
  for (const value of ['true', 1, null, undefined, {}]) assert.equal(requestFor({ ...GOOD, restriction: { denyUser: value } }).reason, 'restriction-invalid', String(value));
  for (const restriction of [true, 'x', [], 5]) assert.equal(requestFor({ ...GOOD, restriction }).reason, 'restriction-invalid');
});

test('the script\'s reply is read strictly: one line, and anything else is an error, never a pass', () => {
  const output = Buffer.from('line one\r\nline two', 'utf8').toString('base64');
  assert.deepEqual(parseReply(`${JSON.stringify({ ok: true, exitCode: 0, timedOut: false, output })}\r\n`), { ok: true, exitCode: 0, timedOut: false, output: 'line one\r\nline two' });
  assert.deepEqual(parseReply(JSON.stringify({ ok: false, reason: 'restricted-token-failed' })), { ok: false, reason: 'restricted-token-failed', fromScript: true });
  assert.deepEqual(parseReply(JSON.stringify({ ok: false, reason: 'Contains Spaces and C:\\path' })), { ok: false, reason: 'launch-failed', fromScript: true }, 'a reason that is not a short code is not repeated');
  for (const text of ['', '\n', 'not json', '[]', '{}', `${JSON.stringify({ ok: true, exitCode: 0, timedOut: false, output })}\nsecond line`, JSON.stringify({ ok: true, exitCode: 'x', timedOut: false, output }), JSON.stringify({ ok: true, exitCode: 0, timedOut: 'no', output }), JSON.stringify({ ok: true, exitCode: 0, timedOut: false, output: 5 }), JSON.stringify({ ok: 'true', exitCode: 0, timedOut: false, output }), undefined, null]) {
    assert.equal(parseReply(text).ok, false, String(text).slice(0, 40));
  }
});

test('runRestricted starts PowerShell by its fixed path with data arguments, and every failure is an error result', async () => {
  const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const script = 'C:\\ext\\resources\\isolation\\restricted-launch.ps1';
  const calls = [];
  const reply = JSON.stringify({ ok: true, exitCode: 0, timedOut: false, output: Buffer.from('hello').toString('base64') });
  const fake = (stdout, error) => (file, argv, options, callback) => { calls.push({ file, argv, options }); setImmediate(() => callback(error ?? null, stdout)); return { stdin: { end() {} } }; };
  const result = await runRestricted(GOOD, { script, powershell: ps, platform: 'win32', execFile: fake(reply) });
  assert.deepEqual(result, { ok: true, exitCode: 0, timedOut: false, output: 'hello' });
  assert.equal(calls[0].file, ps);
  assert.deepEqual(calls[0].argv.slice(0, 7), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Request']);
  assert.equal(calls[0].options.shell, false, 'no shell');
  assert.equal(calls[0].argv.length, 8, 'the request is one data argument');

  const failing = async (opts, input = GOOD) => runRestricted(input, { script, powershell: ps, platform: 'win32', ...opts });
  assert.equal((await failing({ platform: 'linux', execFile: fake(reply) })).reason, 'platform-not-windows');
  assert.equal((await failing({ powershell: null, execFile: fake(reply) })).reason, 'powershell-unavailable');
  assert.equal((await failing({ powershell: 'powershell.exe', execFile: fake(reply) })).reason, 'powershell-unavailable', 'never found through PATH');
  assert.equal((await failing({ script: 'relative.ps1', execFile: fake(reply) })).reason, 'script-unavailable');
  assert.equal((await failing({ execFile: fake(reply) }, { ...GOOD, exe: 'cmd.exe' })).reason, 'program-invalid');
  assert.equal((await failing({ execFile: fake('garbage') })).reason, 'reply-invalid');
  assert.equal((await failing({ execFile: fake('', Object.assign(new Error('x'), { code: 1 })) })).reason, 'powershell-failed');
  assert.equal((await failing({ execFile: fake('', Object.assign(new Error('x'), { killed: true })) })).reason, 'powershell-timeout');
  assert.equal((await failing({ execFile: fake(JSON.stringify({ ok: false, reason: 'restricted-token-failed' }), Object.assign(new Error('exit 3'), { code: 3 })) })).reason, 'restricted-token-failed', 'the script\'s own reason is kept');
  assert.equal((await failing({ execFile: () => { throw new Error('boom'); } })).reason, 'powershell-failed');
});

test('PowerShell is found only under the system folder; the environment loses credentials; the user folder\'s credential places are listed', () => {
  assert.equal(powershellPath({ SystemRoot: 'C:\\Windows' }), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  for (const SystemRoot of [undefined, '', 'Windows', 'C:\\Windows\\..\\x', 'C:\\Win"dows', 'C:\\a\u0000b', '\\\\server\\share\\..\\x']) assert.equal(powershellPath({ SystemRoot }), null, String(SystemRoot));
  assert.equal(launchScriptPath(path.resolve('/ext')), path.join(path.resolve('/ext'), 'resources', 'isolation', 'restricted-launch.ps1'));
  assert.equal(launchScriptPath('relative'), null);

  const pairs = environmentPairs({ Path: 'C:\\x', SystemRoot: 'C:\\Windows', gh_token: 'x', GITHUB_TOKEN: 'x', Ssh_Auth_Sock: 's', GIT_CONFIG_PARAMETERS: "'a=b'", GIT_ASKPASS: 'p', 'BAD NAME': 'x', GOOD: 'ok' });
  assert.deepEqual(pairs.sort(), ['GOOD=ok', 'Path=C:\\x', 'SystemRoot=C:\\Windows']);

  const locations = credentialLocations('C:\\Users\\someone');
  assert.equal(locations.length, HOME_CREDENTIAL_PATHS.length);
  for (const needed of ['.git-credentials', '.netrc', '.ssh', 'AppData\\Roaming\\GitHub CLI', 'AppData\\Local\\Microsoft\\Credentials']) assert.ok(locations.includes(`C:\\Users\\someone\\${needed}`), needed);
  for (const bad of ['relative', '', undefined, 'C:\\a\u0000']) assert.equal(credentialLocations(bad), null);
});

test('the shipped script is in the extension folder and contains no shell call and no download', () => {
  const text = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(text, /CreateRestrictedToken/);
  assert.match(text, /DISABLE_MAX_PRIVILEGE/);
  assert.match(text, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
  for (const forbidden of [/Invoke-Expression/i, /\biex\b/i, /Invoke-WebRequest/i, /Invoke-RestMethod/i, /DownloadString|DownloadFile|WebClient/i, /Start-Process/i, /cmd\.exe/i, /-EncodedCommand/i]) assert.doesNotMatch(text, forbidden, String(forbidden));
});

test('every failure reason the script can give is a short lower-case code (a reason that is not one is dropped by the reader)', () => {
  const text = fs.readFileSync(SCRIPT, 'utf8');
  const reasons = [...text.matchAll(/Fail\("([^"]+)"/g)].map((match) => match[1]);
  assert.ok(reasons.length >= 10, `found ${reasons.length} reasons`);
  for (const reason of reasons) assert.match(reason, /^[a-z0-9-]+$/, reason);
  for (const needed of ['open-token-failed', 'restricted-token-failed-', 'default-dacl-failed-', 'create-process-failed-', 'job-failed']) assert.ok(reasons.includes(needed), needed);
  // Every switch the request may carry is read by the script.
  for (const name of ['denyUser', 'denyAdmins', 'dropPrivileges', 'noWindow', 'useJob', 'breakawayOk', 'plainCopy', 'keepDefaultDacl']) assert.match(text, new RegExp(`\\b${name}\\b`), name);
});

test('off Windows, or without PowerShell, nothing is probed and every channel stays unknown', async () => {
  for (const options of [{ platform: 'linux' }, { platform: 'darwin' }, { platform: 'win32', powershell: 'C:\\does-not-exist\\powershell.exe' }, { platform: 'win32', script: 'C:\\does-not-exist\\script.ps1' }]) {
    const module = createWindowsModule(options);
    const { probes } = await collectProbes(module, { timeoutMs: 2000 });
    const assessment = assessIsolation({ platform: 'win32', probes });
    assert.equal(assessment.mode, 'advisory');
    assert.ok(assessment.channels.every((entry) => entry.state === 'unknown' && entry.reason === 'control-did-not-run'), JSON.stringify(options));
    assert.equal(decideLaunch({ assessment, requested: 'enforced' }).allowed, false, 'enforcement is refused, not downgraded');
    await module.dispose();
  }
  assert.deepEqual(await createWindowsModule({ platform: 'linux' }).probe('not-a-channel'), { control: false });
});

test('judging a channel: only a control that got through AND a restricted program that could do the same kind of thing elsewhere make a result; anything else is unknown', async () => {
  const attempt = (control, inside) => async (restricted) => (restricted ? inside : control);
  const probe = (channel, control, inside) => createWindowsModule({ attempts: { [channel]: attempt(control, inside) } }).probe(channel);
  const got = { achieved: true, can: true };
  // A bypass: nothing got through inside, with a working control and a working restricted program, is "blocked"; something got through is "open".
  assert.deepEqual(await probe('file-credentials', got, { achieved: false, can: true }), { control: true, outcome: 'blocked' });
  assert.deepEqual(await probe('file-credentials', got, { achieved: true, can: true }), { control: true, outcome: 'open' });
  // An interaction channel is judged the other way round.
  assert.deepEqual(await probe('cli-own-login', got, { achieved: true, can: true }), { control: true, outcome: 'works' });
  assert.deepEqual(await probe('cli-own-login', got, { achieved: false, can: true }), { control: true, outcome: 'broken' });
  // The control did not get through, was skipped, or gave nothing: the channel is unknown, whatever happened inside.
  for (const control of [{ achieved: false, can: true }, { skipped: true }, { achieved: 'yes' }, {}, undefined, null]) {
    assert.deepEqual(await probe('file-credentials', control, { achieved: false, can: true }), { control: false }, JSON.stringify(control));
  }
  // The restricted program could not do the same kind of thing where the restriction does not reach: its launch failed, not the channel.
  for (const inside of [{ achieved: false, can: false }, { achieved: false }, { achieved: false, can: 'yes' }, { skipped: true }, undefined, null]) {
    assert.deepEqual(await probe('file-credentials', got, inside), { control: false }, JSON.stringify(inside));
  }
  // A channel with no attempt, or a name that is not a channel, is unknown.
  assert.deepEqual(await createWindowsModule({ attempts: {} }).probe('file-credentials'), { control: false });
  assert.deepEqual(await createWindowsModule({ attempts: { x: attempt(got, got) } }).probe('x'), { control: false });
});

// ---- on native Windows only: the real script and the real harness --------------------------------------------------

const realModule = () => createWindowsModule();
const nodeExe = process.execPath;

test('on Windows: a program runs under the restricted token, and arguments with spaces, quotes and backslashes arrive unchanged', onlyWindows, async () => {
  const printArgs = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
  const args = ['plain', 'with space', 'a"quote', 'trailing\\', 'back\\"slash', '', 'two  spaces', 'C:\\Program Files\\x y\\', '\\\\server\\share'];
  const reply = await runRestricted({ exe: nodeExe, args: ['-e', printArgs, ...args], env: environmentPairs(process.env), timeoutMs: 20000 }, { script: SCRIPT });
  console.log(`restricted launch (windows): ${JSON.stringify({ ok: reply.ok, reason: reply.reason, exitCode: reply.exitCode, timedOut: reply.timedOut })}`);
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal(reply.exitCode, 0);
  assert.deepEqual(JSON.parse(reply.output), args);
});

test('on Windows: the time limit ends a program that does not stop, and what it started with it', onlyWindows, async () => {
  const started = Date.now();
  const reply = await runRestricted({ exe: nodeExe, args: ['-e', 'setInterval(() => {}, 1000)'], env: environmentPairs(process.env), timeoutMs: 1500 }, { script: SCRIPT });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal(reply.timedOut, true);
  assert.ok(Date.now() - started < 25000, 'it did not wait for the program');
});

test('on Windows: every channel is tried against a control, and the results are printed for the log', onlyWindows, async () => {
  const module = realModule();
  try {
    for (const line of await module.describe()) console.log(`windows isolation: ${line}`);
    for (const line of await module.diagnoseVariants()) console.log(`windows isolation: ${line}`);
    for (const line of await module.diagnoseFacilities()) console.log(`windows isolation: ${line}`);
    const { probes } = await collectProbes(module, { timeoutMs: 120000 });
    const assessment = assessIsolation({ platform: 'win32', probes });
    for (const line of describeAssessment(assessment)) console.log(`windows isolation: ${line}`);
    console.log(`windows isolation: probes ${JSON.stringify(Object.fromEntries(Object.entries(probes).map(([channel, probe]) => [channel, { control: probe.control, outcome: probe.outcome }])))}`);
    for (const channel of Object.keys(CHANNELS)) {
      const probe = probes[channel];
      assert.ok(probe && typeof probe.control === 'boolean', `${channel} was probed`);
      if (probe.control === false) assert.equal(probe.outcome, undefined, `${channel}: no outcome without a control`);
    }
    assert.equal(probes['terminal-interaction'].control, false, 'there is no pseudo-console in this harness: unknown');
    // The restriction cannot block the network: a result of "blocked" for it would be a false claim.
    for (const channel of ['git-push', 'gh-cli', 'direct-http']) assert.notEqual(probes[channel].outcome, 'blocked', `${channel} cannot be blocked by a token`);
    assert.equal(assessment.mode, 'advisory', 'not every required channel is enforced, so enforcement is not available');
  } finally { await module.dispose(); }
});

test('on Windows: which parts of the restriction still let a program start (printed for the log); with none of them the launcher itself must work', onlyWindows, async () => {
  const system = process.env.SystemRoot;
  const cmd = path.win32.join(system, 'System32', 'cmd.exe');
  const variants = [
    { name: 'no restriction at all', restriction: { denyUser: false, denyAdmins: false, dropPrivileges: false } },
    { name: 'no-window flag only', restriction: { denyUser: false, denyAdmins: false, dropPrivileges: false, noWindow: true } },
    { name: 'privileges dropped only', restriction: { denyUser: false, denyAdmins: false, dropPrivileges: true } },
    { name: 'administrators deny-only only', restriction: { denyUser: false, denyAdmins: true, dropPrivileges: false } },
    { name: 'user deny-only only', restriction: { denyUser: true, denyAdmins: false, dropPrivileges: false } },
    { name: 'user and administrators deny-only', restriction: { denyUser: true, denyAdmins: true, dropPrivileges: false } },
    { name: 'the full restriction (the default)', restriction: undefined }
  ];
  const results = {};
  for (const variant of variants) {
    for (const [label, exe, args] of [['cmd', cmd, ['/d', '/c', 'echo ok']], ['node', nodeExe, ['-e', 'process.stdout.write("ok")']]]) {
      const reply = await runRestricted({ exe, args, env: environmentPairs(process.env), timeoutMs: 20000, ...(variant.restriction ? { restriction: variant.restriction } : {}) }, { script: SCRIPT });
      results[`${variant.name} / ${label}`] = reply.ok ? `exit ${reply.exitCode >>> 0 === reply.exitCode ? `0x${reply.exitCode.toString(16)}` : reply.exitCode}${reply.timedOut ? ' (timed out)' : ''} output=${JSON.stringify(reply.output.trim().slice(0, 20))}` : `launch failed: ${reply.reason}`;
    }
  }
  for (const [name, outcome] of Object.entries(results)) console.log(`windows isolation: variant ${name}: ${outcome}`);
  assert.match(results['no restriction at all / cmd'], /^exit (?:0x0|0) output="ok"/, 'the launcher itself (token copy, job, pipes, process creation) works');
});
