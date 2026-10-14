#!/usr/bin/env node
'use strict';

// Reproducible check for P0 account isolation. For each profile it validates the
// config directory, reports inherited credential overrides, asks the CLI itself
// who is logged in, and flags profiles that resolve to the same real account.
//
//   node scripts/p0/check-account-isolation.js --repo <path> \
//     --profile claude=<configDir> --profile claude=<configDir> \
//     --profile codex=<configDir> --profile codex=<configDir>
//
// The report is redacted: no emails, org names, tokens or directory paths. Exit
// code 0 means every profile is ready, 1 means at least one problem, 2 is usage.

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const { PROVIDERS, validateProfile, findConfigDirConflicts, buildLaunchEnv } =
  require('../../src/accounts/profile');
const observation = require('../../src/accounts/observation');
const { reportEntry, profileReadiness, fleetReadiness } = require('../../src/accounts/readiness');

const TIMEOUT_MS = 20000;
const shell = process.platform === 'win32'; // .cmd shims; arguments below are constants

function parseArgs(argv) {
  const options = { repo: process.cwd(), profiles: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--repo') {
      options.repo = path.resolve(argv[++i] || '');
    } else if (argv[i] === '--profile') {
      const [provider, ...rest] = String(argv[++i] || '').split('=');
      options.profiles.push({ provider, configDir: rest.join('=') });
    } else {
      return null;
    }
  }
  const bad = options.profiles.some((p) => !Object.hasOwn(PROVIDERS, p.provider) || !p.configDir);
  return options.profiles.length === 0 || bad ? null : options;
}

function cliVersion(command) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: TIMEOUT_MS, shell });
  return result.status === 0 ? result.stdout.trim().split('\n')[0] : null;
}

function claudeStatus(env) {
  const result = spawnSync('claude', ['auth', 'status', '--json'], {
    env, encoding: 'utf8', timeout: TIMEOUT_MS, shell
  });
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

// Minimal newline-delimited JSON-RPC client for `codex app-server --stdio`.
function codexAppServer(env) {
  return new Promise((resolve) => {
    const child = spawn('codex', ['app-server', '--stdio'], { env, shell, stdio: ['pipe', 'pipe', 'ignore'] });
    const pending = new Map();
    let nextId = 1;
    let buffer = '';
    const done = (value) => { child.kill(); resolve(value); };
    const timer = setTimeout(() => done(null), TIMEOUT_MS);
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          if (pending.has(message.id)) pending.get(message.id)(message);
        } catch { /* ignore non-JSON output */ }
      }
    });
    const call = (method, params) => new Promise((ok) => {
      const id = nextId++;
      pending.set(id, ok);
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    (async () => {
      const init = await call('initialize', { clientInfo: { name: 'multiagent-p0-check', version: '0.0.0' } });
      child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
      const account = await call('account/read', { refreshToken: false });
      const limits = await call('account/rateLimits/read', undefined);
      clearTimeout(timer);
      done({ init: init.result, account: account.result, limits: limits.result || null });
    })().catch(() => done(null));
  });
}

async function inspect(profile, env, observedAt) {
  if (profile.provider === 'claude') {
    const status = claudeStatus(env);
    if (!status) return { identity: null, quota: [] };
    return { identity: observation.claudeIdentityFromAuthStatus(status, { profile, observedAt }), quota: [] };
  }
  const reply = await codexAppServer(env);
  if (!reply || !reply.account) return { identity: null, quota: [] };
  const identity = observation.codexIdentityFromAccountRead(reply.account, {
    profile, observedAt, codexHome: reply.init && reply.init.codexHome
  });
  const quota = reply.limits
    ? observation.codexQuotaFromRateLimits(reply.limits, { profileId: profile.id, observedAt }).observations
    : [];
  return { identity, quota };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    console.error('usage: check-account-isolation.js [--repo <path>] --profile <claude|codex>=<configDir> [...]');
    return 2;
  }

  const counters = {};
  const profiles = options.profiles.map((entry) => {
    counters[entry.provider] = (counters[entry.provider] || 0) + 1;
    return {
      id: `${entry.provider}#${counters[entry.provider]}`,
      provider: entry.provider,
      label: `${entry.provider} ${counters[entry.provider]}`,
      configDir: entry.configDir
    };
  });
  const context = { repoRoot: options.repo };
  const observedAt = new Date().toISOString();
  const conflicts = findConfigDirConflicts(profiles, context);
  const identities = [];
  const report = [];

  for (const profile of profiles) {
    const validation = validateProfile(profile, context);
    const { env, blockers } = buildLaunchEnv(profile, process.env);
    const result = validation.ok
      ? await inspect(profile, env, observedAt)
      : { identity: null, quota: [] };
    if (result.identity) identities.push(result.identity);
    const entry = reportEntry(profile.id, { validation, blockers, identity: result.identity });
    const readiness = profileReadiness(entry);
    report.push({
      ...entry,
      ready: readiness.ready,
      readyReasons: readiness.reasons,
      quota: result.quota.map((q) => ({
        field: q.field, value: q.value, unit: q.unit, confidence: q.confidence, reason: q.reason || null
      }))
    });
  }

  const groups = observation.groupBySubject(identities);
  const fleet = fleetReadiness(report, { conflicts, duplicates: groups.duplicates });
  const ready = fleet.ready;

  console.log(JSON.stringify({
    observedAt,
    platform: process.platform,
    cliVersions: {
      claude: report.some((r) => r.id.startsWith('claude')) ? cliVersion('claude') : undefined,
      codex: report.some((r) => r.id.startsWith('codex')) ? cliVersion('codex') : undefined
    },
    profiles: report,
    dirConflicts: conflicts,
    duplicateAccounts: groups.duplicates,
    ready,
    readyReasons: fleet.reasons
  }, null, 2));
  return ready ? 0 : 1;
}

main().then((code) => { process.exitCode = code; });
