'use strict';

// Hook inputs below are the examples of https://code.claude.com/docs/en/hooks ("Hook input and output",
// "UserPromptSubmit input", "PostToolUse input", "Notification input", "Stop input", "SessionEnd input").
// Nothing here runs a real Claude CLI: these are synthetic stdin payloads.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { spawn } = require('node:child_process');
const { runHookBridge, hookRecordPath, SESSION_ID_ENV } = require('../../src/accounts/claudeHookBridge');

const SCRIPT = path.resolve(__dirname, '../../src/accounts/claudeHookBridge.js');
const common = { session_id: 'abc123', transcript_path: '/home/user/.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl', cwd: '/home/user/project', permission_mode: 'default' };
const DOC_EXAMPLES = {
  UserPromptSubmit: { ...common, hook_event_name: 'UserPromptSubmit', prompt: 'Write a function to calculate the factorial of a number' },
  PreToolUse: { session_id: 'abc123', prompt_id: '550e8400-e29b-41d2-a716-446655440000', transcript_path: common.transcript_path, cwd: '/home/user/my-project', permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run test suite', timeout: 120000, run_in_background: false }, tool_use_id: 'toolu_01ABC123...' },
  PostToolUse: { ...common, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: '/path/to/file.txt', content: 'file content' }, tool_response: { filePath: '/path/to/file.txt', type: 'create' }, tool_use_id: 'toolu_01ABC123...', duration_ms: 12 },
  Notification: { ...common, hook_event_name: 'Notification', message: 'Claude needs your permission', title: 'Permission needed', notification_type: 'permission_prompt' },
  Stop: { ...common, hook_event_name: 'Stop', stop_hook_active: true, last_assistant_message: "I've completed the refactoring. Here's a summary...", background_tasks: [{ id: 'task-001', type: 'shell', status: 'running', description: 'tail logs', command: 'tail -f /var/log/syslog' }], session_crons: [{ id: 'cron-001', schedule: '0 9 * * 1-5', recurring: true, prompt: 'check the build' }] },
  SessionEnd: { ...common, hook_event_name: 'SessionEnd', reason: 'other' }
};

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hook-bridge-'));
  return { root, env: { CLAUDE_CONFIG_DIR: root, [SESSION_ID_ENV]: 'session-a' }, file: hookRecordPath(root, 'session-a'), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

async function feed(input, env, extra = {}) {
  const stdin = new PassThrough();
  const done = runHookBridge({ stdin, env, now: () => new Date('2026-01-01T00:00:00.000Z'), timeoutMs: 500, ...extra });
  if (input !== null) { stdin.end(input); }
  await done;
}

const filesBelow = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));

test('every documented example keeps only the session id, the event name and the permission mode', async () => {
  for (const [event, payload] of Object.entries(DOC_EXAMPLES)) {
    const ctx = setup();
    try {
      await feed(JSON.stringify(payload), ctx.env);
      const record = JSON.parse(fs.readFileSync(ctx.file, 'utf8'));
      assert.deepEqual(Object.keys(record).sort(), ['eventId', 'hook', 'observedAt', 'providerSessionId', 'schemaVersion', 'sequence']);
      assert.deepEqual(record.hook, { hookEventName: event, permissionMode: 'default' });
      assert.equal(record.providerSessionId, 'abc123');
      // Every file written (records, temporaries) is scanned for anything private from the input.
      for (const file of filesBelow(ctx.root)) {
        const text = fs.readFileSync(file, 'utf8');
        for (const secret of ['transcript', '/Users', 'my-project', 'factorial', 'npm test', 'file content', 'needs your permission', 'Permission needed', 'completed the refactoring', 'tail -f', 'check the build', 'jsonl']) {
          assert.equal(text.includes(secret), false, `${event}: ${file} must not contain ${secret}`);
        }
      }
      assert.deepEqual(fs.readdirSync(path.dirname(ctx.file)), [path.basename(ctx.file)], 'no temporary file is left behind');
    } finally { ctx.cleanup(); }
  }
});

test('the record is private (0600 file, 0700 folder) and a later event gets a later sequence', async () => {
  const ctx = setup();
  try {
    await feed(JSON.stringify(DOC_EXAMPLES.PreToolUse), ctx.env);
    const first = JSON.parse(fs.readFileSync(ctx.file, 'utf8'));
    await feed(JSON.stringify(DOC_EXAMPLES.Stop), ctx.env);
    const second = JSON.parse(fs.readFileSync(ctx.file, 'utf8'));
    assert.ok(second.sequence > first.sequence, 'same millisecond still yields a larger sequence');
    assert.notEqual(second.eventId, first.eventId);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(ctx.file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(ctx.file)).mode & 0o777, 0o700);
    }
  } finally { ctx.cleanup(); }
});

test('nothing is written for empty, malformed, hostile or oversized input', async () => {
  const hostile = [
    '', '   ', 'not json', '[]', 'null', '"abc"', '{"session_id":', '{}',
    JSON.stringify({ session_id: '../../etc/passwd', hook_event_name: 'Stop' }),
    JSON.stringify({ session_id: 'abc123', hook_event_name: 'SessionStart' }),
    JSON.stringify({ session_id: 'abc123', hook_event_name: '__proto__' }),
    JSON.stringify({ session_id: 'abc123', hook_event_name: 'Stop\n' }),
    JSON.stringify({ session_id: 'a'.repeat(129), hook_event_name: 'Stop' }),
    JSON.stringify({ session_id: ['abc123'], hook_event_name: 'Stop' }),
    JSON.stringify({ session_id: 'abc123', hook_event_name: ['Stop'] }),
    JSON.stringify({ session_id: 'abc 123', hook_event_name: 'Stop' }),
    '\u0000\u0001\u0002',
    JSON.stringify({ session_id: 'abc123', hook_event_name: 'Stop', pad: 'x'.repeat(2 * 1024 * 1024) })
  ];
  for (const input of hostile) {
    const ctx = setup();
    try {
      await feed(input, ctx.env);
      assert.equal(fs.existsSync(path.join(ctx.root, 'session-observations')), false, `no folder for ${input.slice(0, 40)}`);
    } finally { ctx.cleanup(); }
  }
});

test('a missing, malformed or relative managed binding writes nothing', async () => {
  const bad = [undefined, '', '../x', 'a/b', 'a.b', '-a', 'a'.repeat(81), 'a\nb'];
  for (const value of bad) {
    const ctx = setup();
    try {
      const env = { CLAUDE_CONFIG_DIR: ctx.root };
      if (value !== undefined) env[SESSION_ID_ENV] = value;
      await feed(JSON.stringify(DOC_EXAMPLES.Stop), env);
      assert.equal(fs.existsSync(path.join(ctx.root, 'session-observations')), false);
    } finally { ctx.cleanup(); }
  }
  const ctx = setup();
  try {
    await feed(JSON.stringify(DOC_EXAMPLES.Stop), { [SESSION_ID_ENV]: 'session-a' });
    await feed(JSON.stringify(DOC_EXAMPLES.Stop), { CLAUDE_CONFIG_DIR: 'relative/dir', [SESSION_ID_ENV]: 'session-a' });
    assert.equal(fs.existsSync(path.join(process.cwd(), 'relative')), false);
  } finally { ctx.cleanup(); }
});

test('input that never ends is abandoned after the time limit', async () => {
  const ctx = setup();
  try {
    const stdin = new PassThrough();
    stdin.write('{"session_id":"abc123",');
    const started = Date.now();
    await runHookBridge({ stdin, env: ctx.env, timeoutMs: 100 });
    assert.ok(Date.now() - started < 2000);
    assert.equal(fs.existsSync(ctx.file), false);
  } finally { ctx.cleanup(); }
});

test('a symlinked observation folder is never written through', { skip: process.platform === 'win32' }, async () => {
  const ctx = setup();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hook-elsewhere-'));
  try {
    fs.symlinkSync(elsewhere, path.join(ctx.root, 'session-observations'));
    await feed(JSON.stringify(DOC_EXAMPLES.Stop), ctx.env);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
  } finally { ctx.cleanup(); fs.rmSync(elsewhere, { recursive: true, force: true }); }
});

test('a symlink planted at the record name is replaced, not followed', { skip: process.platform === 'win32' }, async () => {
  const ctx = setup();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hook-target-'));
  try {
    const target = path.join(elsewhere, 'victim.txt');
    fs.writeFileSync(target, 'keep');
    fs.mkdirSync(path.dirname(ctx.file), { recursive: true });
    fs.symlinkSync(target, ctx.file);
    await feed(JSON.stringify(DOC_EXAMPLES.Stop), ctx.env);
    assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
    assert.equal(fs.lstatSync(ctx.file).isSymbolicLink(), false);
  } finally { ctx.cleanup(); fs.rmSync(elsewhere, { recursive: true, force: true }); }
});

function runChild(input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    // A hung child is a defect: it is always killed.
    const killer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('hook bridge child hung')); }, 10_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(killer); reject(error); });
    child.on('close', (code) => { clearTimeout(killer); resolve({ code, stdout, stderr }); });
    child.stdin.on('error', () => { /* the child may exit before reading everything */ });
    child.stdin.end(input);
  });
}

test('the real script prints nothing and exits 0 for a documented event, empty, malformed and huge input', async () => {
  for (const input of [JSON.stringify(DOC_EXAMPLES.UserPromptSubmit), '', 'not json', JSON.stringify({ session_id: 'abc123', hook_event_name: 'Stop', pad: 'x'.repeat(3 * 1024 * 1024) }), '\u0000'.repeat(1000)]) {
    const ctx = setup();
    try {
      const result = await runChild(input, ctx.env);
      assert.equal(result.code, 0);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
    } finally { ctx.cleanup(); }
  }
});

test('the real script exits 0 even when it cannot write at all', async () => {
  const ctx = setup();
  try {
    fs.writeFileSync(path.join(ctx.root, 'session-observations'), 'a file where a folder should be');
    const result = await runChild(JSON.stringify(DOC_EXAMPLES.Stop), ctx.env);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  } finally { ctx.cleanup(); }
});

test('the real script writes the record for a managed session', async () => {
  const ctx = setup();
  try {
    const result = await runChild(JSON.stringify(DOC_EXAMPLES.Notification), ctx.env);
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(fs.readFileSync(ctx.file, 'utf8')).hook.hookEventName, 'Notification');
  } finally { ctx.cleanup(); }
});

test('the permission mode is kept only when it is one Claude Code documents (#362)', async () => {
  for (const [mode, kept] of [['auto', 'auto'], ['bypassPermissions', 'bypassPermissions'], ['plan', 'plan'], ['Auto', undefined], ['auto; rm -rf /', undefined], [7, undefined], [undefined, undefined], ['__proto__', undefined]]) {
    const ctx = setup();
    try {
      await feed(JSON.stringify({ session_id: 'abc123', hook_event_name: 'Stop', ...(mode === undefined ? {} : { permission_mode: mode }) }), ctx.env);
      const record = JSON.parse(fs.readFileSync(ctx.file, 'utf8'));
      assert.deepEqual(record.hook, { hookEventName: 'Stop', ...(kept ? { permissionMode: kept } : {}) }, String(mode));
    } finally { ctx.cleanup(); }
  }
});
