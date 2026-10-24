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
  const passing = { id: '02', title: 'Passing item', issue: '#2', acceptance: 'not-done', pending: '#357: three cards', steps: [{ name: 'only', does: 'Clicks.', run: async ({ check }) => { ran.push('02-only'); check('equal', 'x', 'x'); } }] };
  assert.equal(await recorder.item(failing, fakePage(), {}), false);
  assert.equal(await recorder.item(passing, fakePage(), {}), true);
  assert.deepEqual(ran, ['01-first', '01-second', '02-only'], 'the failing item stops; the next item still runs');
  recorder.write({ vscode: '1.95.0' });
  const report = fs.readFileSync(path.join(out, 'REPORT.md'), 'utf8');
  assert.match(report, /\*\*checks: 1 of 2 items passed; accepted \(#360\): 0 of 2\*\*/);
  assert.match(report, /\| 01 \| Failing item \| FAIL \|/);
  assert.match(report, /✔ a title is shown — saw: `Accounts \(0\)`/);
  assert.match(report, /✘ the e-mail is shown — saw: `no e-mail`/);
  assert.match(report, /!\[01 second\]\(01-second-failed\.png\)/, 'a failed step keeps a screenshot of the moment it failed');
  assert.match(report, /!\[02 only\]\(02-only\.png\)/);
  assert.match(report, /\| 02 \| Passing item \| checks pass — NOT DONE \(#357: three cards\) \|/, 'passing checks are not called accepted');
  assert.match(report, /Still to do for the acceptance: #357: three cards/);
  assert.doesNotMatch(report, /\| 02 \| Passing item \| accepted \|/);
  assert.deepEqual(recorder.screenshots(), ['01-first.png', '02-only.png'], 'only passed steps are offered to the user guide');
  assert.ok(fs.existsSync(path.join(out, 'report.json')));
});

test('only an item marked accepted whose checks all held is reported as accepted; anything unmarked is not done (#371)', () => {
  const { Recorder: R } = require('./report');
  assert.equal(R.verdict({ ok: true, acceptance: 'accepted' }), 'accepted');
  assert.equal(R.verdict({ ok: false, acceptance: 'accepted' }), 'FAIL');
  assert.equal(R.verdict({ ok: true, acceptance: 'framework' }), 'checks pass — framework check only, not accepted');
  assert.equal(R.verdict({ ok: true, acceptance: 'not-done', pending: '#357' }), 'checks pass — NOT DONE (#357)');
});

test('an item is either accepted with nothing pending, or not done with what is still to do (#371, #357)', () => {
  const { ITEMS } = require('./steps');
  for (const item of ITEMS) {
    if (item.acceptance === 'accepted') assert.equal(item.pending, undefined, `${item.id} is accepted, so nothing is pending`);
    else assert.match(item.pending ?? '', /#\d+/, `${item.id} says which issue finishes it`);
  }
  // #357: the side bar keeps one entry, and one screen shows every agent with its codename, account and mode.
  assert.deepEqual(ITEMS.filter((item) => item.acceptance === 'accepted').map((item) => item.id), ['00', '01', '11', '02', '03', '08']);
  // #353: item 08 reads an Issue and a pull request, opens a diff, writes, publishes and asks an agent about a post.
  assert.deepEqual(ITEMS.find((item) => item.id === '08').steps.map((step) => step.name), ['open-issue-page', 'open-pr-page', 'open-file-diff', 'write-comment', 'publish-comment', 'ask-agent']);
  // #352: item 03 adds a Codex account, sets a role group's default account, starts with it and switches an agent's account.
  const three = ITEMS.find((item) => item.id === '03');
  assert.deepEqual(three.steps.map((step) => step.name), ['add-codex-account', 'set-default-account', 'see-default-first', 'start-with-default', 'confirm-switch', 'switch-account']);
  const eleven = ITEMS.find((item) => item.id === '11');
  assert.ok(eleven.steps.some((step) => step.name === 'start-four-agents') && eleven.steps.some((step) => step.name === 'see-four-cards'), 'item 11 starts four agents and looks at their cards');
});
