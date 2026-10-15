import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCommand, childEnvironment } from '../../src/accounts/identityRunner';

const { checkAccountIdentity, describeCheck, REASONS, MAX_OUTPUT_BYTES } = require('../../src/accounts/identity-check') as {
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
const run = (w: ReturnType<typeof world>, mode: string, extra: Record<string, unknown> = {}) =>
  checkAccountIdentity({ profile: w.profile, context: w.context, env: { PATH: process.env.PATH }, runner: fake(mode).runner, now: () => new Date('2026-10-16T01:02:03.000Z'), ...extra });
const nothingSecret = (value: unknown) => {
  const text = JSON.stringify(value);
  assert.equal(text.includes(EMAIL), false, 'the email is nowhere in the result');
  assert.equal(text.includes('example.test'), false);
  assert.equal(text.includes('org-synthetic'), false, 'no raw organisation id');
};

test('a signed-in account gives a short fingerprint, the login method and a plan only if the CLI reported one', async (t) => {
  const w = world(t);
  const result = await run(w, 'ok');
  assert.deepEqual([result.ok, result.state, result.reason, result.source, result.checkedAt], [true, 'checked', 'checked', 'claude auth status --json', '2026-10-16T01:02:03.000Z']);
  assert.equal(result.identity.loggedIn, true);
  assert.equal(result.identity.authMethod, 'claude.ai');
  assert.equal(result.identity.subject.confidence, 'actual');
  assert.match(result.identity.subject.value, /^[0-9a-f]{32}$/, 'a one-way key, not an email');
  assert.equal(result.identity.plan.value, 'max');
  nothingSecret(result);
  assert.match(describeCheck(result).summary, /Signed in/);
  nothingSecret(describeCheck(result));
});

test('the exact command is the provider\'s status command as an argument array, from the registry executable', async (t) => {
  const w = world(t);
  const seen: Array<{ file: string; args: string[] }> = [];
  await checkAccountIdentity({ profile: w.profile, context: w.context, env: {}, runner: fake('ok', {}, seen).runner });
  assert.deepEqual(seen, [{ file: 'claude', args: ['auth', 'status', '--json'] }]);
});

test('no plan reported means the plan is unknown, and an odd plan text is dropped', async (t) => {
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

test('not signed in is reported as not signed in, with no identity', async (t) => {
  const w = world(t);
  const result = await run(w, 'not-logged-in');
  assert.equal(result.ok, true);
  assert.equal(result.identity.loggedIn, false);
  assert.equal(result.identity.subject.confidence, 'unknown');
  assert.match(describeCheck(result).summary, /not signed in/);
});

test('every failure is unknown with a reason, never ready, and none carries the CLI output', async (t) => {
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

test('a check that takes too long is stopped and reported as timed out', async (t) => {
  const w = world(t);
  const started = Date.now();
  const result = await checkAccountIdentity({
    profile: w.profile, context: w.context, env: { PATH: process.env.PATH },
    runner: (file: string, args: string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number }) =>
      runCommand(process.execPath, [FAKE, ...args], { ...options, timeoutMs: 300, env: childEnvironment({ FAKE_MODE: 'sleep' }, options.env) })
  });
  assert.deepEqual([result.reason, result.identity], ['timed-out', null]);
  assert.ok(Date.now() - started < 20000, 'the child was killed, not waited for');
});

test('too much output is refused by size, not parsed', async (t) => {
  const w = world(t);
  const result = await run(w, 'huge');
  assert.equal(result.reason, 'output-too-large');
  const injected = await checkAccountIdentity({ profile: w.profile, context: w.context, runner: async () => ({ code: 0, stdout: 'x'.repeat(MAX_OUTPUT_BYTES + 1) }) });
  assert.equal(injected.reason, 'output-too-large', 'also when the runner did not truncate');
  const exact = await checkAccountIdentity({ profile: w.profile, context: w.context, runner: async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: false }) }) });
  assert.equal(exact.ok, true);
});

test('a missing CLI is reported as not found, and a runner that throws or answers badly is a failed run', async (t) => {
  const w = world(t);
  const missing = await checkAccountIdentity({ profile: w.profile, context: w.context, runner: (file: string, args: string[], options: any) => runCommand(path.join(w.root, 'no-such-cli'), args, options) });
  assert.equal(missing.reason, 'cli-not-found');
  for (const runner of [async () => { throw new Error(`boom ${EMAIL}`); }, async () => null, async () => 'text', async () => ({ code: null, stdout: '', errorCode: 'EACCES' })]) {
    const result = await checkAccountIdentity({ profile: w.profile, context: w.context, runner });
    assert.deepEqual([result.ok, result.reason], [false, 'run-failed']);
    nothingSecret(result);
  }
});

test('the child runs in the profile\'s environment: its folder is set and inherited credentials are removed', async (t) => {
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

test('a CLI that used a different folder, or an API key, is flagged', async (t) => {
  const w = world(t);
  assert.ok((await run(w, 'ok-other-folder')).identity.anomalies.includes('config-dir-mismatch'));
  const keyed = await run(w, 'ok-api-key');
  assert.ok(keyed.identity.anomalies.includes('credential-from-environment'));
  assert.equal(keyed.identity.subject.confidence, 'unknown', 'an API-key login is not a verified person');
  assert.match(describeCheck(await run(w, 'ok-api-key')).summary, /did not confirm who/);
  const mismatch = await checkAccountIdentity({ profile: { ...w.profile, expectedAuthMethod: 'api-key' }, context: w.context, runner: fake('ok').runner });
  assert.ok(mismatch.identity.anomalies.includes('auth-method-mismatch'));
});

test('providers with no check, unknown providers and rejected profiles are unknown and run nothing', async (t) => {
  const w = world(t);
  let ran = 0;
  const runner = async () => { ran += 1; return { code: 0, stdout: '{}' }; };
  for (const provider of ['codex', 'agy', 'opencode', '', undefined, '__proto__', 'constructor']) {
    const result = await checkAccountIdentity({ profile: { ...w.profile, provider }, context: w.context, runner });
    assert.deepEqual([result.reason, result.identity], ['provider-not-supported', null], String(provider));
    assert.match(describeCheck(result).summary, /no sign-in check/);
  }
  for (const profile of [null, undefined, 'x', 5, []]) assert.equal((await checkAccountIdentity({ profile, context: w.context, runner })).reason, 'provider-not-supported');
  const inside = { ...w.profile, configDir: path.join(w.repoRoot, 'account') };
  assert.equal((await checkAccountIdentity({ profile: inside, context: w.context, runner })).reason, 'profile-rejected');
  assert.equal((await checkAccountIdentity({ profile: { ...w.profile, configDir: 'relative' }, context: w.context, runner })).reason, 'profile-rejected');
  assert.equal(ran, 0, 'nothing was run');
});

test('stderr never reaches the result, even when the CLI succeeds', async (t) => {
  const w = world(t);
  const result = await run(w, 'stderr-ok');
  assert.equal(result.ok, true);
  nothingSecret(result);
});

test('arguments are never built from the profile: the command is fixed', async (t) => {
  const w = world(t);
  const hostile = { ...w.profile, label: '$(touch /tmp/x); rm -rf /', id: 'acct-1' };
  const seen: Array<{ file: string; args: string[] }> = [];
  await checkAccountIdentity({ profile: hostile, context: w.context, runner: fake('ok', {}, seen).runner });
  assert.deepEqual(seen[0].args, ['auth', 'status', '--json']);
});

test('describeCheck has plain words for every reason and for a missing result', () => {
  for (const reason of Object.keys(REASONS)) {
    const words = describeCheck({ state: 'unknown', reason });
    assert.ok(words.summary.length > 20 && words.hint.length > 10, reason);
    assert.equal(/[a-z]+-[a-z]+-[a-z]+/.test(words.summary + words.hint), false, `${reason} shows a code`);
  }
  assert.equal(describeCheck({ state: 'unknown', reason: 'something-new' }).summary, REASONS['run-failed'].summary);
  assert.match(describeCheck(undefined).summary, /not been run/);
  assert.match(describeCheck(null).hint, /Check/);
});

test('the runner returns exit codes and keeps nothing but stdout', async () => {
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

test('a shell metacharacter in an argument is passed as text, not run', async () => {
  const result = await runCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', '$(echo injected); echo more'], { env: { PATH: process.env.PATH }, timeoutMs: 5000, maxOutputBytes: 1000 });
  assert.equal(result.stdout, '$(echo injected); echo more');
});

test('a signed-in account with a problem says so instead of offering to start', async (t) => {
  const w = world(t);
  const fine = describeCheck(await run(w, 'ok'));
  const odd = describeCheck(await run(w, 'ok-other-folder'));
  assert.match(fine.hint, /start a session/);
  assert.match(odd.hint, /something looks wrong/i);
  assert.equal(/start a session/.test(odd.hint), false);
});
