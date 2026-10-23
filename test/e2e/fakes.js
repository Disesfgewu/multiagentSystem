'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Synthetic CLIs for the end-to-end run (#361): `claude`, `codex`, `agy` and `gh`, first on PATH. They never reach a network or a real
 * account. Each records how it was called (one JSON line per call in `calls.jsonl`), so a step can prove what the extension asked
 * for, and answers the few questions the extension asks with fixed, obviously fake data (e-mail addresses end in `example.test`).
 */

const ACCOUNT = Object.freeze({ email: 'owner-a@example.test', orgName: 'Example Org', orgId: 'org-example', subscriptionType: 'max' });

function script(name, calls) {
  // One small Node program per CLI, run by the Node that runs the tests (never the person's own).
  return `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ cli: ${JSON.stringify(name)}, args, configDir: process.env.CLAUDE_CONFIG_DIR || process.env.CODEX_HOME || null }) + '\\n');
const has = (...words) => words.every((word) => args.includes(word));
if (has('--version')) { process.stdout.write(${JSON.stringify(name)} + ' 0.0.0-synthetic\\n'); process.exit(0); }
if (${JSON.stringify(name)} === 'claude' && has('auth', 'status')) {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: ${JSON.stringify(ACCOUNT.email)}, orgId: ${JSON.stringify(ACCOUNT.orgId)}, orgName: ${JSON.stringify(ACCOUNT.orgName)}, subscriptionType: ${JSON.stringify(ACCOUNT.subscriptionType)}, configDirectory: process.env.CLAUDE_CONFIG_DIR || null }));
  process.exit(0);
}
if (${JSON.stringify(name)} === 'gh' && has('auth', 'status')) { process.stdout.write('github.example.test\\n  Logged in to github.example.test account synthetic-owner\\n'); process.exit(0); }
// Anything else: an agent session. It waits (like an interactive CLI) until its terminal is closed.
process.stdout.write('synthetic ' + ${JSON.stringify(name)} + ' ready\\n');
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

module.exports = { writeFakeClis, readCalls, ACCOUNT };
