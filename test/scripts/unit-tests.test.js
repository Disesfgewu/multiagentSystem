'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { alive, leftovers, readProcesses, elapsedSeconds } = require('../../scripts/unit-tests');

const TRACKER = path.join(__dirname, '..', '..', 'scripts', 'track-children.js');

const RUN = 100;
const START = 1_000_000;
const later = START + 5000;
const before = START - 60_000;
// A process list: pid → [ppid, pgid, startedMs].
const list = (entries) => new Map(Object.entries(entries).map(([pid, [ppid, pgid, startedMs]]) => [Number(pid), { ppid, pgid, startedMs }]));
const look = (record, processes, isAlive = (target) => processes.has(Math.abs(target)) || [...processes.values()].some((row) => -target === row.pgid)) =>
  leftovers(record, { processes, runGroup: RUN, runStartMs: START, isAlive });

test('a recorded process in the run\'s group that started after the run is left behind and stopped; one that ended is not listed (#382)', () => {
  assert.deepEqual(look('10 0\n11 0\n', list({ 11: [RUN, RUN, later] })), [{ pid: 11, group: false, leader: false, stop: true, why: null }]);
});

test('a process id given again to a process that started before the run is listed, never stopped (#382)', () => {
  const [entry] = look('11 0\n', list({ 11: [RUN, RUN, before] }));
  assert.equal(entry.stop, false);
  assert.match(entry.why, /started before this run/);
  const [edge] = look('12 0\n', list({ 12: [RUN, RUN, START + 500] }));
  assert.equal(edge.stop, false, 'within the second ps cannot tell apart, it is not stopped');
});

test('a process of another user (EPERM) is not one the tests left (#382)', () => {
  assert.deepEqual(look('11 0\n', list({ 11: [RUN, RUN, later] }), () => false), []);
});

test('a recorded process outside the run\'s group is stopped only as a detached leader of its own group whose parent is ours or gone (#382)', () => {
  assert.equal(look('11 0\n', list({ 11: [RUN, 555, later] }))[0].stop, false, 'not detached, not in the run group');
  assert.deepEqual(look('20 1\n', list({ 20: [1, 20, later] })), [{ pid: 20, group: false, leader: true, stop: true, why: null }]);
  assert.equal(look('20 1\n30 0\n', list({ 20: [30, 20, later] }))[0].stop, true, 'its parent is a recorded process');
  const foreignParent = look('20 1\n', list({ 20: [777, 20, later] }))[0];
  assert.equal(foreignParent.stop, false);
  assert.match(foreignParent.why, /parent/);
  assert.equal(look('20 1\n', list({ 20: [1, 21, later] }))[0].stop, false, 'it no longer leads its own group');
  assert.equal(look('20 1\n', list({ 20: [1, 20, later], 22: [20, 20, before] }))[0].stop, false, 'its group holds an older process');
});

test('a detached child that ended is still left behind when its group runs on; the group is stopped only when all of it is newer than the run (#382)', () => {
  assert.deepEqual(look('20 1\n', list({ 23: [1, 20, later] })), [{ pid: 20, group: true, leader: true, stop: true, why: null }]);
  assert.equal(look('20 1\n', list({ 23: [1, 20, later], 24: [1, 20, before] }))[0].stop, false);
  assert.deepEqual(look('21 0\n', list({ 23: [1, 21, later] })), [], 'a child that is not detached leads no group of its own');
});

test('a process still in the run\'s group is left behind even when nothing recorded it; the run itself and other groups are not (#382)', () => {
  const processes = list({ [RUN]: [1, RUN, later], 101: [1, RUN, later], 102: [1, 555, later], 103: [1, RUN, before] });
  assert.deepEqual(look('', processes).map((entry) => [entry.pid, entry.stop]), [[101, true], [103, false]]);
  assert.deepEqual(leftovers('', { processes, runGroup: null, runStartMs: START, isAlive: () => true }), [], 'without the run\'s group only the record is looked at');
});

test('a recorded process not in the process list is listed, not stopped; lines that are not a record are ignored (#382)', () => {
  const [entry] = look('11 0\n', new Map(), () => true);
  assert.equal(entry.stop, false);
  assert.deepEqual(look('x 1\n12\n13 2\n', new Map(), () => true), []);
});

test('a process this user may not signal (EPERM) does not count as running; this one does (#382)', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  assert.equal(alive(1), false, 'pid 1 belongs to the system');
  assert.equal(alive(process.pid), true);
});

test('ps elapsed times and lines are read as ps prints them, and anything else is skipped (#382)', () => {
  assert.equal(elapsedSeconds('00:07'), 7);
  assert.equal(elapsedSeconds('12:07:52'), 12 * 3600 + 7 * 60 + 52);
  assert.equal(elapsedSeconds('03-12:07:52'), (3 * 24 + 12) * 3600 + 7 * 60 + 52);
  for (const bad of ['', '7', '1:60', 'aa:bb', '25:00:00']) assert.equal(elapsedSeconds(bad), null, bad);
  const rows = readProcesses('  336     1   336 01:00\n bad line\n  400   336   336 xx\n', 10_000_000);
  assert.deepEqual([...rows], [[336, { ppid: 1, pgid: 336, startedMs: 10_000_000 - 60_000 }]]);
});

test('Ctrl-C reaches the tests, which run in a group of their own: the run stops and the check still runs (#382)', { skip: process.platform === 'win32', timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-ctrlc-'));
  const pidFile = path.join(dir, 'pid');
  const slow = path.join(dir, 'slow.test.js');
  fs.writeFileSync(slow, `require('node:test')('slow', () => new Promise(() => { require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000); }));\n`);
  // This test runs inside node --test, which marks its children (NODE_TEST_CONTEXT); the runner here must start a run of its own.
  const withoutTestContext = { ...process.env };
  delete withoutTestContext.NODE_TEST_CONTEXT;
  const runner = spawn(process.execPath, ['-e', `require(${JSON.stringify(path.join(__dirname, '..', '..', 'scripts', 'unit-tests.js'))}).runAndCheck(['--test', ${JSON.stringify(slow)}]).then((code) => process.exit(code))`], { stdio: 'ignore', detached: true, env: withoutTestContext });
  let testPid = null;
  t.after(() => {
    for (const target of [-runner.pid, testPid]) { try { if (target) process.kill(target, 'SIGKILL'); } catch { /* gone */ } }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (let waited = 0; testPid === null && waited < 30000; waited += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8')) testPid = Number(fs.readFileSync(pidFile, 'utf8'));
  }
  assert.ok(testPid, 'the slow test started');
  const exited = new Promise((resolve) => runner.on('exit', (code) => resolve(code)));
  process.kill(runner.pid, 'SIGINT');
  const code = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve('still running'), 15000))]);
  assert.notEqual(code, 'still running', 'the runner ended after Ctrl-C');
  assert.notEqual(code, 0);
  let alive = true;
  try { process.kill(testPid, 0); } catch { alive = false; }
  assert.equal(alive, false, 'the tests did not go on in the background');
});

test('the tracker records each child, and util.promisify(execFile) still resolves to { stdout, stderr } (#382)', { skip: process.platform === 'win32' }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-tracker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const record = path.join(dir, 'children.txt');
  fs.writeFileSync(record, '');
  const source = "const cp = require('node:child_process'); const util = require('node:util');"
    + "util.promisify(cp.execFile)(process.execPath, ['-e', 'process.stdout.write(\"hi\")']).then(({ stdout }) => {"
    + "cp.spawn(process.execPath, ['-e', ''], { detached: true }).on('exit', () => process.stdout.write(stdout)); });";
  const run = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8', env: { ...process.env, MULTIAGENT_UNIT_CHILDREN: record, NODE_OPTIONS: `--require ${JSON.stringify(TRACKER)}` } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'hi');
  const lines = fs.readFileSync(record, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, lines.join('|'));
  assert.match(lines[0], /^\d+ 0$/);
  assert.match(lines[1], /^\d+ 1$/, 'the detached child is recorded as leading its own group');
});
