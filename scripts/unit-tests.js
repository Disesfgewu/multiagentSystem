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

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PATTERNS = ['test/**/*.test.js', 'out/test/unit/**/*.test.js'];

const alive = (target) => { try { process.kill(target, 0); return true; } catch (error) { return Boolean(error && error.code === 'EPERM'); } };

/**
 * What is still running: each process the record lists, each group a detached child leads (its grandchildren too), and each
 * process still in the run's own group (`runGroup`, from `psText`: lines of "pid pgid"), which catches a grandchild whose parent
 * did not load the tracker (a shell script, or a fixture started with a reduced environment).
 */
function leftovers(recordText, isAlive = alive, runGroup = null, psText = '') {
  const seen = new Map();
  for (const line of String(recordText).split('\n')) {
    const match = /^(\d+) ([01])$/.exec(line.trim());
    if (!match) continue;
    const pid = Number(match[1]);
    seen.set(pid, (seen.get(pid) ?? false) || match[2] === '1');
  }
  const left = [];
  for (const [pid, leader] of seen) {
    if (isAlive(pid)) left.push({ pid, group: false });
    else if (leader && isAlive(-pid)) left.push({ pid, group: true });
  }
  if (Number.isSafeInteger(runGroup)) {
    for (const line of String(psText).split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (!match || Number(match[2]) !== runGroup) continue;
      const pid = Number(match[1]);
      if (pid !== runGroup && !left.some((entry) => entry.pid === pid)) left.push({ pid, group: false });
    }
  }
  return left;
}

function commandOf(pid) {
  const shown = spawnSync('ps', ['-ww', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
  return shown.status === 0 && shown.stdout.trim() ? shown.stdout.trim().slice(0, 300) : '(only its process group is left)';
}

function main() {
  if (process.platform === 'win32') {
    const run = spawnSync(process.execPath, ['--test', '--test-force-exit', '--test-timeout=120000', ...PATTERNS], { stdio: 'inherit' });
    console.log('unit tests: the check for processes left behind is not made on Windows (#382).');
    process.exit(run.status === 0 ? 0 : 1);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-unit-children-'));
  const record = path.join(dir, 'children.txt');
  fs.writeFileSync(record, '');
  const tracker = path.join(__dirname, 'track-children.js');
  const env = { ...process.env, MULTIAGENT_UNIT_CHILDREN: record, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${JSON.stringify(tracker)}`.trim() };
  // The run leads a process group of its own, so what it leaves behind can be found by that group, not by a name.
  const run = spawnSync(process.execPath, ['--test', '--test-force-exit', '--test-timeout=120000', ...PATTERNS], { stdio: 'inherit', env, detached: true });
  let failed = run.status !== 0;
  const look = () => leftovers(fs.readFileSync(record, 'utf8'), alive, run.pid, spawnSync('ps', ['-A', '-o', 'pid=,pgid='], { encoding: 'utf8' }).stdout ?? '');
  // A process stopped at the very end may still be exiting: look again a moment later before calling it left behind.
  let left = look();
  if (left.length > 0) { spawnSync('sleep', ['2']); left = look(); }
  const started = new Set(fs.readFileSync(record, 'utf8').split('\n').filter(Boolean).map((line) => line.split(' ')[0])).size;
  if (left.length > 0) {
    failed = true;
    console.error(`unit tests: ${left.length} of the ${started} processes the tests started are still running (#382):`);
    for (const entry of left) console.error(`  ${entry.pid}${entry.group ? ' (its process group)' : ''}: ${commandOf(entry.pid)}`);
    // Ours, by the record: stopped, so CI does not wait for them.
    for (const entry of left) { for (const target of [entry.pid, -entry.pid]) { try { process.kill(target, 'SIGKILL'); } catch { /* gone */ } } }
  } else {
    console.log(`unit tests: none of the ${started} processes the tests started is left running.`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

if (require.main === module) main();

module.exports = { leftovers };
