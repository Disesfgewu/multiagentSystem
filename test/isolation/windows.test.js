'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { requestFor, parseReply, runRestricted, environmentPairs, powershellPath, launchScriptPath, credentialLocations, HOME_CREDENTIAL_PATHS } = require('../../src/isolation/windows');
const { createWindowsModule, summarizeGroups, explainToolFailure } = require('./windows-harness');
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

test('a tool that could not list the token\'s groups is reported as "could not enumerate", never as 0 deny-only', () => {
  const rows = '"Everyone","Well-known group","S-1-1-0","Mandatory group, Enabled by default, Enabled group"\r\n"BUILTIN\\Administrators","Alias","S-1-5-32-544","Group used for deny only"\r\n';
  assert.equal(summarizeGroups({ ok: true, stdout: rows }), '2 group row(s), 1 deny-only');
  assert.equal(summarizeGroups({ ok: true, stdout: '"Everyone","Well-known group","S-1-1-0","Mandatory group"\r\n' }), '1 group row(s), 0 deny-only', 'a real zero is still a zero');
  assert.equal(summarizeGroups({ ok: false, stdout: 'ERROR: Access is denied.\r\nERROR: Unable to get group membership information.\r\n' }), 'could not enumerate (Access is denied.)');
  assert.equal(summarizeGroups({ ok: true, stdout: 'ERROR: Access is denied.' }), 'could not enumerate (Access is denied.)', 'an ERROR line counts even if the exit code was 0');
  assert.match(summarizeGroups({ ok: false, stdout: rows }), /could not enumerate \(the program failed\)/, 'a non-zero exit is not a list');
  assert.match(summarizeGroups({ ok: true, stdout: '' }), /could not enumerate \(no output\)/);
  assert.match(summarizeGroups({ ok: true, stdout: undefined }), /no output/);
  assert.equal(summarizeGroups({ launchFailed: 'create-process-failed-5' }), 'could not enumerate (launch failed: create-process-failed-5)');
});

test('a setup command that failed is reported with its own first line of output, never as success and never with a SID', () => {
  assert.equal(explainToolFailure('icacls', { ok: true, stdout: 'processed 1 file', stderr: '' }), null);
  assert.equal(explainToolFailure('icacls grant', { ok: false, stdout: '', stderr: 'Access is denied.\r\nSuccessfully processed 0 files; Failed processing 1 files' }), 'icacls grant failed: Access is denied.');
  assert.equal(explainToolFailure('whoami', { ok: false, stdout: 'ERROR: x S-1-5-21-111-222-333-1001 y', stderr: '' }), 'whoami failed: ERROR: x S-1-5-21-… y');
  assert.equal(explainToolFailure('x', { ok: false, stdout: '', stderr: '' }), 'x failed (no message)');
  for (const bad of [undefined, null, {}, { ok: 'yes' }, { ok: 1 }]) assert.match(explainToolFailure('t', bad), /^t failed/, String(bad));
  assert.ok(explainToolFailure('x', { ok: false, stderr: 'a'.repeat(500) }).length < 200, 'long output is cut');
});

test('a harness whose fixture cannot be built (no whoami to ask) says why, and every channel stays unknown', async () => {
  const module = createWindowsModule({ platform: 'win32', parentEnv: { SystemRoot: process.platform === 'win32' ? process.env.SystemRoot : '/nonexistent-system-root' }, powershell: process.execPath, script: __filename, tmpRoot: require('node:os').tmpdir() });
  if (process.platform !== 'win32') {
    // Off Windows the tools do not exist: the setup fails at its first step, which is what this checks.
    assert.deepEqual(await module.probe('file-credentials'), { control: false });
    assert.match(String(module.preparationError()), /whoami \/user failed|ENOENT|failed/);
  }
  await module.dispose();
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
  assert.equal(parseReply(JSON.stringify({ ok: true, exitCode: 0, timedOut: false, output, elevated: true })).elevated, true, 'whether the caller was elevated is passed on');
  assert.equal(parseReply(JSON.stringify({ ok: true, exitCode: 0, timedOut: false, output, elevated: 'yes' })).ok, false);
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

// Issue #349: the whole measurement must end inside the test runner's 120 s, however slow the Windows runner is that day. Each phase
// and each channel has its own limit; what does not finish in time is printed as such and its channel stays unknown, which is what
// `assessIsolation` makes of a channel with no evidence. Nothing here can make a channel look enforced.
const BUDGET_MS = 105000;
const PHASE_MS = { describe: 20000, variants: 25000, facilities: 10000 };
const CHANNEL_MS = 20000;
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The platform module with its `probe` watched: how each channel's probe ended. `collectProbes` turns a probe that throws or answers
 * nonsense into "no evidence" (unknown), which is right for the product but would let a broken probe pass a test unnoticed.
 *
 * `collectProbes` gives up on a channel when its own limit runs out or the overall deadline fires, and aborts that channel's signal
 * (#349). A probe that ends after that is "abandoned": whatever it answered was not kept, so it is no evidence, but it is not a broken
 * probe either. (Before, a probe that answered after its limit was recorded as "answered", and a channel with no evidence that had
 * "answered" failed the test.)
 */
function watched(module) {
  const status = {};
  const describeError = (error) => String(error && error.message ? error.message : error).slice(0, 80);
  const probe = (channel, context) => {
    status[channel] = 'running';
    const abandoned = () => Boolean(context && context.signal && context.signal.aborted);
    const settle = (value) => {
      status[channel] = abandoned() ? 'abandoned' : isPlainObject(value) && typeof value.control === 'boolean' ? 'answered' : `answered something that is not a probe result (${String(JSON.stringify(value)).slice(0, 60)})`;
      return value;
    };
    const fail = (error) => { status[channel] = abandoned() ? 'abandoned' : `threw (${describeError(error)})`; throw error; };
    let pending;
    try { pending = Promise.resolve(module.probe(channel, context)); } catch (error) { return fail(error); }
    return pending.then(settle, fail);
  };
  return { module: { platform: module.platform, probe }, status };
}

/**
 * What a measurement may leave out, and what it may not: a probe that threw or answered nonsense always fails, naming the channel. A
 * channel with no evidence is allowed when `collectProbes` gave up on it (its own limit ran out: "abandoned", or still "running"
 * when the measurement ended) or when the overall deadline fired (also those never started). A channel that answered in time must
 * have its evidence. The caller checks that no channel without evidence is called enforced.
 * @returns {{ measured: string[], missing: string[] }}
 */
function checkMeasurement({ probes, status, deadlineFired }) {
  const channels = Object.keys(CHANNELS);
  const broken = channels.filter((channel) => typeof status[channel] === 'string' && !['answered', 'running', 'abandoned'].includes(status[channel]));
  if (broken.length > 0) assert.fail(`probes that failed: ${broken.map((channel) => `${channel} ${status[channel]}`).join('; ')}`);
  const measured = channels.filter((channel) => isPlainObject(probes[channel]) && typeof probes[channel].control === 'boolean');
  const missing = channels.filter((channel) => !measured.includes(channel));
  if (!deadlineFired) {
    // Without the deadline every channel was started; one that answered in time and still has no evidence is a real failure.
    const unexplained = missing.filter((channel) => status[channel] !== 'abandoned' && status[channel] !== 'running');
    assert.deepEqual(unexplained, [], `the deadline did not fire, yet these channels have no evidence: ${unexplained.map((channel) => `${channel} (${status[channel] ?? 'never started'})`).join(', ')}`);
    assert.ok(measured.length > 0, 'at least one channel was measured');
  }
  return { measured, missing };
}

/** The value, or `{ timedOut: true }` once `ms` have passed (the work itself goes on in the background and is disposed of at the end). */
async function withLimit(work, ms) {
  let timer;
  try {
    return await Promise.race([work.then((value) => ({ timedOut: false, value })), new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), ms); })]);
  } finally { clearTimeout(timer); }
}

test('a measurement that runs out of time ends on time; only channels the deadline stopped may lack evidence, never one whose probe broke (issue #349)', async () => {
  assert.deepEqual(await withLimit(new Promise((resolve) => setTimeout(() => resolve('late'), 200)), 20), { timedOut: true });
  assert.deepEqual(await withLimit(Promise.resolve('on time'), 1000), { timedOut: false, value: 'on time' });
  const channels = Object.keys(CHANNELS);
  const answer = (channel) => ({ control: true, outcome: CHANNELS[channel].kind === 'bypass' ? 'open' : 'works' });
  const fake = (behave) => ({ platform: 'win32', probe: async (channel) => behave(channel) });
  const measure = async (module, { channelMs = 100, deadlineMs } = {}) => {
    const deadline = new AbortController();
    const timer = deadlineMs === undefined ? undefined : setTimeout(() => deadline.abort(), deadlineMs);
    const watch = watched(module);
    const { probes } = await collectProbes(watch.module, { timeoutMs: channelMs, signal: deadline.signal });
    clearTimeout(timer);
    return { probes, status: watch.status, deadlineFired: deadline.signal.aborted };
  };

  // Every probe answers: all measured, nothing missing.
  const all = await measure(fake(answer));
  assert.deepEqual(checkMeasurement(all), { measured: channels, missing: [] });

  // A probe that throws, answers something that is not a result, or answers a result without a control: the test fails, naming it.
  for (const [label, behave] of [
    ['throws', (channel) => { if (channel === channels[2]) throw new Error('broken probe'); return answer(channel); }],
    ['rejects', (channel) => (channel === channels[2] ? Promise.reject(new Error('broken probe')) : answer(channel))],
    ['not an object', (channel) => (channel === channels[2] ? 'yes' : answer(channel))],
    ['no control', (channel) => (channel === channels[2] ? { outcome: 'open' } : answer(channel))]
  ]) {
    const result = await measure(fake(behave));
    assert.throws(() => checkMeasurement(result), (error) => error instanceof assert.AssertionError && error.message.includes(channels[2]), label);
    // Even when the deadline also fired: a broken probe is never excused as "out of time".
    assert.throws(() => checkMeasurement({ ...result, deadlineFired: true }), assert.AssertionError, `${label}, deadline fired`);
  }

  // A slow channel while the deadline fires: the measurement ends on time and the channels without evidence are unknown, never enforced.
  const slow = (channel) => (channel === channels[1] ? new Promise((resolve) => setTimeout(() => resolve(answer(channel)), 5000)) : { control: true, outcome: CHANNELS[channel].kind === 'bypass' ? 'blocked' : 'works' });
  const started = Date.now();
  const late = await measure(fake(slow), { deadlineMs: 50, channelMs: 2000 });
  assert.ok(Date.now() - started < 3000, 'it ended on time instead of waiting for the slow channel');
  assert.equal(late.deadlineFired, true);
  const { missing } = checkMeasurement(late);
  assert.ok(missing.includes(channels[1]), 'the slow channel has no evidence');
  const assessment = assessIsolation({ platform: 'win32', probes: late.probes });
  for (const channel of missing) assert.notEqual(assessment.channels.find((entry) => entry.channel === channel).state, 'enforced', channel);
  assert.equal(assessment.mode, 'advisory');

  // #349: a channel whose own limit ran out (here 50 ms) answers later (80 ms) while the deadline does not fire. `collectProbes` gave up
  // on it, so it has no evidence; that is not a broken probe: it is abandoned, unknown, and never enforced.
  const late80 = (channel) => (channel === channels[1] ? new Promise((resolve) => setTimeout(() => resolve(answer(channel)), 80)) : answer(channel));
  const own = await measure(fake(late80), { channelMs: 50 });
  assert.equal(own.deadlineFired, false);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(own.status[channels[1]], 'abandoned', 'an answer after the limit is recorded as abandoned, not as answered');
  const ownCheck = checkMeasurement(own);
  assert.deepEqual(ownCheck.missing, [channels[1]]);
  const ownAssessment = assessIsolation({ platform: 'win32', probes: own.probes });
  assert.notEqual(ownAssessment.channels.find((entry) => entry.channel === channels[1]).state, 'enforced');
  // Still running when the measurement ended, its own limit already past: also no evidence, also never enforced.
  const stillRunning = await measure(fake(slow), { channelMs: 50 });
  assert.equal(stillRunning.status[channels[1]], 'running');
  assert.deepEqual(checkMeasurement(stillRunning).missing, [channels[1]]);
  // A probe that throws or answers nonsense before it is given up on still fails, without the deadline too.
  const brokenInTime = await measure(fake((channel) => (channel === channels[3] ? 'yes' : answer(channel))), { channelMs: 50 });
  assert.throws(() => checkMeasurement(brokenInTime), (error) => error instanceof assert.AssertionError && error.message.includes(channels[3]));
  // A probe that fails only because it was given up on (it rejects after its limit, as an aborted probe does) is abandoned too.
  const abortedLate = await measure(fake((channel) => (channel === channels[2] ? new Promise((_, reject) => setTimeout(() => reject(new Error('aborted')), 80)) : answer(channel))), { channelMs: 50 });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(abortedLate.status[channels[2]], 'abandoned');
  assert.deepEqual(checkMeasurement(abortedLate).missing, [channels[2]]);
  // An answer that came in time but has no evidence would be a real failure: it is never excused.
  const dropped = { ...all, probes: Object.fromEntries(Object.entries(all.probes).filter(([channel]) => channel !== channels[4])) };
  assert.throws(() => checkMeasurement(dropped), (error) => error instanceof assert.AssertionError && error.message.includes(`${channels[4]} (answered)`));
});

test('on Windows: every channel is tried against a control, and the results are printed for the log', onlyWindows, async () => {
  const startedAt = Date.now();
  const left = () => Math.max(0, BUDGET_MS - (Date.now() - startedAt));
  const module = realModule();
  const deadline = new AbortController();
  const overall = setTimeout(() => deadline.abort(), BUDGET_MS);
  try {
    const described = await withLimit(module.describe(), Math.min(PHASE_MS.describe, left()));
    assert.equal(module.preparationError(), null, `the fixture could not be built: ${module.preparationError()}`);
    if (described.timedOut) console.log(`windows isolation: describe timed out after ${PHASE_MS.describe / 1000} s (the deny-only check below is not made)`);
    else {
      for (const line of described.value) console.log(`windows isolation: ${line}`);
      // The user's own SID no longer grants access: a place whose access list names only the user can be read outside the restriction and not inside it.
      assert.equal(described.value.__userSidDenyOnly, true, 'the user SID is deny-only in the restricted token');
    }
    for (const [phase, run] of [['variants', () => module.diagnoseVariants()], ['facilities', () => module.diagnoseFacilities()]]) {
      const result = await withLimit(run(), Math.min(PHASE_MS[phase], left()));
      if (result.timedOut) console.log(`windows isolation: ${phase} diagnosis timed out after ${PHASE_MS[phase] / 1000} s`);
      else for (const line of result.value) console.log(`windows isolation: ${line}`);
    }
    // Each channel has its own limit; the overall deadline stops the rest. A channel not probed in time has no evidence: unknown.
    const watch = watched(module);
    const { probes } = await collectProbes(watch.module, { timeoutMs: CHANNEL_MS, signal: deadline.signal });
    const assessment = assessIsolation({ platform: 'win32', probes });
    for (const line of describeAssessment(assessment)) console.log(`windows isolation: ${line}`);
    console.log(`windows isolation: probe status ${JSON.stringify(watch.status)}`);
    const { measured, missing } = checkMeasurement({ probes, status: watch.status, deadlineFired: deadline.signal.aborted });
    console.log(`windows isolation: probes ${JSON.stringify(Object.fromEntries(Object.entries(probes).map(([channel, probe]) => [channel, { control: probe.control, outcome: probe.outcome }])))}`);
    if (missing.length > 0) console.log(`windows isolation: not probed in time (unknown): ${missing.join(', ')} · ${Math.round((Date.now() - startedAt) / 1000)} s used of ${BUDGET_MS / 1000} s`);
    for (const channel of measured) if (probes[channel].control === false) assert.equal(probes[channel].outcome, undefined, `${channel}: no outcome without a control`);
    if (measured.includes('terminal-interaction')) assert.equal(probes['terminal-interaction'].control, false, 'there is no pseudo-console in this harness: unknown');
    // The restriction cannot block the network: a result of "blocked" for it would be a false claim.
    for (const channel of ['git-push', 'gh-cli', 'direct-http']) if (measured.includes(channel)) assert.notEqual(probes[channel].outcome, 'blocked', `${channel} cannot be blocked by a token`);
    for (const channel of missing) assert.notEqual(assessment.channels.find((entry) => entry.channel === channel)?.state, 'enforced', `${channel} has no evidence, so it is never enforced`);
    assert.equal(assessment.mode, 'advisory', 'not every required channel is enforced, so enforcement is not available');
  } finally {
    clearTimeout(overall);
    await withLimit(module.dispose(), 10000);
  }
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
