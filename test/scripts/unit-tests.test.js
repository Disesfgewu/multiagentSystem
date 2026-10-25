'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { leftovers } = require('../../scripts/unit-tests');

const TRACKER = path.join(__dirname, '..', '..', 'scripts', 'track-children.js');

test('a recorded process still running is left behind; one that ended is not (#382)', () => {
  const left = leftovers('10 0\n11 0\n', (target) => target === 11);
  assert.deepEqual(left, [{ pid: 11, group: false }]);
});

test('a detached child that ended is still left behind when its group runs on (#382)', () => {
  assert.deepEqual(leftovers('20 1\n', (target) => target === -20), [{ pid: 20, group: true }]);
  assert.deepEqual(leftovers('21 0\n', (target) => target === -21), [], 'a child that is not detached leads no group of its own');
});

test('a process still in the run\'s own group is left behind, even when nothing recorded it; the run itself and other groups are not (#382)', () => {
  const ps = '  100   100\n  101   100\n  102   555\n  103   100\nnot a line\n';
  assert.deepEqual(leftovers('103 0\n', (target) => target === 103, 100, ps), [{ pid: 103, group: false }, { pid: 101, group: false }]);
  assert.deepEqual(leftovers('', () => false, null, ps), [], 'without the run\'s group only the record is looked at');
});

test('lines that are not a record are ignored (#382)', () => {
  assert.deepEqual(leftovers('x 1\n12\n13 2\n', () => true), []);
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
