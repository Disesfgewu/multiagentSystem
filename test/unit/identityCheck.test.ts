import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCommand, childEnvironment } from '../../src/accounts/identityRunner';

const { checkAccountIdentity, describeCheck, splitFolderIssues, REASONS, MAX_OUTPUT_BYTES } = require('../../src/accounts/identity-check') as {
  splitFolderIssues(issues: unknown): { folder: string[]; confirmation: string[] };
  checkAccountIdentity(input: Record<string, unknown>): Promise<any>;
  describeCheck(result: unknown): { summary: string; hint: string };
  REASONS: Record<string, { summary: string; hint: string }>;
  MAX_OUTPUT_BYTES: number;
};

const EMAIL = 'person@example.test';
const FAKE = path.resolve(__dirname, '..', '..', '..', 'test', 'accounts', 'fixtures', 'fake-cli.js');

function world(t: { after(fn: () => void): void }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'multiagent-identity-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homeDir = path.join(root, 'home');
  const repoRoot = path.join(homeDir, 'projects', 'app');
  const configDir = path.join(homeDir, 'multiagent-accounts', 'claude-work');
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  const profile = { id: 'acct-1', provider: 'claude', label: 'Work', configDir, expectedAuthMethod: null };
  return { root, homeDir, repoRoot, configDir, profile, context: { repoRoot, homeDir } };
}

// The real runner, pointed at the synthetic CLI through node. The file and arguments the check passes
// (`claude auth status --json`) are kept in `seen` so the exact command can be asserted.
function fake(mode: string, extraEnv: Record<string, string | null> = {}, seen: Array<{ file: string; args: string[] }> = []) {
  return {
    seen,
    runner: (file: string, args: string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number }) => {
      seen.push({ file, args });
      return runCommand(process.execPath, [FAKE, ...args], { ...options, env: childEnvironment({ FAKE_MODE: mode, ...extraEnv }, options.env) });
    }
  };
}
// the tests drive a fake CLI through node on every platform, so they ask for the checking path even on Windows
const PLATFORM = process.platform === 'win32' ? 'linux' : process.platform;
const run = (w: ReturnType<typeof world>, mode: string, extra: Record<string, unknown> = {}) =>
  checkAccountIdentity({ profile: w.profile, context: w.context, platform: PLATFORM, env: { PATH: process.env.PATH }, runner: fake(mode).runner, now: () => new Date('2026-10-16T01:02:03.000Z'), ...extra });
// The e-mail address and organization are kept only in `display` (#352: shown on this computer's screen, never stored): everything
// else of a result, which is what gets stored, holds neither.
const nothingSecret = (value: unknown) => {
  const { display: _display, ...rest } = (value !== null && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const text = JSON.stringify(value !== null && typeof value === 'object' ? rest : value);
  assert.equal(text.includes(EMAIL), false, 'the email is nowhere in the result');
  assert.equal(text.includes('example.test'), false);
  assert.equal(text.includes('org-synthetic'), false, 'no raw organisation id');
};

test('a signed-in account gives a short fingerprint, the login method and a plan only if the CLI reported one', { timeout: 40_000 }, async (t) => {
  const w = world(t);
  const result = await run(w, 'ok');
  assert.deepEqual([result.ok, result.state, result.reason, result.source, result.checkedAt], [true, 'checked', 'checked', 'claude auth status --json', '2026-10-16T01:02:03.000Z']);
  assert.equal(result.identity.loggedIn, true);
  assert.equal(result.identity.authMethod, 'claude.ai');
  assert.equal(result.identity.subject.confidence, 'actual');
  assert.match(result.identity.subject.value, /^[0-9a-f]{32}$/, 'a one-way key, not an email');
  assert.equal(result.identity.plan.value, 'max');
  nothingSecret(result);
  assert.equal((result as any).display.email, EMAIL, 'the e-mail address is only in the display part, for the screen');
  assert.match(describeCheck(result).summary, /Signed in/);
  nothingSecret(describeCheck(result));
});

test('the exact command is the provider\'s status command as an argument array, from the registry executable', { timeout: 40_000 }, async (t) => {
  const w = world(t);
  const seen: Array<{ file: string; args: string[] }> = [];
  await checkAccountIdentity({ profile: w.profile, context: w.context, platform: PLATFORM, env: {}, runner: fake('ok', {}, seen).runner });
  assert.deepEqual(seen, [{ file: 'claude', args: ['auth', 'status', '--json'] }]);
});

test('no plan reported means the plan is unknown, and an odd plan text is dropped', { timeout: 40_000 }, async (t) => {
  const w = world(t);
  assert.equal((await run(w, 'ok-no-plan')).identity.plan.value, null);
  assert.equal((await run(w, 'ok-no-plan')).identity.plan.confidence, 'unknown');
  for (const mode of ['ok-weird-plan', 'ok-long-plan']) {
    const result = await run(w, mode);
    assert.equal(result.ok, true);
    assert.equal(result.identity.plan.value, null, mode);
    assert.equal(result.identity.plan.reason, 'unusable-value');
  }
});

test('not signed in is reported as not signed in, with no identity', { timeout: 40_000 }, async (t) => {
  const w = world(t);
  const result = await run(w, 'not-logged-in');
  assert.equal(result.ok, true);
  assert.equal(result.identity.loggedIn, false);
  assert.equal(result.identity.subject.confidence, 'unknown');
  assert.match(describeCheck(result).summary, /not signed in/);
});

test('every failure is unknown with a reason, never ready, and none carries the CLI output', { timeout: 40_000 }, async (t) => {
  const w = world(t);
  const cases: Array<[string, string]> = [
    ['text', 'not-json'], ['empty', 'not-json'], ['array', 'unexpected-shape'], ['shape', 'unexpected-shape'], ['loggedIn-string', 'unexpected-shape'],
    ['exit1', 'nonzero-exit'], ['exit2-stderr', 'nonzero-exit'], ['crash', 'nonzero-exit'], ['huge', 'output-too-large']
  ];
  for (const [mode, reason] of cases) {
    const result = await run(w, mode);
    assert.deepEqual([result.ok, result.state, result.reason, result.identity], [false, 'unknown', reason, null], mode);
    nothingSecret(result);
    const words = describeCheck(result);
    assert.equal(words.summary, REASONS[reason].summary);
    nothingSecret(words);
  }
});

test('a check that takes too long is stopped and reported as timed out', { timeout: 40_000 }, async (t) => {
  const w = world(t);
  const started = Date.now();
  const result = await checkAccountIdentity({
    profile: w.profile, context: w.context, platform: PLATFORM, env: { PATH: process.env.PATH },
    runner: (file: string, args: string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number }) =>
      runCommand(process.execPath, [FAKE, ...args], { ...options, timeoutMs: 300, env: childEnvironment({ FAKE_MODE: 'sleep' }, options.env) })
  });
  assert.deepEqual([result.reason, result.identity], ['timed-out', null]);
  assert.ok(Date.now() - started < 20000, 'the child was killed, not waited for');
});

test('too much output is refused by size, not parsed', { timeout: 40_000 }, async (t) => {
  const w = world(t);
  const result = await run(w, 'huge');
  assert.equal(result.reason, 'output-too-large');
  const injected = await checkAccountIdentity({ profile: w.profile, context: w.context, platform: PLATFORM, runner: async () => ({ code: 0, stdout: 'x'.repeat(MAX_OUTPUT_BYTES + 1) }) });
  assert.equal(injected.reason, 'output-too-large', 'also when the runner did not truncate');
  const exact = await checkAccountIdentity({ profile: w.profile, context: w.context, platform: PLATFORM, runner: async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: false }) }) });
  assert.equal(exact.ok, true);
});

test('a missing CLI is reported as not found, and a runner that throws or answers badly is a failed run', { timeout: 40_000 }, async (t) => {
  const w = world(t);
  const missing = await checkAccountIdentity({ profile: w.profile, context: w.context, platform: PLATFORM, runner: (file: string, args: string[], options: any) => runCommand(path.join(w.root, 'no-such-cli'), args, options) });
  assert.equal(missing.reason, 'cli-not-found');
  for (const runner of [async () => { throw new Error(`boom ${EMAIL}`); }, async () => null, async () => 'text', async () => ({ code: null, stdout: '', errorCode: 'EIO' })]) {
    const result = await checkAccountIdentity({ profile: w.profile, context: w.context, platform: PLATFORM, runner });
    assert.deepEqual([result.ok, result.reason], [false, 'run-failed']);
    nothingSecret(result);
  }
});

test('the child runs in the profile\'s environment: its folder is set and inherited credentials are removed', { timeout: 40_000 }, async (t) => {
  const w = world(t);
  const env = childEnvironment({ CLAUDE_CONFIG_DIR: w.configDir, ANTHROPIC_API_KEY: null }, { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'synthetic-key', KEEP: 'x' });
  assert.deepEqual([env.CLAUDE_CONFIG_DIR, env.ANTHROPIC_API_KEY, env.KEEP], [w.configDir, undefined, 'x']);
  const result = await run(w, 'echo-env', { env });
  assert.equal(result.ok, true);
  assert.equal(result.identity.configDirMatches, true, 'the CLI used this profile\'s folder');
  assert.deepEqual(result.identity.anomalies, [], 'no credential from the environment reached the CLI');
  const leaked = await run(w, 'echo-env', { env: childEnvironment({ CLAUDE_CONFIG_DIR: w.configDir }, { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'synthetic-key' }) });
  assert.ok(leaked.identity.anomalies.includes('credential-from-environment'), 'the fake would have shown an inherited key');
});

test('a CLI that used a different folder, or an API key, is flagged', { timeout: 40_000 }, async (t) => {
  const w = world(t);
  assert.ok((await run(w, 'ok-other-folder')).identity.anomalies.includes('config-dir-mismatch'));
  const keyed = await run(w, 'ok-api-key');
  assert.ok(keyed.identity.anomalies.includes('credential-from-environment'));
  assert.equal(keyed.identity.subject.confidence, 'unknown', 'an API-key login is not a verified person');
  assert.match(describeCheck(await run(w, 'ok-api-key')).summary, /did not confirm who/);
  const mismatch = await checkAccountIdentity({ profile: { ...w.profile, expectedAuthMethod: 'api-key' }, context: w.context, platform: PLATFORM, runner: fake('ok').runner });
  assert.ok(mismatch.identity.anomalies.includes('auth-method-mismatch'));
});

test('providers with no check, unknown providers and rejected profiles are unknown and run nothing', { timeout: 40_000 }, async (t) => {
  const w = world(t);
  let ran = 0;
  const runner = async () => { ran += 1; return { code: 0, stdout: '{}' }; };
  for (const provider of ['codex', 'agy', 'opencode', '', undefined, '__proto__', 'constructor']) {
    const result = await checkAccountIdentity({ profile: { ...w.profile, provider }, context: w.context, platform: PLATFORM, runner });
    assert.deepEqual([result.reason, result.identity], ['provider-not-supported', null], String(provider));
    assert.match(describeCheck(result).summary, /no sign-in check/);
  }
  for (const profile of [null, undefined, 'x', 5, []]) assert.equal((await checkAccountIdentity({ profile, context: w.context, platform: PLATFORM, runner })).reason, 'provider-not-supported');
  const inside = { ...w.profile, configDir: path.join(w.repoRoot, 'account') };
  assert.equal((await checkAccountIdentity({ profile: inside, context: w.context, platform: PLATFORM, runner })).reason, 'profile-rejected');
  assert.equal((await checkAccountIdentity({ profile: { ...w.profile, configDir: 'relative' }, context: w.context, platform: PLATFORM, runner })).reason, 'profile-rejected');
  assert.equal(ran, 0, 'nothing was run');
});

test('stderr never reaches the result, even when the CLI succeeds', { timeout: 40_000 }, async (t) => {
  const w = world(t);
  const result = await run(w, 'stderr-ok');
  assert.equal(result.ok, true);
  nothingSecret(result);
});

test('arguments are never built from the profile: the command is fixed', { timeout: 40_000 }, async (t) => {
  const w = world(t);
  const hostile = { ...w.profile, label: '$(touch /tmp/x); rm -rf /', id: 'acct-1' };
  const seen: Array<{ file: string; args: string[] }> = [];
  await checkAccountIdentity({ profile: hostile, context: w.context, platform: PLATFORM, runner: fake('ok', {}, seen).runner });
  assert.deepEqual(seen[0].args, ['auth', 'status', '--json']);
});

test('describeCheck has plain words for every reason and for a missing result', { timeout: 40_000 }, () => {
  for (const reason of Object.keys(REASONS)) {
    const words = describeCheck({ state: 'unknown', reason });
    assert.ok(words.summary.length > 20 && words.hint.length > 10, reason);
    assert.equal(/[a-z]+-[a-z]+-[a-z]+/.test(words.summary + words.hint), false, `${reason} shows a code`);
  }
  assert.equal(describeCheck({ state: 'unknown', reason: 'something-new' }).summary, REASONS['run-failed'].summary);
  assert.match(describeCheck(undefined).summary, /not been run/);
  assert.match(describeCheck(null).hint, /Check/);
});

test('the runner returns exit codes and keeps nothing but stdout', { timeout: 40_000 }, async () => {
  const ok = await runCommand(process.execPath, ['-e', 'process.stdout.write("hi"); process.stderr.write("secret@example.test")'], { env: { PATH: process.env.PATH }, timeoutMs: 5000, maxOutputBytes: 1000 });
  assert.deepEqual(ok, { code: 0, stdout: 'hi' });
  const failed = await runCommand(process.execPath, ['-e', 'process.exit(3)'], { env: { PATH: process.env.PATH }, timeoutMs: 5000, maxOutputBytes: 1000 });
  assert.equal(failed.code, 3);
  const big = await runCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(5000))'], { env: { PATH: process.env.PATH }, timeoutMs: 5000, maxOutputBytes: 1000 });
  assert.deepEqual([big.truncated, big.stdout], [true, '']);
  const slow = await runCommand(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { env: { PATH: process.env.PATH }, timeoutMs: 300, maxOutputBytes: 1000 });
  assert.equal(slow.timedOut, true);
  const none = await runCommand('definitely-not-a-real-command-xyz', [], { env: { PATH: process.env.PATH }, timeoutMs: 5000, maxOutputBytes: 1000 });
  assert.equal(none.errorCode, 'ENOENT');
});

test('a shell metacharacter in an argument is passed as text, not run', { timeout: 40_000 }, async () => {
  const result = await runCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', '$(echo injected); echo more'], { env: { PATH: process.env.PATH }, timeoutMs: 5000, maxOutputBytes: 1000 });
  assert.equal(result.stdout, '$(echo injected); echo more');
});

test('a signed-in account with a problem says so instead of offering to start', { timeout: 40_000 }, async (t) => {
  const w = world(t);
  const fine = describeCheck(await run(w, 'ok'));
  const odd = describeCheck(await run(w, 'ok-other-folder'));
  assert.match(fine.hint, /start a session/);
  assert.match(odd.hint, /something looks wrong/i);
  assert.equal(/start a session/.test(odd.hint), false);
});


test('a command that ignores SIGTERM is killed after the grace period, and the caller is not kept waiting', { timeout: 40_000 }, async (t) => {
  const w = world(t);
  const pidFile = path.join(w.root, 'pid.txt');
  const started = Date.now();
  const outcome = await runCommand(process.execPath, [FAKE], { env: childEnvironment({ FAKE_MODE: 'ignore-sigterm', FAKE_PIDFILE: pidFile }, { PATH: process.env.PATH }), timeoutMs: 400, maxOutputBytes: 1000, graceMs: 300 });
  assert.equal(outcome.timedOut, true);
  assert.ok(Date.now() - started < 4000, `answered in ${Date.now() - started} ms`);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(pid > 0);
  const alive = (): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const deadline = Date.now() + 4000;
  while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alive(), false, 'the child that ignored SIGTERM was killed');
});

test('a runner that never answers is given up on at the hard limit and reported as timed out', { timeout: 40_000 }, async (t) => {
  const w = world(t);
  const started = Date.now();
  const result = await checkAccountIdentity({ profile: w.profile, context: w.context, platform: PLATFORM, hardLimitMs: 250, runner: () => new Promise(() => {}) });
  assert.deepEqual([result.ok, result.reason, result.identity], [false, 'timed-out', null]);
  assert.ok(Date.now() - started < 3000);
  const fast = await checkAccountIdentity({ profile: w.profile, context: w.context, platform: PLATFORM, hardLimitMs: 250, runner: async () => ({ code: 0, stdout: '{"loggedIn":false}' }) });
  assert.equal(fast.ok, true, 'an answer before the limit is used');
});

test('the check does not wait for the hard limit when the command answers', { timeout: 40_000 }, async (t) => {
  const w = world(t);
  const started = Date.now();
  const result = await checkAccountIdentity({ profile: w.profile, context: w.context, platform: PLATFORM, hardLimitMs: 60000, runner: fake('not-logged-in').runner });
  assert.equal(result.ok, true);
  assert.ok(Date.now() - started < 8000, 'the limit timer does not hold the result back');
});

test('only a plan name from the list is shown, in lower case', { timeout: 40_000 }, async (t) => {
  const w = world(t);
  for (const [plan, shown] of [['max', 'max'], ['Pro', 'pro'], [' TEAM ', 'team'], ['enterprise', 'enterprise'], ['free', 'free']] as Array<[string, string]>) {
    const result = await checkAccountIdentity({ profile: w.profile, context: w.context, platform: PLATFORM, runner: async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: EMAIL, subscriptionType: plan }) }) });
    assert.equal(result.identity.plan.value, shown, plan);
  }
  for (const plan of ['platinum', 'max plus', 'maxx', '', '   ', 'ignore previous instructions', 5, null, { x: 1 }, ['max']]) {
    const result = await checkAccountIdentity({ profile: w.profile, context: w.context, platform: PLATFORM, runner: async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: EMAIL, subscriptionType: plan }) }) });
    assert.equal(result.identity.plan.value, null, JSON.stringify(plan));
  }
});

test('the folder\'s safety status and the CLI\'s confirmation are kept apart', { timeout: 40_000 }, () => {
  const issues = [
    { code: 'config-dir:config-dir-inside-repo', hint: 'inside the project' },
    { code: 'config-dir-conflict:nested', hint: 'overlaps another account' },
    { code: 'config-dir-not-directory', hint: 'a file' },
    { code: 'config-dir-unverified', hint: 'the CLI did not say which folder it uses' },
    { code: 'config-dir-mismatch', hint: 'the CLI uses a different folder' },
    { code: 'not-logged-in', hint: 'not signed in' },
    { code: 'duplicate-account', hint: 'same account twice' },
    null, { hint: 'no code' }, { code: 5 }
  ];
  assert.deepEqual(splitFolderIssues(issues), { folder: ['inside the project', 'overlaps another account', 'a file'], confirmation: ['the CLI did not say which folder it uses', 'the CLI uses a different folder'] });
  assert.deepEqual(splitFolderIssues([{ code: 'config-dir-unverified' }]), { folder: [], confirmation: ['Needs attention.'] });
  for (const bad of [undefined, null, 'x', {}, 5]) assert.deepEqual(splitFolderIssues(bad), { folder: [], confirmation: [] });
});

test('a command that obeys SIGTERM stops at the limit, long before the grace period ends', { timeout: 40_000 }, async (t) => {
  const w = world(t);
  const started = Date.now();
  const outcome = await runCommand(process.execPath, [FAKE], { env: childEnvironment({ FAKE_MODE: 'sleep' }, { PATH: process.env.PATH }), timeoutMs: 300, maxOutputBytes: 1000, graceMs: 20000 });
  assert.equal(outcome.timedOut, true);
  assert.ok(Date.now() - started < 8000, `stopped after ${Date.now() - started} ms, not after the 20 s grace`);
  void w;
});


test('on Windows the check is not run at all: it says so and starts nothing', { timeout: 40_000 }, async (t) => {
  const w = world(t);
  let ran = 0;
  const result = await checkAccountIdentity({ profile: w.profile, context: w.context, platform: 'win32', runner: async () => { ran += 1; return { code: 0, stdout: '{"loggedIn":false}' }; } });
  assert.deepEqual([result.ok, result.reason, result.identity, ran], [false, 'windows-not-supported', null, 0]);
  assert.match(describeCheck(result).summary, /not supported on Windows yet/);
  for (const platform of ['darwin', 'linux']) assert.equal((await checkAccountIdentity({ profile: w.profile, context: w.context, platform, runner: async () => ({ code: 0, stdout: '{"loggedIn":false}' }) })).ok, true, platform);
});

test('a CLI file that cannot be executed is reported as such, apart from "not found"', { timeout: 40_000, skip: process.platform === 'win32' }, async (t) => {
  const w = world(t);
  const file = path.join(w.root, 'not-executable');
  fs.writeFileSync(file, '#!/bin/sh\necho hi\n', { mode: 0o644 });
  const outcome = await runCommand(file, [], { env: { PATH: process.env.PATH }, timeoutMs: 3000, maxOutputBytes: 1000 });
  assert.equal(outcome.errorCode, 'EACCES');
  const result = await checkAccountIdentity({ profile: w.profile, context: w.context, platform: PLATFORM, runner: async () => outcome });
  assert.deepEqual([result.reason, result.identity], ['cli-not-executable', null]);
  assert.match(describeCheck(result).summary, /permission denied/);
});

test('a timeout stops the whole process group: a process the command started is stopped too', { timeout: 40_000, skip: process.platform === 'win32' }, async (t) => {
  const w = world(t);
  const childPidFile = path.join(w.root, 'grandchild.pid');
  const parentPidFile = path.join(w.root, 'parent.pid');
  const outcome = await runCommand(process.execPath, [FAKE], { env: childEnvironment({ FAKE_MODE: 'grandchild', FAKE_PIDFILE: parentPidFile, FAKE_CHILD_PIDFILE: childPidFile }, { PATH: process.env.PATH }), timeoutMs: 1200, maxOutputBytes: 1000, graceMs: 500 });
  assert.equal(outcome.timedOut, true);
  const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const read = (file: string): number => Number(fs.readFileSync(file, 'utf8'));
  const deadline = Date.now() + 6000;
  while ((alive(read(parentPidFile)) || alive(read(childPidFile))) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alive(read(parentPidFile)), false, 'the command was stopped');
  assert.equal(alive(read(childPidFile)), false, 'what the command started was stopped too');
});

test('a grandchild that ignores SIGTERM is still killed even when the direct child obeys it and exits first', { timeout: 40_000, skip: process.platform === 'win32' }, async (t) => {
  const w = world(t);
  const childPidFile = path.join(w.root, 'grandchild-ignoring.pid');
  const parentPidFile = path.join(w.root, 'parent-obeying.pid');
  const outcome = await runCommand(process.execPath, [FAKE], { env: childEnvironment({ FAKE_MODE: 'grandchild-ignore-sigterm', FAKE_PIDFILE: parentPidFile, FAKE_CHILD_PIDFILE: childPidFile }, { PATH: process.env.PATH }), timeoutMs: 1200, maxOutputBytes: 1000, graceMs: 500 });
  assert.equal(outcome.timedOut, true);
  const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const read = (file: string): number => Number(fs.readFileSync(file, 'utf8'));
  const deadline = Date.now() + 6000;
  while ((alive(read(parentPidFile)) || alive(read(childPidFile))) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alive(read(parentPidFile)), false, 'the direct child, which obeyed SIGTERM, exited');
  assert.equal(alive(read(childPidFile)), false, 'the grandchild, which ignored SIGTERM, was still killed via the group-wide SIGKILL');
});

test('however the child dies after the time limit, the result is a timeout', { timeout: 40_000 }, async () => {
  const outcome = await runCommand(process.execPath, ['-e', 'process.on("SIGTERM", () => process.exit(7)); setInterval(() => {}, 1000)'], { env: { PATH: process.env.PATH }, timeoutMs: 300, maxOutputBytes: 1000, graceMs: 2000 });
  assert.equal(outcome.timedOut, true, 'a command that exits with its own code after SIGTERM is still a timeout');
  assert.equal(outcome.code, null);
});

test('a command that floods its output is stopped, not left running', { timeout: 40_000, skip: process.platform === 'win32' }, async (t) => {
  const w = world(t);
  const pidFile = path.join(w.root, 'flood.pid');
  const script = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); const w = () => { process.stdout.write('x'.repeat(65536)); setTimeout(w, 5); }; w();`;
  const outcome = await runCommand(process.execPath, ['-e', script], { env: { PATH: process.env.PATH }, timeoutMs: 20000, maxOutputBytes: 1000 });
  assert.equal(outcome.truncated, true);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  const alive = (): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const deadline = Date.now() + 5000;
  while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alive(), false, 'the flooding command was killed');
});

test('a command that dies from a signal is a failed run, not an answer', { timeout: 40_000, skip: process.platform === 'win32' }, async () => {
  const outcome = await runCommand(process.execPath, ['-e', 'process.kill(process.pid, "SIGKILL")'], { env: { PATH: process.env.PATH }, timeoutMs: 5000, maxOutputBytes: 1000 });
  assert.deepEqual([outcome.code, outcome.timedOut, outcome.errorCode], [null, undefined, 'ERR_SIGNAL']);
});
