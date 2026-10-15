#!/usr/bin/env node
'use strict';

// Reproducible P0 experiment for role-scoped memory injection, using synthetic
// data only and a private directory outside the repository.
//
//   node scripts/p0/check-memory-injection.js [--repo <path>] [--live-claude [--model <alias>]]
//
// Codex is verified without any model call (`codex debug prompt-input`). Claude
// has no equivalent, so its live check is opt-in: it sends three tiny requests
// under the current login. Exit code 0 means every executed check passed.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { MemoryStore } = require('../../src/memory/store');
const { resolveRules } = require('../../src/memory/rules');
const { planInjection, writePlan, cleanupPlan } = require('../../src/memory/injection');
const { scanMemoryStorePublication } = require('../../src/memory/publish-check');
const { checkPrivateRoot } = require('../../src/memory/paths');

const TIMEOUT_MS = 90000;
const results = [];
const record = (name, pass, detail) => results.push({ name, status: pass ? 'pass' : 'fail', detail });
const skip = (name, detail) => results.push({ name, status: 'skipped', detail });

function parseArgs(argv) {
  const options = { repo: process.cwd(), live: false, model: 'haiku' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--repo') options.repo = path.resolve(argv[++i] || '');
    else if (argv[i] === '--live-claude') options.live = true;
    else if (argv[i] === '--model') options.model = argv[++i] || '';
    else return null;
  }
  return options.model ? options : null;
}

// Arguments are passed as an array. On Windows a `.cmd` shim needs a shell, so
// a failed direct start is retried through the shell with spaces quoted.
function run(command, args, { env, input } = {}) {
  const base = { encoding: 'utf8', timeout: TIMEOUT_MS, env: env || process.env, input };
  let result = spawnSync(command, args, base);
  if (result.error && process.platform === 'win32') {
    const quoted = args.map((arg) => (/[\s&]/.test(arg) ? `"${arg}"` : arg));
    result = spawnSync(command, quoted, { ...base, shell: true });
  }
  return result;
}

// `--help` output is not a reliable capability list (Claude Code documents that it
// omits flags), so each flag is probed instead: an unknown option is rejected by
// the argument parser before anything else runs, a known one fails later on the
// missing file or login. No credential variables are passed, so no request is sent.
const UNKNOWN_FLAG = /unknown option|unexpected argument|unrecognized (?:option|argument)/i;

function probeEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_|OPENAI_|CODEX_API)/i.test(key)) delete env[key];
  }
  return env;
}

function accepts(command, args, extraEnv) {
  const out = run(command, args, { env: probeEnv(extraEnv), input: '' });
  return !UNKNOWN_FLAG.test(`${out.stdout || ''}\n${out.stderr || ''}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    console.error('usage: check-memory-injection.js [--repo <path>] [--live-claude [--model <alias>]]');
    return 2;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multiagent-p0-memory-'));
  try {
    const privateDir = path.join(root, 'private');
    const codexHome = path.join(root, 'codex-home');
    fs.mkdirSync(codexHome);
    const placement = checkPrivateRoot(privateDir, options.repo);
    record('private directory is outside the repository', placement.ok, placement.problems);

    const marker = crypto.randomBytes(2).toString('hex');
    const words = { 'role-a': `ALPHA-${marker}`, 'role-b': `BRAVO-${marker}` };
    const store = new MemoryStore({ dir: path.join(privateDir, 'store'), repoRoot: options.repo });
    const scope = (roleGroupId) => ({ repoId: 'synthetic-repo', roleGroupId, privacyDomain: 'synthetic-domain' });

    for (const [roleGroupId, word] of Object.entries(words)) {
      const proposed = store.propose({
        ...scope(roleGroupId),
        content: `The secret codeword for this session is ${word}.`,
        source: { kind: 'task', ref: 'synthetic' }
      });
      store.adopt(proposed.id, { kind: 'rule', id: 'p0-experiment' });
    }

    const task = 'What is the secret codeword for this session?';
    const select = (roleGroupId) => store.select({ ...scope(roleGroupId), task });
    record('role A retrieves only its own memory',
      select('role-a').items.length === 1 && select('role-a').items[0].content.includes(words['role-a']), null);
    record('role B retrieves only its own memory',
      select('role-b').items.length === 1 && select('role-b').items[0].content.includes(words['role-b']), null);
    record('an unrelated role group retrieves nothing', select('role-c').items.length === 0, null);

    const rules = resolveRules([
      { id: 'platform-1', layer: 'platform', type: 'forbid', key: 'publish.private-data' }
    ]);
    const plans = {};
    const planFor = (provider, roleGroupId, capabilities) => planInjection({
      provider,
      roleGroup: { id: roleGroupId, name: roleGroupId },
      rules,
      memories: select(roleGroupId).items,
      privateDir,
      repoRoot: options.repo,
      codexHome,
      sessionToken: `${roleGroupId.replace(/[^A-Za-z0-9]/g, '')}${marker}${crypto.randomBytes(3).toString('hex')}`,
      capabilities
    });

    // ---- Codex: offline verification of the model-visible input ----
    const codexVersion = run('codex', ['--version']);
    if (codexVersion.status !== 0) {
      skip('codex prompt-input checks', 'codex CLI not available');
    } else {
      const caps = {
        profileFlag: accepts('codex', ['-p', 'mas-probe', 'debug', 'prompt-input', 'ping'], { CODEX_HOME: codexHome })
      };
      record('codex accepts -p <profile>', caps.profileFlag, codexVersion.stdout.trim());
      for (const roleGroupId of ['role-a', 'role-b']) {
        const plan = planFor('codex', roleGroupId, caps);
        plans[roleGroupId] = plan;
        writePlan(plan);
        record(`codex ${roleGroupId}: argv carries a profile name, not content`,
          plan.method === 'profile-developer-instructions' &&
          !plan.argv.join(' ').includes(words[roleGroupId]), plan.method);
        const out = run('codex', [...plan.argv, 'debug', 'prompt-input', 'ping'],
          { env: { ...process.env, CODEX_HOME: codexHome } });
        const text = out.stdout || '';
        const other = roleGroupId === 'role-a' ? 'role-b' : 'role-a';
        record(`codex ${roleGroupId}: own memory is in the model-visible input`,
          out.status === 0 && text.includes(words[roleGroupId]), `exit ${out.status}`);
        record(`codex ${roleGroupId}: the other role's memory is absent`,
          out.status === 0 && !text.includes(words[other]), null);
        cleanupPlan(plan);
      }
      const bare = run('codex', ['debug', 'prompt-input', 'ping'], { env: { ...process.env, CODEX_HOME: codexHome } });
      record('codex without a profile sees neither memory',
        bare.status === 0 && !bare.stdout.includes(words['role-a']) && !bare.stdout.includes(words['role-b']), null);
    }

    // ---- Claude: plan checks always, live check opt-in ----
    const claudeVersion = run('claude', ['--version']);
    if (claudeVersion.status !== 0) {
      skip('claude checks', 'claude CLI not available');
    } else {
      const probeDir = path.join(root, 'claude-probe');
      fs.mkdirSync(probeDir);
      const supported = accepts('claude',
        ['-p', '--append-system-prompt-file', path.join(root, 'missing.txt'), 'ping'],
        { CLAUDE_CONFIG_DIR: probeDir });
      record('claude accepts --append-system-prompt-file', supported, claudeVersion.stdout.trim());
      for (const roleGroupId of ['role-a', 'role-b']) {
        const plan = planFor('claude', roleGroupId, { appendSystemPromptFile: supported });
        plans[`claude-${roleGroupId}`] = plan;
        record(`claude ${roleGroupId}: argv carries a file path, not content`,
          !plan.argv.join(' ').includes(words[roleGroupId]), plan.method);
      }

      if (!options.live) {
        skip('claude live injection', 'pass --live-claude to send three small requests under the current login');
      } else {
        const question = 'What is the secret codeword for this session? Answer with only the codeword, ' +
          'or UNKNOWN if no codeword was given to you.';
        const ask = (extra) => {
          const out = run('claude', ['-p', '--model', options.model, '--max-turns', '1', '--tools', '',
            '--no-session-persistence', '--disable-slash-commands', ...extra], { input: question });
          return { status: out.status, text: (out.stdout || '').trim() };
        };
        const control = ask([]);
        record('claude live: control without injection does not know a codeword',
          control.status === 0 && !Object.values(words).some((w) => control.text.includes(w)), `exit ${control.status}`);
        for (const roleGroupId of ['role-a', 'role-b']) {
          const plan = plans[`claude-${roleGroupId}`];
          if (plan.method !== 'append-system-prompt-file') {
            skip(`claude live ${roleGroupId}`, 'flag not available; manual plan only');
            continue;
          }
          writePlan(plan);
          const answer = ask(plan.argv);
          const other = roleGroupId === 'role-a' ? 'role-b' : 'role-a';
          record(`claude live ${roleGroupId}: answers with its own codeword only`,
            answer.status === 0 && answer.text.includes(words[roleGroupId]) && !answer.text.includes(words[other]),
            `exit ${answer.status}`);
          cleanupPlan(plan);
        }
      }
    }

    // ---- Publish check ----
    const leaked = `## Notes\n\nthe secret codeword for this session is ${words['role-a']} -- as discussed.`;
    const leakResult = scanMemoryStorePublication(leaked, store);
    record('publish check can read the private memory store',
      !leakResult.findings.some((f) => f.code === 'private-memory-unavailable'), null);
    record('publish check flags a memory fragment in a PR body',
      leakResult.blocked && leakResult.findings.some((f) => f.code === 'memory-fragment'), null);
    const clean = scanMemoryStorePublication('Adds validation for configuration directories and covers it with tests.', store);
    record('publish check passes ordinary public text', !clean.blocked, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const failed = results.filter((r) => r.status === 'fail').length;
  console.log(JSON.stringify({
    observedAt: new Date().toISOString(),
    platform: process.platform,
    results,
    summary: {
      pass: results.filter((r) => r.status === 'pass').length,
      fail: failed,
      skipped: results.filter((r) => r.status === 'skipped').length
    }
  }, null, 2));
  return failed === 0 ? 0 : 1;
}

main().then((code) => { process.exitCode = code; });
