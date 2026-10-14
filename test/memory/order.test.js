'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { byCodeUnit } = require('../../src/memory/order');

const IDS = ['B', 'a', 'a-1', 'a_1', 'A', 'a.1'];
// UTF-16 code unit order: 'A' 65, 'B' 66, 'a' 97, then 'a-' (45) < 'a.' (46) < 'a_' (95).
const BY_CODE_UNIT = ['A', 'B', 'a', 'a-1', 'a.1', 'a_1'];

test('byCodeUnit orders by UTF-16 code unit with a fixed, known result', () => {
  assert.deepEqual([...IDS].sort(byCodeUnit), BY_CODE_UNIT);
  assert.deepEqual([...IDS].reverse().sort(byCodeUnit), BY_CODE_UNIT, 'the input order does not matter');
  assert.equal(byCodeUnit('a', 'a'), 0);
  assert.equal(byCodeUnit('a', 'b'), -1);
  assert.equal(byCodeUnit('b', 'a'), 1);
  assert.equal(byCodeUnit('B', 'a'), -1, 'uppercase sorts before lowercase');
  assert.equal(byCodeUnit('a', 'a-1'), -1, 'a prefix sorts first');
  // Documented: this is code unit order, not code point order: a surrogate pair (D83D...) sorts
  // before U+FFFF. It is stable and machine independent, which is what matters here.
  assert.equal(byCodeUnit('\u{1F600}', '￿'), -1);
});

test('the memory code no longer uses locale-dependent comparison anywhere', () => {
  const fs = require('node:fs');
  const dir = path.join(__dirname, '..', '..', 'src', 'memory');
  const offenders = fs.readdirSync(dir)
    .filter((name) => name.endsWith('.js'))
    .filter((name) => /\.localeCompare\(/.test(fs.readFileSync(path.join(dir, name), 'utf8').replace(/\/\/.*$/gm, '')));
  // rules.js is fixed by the role-group work (#14, PR #40), which defines the same helper there.
  assert.deepEqual(offenders.filter((name) => name !== 'rules.js'), []);
});

// The same scrambled ids, rendered and retrieved in child processes under very different locales.
const LOCALES = ['C', 'en_US.UTF-8', 'zh_TW.UTF-8', 'sv_SE.UTF-8', 'tr_TR.UTF-8', 'de_DE.UTF-8'];

function probe(locale) {
  const env = { ...process.env, LC_ALL: locale, LANG: locale, LANGUAGE: locale };
  const out = execFileSync(process.execPath, [path.join(__dirname, 'fixtures', 'order-probe.js')], { env, encoding: 'utf8' });
  return JSON.parse(out);
}

test('injected text and retrieval order are identical under every locale and equal the code unit order', (t) => {
  const results = LOCALES.map((locale) => ({ locale, ...probe(locale) }));
  const expectedInjected = ['platform-first', ...BY_CODE_UNIT.map((id) => `rule-${id}`), ...BY_CODE_UNIT.map((id) => `note-${id}`)];
  for (const result of results) {
    assert.deepEqual(result.injected, expectedInjected, `injected order under ${result.locale}`);
    assert.deepEqual(result.selected, BY_CODE_UNIT, `retrieval order under ${result.locale}`);
  }
  const distinct = new Set(results.map((result) => JSON.stringify(result.localeSort)));
  t.diagnostic(`localeCompare produced ${distinct.size} different order(s) across these locales on this machine (collator: ${results.map((r) => r.collatorLocale).join(', ')})`);
});
