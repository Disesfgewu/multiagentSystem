'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { powershellPath } = require('../../src/isolation/windows');

/**
 * Issue #289 prototype (test code: not shipped, not used by any launch path). It runs a program inside an AppContainer
 * (`appcontainer-launch.ps1`) and makes the system changes needed to let that program reach exactly one local port, the
 * filtering proxy, and nothing else on the network:
 *   - an AppContainer profile (no administrator rights needed);
 *   - read access for the container on the folders the programs it runs live in, and on the folders it may use;
 *   - a loopback exemption for the container, which needs administrator rights;
 *   - firewall rules for the container's package SID that block every port but the proxy's, which need administrator rights;
 *   - the firewall turned on for a profile where it was off, which needs administrator rights.
 *
 * Every change is written to a ledger file BEFORE it is made, so closing the session, a step that failed halfway, or a run
 * that died (the next run reads the ledger) all undo the same list. Undoing is checked: `close` reports what is still there.
 * The steps that need administrator rights are refused unless the caller passed explicit consent.
 */

const win32 = path.win32;
const SCRIPT = path.join(__dirname, 'appcontainer-launch.ps1');
const NAME = /^mas-proto-[0-9a-f]{16}$/;
const CONTAINER_SID = /^S-1-15-2(-[0-9]{1,10}){7}$/;
const CAPABILITY_SID = /^S-1-15-3-[0-9]{1,10}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const FIREWALL_PROFILES = Object.freeze(['Domain', 'Private', 'Public']);

/** What each step that needs administrator rights does, in the words shown to the person before they agree. */
const ELEVATED_STEPS = Object.freeze({
  loopback: 'Let the isolated program reach 127.0.0.1 at all (CheckNetIsolation LoopbackExempt -a -p=<container SID>). Removed when the session ends.',
  firewall: 'Add Windows Firewall rules, for the isolated program only, that block every port except the filtering proxy\'s (New-NetFirewallRule -Package <container SID>). Removed when the session ends.',
  'firewall-profile': 'Turn Windows Firewall on for a network profile where it is off, because rules do nothing while it is off (Set-NetFirewallProfile -Enabled True). Turned back off when the session ends.',
  acl: 'Give the isolated program read access to the folders of the programs it runs when they live where only administrators can change access (icacls /grant). Removed when the session ends.'
});

const refuse = (reason, extra = {}) => ({ ok: false, reason, ...extra });
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const newName = () => `mas-proto-${randomBytes(8).toString('hex')}`;

/** The request the launcher reads, checked here first so the script only ever receives well-formed data. */
function requestFor(action, fields = {}) {
  if (!isPlain(fields) || typeof fields.name !== 'string' || !NAME.test(fields.name)) return refuse('name-invalid');
  if (action === 'create' || action === 'delete') return { ok: true, encoded: Buffer.from(JSON.stringify({ action, name: fields.name }), 'utf8').toString('base64') };
  if (action !== 'run') return refuse('action-invalid');
  const { exe, args = [], cwd = '', env = [], stdin = '', timeoutMs = 15000, capabilities = [] } = fields;
  if (typeof exe !== 'string' || !win32.isAbsolute(exe) || exe.length > 520 || CONTROL.test(exe)) return refuse('program-invalid');
  if (!Array.isArray(args) || args.length > 64 || args.some((arg) => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\u0000'))) return refuse('argument-invalid');
  if (typeof cwd !== 'string' || (cwd !== '' && (!win32.isAbsolute(cwd) || CONTROL.test(cwd)))) return refuse('cwd-invalid');
  if (!Array.isArray(env) || env.length > 256 || env.some((pair) => typeof pair !== 'string' || pair.indexOf('=') < 1 || pair.includes('\u0000'))) return refuse('environment-invalid');
  if (typeof stdin !== 'string' || stdin.length > 65536) return refuse('stdin-invalid');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) return refuse('timeout-invalid');
  if (!Array.isArray(capabilities) || capabilities.length > 8 || capabilities.some((sid) => typeof sid !== 'string' || !CAPABILITY_SID.test(sid))) return refuse('capability-invalid');
  const json = JSON.stringify({ action, name: fields.name, exe, args, cwd, env, stdin, timeoutMs, capabilities });
  return { ok: true, encoded: Buffer.from(json, 'utf8').toString('base64') };
}

/** Reads the launcher's one line of JSON for `action`. Anything else is an error. */
function parseReply(action, stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length !== 1) return refuse('reply-invalid');
  let reply;
  try { reply = JSON.parse(lines[0]); } catch { return refuse('reply-invalid'); }
  if (!isPlain(reply)) return refuse('reply-invalid');
  if (reply.ok === false) return refuse(typeof reply.reason === 'string' && /^[a-z0-9-]{1,64}$/.test(reply.reason) ? reply.reason : 'launch-failed');
  if (reply.ok !== true) return refuse('reply-invalid');
  if (action === 'create') return typeof reply.sid === 'string' && CONTAINER_SID.test(reply.sid) ? { ok: true, sid: reply.sid } : refuse('reply-invalid');
  if (action === 'delete') return { ok: true };
  if (!Number.isSafeInteger(reply.exitCode) || typeof reply.timedOut !== 'boolean' || typeof reply.output !== 'string') return refuse('reply-invalid');
  return { ok: true, exitCode: reply.exitCode, timedOut: reply.timedOut, output: Buffer.from(reply.output, 'base64').toString('utf8') };
}

function runTool(file, args, { timeoutMs = 60000, run = execFile } = {}) {
  return new Promise((resolve) => {
    try {
      const child = run(file, args, { windowsHide: true, shell: false, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => resolve({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
      if (child && child.stdin) child.stdin.end();
    } catch { resolve({ ok: false, stdout: '', stderr: 'could not start' }); }
  });
}

function callLauncher(action, fields, { powershell, script = SCRIPT, run = execFile } = {}) {
  const made = requestFor(action, fields);
  if (!made.ok) return Promise.resolve(made);
  if (typeof powershell !== 'string' || !win32.isAbsolute(powershell)) return Promise.resolve(refuse('powershell-unavailable'));
  const timeoutMs = (action === 'run' ? fields.timeoutMs ?? 15000 : 0) + 60000;
  return runTool(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Request', made.encoded], { timeoutMs, run }).then((result) => parseReply(action, result.stdout));
}

// ---- the ledger: every system change, written before it is made ----------------------------------------------------

const ENTRY_CHECK = {
  profile: (entry) => NAME.test(entry.name ?? ''),
  acl: (entry) => typeof entry.path === 'string' && win32.isAbsolute(entry.path) && !CONTROL.test(entry.path) && CONTAINER_SID.test(entry.sid ?? ''),
  loopback: (entry) => CONTAINER_SID.test(entry.sid ?? ''),
  firewall: (entry) => NAME.test(entry.group ?? ''),
  'firewall-profile': (entry) => FIREWALL_PROFILES.includes(entry.profile)
};

/** Reads a ledger file strictly. A ledger that cannot be read is reported, never treated as "nothing to undo". */
function readLedger(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) { return error && error.code === 'ENOENT' ? { ok: true, entries: [] } : refuse('ledger-unreadable'); }
  let entries;
  try { entries = JSON.parse(text); } catch { return refuse('ledger-invalid'); }
  if (!Array.isArray(entries) || entries.some((entry) => !isPlain(entry) || !Object.hasOwn(ENTRY_CHECK, entry.kind) || !ENTRY_CHECK[entry.kind](entry))) return refuse('ledger-invalid');
  return { ok: true, entries };
}

function writeLedger(file, entries) {
  const temporary = `${file}.${process.pid}.tmp`;
  const handle = fs.openSync(temporary, 'w');
  try { fs.writeSync(handle, JSON.stringify(entries)); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
  fs.renameSync(temporary, file);
}

/**
 * The commands that make, undo and look for each kind of change. `tools.run(file, args)` runs a program; in tests it is
 * replaced so the bookkeeping can be checked on any platform.
 */
function systemTools({ systemRoot, powershell, run = runTool }) {
  const sys = (...parts) => win32.join(systemRoot, 'System32', ...parts);
  const icacls = sys('icacls.exe');
  const checkNetIsolation = sys('CheckNetIsolation.exe');
  const ps = (command) => run(powershell, ['-NoProfile', '-NonInteractive', '-Command', command]);
  return {
    grant: (entry) => run(icacls, [entry.path, '/grant', `*${entry.sid}:(OI)(CI)RX`]),
    grantWrite: (entry) => run(icacls, [entry.path, '/grant', `*${entry.sid}:(OI)(CI)M`]),
    ungrant: (entry) => run(icacls, [entry.path, '/remove:g', `*${entry.sid}`]),
    aclMentions: async (entry) => { const seen = await run(icacls, [entry.path]); return seen.ok ? seen.stdout.toUpperCase().includes(entry.sid.toUpperCase()) : null; },
    exempt: (entry) => run(checkNetIsolation, ['LoopbackExempt', '-a', `-p=${entry.sid}`]),
    unexempt: (entry) => run(checkNetIsolation, ['LoopbackExempt', '-d', `-p=${entry.sid}`]),
    exempted: async (entry) => { const seen = await run(checkNetIsolation, ['LoopbackExempt', '-s']); return seen.ok ? seen.stdout.toUpperCase().includes(entry.sid.toUpperCase()) : null; },
    // Every value placed in these commands was checked above: a fixed group name, a container SID and port numbers.
    addRules: (entry) => ps(firewallCommand(entry)),
    removeRules: (entry) => ps(`Remove-NetFirewallRule -Group '${entry.group}' -ErrorAction SilentlyContinue; exit 0`),
    rulesLeft: async (entry) => { const seen = await ps(`@(Get-NetFirewallRule -Group '${entry.group}' -ErrorAction SilentlyContinue).Count`); return seen.ok ? Number(seen.stdout.trim()) !== 0 : null; },
    profileEnabled: async (profile) => { const seen = await ps(`(Get-NetFirewallProfile -Name '${profile}').Enabled`); return seen.ok ? /true/i.test(seen.stdout) : null; },
    enableProfile: (entry) => ps(`Set-NetFirewallProfile -Name '${entry.profile}' -Enabled True`),
    restoreProfile: (entry) => ps(`Set-NetFirewallProfile -Name '${entry.profile}' -Enabled False`),
    profileLeft: async (entry) => { const seen = await ps(`(Get-NetFirewallProfile -Name '${entry.profile}').Enabled`); return seen.ok ? /true/i.test(seen.stdout) : null; },
    deleteProfile: (entry) => callLauncher('delete', { name: entry.name }, { powershell }).then((reply) => ({ ok: reply.ok || reply.reason === 'profile-delete-failed-2' || reply.reason === 'profile-delete-failed-1168', stdout: '', stderr: reply.reason ?? '' })),
    // The profile's mapping under the user's registry hive is what deleting it removes.
    profileExists: async (entry) => {
      const seen = await run(sys('reg.exe'), ['query', 'HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppContainer\\Mappings', '/s', '/f', entry.name, '/d']);
      // reg exits 1 both for "no match" and for a real error: only its own count (or a missing key) is an answer.
      const said = `${seen.stdout}\n${seen.stderr}`;
      const count = /End of search:\s*(\d+)\s*match/i.exec(said);
      if (count) return Number(count[1]) > 0;
      return /unable to find the specified registry key/i.test(said) ? false : null;
    }
  };
}

/** Ports to block for "everything but `allowed`", as Windows Firewall ranges. */
function blockedRanges(allowed) {
  if (!Number.isInteger(allowed) || allowed < 1 || allowed > 65535) return null;
  const ranges = [];
  if (allowed > 1) ranges.push(allowed === 2 ? '1' : `1-${allowed - 1}`);
  if (allowed < 65535) ranges.push(allowed === 65534 ? '65535' : `${allowed + 1}-65535`);
  return ranges;
}

function firewallCommand(entry) {
  const ranges = blockedRanges(entry.port);
  if (!ranges || !NAME.test(entry.group) || !CONTAINER_SID.test(entry.sid)) throw new Error('firewall rule input invalid');
  const common = `-Group '${entry.group}' -Direction Outbound -Action Block -Package '${entry.sid}' -Profile Any -ErrorAction Stop`;
  return [
    `New-NetFirewallRule -DisplayName '${entry.group} tcp other ports' ${common} -Protocol TCP -RemotePort ${ranges.join(',')} | Out-Null`,
    // The proxy's port, but on any address other than 127.0.0.1.
    `New-NetFirewallRule -DisplayName '${entry.group} tcp proxy port elsewhere' ${common} -Protocol TCP -RemotePort ${entry.port} -RemoteAddress '0.0.0.0-127.0.0.0','127.0.0.2-255.255.255.255','::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff' | Out-Null`,
    `New-NetFirewallRule -DisplayName '${entry.group} udp' ${common} -Protocol UDP | Out-Null`,
    'exit 0'
  ].join('; ');
}

const UNDO = { profile: 'deleteProfile', acl: 'ungrant', loopback: 'unexempt', firewall: 'removeRules', 'firewall-profile': 'restoreProfile' };
const STILL_THERE = { profile: 'profileExists', acl: 'aclMentions', loopback: 'exempted', firewall: 'rulesLeft', 'firewall-profile': 'profileLeft' };

/** Undoes every entry in reverse order, then looks for each one: what is still there (or could not be checked) is returned. */
async function undoAll(entries, tools) {
  const failures = [];
  for (const entry of [...entries].reverse()) {
    const done = await tools[UNDO[entry.kind]](entry);
    if (!done || done.ok !== true) failures.push({ entry, step: 'undo' });
  }
  const leftovers = [];
  for (const entry of entries) {
    const there = await tools[STILL_THERE[entry.kind]](entry);
    if (there !== false) leftovers.push({ ...entry, state: there === true ? 'still-there' : 'could-not-check' });
  }
  return { failures, leftovers };
}

/** Undoes what a run that died left in its ledger. A ledger that cannot be read is an error: nothing is assumed clean. */
async function recoverLedger(file, tools) {
  const read = readLedger(file);
  if (!read.ok) return read;
  const result = await undoAll(read.entries, tools);
  if (result.leftovers.length === 0) fs.rmSync(file, { force: true });
  return { ok: result.leftovers.length === 0, ...result };
}

/**
 * One isolated session. Nothing is changed until a step is asked for; each step is recorded first.
 * `tools` and `launcher` stand in for the system in tests, so the bookkeeping can be checked on any platform.
 * @param {{ ledgerFile: string, consent?: { elevated?: boolean }, systemRoot?: string, powershell?: string, tools?: object, launcher?: Function, name?: string }} options
 */
function createSession({ ledgerFile, consent = {}, systemRoot = process.env.SystemRoot, powershell = powershellPath(), tools, launcher = callLauncher, name = newName() } = {}) {
  if (typeof ledgerFile !== 'string' || !path.isAbsolute(ledgerFile)) throw new Error('ledgerFile must be an absolute path');
  const tool = tools ?? systemTools({ systemRoot, powershell });
  const entries = [];
  let sid = null;
  let closed = false;
  const elevatedAllowed = isPlain(consent) && consent.elevated === true;

  async function record(entry, make) {
    if (closed) return refuse('session-closed');
    entries.push(entry);
    writeLedger(ledgerFile, entries);
    let made;
    try { made = await make(); } catch { made = { ok: false }; }
    return made && made.ok === true ? { ok: true } : refuse(`${entry.kind}-failed`, { said: String(made?.stderr || made?.stdout || '').trim().slice(0, 200) });
  }
  const needsConsent = (step) => (elevatedAllowed ? null : refuse('consent-required', { step, text: ELEVATED_STEPS[step] }));

  return {
    name,
    sid: () => sid,
    entries: () => entries.map((entry) => ({ ...entry })),
    async createProfile() {
      if (sid) return { ok: true, sid };
      const made = await record({ kind: 'profile', name }, async () => {
        const reply = await launcher('create', { name }, { powershell });
        if (reply.ok) sid = reply.sid;
        return reply.ok ? { ok: true } : { ok: false, stderr: reply.reason };
      });
      return made.ok ? { ok: true, sid } : made;
    },
    /** Read (and, with `write`, change) access for the container on one folder. `elevated` when only administrators can change it. */
    async grant(folder, { write = false, elevated = false } = {}) {
      if (!sid) return refuse('no-profile');
      if (elevated) { const refused = needsConsent('acl'); if (refused) return refused; }
      if (typeof folder !== 'string' || !win32.isAbsolute(folder) || CONTROL.test(folder)) return refuse('path-invalid');
      const entry = { kind: 'acl', path: folder, sid };
      return record(entry, () => (write ? tool.grantWrite(entry) : tool.grant(entry)));
    },
    async exemptLoopback() {
      const refused = needsConsent('loopback'); if (refused) return refused;
      if (!sid) return refuse('no-profile');
      return record({ kind: 'loopback', sid }, () => tool.exempt({ sid }));
    },
    /** Firewall rules that leave the container only `port` on 127.0.0.1 (TCP). */
    async allowOnlyPort(port) {
      const refused = needsConsent('firewall'); if (refused) return refused;
      if (!sid) return refuse('no-profile');
      if (!blockedRanges(port)) return refuse('port-invalid');
      return record({ kind: 'firewall', group: name, sid, port }, () => tool.addRules({ group: name, sid, port }));
    },
    /** Turns the firewall on for every profile where it is off; the ones that were already on are not touched or recorded. */
    async enableFirewall() {
      const refused = needsConsent('firewall-profile'); if (refused) return refused;
      const changed = [];
      for (const profile of FIREWALL_PROFILES) {
        const on = await tool.profileEnabled(profile);
        if (on === null) return refuse('firewall-state-unknown', { profile });
        if (on) continue;
        const made = await record({ kind: 'firewall-profile', profile }, () => tool.enableProfile({ profile }));
        if (!made.ok) return made;
        changed.push(profile);
      }
      return { ok: true, changed };
    },
    run(request, options = {}) {
      if (!sid) return Promise.resolve(refuse('no-profile'));
      return launcher('run', { ...request, name, capabilities: request.capabilities ?? [] }, { powershell, ...options });
    },
    /** Undoes everything this session recorded and checks it is gone. The ledger is removed only when nothing is left. */
    async close() {
      if (closed) return { ok: true, failures: [], leftovers: [] };
      closed = true;
      const result = await undoAll(entries, tool);
      if (result.leftovers.length === 0) fs.rmSync(ledgerFile, { force: true });
      return { ok: result.leftovers.length === 0, ...result };
    }
  };
}

module.exports = { SCRIPT, ELEVATED_STEPS, requestFor, parseReply, callLauncher, readLedger, recoverLedger, undoAll, systemTools, blockedRanges, firewallCommand, createSession, newName };
