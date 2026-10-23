'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRefreshLoop } = require('../../src/commandCenter/refreshLoop');

const flush = async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); };

test('a refresh slower than the requests still updates the screen, never two at once, and the last update is the newest (#368)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requested = 0;
  let running = 0;
  let most = 0;
  const shown = [];
  // Each refresh takes 3 seconds and shows what was requested when it started.
  const loop = createRefreshLoop(async () => {
    running += 1;
    most = Math.max(most, running);
    const seen = requested;
    await new Promise((resolve) => setTimeout(resolve, 3000));
    shown.push(seen);
    running -= 1;
  });
  // A request every 300 ms for 10 seconds, like agents reporting changes.
  for (let at = 0; at < 10000; at += 300) {
    requested += 1;
    void loop.request();
    t.mock.timers.tick(300);
    await flush();
  }
  for (let index = 0; index < 5; index += 1) { t.mock.timers.tick(3000); await flush(); }
  assert.ok(shown.length >= 3, `the screen was updated ${shown.length} times`);
  assert.equal(most, 1, 'never more than one refresh at a time');
  assert.equal(shown.at(-1), requested, 'the last update shows the newest state');
  assert.equal(loop.running(), false);
});

test('requests while one runs make exactly one more run, and request() waits for it (#368)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let runs = 0;
  const loop = createRefreshLoop(async () => { runs += 1; await new Promise((resolve) => setTimeout(resolve, 100)); });
  const first = loop.request();
  const second = loop.request();
  const third = loop.request();
  assert.equal(second, first, 'one promise for the whole loop');
  assert.equal(third, first);
  let done = false;
  void first.then(() => { done = true; });
  t.mock.timers.tick(100); await flush();
  assert.equal(done, false, 'the requests made during the first run are not done yet');
  t.mock.timers.tick(100); await flush();
  assert.equal(done, true);
  assert.equal(runs, 2, 'the requests in between made one more run, not three');
});

test('a failing refresh does not stop the next one (#368)', async () => {
  let calls = 0;
  const loop = createRefreshLoop(async () => { calls += 1; if (calls === 1) throw new Error('slow read failed'); });
  await loop.request();
  await loop.request();
  assert.equal(calls, 2);
  assert.throws(() => createRefreshLoop(), TypeError);
});

test('the Command Center refreshes through the loop, publishes the cards before the slow reads, and drops nothing (#368)', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/commandCenter/commandCenter.ts'), 'utf8').replace(/\r\n/g, '\n');
  assert.doesNotMatch(source, /generation/, 'no refresh throws its result away for a newer one');
  assert.match(source, /const loop = createRefreshLoop\(refreshOnce\);\n {2}const refresh = \(\): Promise<void> => loop\.request\(\);/);
  const body = source.slice(source.indexOf('const refreshOnce = async'), source.indexOf('const loop = createRefreshLoop'));
  const firstPublish = body.indexOf('publish(');
  assert.ok(firstPublish > 0 && firstPublish < body.indexOf('pullRequestSummary(') && firstPublish < body.indexOf('readAccounts('), 'the cards are published before the pull request reports and accounts are read');
  assert.equal((body.match(/publish\(/g) ?? []).length, 2, 'two steps');
  assert.doesNotMatch(body, /\breturn;/, 'no step returns without publishing');
});
