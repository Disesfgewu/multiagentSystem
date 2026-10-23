'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { execFile } = require('node:child_process');
const proto = require('./appcontainer-prototype');
const { createWindowsModule } = require('./windows-harness');
const { CHANNELS, collectProbes, assessIsolation, describeAssessment, decideLaunch } = require('../../src/isolation/capabilities');
const { runRestricted, environmentPairs } = require('../../src/isolation/windows');

// The Windows part changes the system (a firewall rule, a loopback exemption): it runs only where that was asked for, in
// the prototype's own CI workflow, never in an ordinary test run on someone's machine.
const prototypeRun = process.platform === 'win32' && process.env.MAS_ISOLATION_PROTOTYPE === '1';
const onlyPrototype = prototypeRun ? {} : { skip: 'needs native Windows and MAS_ISOLATION_PROTOTYPE=1 (it changes firewall and network-isolation settings)' };
const NAME = 'mas-proto-0123456789abcdef';
const SID = 'S-1-15-2-1-2-3-4-5-6-7';
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mas-ac-'));

test('a launcher request is checked first: only the prototype\'s own profile names, a well-formed program and capability SIDs', () => {
  const good = { name: NAME, exe: 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'echo hi'], env: ['A=1'], timeoutMs: 5000 };
  const decoded = (made) => JSON.parse(Buffer.from(made.encoded, 'base64').toString('utf8'));
  assert.deepEqual(decoded(proto.requestFor('run', good)), { action: 'run', name: NAME, exe: good.exe, args: good.args, cwd: '', env: good.env, stdin: '', timeoutMs: 5000, capabilities: [] });
  assert.deepEqual(decoded(proto.requestFor('create', { name: NAME })), { action: 'create', name: NAME });
  for (const name of ['mas-proto-0123', 'MAS-PROTO-0123456789ABCDEF', 'other-0123456789abcdef', 'mas-proto-0123456789abcdef ', '', undefined, 5]) {
    for (const action of ['create', 'delete', 'run']) assert.equal(proto.requestFor(action, { ...good, name }).reason, 'name-invalid', `${action} ${name}`);
  }
  assert.equal(proto.requestFor('exec', good).reason, 'action-invalid');
  const bad = (over, reason) => assert.equal(proto.requestFor('run', { ...good, ...over }).reason, reason, JSON.stringify(over).slice(0, 60));
  for (const exe of ['cmd.exe', '', undefined, 'C:\\a\u0001.exe']) bad({ exe }, 'program-invalid');
  for (const args of ['x', [5], ['a\u0000']]) bad({ args }, 'argument-invalid');
  for (const env of [['NOEQUALS'], ['=x'], [5], 'A=1']) bad({ env }, 'environment-invalid');
  for (const timeoutMs of [0, 120001, 1.5]) bad({ timeoutMs }, 'timeout-invalid');
  for (const capabilities of [['S-1-5-32-544'], ['S-1-15-3-1; calc'], 'S-1-15-3-1', [1]]) bad({ capabilities }, 'capability-invalid');
  assert.equal(proto.requestFor('run', { ...good, capabilities: ['S-1-15-3-1'] }).ok, true);
});

test('the launcher\'s reply is read strictly; anything that is not its one line of JSON is an error', () => {
  const output = Buffer.from('hi', 'utf8').toString('base64');
  assert.deepEqual(proto.parseReply('run', JSON.stringify({ ok: true, exitCode: 0, timedOut: false, output })), { ok: true, exitCode: 0, timedOut: false, output: 'hi' });
  assert.deepEqual(proto.parseReply('create', JSON.stringify({ ok: true, sid: SID })), { ok: true, sid: SID });
  assert.equal(proto.parseReply('create', JSON.stringify({ ok: true, sid: 'S-1-5-32-544' })).ok, false, 'only a container SID is a profile');
  assert.deepEqual(proto.parseReply('delete', JSON.stringify({ ok: false, reason: 'profile-delete-failed-5' })), { ok: false, reason: 'profile-delete-failed-5' });
  assert.equal(proto.parseReply('run', JSON.stringify({ ok: false, reason: 'Not A Code' })).reason, 'launch-failed');
  for (const text of ['', 'x', '[]', JSON.stringify({ ok: true }), `${JSON.stringify({ ok: true, exitCode: 0, timedOut: false, output })}\nmore`, JSON.stringify({ ok: 'true', sid: SID })]) {
    assert.equal(proto.parseReply('run', text).ok, false, text);
  }
});

test('the firewall rules block every port but the proxy\'s, and the proxy\'s port everywhere but 127.0.0.1', () => {
  assert.deepEqual(proto.blockedRanges(50000), ['1-49999', '50001-65535']);
  assert.deepEqual(proto.blockedRanges(1), ['2-65535']);
  assert.deepEqual(proto.blockedRanges(2), ['1', '3-65535']);
  assert.deepEqual(proto.blockedRanges(65534), ['1-65533', '65535']);
  assert.deepEqual(proto.blockedRanges(65535), ['1-65534']);
  for (const port of [0, 65536, 1.5, '80', undefined]) assert.equal(proto.blockedRanges(port), null, String(port));
  const command = proto.firewallCommand({ group: NAME, sid: SID, port: 50000 });
  assert.match(command, /-RemotePort 1-49999,50001-65535/);
  assert.match(command, /-RemotePort 50000 -RemoteAddress '0\.0\.0\.0-127\.0\.0\.0','127\.0\.0\.2-255\.255\.255\.255'/);
  assert.match(command, /-Protocol UDP/);
  assert.equal((command.match(/-Package 'S-1-15-2-1-2-3-4-5-6-7'/g) ?? []).length, 3, 'every rule is for the container only');
  assert.equal((command.match(/-Action Block/g) ?? []).length, 3, 'nothing is allowed by a rule: the proxy port is what is left over');
  for (const bad of [{ group: 'x', sid: SID, port: 1 }, { group: NAME, sid: 'S-1-5-18', port: 1 }, { group: NAME, sid: SID, port: 0 }, { group: `${NAME}'; calc`, sid: SID, port: 1 }]) {
    assert.throws(() => proto.firewallCommand(bad), /invalid/, JSON.stringify(bad));
  }
});

/** A stand-in for the system: a set of changes that exist, and a log of what was done in which order. */
function fakeSystem({ failing = [], undoFailing = [], unknown = [] } = {}) {
  const present = new Set();
  const log = [];
  const key = (entry) => `${entry.kind ?? ''}:${entry.name ?? entry.path ?? entry.group ?? entry.profile ?? entry.sid}`;
  const change = (kind, verb) => async (entry) => {
    const id = key({ kind, ...entry });
    log.push(`${verb} ${id}`);
    if (verb === 'make' && failing.includes(kind)) return { ok: false, stderr: 'refused' };
    if (verb === 'undo' && undoFailing.includes(kind)) return { ok: false };
    if (verb === 'make') present.add(id); else present.delete(id);
    return { ok: true };
  };
  const there = (kind) => async (entry) => (unknown.includes(kind) ? null : present.has(key({ kind, ...entry })));
  const profilesOff = new Set(['Public']);
  return {
    present, log, profilesOff,
    tools: {
      grant: change('acl', 'make'), grantWrite: change('acl', 'make'), ungrant: change('acl', 'undo'), aclMentions: there('acl'),
      exempt: change('loopback', 'make'), unexempt: change('loopback', 'undo'), exempted: there('loopback'),
      addRules: change('firewall', 'make'), removeRules: change('firewall', 'undo'), rulesLeft: there('firewall'),
      profileEnabled: async (profile) => !profilesOff.has(profile) || present.has(`firewall-profile:${profile}`),
      enableProfile: change('firewall-profile', 'make'), restoreProfile: change('firewall-profile', 'undo'), profileLeft: there('firewall-profile'),
      deleteProfile: change('profile', 'undo'), profileExists: there('profile')
    }
  };
}

/** A session on the fake system: its launcher makes the profile there. */
function fakeSession(system, options = {}) {
  const ledgerFile = path.join(scratch(), 'ledger.json');
  const launcher = async (action) => {
    if (action !== 'create') return { ok: false, reason: 'not-in-this-test' };
    system.log.push(`make profile:${NAME}`);
    system.present.add(`profile:${NAME}`);
    return { ok: true, sid: SID };
  };
  const session = proto.createSession({ ledgerFile, tools: system.tools, launcher, name: NAME, powershell: 'C:\\none.exe', ...options });
  return { session, ledgerFile };
}

test('without consent, every step that needs administrator rights is refused before anything is recorded or changed', async () => {
  const system = fakeSystem();
  const { session, ledgerFile } = fakeSession(system);
  for (const [step, call] of [['loopback', () => session.exemptLoopback()], ['firewall', () => session.allowOnlyPort(50000)], ['firewall-profile', () => session.enableFirewall()]]) {
    const refused = await call();
    assert.equal(refused.reason, 'consent-required', step);
    assert.equal(refused.step, step);
    assert.equal(refused.text, proto.ELEVATED_STEPS[step], 'the person is shown what the step does');
  }
  assert.equal(fs.existsSync(ledgerFile), false, 'nothing was recorded');
  assert.deepEqual(system.log, [], 'nothing was changed');
  assert.equal((await session.run({ exe: 'C:\\a.exe' })).reason, 'no-profile', 'nothing runs before the profile exists');
  // Consent must be exactly `elevated: true`.
  for (const consent of [{ elevated: 'yes' }, { elevated: 1 }, [], null, 'all']) {
    const other = fakeSession(fakeSystem(), { consent });
    assert.equal((await other.session.exemptLoopback()).reason, 'consent-required', JSON.stringify(consent));
  }
  for (const step of ['loopback', 'firewall', 'firewall-profile', 'acl']) assert.match(proto.ELEVATED_STEPS[step], /Removed|back off/, `${step} says it is undone`);
});

test('each change is written to the ledger before it is made; closing undoes them in reverse order and checks each is gone', async () => {
  const system = fakeSystem();
  let ledgerWhenMade = null;
  const exempt = system.tools.exempt;
  system.tools.exempt = async (entry) => { ledgerWhenMade = JSON.parse(fs.readFileSync(ledgerFile, 'utf8')); return exempt(entry); };
  const { session, ledgerFile } = fakeSession(system, { consent: { elevated: true } });
  assert.equal((await session.createProfile()).ok, true);
  assert.equal((await session.grant('C:\\tools\\node')).ok, true);
  assert.equal((await session.exemptLoopback()).ok, true);
  assert.deepEqual(ledgerWhenMade.map((entry) => entry.kind), ['profile', 'acl', 'loopback'], 'the exemption was on the ledger before it was made');
  assert.equal((await session.allowOnlyPort(50000)).ok, true);
  assert.deepEqual(await session.enableFirewall(), { ok: true, changed: ['Public'] }, 'only the profile that was off is turned on and recorded');
  assert.deepEqual(JSON.parse(fs.readFileSync(ledgerFile, 'utf8')).map((entry) => entry.kind), ['profile', 'acl', 'loopback', 'firewall', 'firewall-profile']);
  const closed = await session.close();
  assert.deepEqual(closed, { ok: true, failures: [], leftovers: [] });
  assert.deepEqual(system.log.filter((line) => line.startsWith('undo')), [
    'undo firewall-profile:Public', `undo firewall:${NAME}`, `undo loopback:${SID}`, 'undo acl:C:\\tools\\node', `undo profile:${NAME}`
  ], 'undone newest first');
  assert.equal(system.present.size, 0);
  assert.equal(fs.existsSync(ledgerFile), false, 'a clean close removes the ledger');
  assert.equal((await session.exemptLoopback()).reason, 'session-closed', 'a closed session changes nothing more');
});

test('a step that fails halfway is still undone, and what could not be removed or checked is reported and keeps the ledger', async () => {
  const system = fakeSystem({ failing: ['firewall'] });
  const { session, ledgerFile } = fakeSession(system, { consent: { elevated: true } });
  assert.equal((await session.createProfile()).ok, true);
  await session.exemptLoopback();
  const failed = await session.allowOnlyPort(50000);
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'firewall-failed');
  const closed = await session.close();
  assert.equal(closed.ok, true, 'the failed step was recorded, so it is undone (and checked) too');
  assert.ok(system.log.includes(`undo firewall:${NAME}`));

  const stuck = fakeSystem({ undoFailing: ['loopback'], unknown: ['acl'] });
  const second = fakeSession(stuck, { consent: { elevated: true } });
  assert.equal((await second.session.createProfile()).ok, true);
  await second.session.grant('C:\\tools\\node');
  await second.session.exemptLoopback();
  const report = await second.session.close();
  assert.equal(report.ok, false);
  assert.deepEqual(report.failures.map((failure) => failure.entry.kind), ['loopback']);
  assert.deepEqual(report.leftovers.map((left) => `${left.kind}:${left.state}`), ['acl:could-not-check', 'loopback:still-there'], 'a check that could not answer is never "gone"');
  assert.equal(fs.existsSync(second.ledgerFile), true, 'the ledger stays so a later run can finish the job');
  assert.equal(fs.existsSync(ledgerFile), false);
});

test('a run that died leaves its ledger, and the next run undoes it; a ledger that cannot be read is an error, never "clean"', async () => {
  const system = fakeSystem();
  const { session, ledgerFile } = fakeSession(system, { consent: { elevated: true } });
  assert.equal((await session.createProfile()).ok, true);
  await session.exemptLoopback();
  await session.allowOnlyPort(50000);
  // The process ends here without closing.
  assert.equal(system.present.size, 3);
  const recovered = await proto.recoverLedger(ledgerFile, system.tools);
  assert.equal(recovered.ok, true);
  assert.equal(system.present.size, 0);
  assert.equal(fs.existsSync(ledgerFile), false);
  assert.deepEqual(await proto.recoverLedger(ledgerFile, system.tools), { ok: true, failures: [], leftovers: [] }, 'no ledger: nothing to undo');
  const dir = scratch();
  for (const [text, reason] of [['not json', 'ledger-invalid'], ['{}', 'ledger-invalid'], [JSON.stringify([{ kind: 'shell', command: 'x' }]), 'ledger-invalid'], [JSON.stringify([{ kind: 'profile', name: 'someone-else' }]), 'ledger-invalid'], [JSON.stringify([{ kind: 'acl', path: 'relative', sid: SID }]), 'ledger-invalid'], [JSON.stringify([{ kind: 'firewall', group: "x'; calc" }]), 'ledger-invalid']]) {
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, text);
    assert.equal((await proto.recoverLedger(file, system.tools)).reason, reason, text);
    assert.equal(fs.existsSync(file), true, 'an unreadable ledger is kept');
  }
  const folder = path.join(dir, 'a-folder');
  fs.mkdirSync(folder);
  assert.equal(proto.readLedger(folder).reason, 'ledger-unreadable');
});

test('the launcher script runs nothing through a shell, downloads nothing, and only touches its own profile names', () => {
  const text = fs.readFileSync(proto.SCRIPT, 'utf8');
  for (const needed of [/PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES/, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/, /CreateAppContainerProfile/, /\^mas-proto-\[0-9a-f\]\{16\}\$/, /profile-exists/]) assert.match(text, needed, String(needed));
  for (const forbidden of [/Invoke-Expression/i, /\biex\b/i, /Invoke-WebRequest/i, /DownloadString|DownloadFile|WebClient/i, /Start-Process/i, /cmd\.exe/i, /-EncodedCommand/i]) assert.doesNotMatch(text, forbidden, String(forbidden));
  const reasons = [...text.matchAll(/Fail\("([^"]+)"/g)].map((match) => match[1]);
  for (const reason of reasons) assert.match(reason, /^[a-z0-9-]+$/, reason);
});

// ---- on Windows, in the prototype workflow only -----------------------------------------------------------------------

const run = (file, args, options = {}) => new Promise((resolve) => {
  execFile(file, args, { windowsHide: true, timeout: 60000, maxBuffer: 4 << 20, encoding: 'utf8', ...options }, (error, stdout, stderr) => resolve({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
});
const listen = (host) => new Promise((resolve, reject) => {
  let count = 0;
  const server = net.createServer((socket) => { count += 1; socket.on('error', () => {}); socket.destroy(); });
  server.once('error', reject);
  server.listen(0, host, () => resolve({ port: server.address().port, count: () => count, close: () => new Promise((done) => server.close(() => done())) }));
});
const ps = (command) => run(path.win32.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', command]);

// What a program inside can reach and do: every answer is what it saw, printed as one JSON object.
const INSIDE_PROBE = `
const net=require('net'),cp=require('child_process'),fs=require('fs'),dns=require('dns');
const [targets,cmd,userOnly,shared]=[JSON.parse(process.argv[1]),process.argv[2],process.argv[3],process.argv[4]];
const out={};
const connect=(t)=>new Promise((r)=>{const s=net.connect({host:t.host,port:t.port});let done=false;const end=(v)=>{if(done)return;done=true;s.destroy();r(v)};s.on('connect',()=>end('connected'));s.on('error',(e)=>end(e.code||'error'));setTimeout(()=>end('timeout'),5000)});
(async()=>{
  for(const t of targets) out[t.label]=await connect(t);
  out.dns=await new Promise((r)=>dns.lookup('github.com',(e)=>r(e?e.code:'resolved')));
  let s=cp.spawnSync(cmd,['/d','/c','echo ok'],{encoding:'utf8'}); out.spawnPipes=s.error?s.error.code:s.status;
  s=cp.spawnSync(cmd,['/d','/c','echo ok'],{stdio:'ignore'}); out.spawnNoPipes=s.error?s.error.code:s.status;
  try{fs.readFileSync(userOnly);out.userOnlyRead='read'}catch(e){out.userOnlyRead=e.code}
  try{fs.writeFileSync(shared,'x');out.sharedWrite='ok'}catch(e){out.sharedWrite=e.code}
  const name='\\\\\\\\.\\\\pipe\\\\mas-ac-'+process.pid;
  await new Promise((r)=>{const server=net.createServer((c)=>c.end('hi'));server.on('error',(e)=>{out.namedPipeServer=e.code;r()});server.listen(name,()=>{out.namedPipeServer='ok';const c=net.connect(name);c.on('data',()=>{out.namedPipeClient='ok'});c.on('error',(e)=>{out.namedPipeClient=e.code;server.close(()=>r())});c.on('close',()=>server.close(()=>r()))})});
  process.stdout.write(JSON.stringify(out));
})();`;

test('on Windows (prototype run): what an AppContainer program can reach with each added step, and the system is clean afterwards', onlyPrototype, async () => {
  const dir = fs.realpathSync.native(scratch());
  const ledgerFile = path.join(dir, 'ledger.json');
  const session = proto.createSession({ ledgerFile, consent: { elevated: true } });
  const servers = {};
  try {
    for (const line of (await ps('Get-NetFirewallProfile | ForEach-Object { "$($_.Name)=$($_.Enabled)" }')).stdout.split(/\r?\n/).filter(Boolean)) console.log(`appcontainer: firewall profile ${line.trim()}`);
    const made = await session.createProfile();
    assert.equal(made.ok, true, JSON.stringify(made));
    const sid = made.sid;
    assert.equal((await session.grant(path.dirname(process.execPath))).ok, true, 'the container can read node');
    const shared = path.join(dir, 'shared');
    fs.mkdirSync(shared);
    assert.equal((await session.grant(shared, { write: true })).ok, true);
    const userOnly = path.join(dir, 'user-only.txt');
    fs.writeFileSync(userOnly, 'synthetic\n');
    const nic = Object.values(os.networkInterfaces()).flat().find((address) => address && address.family === 'IPv4' && !address.internal);
    servers.proxy = await listen('127.0.0.1');
    servers.other = await listen('127.0.0.1');
    if (nic) servers.nic = await listen(nic.address);
    const targets = [{ label: 'proxyPort', host: '127.0.0.1', port: servers.proxy.port }, { label: 'otherLoopbackPort', host: '127.0.0.1', port: servers.other.port }, ...(nic ? [{ label: 'ownNicAddress', host: nic.address, port: servers.nic.port }] : []), { label: 'githubCom443', host: 'github.com', port: 443 }];
    const cmd = path.win32.join(process.env.SystemRoot, 'System32', 'cmd.exe');
    const args = ['-e', INSIDE_PROBE, JSON.stringify(targets), cmd, userOnly, path.join(shared, 'written.txt')];
    const env = environmentPairs({ ...process.env, TEMP: shared, TMP: shared });
    const report = async (label, reply) => {
      const counts = Object.fromEntries(Object.entries(servers).map(([key, server]) => [key, server.count()]));
      const seen = reply.ok ? (reply.output.trim().slice(-600) || `exit ${reply.exitCode}`) : `launch failed (${reply.reason})`;
      console.log(`appcontainer: ${label}: ${seen} | connections seen by the stand-ins ${JSON.stringify(counts)}`);
      return reply.ok ? (() => { try { return JSON.parse(reply.output.trim()); } catch { return null; } })() : null;
    };
    const control = await report('control (no isolation)', await new Promise((resolve) => execFile(process.execPath, args, { encoding: 'utf8', timeout: 60000 }, (error, stdout) => resolve({ ok: true, exitCode: error ? 1 : 0, output: String(stdout) }))));
    assert.equal(control?.proxyPort, 'connected', 'the control reaches the proxy port');
    const inside = (capabilities = []) => session.run({ exe: process.execPath, args, env, timeoutMs: 60000, capabilities });
    const results = {};
    results.plain = await report('AppContainer, no capabilities, no exemption', await inside());
    results.internet = await report('AppContainer with internetClient', await inside(['S-1-15-3-1']));
    assert.equal((await session.exemptLoopback()).ok, true);
    results.exempt = await report('AppContainer + loopback exemption', await inside());
    assert.equal((await session.allowOnlyPort(servers.proxy.port)).ok, true);
    results.rules = await report('AppContainer + loopback exemption + firewall rules', await inside());
    const enabled = await session.enableFirewall();
    assert.equal(enabled.ok, true, JSON.stringify(enabled));
    console.log(`appcontainer: firewall profiles turned on for this run: ${JSON.stringify(enabled.changed)}`);
    if (enabled.changed.length > 0) results.rulesOn = await report('AppContainer + loopback exemption + firewall rules, firewall on', await inside());
    assert.ok(results.plain, 'the AppContainer launch works at all');
    assert.notEqual(results.plain.githubCom443, 'connected', 'with no capabilities, the internet is closed');
    assert.notEqual(results.plain.userOnlyRead, 'read', 'a file that grants only the user is closed');
    console.log(`appcontainer: container SID ${sid.replace(/(-[0-9]+){5}$/, '-…')}`);
  } finally {
    for (const server of Object.values(servers)) await server.close();
    const closed = await session.close();
    console.log(`appcontainer: cleanup ${JSON.stringify({ ok: closed.ok, failures: closed.failures.map((failure) => failure.entry.kind), leftovers: closed.leftovers })}`);
    assert.equal(closed.ok, true, `left behind: ${JSON.stringify(closed.leftovers)}`);
  }
});

test('on Windows (prototype run): the named-pipe failure under a token with the user and Administrators deny-only, explained by the pipe\'s own access list', onlyPrototype, async () => {
  const script = path.resolve(__dirname, '..', '..', 'resources', 'isolation', 'restricted-launch.ps1');
  const pipe = `mas-np-${process.pid}-${Date.now()}`;
  const full = `\\\\.\\pipe\\${pipe}`;
  // Inside: make a pipe server, then open it read-only, read-write, and as a client socket; stay up so the access list can be read.
  const source = `const net=require('net'),fs=require('fs');const name=process.argv[1];const out={};const server=net.createServer((c)=>{c.on('error',()=>{});c.end()});server.on('error',(e)=>{out.server=e.code;done()});server.listen(name,()=>{out.server='ok';for(const [label,flag] of [['openRead','r'],['openReadWrite','r+']]){try{fs.closeSync(fs.openSync(name,flag));out[label]='ok'}catch(e){out[label]=e.code}}const c=net.connect(name);c.on('connect',()=>{out.connect='ok';c.destroy()});c.on('error',(e)=>{out.connect=e.code});setTimeout(done,9000)});function done(){process.stdout.write(JSON.stringify(out));process.exit(0)}`;
  const describe = (sddl) => String(sddl).trim().replace(/S-1-5-21-[0-9-]+/g, 'S-1-5-21-…');
  for (const [label, restriction] of [['unrestricted copy (control)', { denyUser: false, denyAdmins: false, dropPrivileges: false }], ['user deny-only', { denyUser: true, denyAdmins: false }], ['administrators deny-only', { denyUser: false, denyAdmins: true }], ['user and administrators deny-only', { denyUser: true, denyAdmins: true }], ['restricting SIDs', { denyUser: false, denyAdmins: false, restrictingSids: true }]]) {
    const name = `${full}-${label.replace(/[^a-z]+/g, '-')}`;
    const [reply, sddl] = await Promise.all([runRestricted({ exe: process.execPath, args: ['-e', source, name], env: environmentPairs(process.env), timeoutMs: 30000, restriction }, { script }), (async () => { await new Promise((resolve) => setTimeout(resolve, 4000)); return ps(`try { (Get-Acl -LiteralPath '${name}').Sddl } catch { 'error: ' + $_.Exception.Message }`); })()]);
    console.log(`named pipe: ${label}: inside ${reply.ok ? reply.output.trim() : `launch failed (${reply.reason})`} | access list ${describe(sddl.stdout || sddl.stderr)}`);
  }
  const own = await run(path.win32.join(process.env.SystemRoot, 'System32', 'whoami.exe'), ['/user', '/groups', '/fo', 'csv', '/nh']);
  console.log(`named pipe: the runner's own token has Administrators enabled: ${/S-1-5-32-544[^\n]*Enabled group/i.test(own.stdout)}`);
});

test('on Windows (prototype run): all nine channels tried inside the AppContainer with the proxy port the only way out', onlyPrototype, async () => {
  const dir = fs.realpathSync.native(scratch());
  const session = proto.createSession({ ledgerFile: path.join(dir, 'ledger.json'), consent: { elevated: true } });
  let module;
  try {
    const made = await session.createProfile();
    assert.equal(made.ok, true, JSON.stringify(made));
    for (const folder of [path.dirname(process.execPath)]) assert.equal((await session.grant(folder)).ok, true, folder);
    module = createWindowsModule({ runInside: (request) => session.run(request), openSids: [made.sid] });
    const { provider } = await module.endpoints();
    assert.equal(module.preparationError(), null, String(module.preparationError()));
    assert.equal((await session.exemptLoopback()).ok, true);
    assert.equal((await session.allowOnlyPort(provider)).ok, true);
    const enabled = await session.enableFirewall();
    assert.equal(enabled.ok, true, JSON.stringify(enabled));
    const { probes } = await collectProbes(module, { timeoutMs: 180000 });
    const assessment = assessIsolation({ platform: 'win32', probes });
    for (const line of describeAssessment(assessment)) console.log(`appcontainer channels: ${line}`);
    console.log(`appcontainer channels: probes ${JSON.stringify(Object.fromEntries(Object.entries(probes).map(([channel, probe]) => [channel, { control: probe.control, outcome: probe.outcome }])))}`);
    for (const channel of Object.keys(CHANNELS)) assert.ok(probes[channel] && typeof probes[channel].control === 'boolean', `${channel} was probed`);
    assert.equal(decideLaunch({ assessment, requested: 'enforced' }).allowed, false, 'terminal interaction is not tried here, so enforcement is still refused');
  } finally {
    if (module) await module.dispose();
    const closed = await session.close();
    console.log(`appcontainer channels: cleanup ${JSON.stringify({ ok: closed.ok, leftovers: closed.leftovers })}`);
    assert.equal(closed.ok, true, `left behind: ${JSON.stringify(closed.leftovers)}`);
  }
});

test('on Windows (prototype run): a run that died is undone from its ledger by the next one, with the real commands', onlyPrototype, async () => {
  const dir = fs.realpathSync.native(scratch());
  const ledgerFile = path.join(dir, 'ledger.json');
  const session = proto.createSession({ ledgerFile, consent: { elevated: true } });
  assert.equal((await session.createProfile()).ok, true);
  const folder = path.join(dir, 'granted');
  fs.mkdirSync(folder);
  assert.equal((await session.grant(folder)).ok, true);
  assert.equal((await session.exemptLoopback()).ok, true);
  assert.equal((await session.allowOnlyPort(50000)).ok, true);
  const failing = await session.grant(path.join(dir, 'does-not-exist'));
  assert.equal(failing.ok, false, 'a step that fails is reported');
  // The session is abandoned here, as if the process had died.
  const tools = proto.systemTools({ systemRoot: process.env.SystemRoot, powershell: require('../../src/isolation/windows').powershellPath() });
  const recovered = await proto.recoverLedger(ledgerFile, tools);
  console.log(`appcontainer recovery: ${JSON.stringify({ ok: recovered.ok, failures: recovered.failures?.map((failure) => failure.entry.kind), leftovers: recovered.leftovers })}`);
  assert.equal(recovered.ok, true, JSON.stringify(recovered.leftovers));
  assert.equal(fs.existsSync(ledgerFile), false);
});
