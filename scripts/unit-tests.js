'use strict';

/**
 * Runs the unit tests, then checks that they left no process behind (#382). A test that starts a process (a synthetic CLI, a
 * detached process group, an app-server fixture) must stop it; one that does not leaves it running after the tests, and on CI the
 * runner then waits for it until the job is cancelled.
 *
 * Every test process loads scripts/track-children.js (through NODE_OPTIONS), which records each child it starts and whether that
 * child leads its own process group. After the tests, each recorded process, and each recorded group, that is still alive is one the
 * tests left: it is listed (process id and command line), stopped, and the run fails. Only what the tests themselves started is
 * looked at; no process is chosen by its name. On Windows the check is not made, and that is said.
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PATTERNS = ['test/**/*.test.js', 'out/test/unit/**/*.test.js'];

// Running and ours to look at: a process of another user (EPERM) is not one the tests left.
const alive = (target) => { try { process.kill(target, 0); return true; } catch { return false; } };

/** "[[dd-]hh:]mm:ss", as `ps -o etime` prints it, in seconds; null when it is not that. */
function elapsedSeconds(text) {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(String(text).trim());
  if (!match) return null;
  const [days, hours, minutes, seconds] = match.slice(1).map((part) => (part === undefined ? 0 : Number(part)));
  return minutes > 59 || seconds > 59 || hours > 23 ? null : ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}

/** Lines of `ps -A -o pid=,ppid=,pgid=,etime=` as pid → { ppid, pgid, startedMs }. `etime` counts whole seconds, so a process started at most a second before `startedMs`. */
function readProcesses(text, nowMs) {
  const rows = new Map();
  for (const line of String(text).split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    const elapsed = match ? elapsedSeconds(match[4]) : null;
    if (match && elapsed !== null) rows.set(Number(match[1]), { ppid: Number(match[2]), pgid: Number(match[3]), startedMs: nowMs - elapsed * 1000 });
  }
  return rows;
}

/**
 * What is still running, and whether it may be stopped. Looked at: each process the record lists, each group a detached child leads
 * (its grandchildren too), and each process still in the run's own group (`runGroup`), which catches a grandchild whose parent did not
 * load the tracker (a shell script, or a fixture started with a reduced environment).
 *
 * A process id can be given again to an unrelated process once the first one ended, so one is stopped (`stop`) only when all of this
 * is true: it started after the run did (with a second to spare for how `ps` counts), and it is in the run's group, or it is a
 * detached child the record lists that still leads its own group (pgid equal to its pid) and whose parent is a recorded process or
 * gone (ppid 1). A group is stopped only when every process in it started after the run. When any of this is not so, or cannot be
 * read, the process is listed and the run fails, but nothing is stopped.
 */
function leftovers(recordText, { processes = new Map(), runGroup = null, runStartMs = Infinity, isAlive = alive } = {}) {
  const seen = new Map();
  for (const line of String(recordText).split('\n')) {
    const match = /^(\d+) ([01])$/.exec(line.trim());
    if (!match) continue;
    const pid = Number(match[1]);
    seen.set(pid, (seen.get(pid) ?? false) || match[2] === '1');
  }
  const after = (row) => Boolean(row) && row.startedMs - 1000 >= runStartMs;
  const members = (group) => [...processes].filter(([, row]) => row.pgid === group);
  const left = [];
  for (const [pid, leader] of seen) {
    if (isAlive(pid)) {
      const row = processes.get(pid);
      let why = null;
      if (!row) why = 'it is not in the process list';
      else if (!after(row)) why = 'it started before this run (its id may have been given to another process)';
      else if (row.pgid === runGroup) why = null;
      else if (!leader || row.pgid !== pid) why = "it is not in this run's process group";
      else if (row.ppid !== 1 && !seen.has(row.ppid)) why = 'its parent is not one the tests started';
      else if (!members(pid).every(([, member]) => after(member))) why = 'its group has a process that started before this run';
      left.push({ pid, group: false, leader: why === null && row.pgid === pid, stop: why === null, why });
    } else if (leader && isAlive(-pid)) {
      const group = members(pid);
      const why = group.length === 0 ? 'its group is not in the process list' : group.every(([, member]) => after(member)) ? null : 'its group has a process that started before this run';
      left.push({ pid, group: true, leader: true, stop: why === null, why });
    }
  }
  if (Number.isSafeInteger(runGroup)) {
    for (const [pid, row] of members(runGroup)) {
      if (pid === runGroup || left.some((entry) => entry.pid === pid) || !isAlive(pid)) continue;
      const why = after(row) ? null : 'it started before this run (its id may have been given to another process)';
      left.push({ pid, group: false, leader: false, stop: why === null, why });
    }
  }
  return left;
}

function commandOf(pid) {
  const shown = spawnSync('ps', ['-ww', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
  return shown.status === 0 && shown.stdout.trim() ? shown.stdout.trim().slice(0, 300) : '(only its process group is left)';
}

const ARGS = ['--test', '--test-force-exit', '--test-timeout=120000', ...PATTERNS];

/** Runs `node <args>` and checks what it left running; resolves to the exit code this script ends with. */
async function runAndCheck(args) {
  if (process.platform === 'win32') {
    const run = spawnSync(process.execPath, args, { stdio: 'inherit' });
    console.log('unit tests: the check for processes left behind is not made on Windows (#382).');
    return run.status === 0 ? 0 : 1;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-unit-children-'));
  const record = path.join(dir, 'children.txt');
  fs.writeFileSync(record, '');
  const tracker = path.join(__dirname, 'track-children.js');
  const env = { ...process.env, MULTIAGENT_UNIT_CHILDREN: record, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${JSON.stringify(tracker)}`.trim() };
  const runStartMs = Date.now();
  // The run leads a process group of its own, so what it leaves behind can be found by that group, not by a name. That group is not
  // the terminal's, so Ctrl-C (and a stop sent to this script) is passed on to it; the check below still runs afterwards.
  const run = spawn(process.execPath, args, { stdio: 'inherit', env, detached: true });
  const forward = (signal) => { try { process.kill(-run.pid, signal); } catch { /* the run has ended */ } };
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);
  const status = await new Promise((resolve) => { run.on('error', () => resolve(1)); run.on('exit', (code) => resolve(code)); });
  process.off('SIGINT', forward);
  process.off('SIGTERM', forward);
  let failed = status !== 0;
  const look = () => leftovers(fs.readFileSync(record, 'utf8'), {
    processes: readProcesses(spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,etime='], { encoding: 'utf8' }).stdout ?? '', Date.now()),
    runGroup: run.pid, runStartMs
  });
  // A process stopped at the very end may still be exiting: look again a moment later before calling it left behind.
  let left = look();
  if (left.length > 0) { await new Promise((resolve) => setTimeout(resolve, 2000)); left = look(); }
  const started = new Set(fs.readFileSync(record, 'utf8').split('\n').filter(Boolean).map((line) => line.split(' ')[0])).size;
  if (left.length > 0) {
    failed = true;
    console.error(`unit tests: ${left.length} of the ${started} processes the tests started are still running (#382):`);
    for (const entry of left) console.error(`  ${entry.pid}${entry.group ? ' (its process group)' : ''}: ${commandOf(entry.pid)}${entry.stop ? '' : ` — not stopped: ${entry.why}`}`);
    // Ours, by the record, the run's group and the start time: stopped, so CI does not wait for them.
    for (const entry of left.filter((item) => item.stop)) {
      for (const target of entry.group ? [-entry.pid] : entry.leader ? [entry.pid, -entry.pid] : [entry.pid]) { try { process.kill(target, 'SIGKILL'); } catch { /* gone */ } }
    }
  } else {
    console.log(`unit tests: none of the ${started} processes the tests started is left running.`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return failed ? 1 : 0;
}

if (require.main === module) void runAndCheck(ARGS).then((code) => process.exit(code));

module.exports = { alive, leftovers, readProcesses, elapsedSeconds, runAndCheck };
