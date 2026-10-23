'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Recorder } = require('./report');

const fakePage = () => ({ screenshot: async ({ path: file }) => fs.writeFileSync(file, 'png') });

test('the e2e report records each check, stops an item at its first failure, runs the other items, and links every screenshot (#361)', async (t) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-e2e-report-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const recorder = new Recorder(out);
  const ran = [];
  const failing = { id: '01', title: 'Failing item', issue: '#1', steps: [
    { name: 'first', does: 'Does the first thing.', run: async ({ check }) => { ran.push('01-first'); check('a title is shown', 'Accounts (0)', /Accounts \(\d+\)/); } },
    { name: 'second', does: 'Does the second thing.', run: async ({ check }) => { ran.push('01-second'); check('the e-mail is shown', 'no e-mail', /@example\.test/); } },
    { name: 'third', does: 'Never runs.', run: async () => { ran.push('01-third'); } }
  ] };
  const passing = { id: '02', title: 'Passing item', issue: '#2', steps: [{ name: 'only', does: 'Clicks.', run: async ({ check }) => { ran.push('02-only'); check('equal', 'x', 'x'); } }] };
  assert.equal(await recorder.item(failing, fakePage(), {}), false);
  assert.equal(await recorder.item(passing, fakePage(), {}), true);
  assert.deepEqual(ran, ['01-first', '01-second', '02-only'], 'the failing item stops; the next item still runs');
  recorder.write({ vscode: '1.95.0' });
  const report = fs.readFileSync(path.join(out, 'REPORT.md'), 'utf8');
  assert.match(report, /\*\*1 of 2 items passed\*\*/);
  assert.match(report, /\| 01 \| Failing item \| FAIL \|/);
  assert.match(report, /✔ a title is shown — saw: `Accounts \(0\)`/);
  assert.match(report, /✘ the e-mail is shown — saw: `no e-mail`/);
  assert.match(report, /!\[01 second\]\(01-second-failed\.png\)/, 'a failed step keeps a screenshot of the moment it failed');
  assert.match(report, /!\[02 only\]\(02-only\.png\)/);
  assert.deepEqual(recorder.screenshots(), ['01-first.png', '02-only.png'], 'only passed steps are offered to the user guide');
  assert.ok(fs.existsSync(path.join(out, 'report.json')));
});
