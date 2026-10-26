'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Synthetic CLIs for the end-to-end run (#361): `claude`, `codex`, `agy` and `gh`, first on PATH. They never reach a network or a real
 * account. Each records how it was called (one JSON line per call in `calls.jsonl`), so a step can prove what the extension asked
 * for, and answers the few questions the extension asks with fixed, obviously fake data (e-mail addresses end in `example.test`).
 *
 * - `claude auth login` / `codex login` finish at once, as after a sign-in in the browser.
 * - `claude auth status` answers for the account folder it was started with: `owner-b@example.test` for a folder whose name has
 *   "work-b" in it, `owner-a@example.test` for any other, so two accounts are two different real accounts.
 * - `codex app-server` answers `initialize` with the CODEX_HOME it was started with and `account/read` with a ChatGPT sign-in,
 *   `codex-owner@example.test` on the Plus plan, then keeps running until it is stopped, like the real server.
 * - `claude` started as an agent does what Claude Code does with a status line (with a synthetic session cost, so the usage log has
 *   a reading of each agent, #359): it runs the `statusLine` command of its account's
 *   settings.json with a status line input on stdin (5-hour 32 %, weekly 10 %, weekly Opus 5 %), so the bridge the extension set
 *   up writes the usage reading the account row shows; then it runs the Stop hooks with a hook input (permission mode auto), so
 *   the hook bridge reports the agent as waiting.
 */

const CODEX_EMAIL = 'codex-owner@example.test';
const ACCOUNT = Object.freeze({ email: 'owner-a@example.test', orgName: 'Example Org', orgId: 'org-example', subscriptionType: 'max' });

function script(name, calls) {
  // One small Node program per CLI, run by the Node that runs the tests (never the person's own).
  return `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const configDir = process.env.CLAUDE_CONFIG_DIR || process.env.CODEX_HOME || null;
// The IDE port it was given (#354), never anything else of its environment.
const idePort = /^[0-9]{1,5}$/.test(process.env.CLAUDE_CODE_SSE_PORT || '') ? Number(process.env.CLAUDE_CODE_SSE_PORT) : null;
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ cli: ${JSON.stringify(name)}, args, configDir, idePort }) + '\\n');
const has = (...words) => words.every((word) => args.includes(word));
const email = configDir && /work-b/i.test(path.basename(configDir)) ? 'owner-b@example.test' : ${JSON.stringify(ACCOUNT.email)};
if (has('--version')) { process.stdout.write(${JSON.stringify(name)} + ' 0.0.0-synthetic\\n'); process.exit(0); }
if (${JSON.stringify(name)} === 'claude' && has('auth', 'login')) { process.stdout.write('Signed in (synthetic).\\n'); process.exit(0); }
if (${JSON.stringify(name)} === 'codex' && has('login')) { process.stdout.write('Signed in (synthetic).\\n'); process.exit(0); }
if (${JSON.stringify(name)} === 'claude' && has('auth', 'status')) {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email, orgId: ${JSON.stringify(ACCOUNT.orgId)}, orgName: ${JSON.stringify(ACCOUNT.orgName)}, subscriptionType: ${JSON.stringify(ACCOUNT.subscriptionType)}, configDirectory: configDir }));
  process.exit(0);
}
if (${JSON.stringify(name)} === 'codex' && has('app-server')) {
  let buffered = '';
  process.stdin.on('data', (chunk) => {
    buffered += chunk;
    let end;
    while ((end = buffered.indexOf('\\n')) >= 0) {
      const message = JSON.parse(buffered.slice(0, end));
      buffered = buffered.slice(end + 1);
      if (message.method === 'initialize') process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: 'synthetic', codexHome: configDir } }) + '\\n');
      if (message.method === 'account/read') process.stdout.write(JSON.stringify({ id: message.id, result: { account: { type: 'chatgpt', email: ${JSON.stringify(CODEX_EMAIL)}, planType: 'plus' }, requiresOpenaiAuth: true } }) + '\\n');
    }
  });
  setInterval(() => {}, 1 << 30);
  return;
}
if (${JSON.stringify(name)} === 'gh' && has('auth', 'status')) { process.stdout.write('github.example.test\\n  Logged in to github.example.test account synthetic-owner\\n'); process.exit(0); }
// An agent session: like Claude Code, run the account's status line command with a status line input, then wait.
if (${JSON.stringify(name)} === 'claude' && configDir) {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8'));
    const command = settings && settings.statusLine && settings.statusLine.command;
    if (typeof command === 'string') {
      const now = Math.floor(Date.now() / 1000);
      const input = { session_id: 'synthetic-' + process.pid, model: { id: 'claude-sonnet-4-5', display_name: 'Sonnet' }, rate_limits: { five_hour: { used_percentage: 32, resets_at: now + 2 * 3600 + 120 }, seven_day: { used_percentage: 10, resets_at: now + 3 * 86400 }, seven_day_opus: { used_percentage: 5, resets_at: now + 3 * 86400 } }, cost: { total_cost_usd: ((process.pid % 9) + 1) / 100 } };
      spawnSync('/bin/sh', ['-c', command], { input: JSON.stringify(input), env: process.env, timeout: 10000 });
    }
    // Like Claude Code at the end of a turn: run the account's Stop hooks with the hook input, so the agent shows as waiting.
    const stops = settings && settings.hooks && Array.isArray(settings.hooks.Stop) ? settings.hooks.Stop : [];
    for (const group of stops) for (const hook of (group && Array.isArray(group.hooks) ? group.hooks : [])) {
      if (hook && hook.type === 'command' && typeof hook.command === 'string') spawnSync('/bin/sh', ['-c', hook.command], { input: JSON.stringify({ session_id: 'synthetic-' + process.pid, hook_event_name: 'Stop', permission_mode: 'auto', cwd: process.cwd() }), env: process.env, timeout: 10000 });
    }
  } catch { /* no settings: nothing to report */ }
}
process.stdout.write('synthetic ' + ${JSON.stringify(name)} + ' ready\\n');
// Like an agent asked from the Ask tab (#357): a typed line that names a file to write the answer to gets a short Markdown answer there.
if (${JSON.stringify(name)} === 'claude') {
  let pending = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    pending += chunk;
    const match = /Write your answer in Markdown to the file «([^»]+)»/.exec(pending);
    if (!match) return;
    pending = '';
    try { fs.writeFileSync(match[1], '## What it does\\n\\n\\x60add\\x60 returns the sum of its two arguments.\\n\\n- It is called by the unit tests.\\n- See [the notes](https://example.test/notes) for more.\\n'); } catch { /* the answer could not be written */ }
  });
}
setInterval(() => {}, 1 << 30);
`;
}

/** Writes the synthetic CLIs into `bin` and returns where each records its calls. */
function writeFakeClis(bin) {
  fs.mkdirSync(bin, { recursive: true });
  const calls = path.join(bin, 'calls.jsonl');
  fs.writeFileSync(calls, '');
  for (const name of ['claude', 'codex', 'agy', 'gh']) fs.writeFileSync(path.join(bin, name), script(name, calls), { mode: 0o755 });
  return { calls, account: ACCOUNT };
}

/** The calls recorded so far, oldest first. */
function readCalls(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; }
}

module.exports = { writeFakeClis, readCalls, ACCOUNT, CODEX_EMAIL };
