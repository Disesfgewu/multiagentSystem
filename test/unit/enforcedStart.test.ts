import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareIsolationForStart, EnforcedStartUi } from '../../src/isolation/enforcedStart';

function ui(answers: { confirm?: boolean } = {}) {
  const seen = { confirms: [] as string[][], progress: 0 };
  const handle: EnforcedStartUi = {
    confirm: async (lines) => { seen.confirms.push(lines); return answers.confirm ?? true; },
    progress: async (work) => { seen.progress += 1; return work(); }
  };
  return { seen, handle };
}

const okPrepared = (log: string[] = []) => async () => ({
  ok: true as const,
  wrapCommand: (executable: string, args: string[]) => ({ executable: '/usr/bin/sandbox-exec', args: ['-f', '/p', executable, ...args] }),
  env: { HTTPS_PROXY: 'http://managed:abc@127.0.0.1:1' },
  summary: ['Enforced isolation: proven.', 'Not verified (#135): the real CLI.'],
  dispose: async () => { log.push('disposed'); }
});
const base = (extra: Record<string, unknown> = {}) => ({ platform: 'darwin', mode: 'enforced', allowedDomains: ['api.provider.test'], interactive: true, storageDir: '/private/store', home: '/synthetic/home', cwd: '/synthetic/work', createHarness: () => ({}), ...extra });

test('without the setting, or in advisory mode, nothing is prepared and nothing is asked: the launch is unchanged', async () => {
  for (const mode of [undefined, 'advisory']) {
    const { seen, handle } = ui();
    let prepared = 0;
    const result = await prepareIsolationForStart({ ...base({ mode }), ui: handle, prepare: (async () => { prepared += 1; return okPrepared()(); }) as never } as never);
    assert.deepEqual(result, { kind: 'advisory' });
    assert.equal(prepared, 0);
    assert.equal(seen.progress, 0);
    assert.equal(seen.confirms.length, 0);
  }
});

test('a mode that is neither advisory nor enforced refuses rather than starting without the isolation the person may have meant', async () => {
  for (const mode of ['enforce', 'Enforced', '', null, true, 1]) {
    const { handle } = ui();
    const result = await prepareIsolationForStart({ ...base({ mode }), ui: handle } as never);
    assert.equal(result.kind, 'refused', String(mode));
  }
});

test('enforced mode without private storage refuses before anything is probed', async () => {
  let prepared = 0;
  const result = await prepareIsolationForStart({ ...base({ storageDir: undefined }), ui: ui().handle, prepare: (async () => { prepared += 1; return okPrepared()(); }) as never } as never);
  assert.equal(result.kind === 'refused' && result.code, 'storage-unavailable');
  assert.equal(prepared, 0);
});

test('enforced mode with sufficient evidence asks the person, saying what is not verified, then returns the wrap and environment', async () => {
  const { seen, handle } = ui();
  const result = await prepareIsolationForStart({ ...base(), ui: handle, prepare: okPrepared() as never } as never);
  assert.equal(result.kind, 'enforced');
  assert.equal(seen.confirms.length, 1);
  assert.ok(seen.confirms[0].some((line) => line.includes('#135')));
  if (result.kind === 'enforced') {
    assert.deepEqual(result.wrap('claude', ['--x']), { executable: '/usr/bin/sandbox-exec', args: ['-f', '/p', 'claude', '--x'] });
    assert.match(String(result.env.HTTPS_PROXY), /127\.0\.0\.1/);
  }
});

test('declining the confirmation starts nothing and removes what was prepared', async () => {
  const log: string[] = [];
  const result = await prepareIsolationForStart({ ...base(), ui: ui({ confirm: false }).handle, prepare: okPrepared(log) as never } as never);
  assert.equal(result.kind === 'refused' && result.code, 'cancelled');
  assert.deepEqual(log, ['disposed']);
});

test('insufficient evidence refuses with the reasons and never falls back to a launch without isolation', async () => {
  const prepare = async () => ({ ok: false as const, code: 'evidence-insufficient', reasons: ['direct-http:open', 'gh-cli:control-did-not-run'], notice: 'Enforced mode was requested but is not available here, so nothing was started.' });
  const { seen, handle } = ui();
  const result = await prepareIsolationForStart({ ...base(), ui: handle, prepare: prepare as never } as never);
  assert.equal(result.kind, 'refused');
  if (result.kind === 'refused') {
    assert.equal(result.code, 'evidence-insufficient');
    assert.match(result.message, /direct-http:open/);
    assert.match(result.message, /nothing was started/);
  }
  assert.equal(seen.confirms.length, 0, 'nobody is asked to confirm something that will not happen');
});

test('only a test that answers for the person skips the confirmation (the caller passes interactive: false only then)', async () => {
  const { seen, handle } = ui();
  const result = await prepareIsolationForStart({ ...base({ interactive: false }), ui: handle, prepare: okPrepared() as never } as never);
  assert.equal(result.kind, 'enforced');
  assert.equal(seen.confirms.length, 0);
});

test('every place that starts or reopens an agent CLI goes through the isolation decision and passes its wrapper on', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', '..', 'src', 'sessions', 'sessionCommands.ts'), 'utf8') as string;
  const calls = [...source.matchAll(/manager\.(start|reopen)\(/g)].length;
  assert.ok(calls >= 2, 'both entry points exist');
  assert.equal([...source.matchAll(/await isolationForLaunch\(/g)].length, calls, 'each one asks for the isolation decision first');
  assert.equal([...source.matchAll(/isolation\.kind === 'enforced' \? \{ wrap: isolation\.wrap \}/g)].length, calls, 'each one passes the wrapper to the manager');
});

test('on Windows (and any platform but macOS) enforced mode refuses first: nothing is probed, asked, prepared or wrapped', async () => {
  for (const platform of ['win32', 'linux', 'freebsd']) {
    for (const interactive of [true, false]) {
      const { seen, handle } = ui();
      let prepared = 0;
      let harnesses = 0;
      const result = await prepareIsolationForStart({
        ...base({ platform, interactive, createHarness: () => { harnesses += 1; return {}; } }),
        ui: handle,
        prepare: (async () => { prepared += 1; return okPrepared()(); }) as never
      } as never);
      assert.equal(result.kind, 'refused', platform);
      if (result.kind === 'refused') {
        assert.equal(result.code, 'platform-not-supported');
        if (platform === 'win32') assert.match(result.message, /Windows does not support managed isolation yet/);
        assert.match(result.message, /advisory/);
      }
      assert.deepEqual([prepared, harnesses, seen.progress, seen.confirms.length], [0, 0, 0, 0], `${platform}: no probe, no progress, no confirmation`);
    }
  }
});

test('on Windows the refusal comes even when storage is missing, so no other path can be taken first', async () => {
  const result = await prepareIsolationForStart({ ...base({ platform: 'win32', storageDir: undefined }), ui: ui().handle } as never);
  assert.equal(result.kind === 'refused' && result.code, 'platform-not-supported');
});

test('advice mode is unchanged on Windows: nothing is refused and nothing is wrapped', async () => {
  for (const mode of [undefined, 'advisory']) assert.deepEqual(await prepareIsolationForStart({ ...base({ platform: 'win32', mode }), ui: ui().handle } as never), { kind: 'advisory' });
});

test('every place that starts or reopens an agent CLI prepares Claude Code\'s attribution settings and hands the file to the manager', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', '..', 'src', 'sessions', 'sessionCommands.ts'), 'utf8') as string;
  const calls = [...source.matchAll(/manager\.(start|reopen)\(/g)].length;
  assert.equal([...source.matchAll(/= attributionFileFor\(/g)].length, calls, 'each one prepares the file');
  assert.equal([...source.matchAll(/\.\.\.\(attributionFile \? \{ attributionFile \} : \{\}\)/g)].length, calls, 'each one passes it on');
});

test('every place that starts or reopens an agent CLI resolves auto mode from the user\'s own settings, tells the person, and hands it to the manager', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', '..', 'src', 'sessions', 'sessionCommands.ts'), 'utf8') as string;
  const calls = [...source.matchAll(/manager\.(start|reopen)\(/g)].length;
  assert.equal([...source.matchAll(/= autoModeFor\(/g)].length, calls, 'each one resolves it');
  assert.equal([...source.matchAll(/\.\.\.\(autoMode\.auto \? \{ autoMode: autoMode\.auto \} : \{\}\)/g)].length, calls, 'each one passes it on');
  assert.equal([...source.matchAll(/\$\{autoMode\.lines\.length > 0/g)].length, calls, 'each confirmation window carries the lines');
  assert.match(source, /readUserLevel\(settings\.inspect\('agents\.autoMode'\)\)\.value/, 'the setting is read from the user level only');
  assert.match(source, /readUserLevel\(settings\.inspect\('agents\.autoModeOverrides'\)\)\.value/);
});

test('the broadcast delivery command takes no argument, asks for the confirmation every time and is not reachable as a session command', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const commands = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'broadcast', 'commands.ts'), 'utf8') as string;
  assert.match(commands, /registerCommand\(BROADCAST_COMMANDS\.deliver, \(\) => deliver\(sessions\)\)/, 'the command ignores whatever it is called with');
  const body = commands.slice(commands.indexOf('async function deliver('), commands.indexOf('let currentTree'));
  assert.match(body, /showWarningMessage\(\s*'Type this broadcast into the running agents\?',\s*\{ modal: true, detail: describePlan\(plan\)\.join\('\\n'\) \},\s*\.\.\.buttons/, 'a modal with the full prompt');
  assert.match(body, /if \(confirmed !== sendWaiting && confirmed !== sendUnknown\) return;/, 'nothing is typed without pressing a button');
  assert.ok(body.indexOf('confirmed !== sendWaiting') < body.indexOf('sendPrompt('), 'the confirmation comes before any typing');
  assert.match(body, /const sendUnknown = waitingIds\.size > 0 \? 'Also Send to Unknown' : 'Send to Unknown Anyway';/, 'sessions of unknown state need their own explicit button');
  assert.match(body, /const includeUnknown = confirmed === sendUnknown;/, 'unknown ones are included only by that button');
  assert.match(body, /allowedIds\.has\(entry\.id\)/, 'only sessions the person was shown and allowed are typed into');
  assert.match(body, /\.get\(selected\.id\)/, 'the broadcast is read again before typing');
  assert.match(body, /isLive\(\(again as/, 'a revoked broadcast is not typed');
  assert.equal([...body.matchAll(/sendPrompt\(/g)].length, 1, 'one place types');
  const sessionCommands = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'sessions', 'sessionCommands.ts'), 'utf8') as string;
  assert.doesNotMatch(sessionCommands, /registerCommand\([^)]*sendPrompt/, 'typing into a terminal is not a VS Code command');
  const manager = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'sessions', 'manager.ts'), 'utf8') as string;
  assert.equal([...manager.matchAll(/terminal\.sendText\(/g)].length, 2, 'the manager types in two places only: the launch command and sendPrompt');
});

test('every start and reopen writes the role group\'s permissions into the session\'s settings file after the instructions are prepared, removes the file with the session, and passes Codex\'s sandbox on (issue #310)', () => {
  // A checkout may use CRLF line ends (Windows): the patterns below span lines, so they read the source with LF.
  const source = (require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', '..', 'src', 'sessions', 'sessionCommands.ts'), 'utf8') as string).replace(/\r\n/g, '\n');
  const calls = [...source.matchAll(/manager\.(start|reopen)\(/g)].length;
  const writes = [...source.matchAll(/attributionFile = attributionFileFor\([^)]*instructions\?\.toolPermissions\)/g)];
  assert.equal(writes.length, calls, 'each one writes the file from the prepared instructions\' permissions');
  assert.equal([...source.matchAll(/= attributionFileFor\(/g)].length, calls, 'and from nowhere else');
  assert.equal([...source.matchAll(/removeClaudeSettings\(file\)/g)].length, calls, 'each one removes the file again with the session, or when the start fails');
  assert.equal([...source.matchAll(/codexArguments\(instructions\?\.toolPermissions\)\.args/g)].length, calls, 'each one passes Codex its sandbox mode');
  assert.equal([...source.matchAll(/if \(instructions\?\.plan\) cleanupSessionPlan\(instructions\.plan\);\n\s*(?:observations\.release\(newSessionId\);\n\s*)?throw error;/g)].length, calls, 'a settings file that cannot be written removes the prepared instruction files and starts nothing');
  const startAt = source.indexOf('async function launch(');
  const writeAt = source.indexOf('attributionFile = attributionFileFor(', startAt);
  assert.ok(source.indexOf('instructions = prep;', startAt) < writeAt, 'the role group\'s permissions exist before the file is written');
});

test('the enforced confirmation carries the extra lines the caller gives (what auto mode means in the sandbox), before the closing sentence', async () => {
  const { seen, handle } = ui();
  await prepareIsolationForStart({ ...base(), ui: handle, prepare: okPrepared() as never, extraLines: ['Auto mode: on (won\'t ask for each approval)', 5 as never] } as never);
  const lines = seen.confirms[0];
  assert.ok(lines.includes('Auto mode: on (won\'t ask for each approval)'));
  assert.ok(!lines.includes(5 as never), 'only text is shown');
  assert.ok(lines.indexOf('Auto mode: on (won\'t ask for each approval)') < lines.findIndex((line) => line.startsWith('This is the enforced mode')));
  const none = ui();
  await prepareIsolationForStart({ ...base(), ui: none.handle, prepare: okPrepared() as never, extraLines: 'not a list' as never } as never);
  assert.equal(none.seen.confirms[0].length, 3, 'a bad list adds nothing');
});
