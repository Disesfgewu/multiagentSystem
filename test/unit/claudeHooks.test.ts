import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  HOOK_BRIDGE_EVENTS, HOOK_OWNER_FILE_NAME, buildHookCommand, buildHookGroup, configureHooksWizard, disableClaudeHooks,
  enableClaudeHooks, inspectHookConfig, readHookOwnerRecord, HookUi
} from '../../src/accounts/claudeHooks';

// Settings shapes follow https://code.claude.com/docs/en/hooks ("Configuration", "Matcher patterns").
const SCRIPT = '/opt/multiagent/out/src/accounts/claudeHookBridge.js';
// Paths and quoting follow the platform the test runs on, so a real temporary folder passes the path check there too.
const WIN = process.platform === 'win32';
const COMMAND = buildHookCommand(SCRIPT, WIN);
const USER_HOOKS = {
  PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: '/path/to/lint-check.sh' }] }],
  PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', if: 'Bash(rm *)', command: '${CLAUDE_PROJECT_DIR}/.claude/hooks/block-rm.sh', args: [] }] }]
};

function profile(settings?: string | object): { dir: string; settingsPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hooks-'));
  const settingsPath = path.join(dir, 'settings.json');
  if (settings !== undefined) fs.writeFileSync(settingsPath, typeof settings === 'string' ? settings : `${JSON.stringify(settings, null, 2)}\n`);
  return { dir, settingsPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const read = (file: string): any => JSON.parse(fs.readFileSync(file, 'utf8'));
const enable = (dir: string) => enableClaudeHooks(dir, SCRIPT, WIN);

test('the hook group is one command handler with no matcher; SessionEnd has no timeout of its own', () => {
  assert.deepEqual(buildHookGroup('Stop', COMMAND), { hooks: [{ type: 'command', command: COMMAND, timeout: 5 }] });
  assert.deepEqual(buildHookGroup('SessionEnd', COMMAND), { hooks: [{ type: 'command', command: COMMAND }] });
  assert.deepEqual([...HOOK_BRIDGE_EVENTS], ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd']);
});

test('unsafe script paths are refused and nothing is written', () => {
  const p = profile({ theme: 'dark' });
  try {
    const before = fs.readFileSync(p.settingsPath, 'utf8');
    for (const bad of ["/tmp/a'b.js", '/tmp/a$(x).js', '/tmp/a;b.js', '/tmp/a`b`.js']) {
      assert.throws(() => buildHookCommand(bad, false));
      assert.deepEqual(enableClaudeHooks(p.dir, bad, false), { ok: false, reason: 'unsafe-path-characters' });
    }
    assert.equal(fs.readFileSync(p.settingsPath, 'utf8'), before);
    assert.equal(fs.existsSync(path.join(p.dir, HOOK_OWNER_FILE_NAME)), false);
  } finally { p.cleanup(); }
});

test('enable merges into a profile with existing hooks and keeps every other key', () => {
  const original = { model: 'opus', permissions: { allow: ['Bash(npm test)'] }, hooks: USER_HOOKS, statusLine: { type: 'command', command: 'my-line' }, env: { A: '1' } };
  const p = profile(original);
  try {
    assert.deepEqual(enable(p.dir), { ok: true, changed: true });
    const after = read(p.settingsPath);
    assert.deepEqual(Object.keys(after), Object.keys(original), 'key order is kept');
    for (const key of ['model', 'permissions', 'statusLine', 'env']) assert.deepEqual(after[key], (original as any)[key]);
    // The user's groups are untouched, in place, and ours are appended after them.
    assert.deepEqual(after.hooks.PostToolUse[0], USER_HOOKS.PostToolUse[0]);
    assert.deepEqual(after.hooks.PreToolUse[0], USER_HOOKS.PreToolUse[0]);
    assert.equal(after.hooks.PostToolUse.length, 2);
    for (const event of HOOK_BRIDGE_EVENTS) assert.deepEqual(after.hooks[event].at(-1), buildHookGroup(event, COMMAND));
    assert.equal(inspectHookConfig(p.dir, SCRIPT, WIN).status, 'active');
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(p.dir, HOOK_OWNER_FILE_NAME)).mode & 0o777, 0o600);
  } finally { p.cleanup(); }
});

test('enable then disable returns settings.json byte for byte, including formatting', () => {
  for (const text of [
    `${JSON.stringify({ model: 'opus', hooks: USER_HOOKS, z: [1, 2] }, null, 2)}\n`,
    JSON.stringify({ model: 'opus', hooks: USER_HOOKS }, null, 4),
    JSON.stringify({ model: 'opus', hooks: USER_HOOKS }, null, '\t') + '\n',
    `${JSON.stringify({ model: 'opus', hooks: { Stop: [] } }, null, 2)}\n`,
    `${JSON.stringify({ model: 'opus', hooks: {} }, null, 2)}\n`,
    `${JSON.stringify({ model: 'opus' }, null, 2)}\n`,
    '{}\n'
  ]) {
    const p = profile(text);
    try {
      assert.equal(enable(p.dir).ok, true);
      assert.notEqual(fs.readFileSync(p.settingsPath, 'utf8'), text);
      assert.deepEqual(disableClaudeHooks(p.dir), { ok: true, changed: true });
      assert.equal(fs.readFileSync(p.settingsPath, 'utf8'), text);
      assert.equal(fs.existsSync(path.join(p.dir, HOOK_OWNER_FILE_NAME)), false);
    } finally { p.cleanup(); }
  }
});

test('enable creates settings.json when there is none, and disable leaves an empty object', () => {
  const p = profile();
  try {
    assert.equal(enable(p.dir).ok, true);
    assert.equal(Object.keys(read(p.settingsPath).hooks).length, 6);
    assert.equal(disableClaudeHooks(p.dir).ok, true);
    assert.deepEqual(read(p.settingsPath), {});
  } finally { p.cleanup(); }
});

test('enable twice changes nothing the second time', () => {
  const p = profile({ hooks: USER_HOOKS });
  try {
    enable(p.dir);
    const once = fs.readFileSync(p.settingsPath, 'utf8');
    assert.deepEqual(enable(p.dir), { ok: true, changed: false });
    assert.equal(fs.readFileSync(p.settingsPath, 'utf8'), once);
  } finally { p.cleanup(); }
});

test('disable removes only the recorded entries; user hooks added later stay', () => {
  const p = profile({ hooks: USER_HOOKS });
  try {
    enable(p.dir);
    const settings = read(p.settingsPath);
    settings.hooks.Stop.push({ hooks: [{ type: 'command', command: 'echo done' }] });
    settings.hooks.PreToolUse.unshift({ matcher: 'Read', hooks: [{ type: 'command', command: 'echo read' }] });
    fs.writeFileSync(p.settingsPath, JSON.stringify(settings, null, 2));
    assert.equal(disableClaudeHooks(p.dir).ok, true);
    const after = read(p.settingsPath);
    assert.deepEqual(after.hooks.Stop, [{ hooks: [{ type: 'command', command: 'echo done' }] }]);
    assert.deepEqual(after.hooks.PreToolUse, [{ matcher: 'Read', hooks: [{ type: 'command', command: 'echo read' }] }, USER_HOOKS.PreToolUse[0]]);
    assert.deepEqual(after.hooks.PostToolUse, USER_HOOKS.PostToolUse);
    assert.equal(after.hooks.Notification, undefined);
    assert.equal(after.hooks.SessionEnd, undefined);
  } finally { p.cleanup(); }
});

test('a user hook identical in text to ours is not removed unless it is recorded as ours', () => {
  const lookalike = { hooks: [{ type: 'command', command: COMMAND, timeout: 5 }] };
  // No record at all: nothing is removed and nothing is written.
  const p = profile({ hooks: { Stop: [lookalike] } });
  try {
    const before = fs.readFileSync(p.settingsPath, 'utf8');
    assert.deepEqual(disableClaudeHooks(p.dir), { ok: false, reason: 'hooks-not-ours' });
    assert.equal(fs.readFileSync(p.settingsPath, 'utf8'), before);
    // Enabling refuses: whose it is cannot be proven, and a later removal might take the user's.
    assert.deepEqual(enable(p.dir), { ok: false, reason: 'hook-lookalike-not-recorded' });
    assert.equal(fs.readFileSync(p.settingsPath, 'utf8'), before);
    assert.equal(fs.existsSync(path.join(p.dir, HOOK_OWNER_FILE_NAME)), false);
  } finally { p.cleanup(); }

  // A record exists for the other events only: the unrecorded lookalike in Stop survives a disable.
  const q = profile({ hooks: {} });
  try {
    enable(q.dir);
    const settings = read(q.settingsPath);
    settings.hooks.Stop = [lookalike];
    fs.writeFileSync(q.settingsPath, JSON.stringify(settings, null, 2));
    const owner = JSON.parse(fs.readFileSync(path.join(q.dir, HOOK_OWNER_FILE_NAME), 'utf8'));
    owner.entries = owner.entries.filter((entry: { event: string }) => entry.event !== 'Stop');
    fs.writeFileSync(path.join(q.dir, HOOK_OWNER_FILE_NAME), JSON.stringify(owner));
    assert.equal(disableClaudeHooks(q.dir).ok, true);
    assert.deepEqual(read(q.settingsPath).hooks.Stop, [lookalike]);
  } finally { q.cleanup(); }
});

test('a group the user edited after we added it is no longer ours and stays', () => {
  const p = profile({});
  try {
    enable(p.dir);
    const settings = read(p.settingsPath);
    settings.hooks.Stop[0].hooks[0].timeout = 99;
    fs.writeFileSync(p.settingsPath, JSON.stringify(settings, null, 2));
    assert.equal(disableClaudeHooks(p.dir).ok, true);
    assert.equal(read(p.settingsPath).hooks.Stop[0].hooks[0].timeout, 99);
  } finally { p.cleanup(); }
});

test('corrupt, non-object and oddly shaped settings.json are refused and left untouched', () => {
  for (const text of ['{ "hooks": ', '[]', 'null', '"x"', '{"hooks": []}', '{"hooks": "x"}', '{"hooks": {"Stop": {"hooks": []}}}']) {
    const p = profile(text);
    try {
      const result = enable(p.dir);
      assert.equal(result.ok, false, text);
      assert.equal(fs.readFileSync(p.settingsPath, 'utf8'), text);
      assert.equal(fs.existsSync(path.join(p.dir, HOOK_OWNER_FILE_NAME)), false);
      assert.equal(inspectHookConfig(p.dir, SCRIPT, WIN).status, 'unreadable');
    } finally { p.cleanup(); }
  }
  const p = profile({});
  try {
    enable(p.dir);
    fs.writeFileSync(p.settingsPath, '{ broken');
    assert.equal(disableClaudeHooks(p.dir).ok, false);
    assert.equal(fs.readFileSync(p.settingsPath, 'utf8'), '{ broken');
  } finally { p.cleanup(); }
});

test('an unreadable ownership record refuses enable and disable', () => {
  for (const record of ['not json', JSON.stringify({ schema: 2, hooksKeyCreated: true, entries: [] }), JSON.stringify({ schema: 1, hooksKeyCreated: true, entries: [{ event: 'Evil', group: { hooks: [{ command: 'x' }] }, eventCreated: true }] }), JSON.stringify({ schema: 1, hooksKeyCreated: true, entries: [{ event: 'Stop', group: { hooks: [{ command: 'x'.repeat(5000) }] }, eventCreated: true }] }), 'x'.repeat(70 * 1024)]) {
    const p = profile({ hooks: USER_HOOKS });
    try {
      fs.writeFileSync(path.join(p.dir, HOOK_OWNER_FILE_NAME), record);
      const before = fs.readFileSync(p.settingsPath, 'utf8');
      assert.deepEqual(enable(p.dir), { ok: false, reason: 'owner-record-unreadable' });
      assert.deepEqual(disableClaudeHooks(p.dir), { ok: false, reason: 'owner-record-unreadable' });
      assert.equal(fs.readFileSync(p.settingsPath, 'utf8'), before);
      assert.equal(readHookOwnerRecord(p.dir).state, 'invalid');
    } finally { p.cleanup(); }
  }
});

test('a linked ownership record is no evidence', { skip: process.platform === 'win32' }, () => {
  const p = profile({ hooks: USER_HOOKS });
  try {
    enable(p.dir);
    const real = path.join(p.dir, 'real-owner.json');
    fs.renameSync(path.join(p.dir, HOOK_OWNER_FILE_NAME), real);
    fs.symlinkSync(real, path.join(p.dir, HOOK_OWNER_FILE_NAME));
    const before = fs.readFileSync(p.settingsPath, 'utf8');
    assert.equal(disableClaudeHooks(p.dir).reason, 'owner-record-unreadable');
    assert.equal(fs.readFileSync(p.settingsPath, 'utf8'), before);
  } finally { p.cleanup(); }
});

test('a settings.json changed between read and write is not overwritten', () => {
  const p = profile({ hooks: USER_HOOKS });
  // The module under test reads fs functions live from the real module, so patch that one.
  const realFs = require('node:fs') as any;
  const realWrite = realFs.writeFileSync;
  try {
    let injected = false;
    // Another editor saves the file after we read it and before our write: the ownership record is written after we read settings and before we write them, which is the moment.
    realFs.writeFileSync = (file: string, ...rest: unknown[]) => {
      if (!injected && String(file).includes(`${HOOK_OWNER_FILE_NAME}.tmp.`)) {
        injected = true;
        realWrite(p.settingsPath, JSON.stringify({ edited: 'meanwhile' }));
      }
      return (realWrite as any)(file, ...rest);
    };
    const result = enable(p.dir);
    realFs.writeFileSync = realWrite;
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'settings-changed');
    assert.deepEqual(read(p.settingsPath), { edited: 'meanwhile' });
    assert.equal(fs.existsSync(path.join(p.dir, HOOK_OWNER_FILE_NAME)), false, 'the ownership record claiming entries that were never written is withdrawn');
  } finally { realFs.writeFileSync = realWrite; p.cleanup(); }
});

test('a symlinked settings.json is updated through the link and the link survives', { skip: process.platform === 'win32' }, () => {
  const p = profile();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hooks-dotfiles-'));
  try {
    const real = path.join(elsewhere, 'settings.json');
    fs.writeFileSync(real, `${JSON.stringify({ model: 'opus', hooks: USER_HOOKS }, null, 2)}\n`);
    fs.symlinkSync(real, p.settingsPath);
    assert.equal(enable(p.dir).ok, true);
    assert.equal(fs.lstatSync(p.settingsPath).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(p.settingsPath), fs.realpathSync(real));
    assert.equal(read(real).hooks.Stop.length, 1);
    assert.equal(disableClaudeHooks(p.dir).ok, true);
    assert.equal(fs.lstatSync(p.settingsPath).isSymbolicLink(), true);
    assert.deepEqual(read(real), { model: 'opus', hooks: USER_HOOKS });
  } finally { p.cleanup(); fs.rmSync(elsewhere, { recursive: true, force: true }); }
});

test('only the profile settings.json is written: no settings.local.json, no workspace .claude folder', () => {
  const p = profile({});
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hooks-workspace-'));
  const previous = process.cwd();
  try {
    fs.mkdirSync(path.join(workspace, '.claude'));
    process.chdir(workspace);
    enable(p.dir);
    assert.deepEqual(fs.readdirSync(path.join(workspace, '.claude')), []);
    assert.deepEqual(fs.readdirSync(p.dir).sort(), [HOOK_OWNER_FILE_NAME, 'settings.json']);
    assert.deepEqual(enableClaudeHooks('relative/profile', SCRIPT, WIN), { ok: false, reason: 'config-dir-not-absolute' });
    assert.equal(fs.existsSync(path.join(workspace, 'relative')), false);
  } finally { process.chdir(previous); p.cleanup(); fs.rmSync(workspace, { recursive: true, force: true }); }
});

test('an install from an older script location is replaced, not duplicated', () => {
  const p = profile({ hooks: USER_HOOKS });
  try {
    enableClaudeHooks(p.dir, '/old/place/claudeHookBridge.js', WIN);
    assert.equal(enable(p.dir).ok, true);
    const after = read(p.settingsPath);
    assert.equal(after.hooks.Stop.length, 1);
    assert.equal(after.hooks.Stop[0].hooks[0].command, COMMAND);
    assert.equal(after.hooks.PostToolUse.length, 2);
    assert.equal(JSON.stringify(after).includes('/old/place'), false);
    assert.equal(disableClaudeHooks(p.dir).ok, true);
    assert.deepEqual(read(p.settingsPath), { hooks: USER_HOOKS });
  } finally { p.cleanup(); }
});

test('disable with nothing of ours left only cleans the stale record', () => {
  const p = profile({ hooks: USER_HOOKS });
  try {
    enable(p.dir);
    fs.writeFileSync(p.settingsPath, JSON.stringify({ hooks: USER_HOOKS }));
    assert.deepEqual(disableClaudeHooks(p.dir), { ok: true, changed: false });
    assert.equal(fs.existsSync(path.join(p.dir, HOOK_OWNER_FILE_NAME)), false);
    assert.deepEqual(read(p.settingsPath), { hooks: USER_HOOKS });
  } finally { p.cleanup(); }
});

function fakeUi(answers: { enable?: boolean; choice?: 'keep' | 'disable'; disable?: boolean }): { ui: HookUi; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    ui: {
      async confirmEnable(label, settingsPath, command, events) { calls.push(`enable:${settingsPath}:${command}:${events.length}`); return answers.enable === true; },
      async promptActiveChoice() { calls.push('choice'); return answers.choice; },
      async confirmDisable() { calls.push('confirmDisable'); return answers.disable === true; },
      showInfo(message) { calls.push(`info:${message}`); },
      showError(message) { calls.push(`error:${message}`); }
    }
  };
}

test('wizard: the dialog shows the file and the command, and declining writes nothing', async () => {
  const p = profile({ model: 'opus' });
  try {
    const before = fs.readFileSync(p.settingsPath, 'utf8');
    const { ui, calls } = fakeUi({ enable: false });
    const outcome = await configureHooksWizard({ id: 'a', provider: 'claude', label: 'Work', configDir: p.dir }, { ui });
    assert.equal(outcome.status, 'cancelled');
    assert.match(calls[0], new RegExp(`^enable:${p.settingsPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:node [\\x27\\x22].*claudeHookBridge\\.js[\\x27\\x22]:6$`));
    assert.equal(fs.readFileSync(p.settingsPath, 'utf8'), before);
    assert.equal(fs.existsSync(path.join(p.dir, HOOK_OWNER_FILE_NAME)), false);
  } finally { p.cleanup(); }
});

test('wizard: consent enables, an active bridge can be kept or removed, other providers are unsupported', async () => {
  const p = profile({ model: 'opus' });
  try {
    const account = { id: 'a', provider: 'claude', label: 'Work', configDir: p.dir };
    assert.equal((await configureHooksWizard(account, { ui: fakeUi({ enable: true }).ui })).status, 'enabled');
    assert.equal(inspectHookConfig(p.dir).status, 'active');
    assert.equal((await configureHooksWizard(account, { ui: fakeUi({ choice: 'keep' }).ui })).status, 'enabled');
    assert.equal(inspectHookConfig(p.dir).status, 'active');
    assert.equal((await configureHooksWizard(account, { ui: fakeUi({ choice: 'disable', disable: false }).ui })).status, 'cancelled');
    assert.equal(inspectHookConfig(p.dir).status, 'active');
    assert.equal((await configureHooksWizard(account, { ui: fakeUi({ choice: 'disable', disable: true }).ui })).status, 'disabled');
    assert.deepEqual(read(p.settingsPath), { model: 'opus' });
    assert.equal((await configureHooksWizard({ ...account, provider: 'codex' }, { ui: fakeUi({}).ui })).status, 'unsupported');
    assert.equal((await configureHooksWizard({ ...account, provider: 'agy' })).status, 'unsupported');
  } finally { p.cleanup(); }
});

test('wizard without a UI acts only with explicit consent', async () => {
  const p = profile({});
  try {
    const account = { id: 'a', provider: 'claude', label: 'Work', configDir: p.dir };
    assert.equal((await configureHooksWizard(account, {})).status, 'cancelled');
    assert.equal((await configureHooksWizard(account, { consent: false })).status, 'cancelled');
    assert.deepEqual(read(p.settingsPath), {});
    assert.equal((await configureHooksWizard(account, { consent: true })).status, 'enabled');
    assert.equal((await configureHooksWizard(account, { consent: true, action: 'disable' })).status, 'disabled');
  } finally { p.cleanup(); }
});

test('wizard refuses an unreadable settings.json before asking anything', async () => {
  const p = profile('{ nope');
  try {
    const { ui, calls } = fakeUi({ enable: true });
    const outcome = await configureHooksWizard({ id: 'a', provider: 'claude', label: 'Work', configDir: p.dir }, { ui });
    assert.equal(outcome.status, 'failed');
    assert.equal(calls.some((call) => call.startsWith('enable:')), false);
    assert.equal(fs.readFileSync(p.settingsPath, 'utf8'), '{ nope');
  } finally { p.cleanup(); }
});
