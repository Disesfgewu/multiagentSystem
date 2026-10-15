'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const detectors = require('../../src/publish/detectors');
const { locateSensitive } = require('../../src/memory/sensitive');
const { scanPublication, LIMITS } = require('../../src/publish/scan');

// Adversarial inputs: one repeated character or short repeated token. A pattern that rescans a
// whole run from every start is quadratic on these and takes minutes at this size. Each input
// must finish well inside a fixed budget; that budget is generous for linear code.
const SIZE = 100_000;
const BUDGET_MS = 1500;
const repeat = (token) => token.repeat(Math.ceil(SIZE / token.length));
const INPUTS = {
  backslashes: '\\', slashes: '/', dots: '.', spaces: ' ', tildes: '~', dollars: '$', digits: '1', letters: 'a', dashes: '-', underscores: '_',
  'a-backslash': 'a\\', 'double-slash': '//', 'drive-backslash': 'C:\\', 'drive-slash': 'C:/', 'at-signs': 'a@', 'dotted-words': 'x.',
  'users-path': '/Users/', 'home-path': '/home/', 'hyphen-words': 'a-', 'token-prefix': 'ghp_', 'assignment': 'key=', 'bearer': 'Bearer ',
  'pem-header': '-----BEGIN ', 'jwt-head': 'eyJ', 'jwt-parts': 'eyJa.eyJb.', 'uuid-parts': '1-', 'unc-parts': '\\\\a\\', 'unc-escaped': '\\\\\\\\a\\\\',
  'doubled-words': 'a\\\\', 'tilde-slash': '~/', 'tilde-backslash': '~\\', 'tilde-escaped': '~\\\\', 'colon': ':', 'quotes': '"', 'newlines': '\n', 'tabs': '\t', 'percent': '%',
  'long-word-then-backslashes': 'a'.repeat(1000) + '\\'
};

function timed(fn) {
  const start = process.hrtime.bigint();
  const result = fn();
  return { ms: Number(process.hrtime.bigint() - start) / 1e6, result };
}

for (const [name, token] of Object.entries(INPUTS)) {
  test(`every detector stays linear on ${name}`, () => {
    const text = repeat(token);
    for (const [label, run] of [
      ['local-paths', () => detectors.localPaths().detect(text)],
      ['sensitive-shapes', () => detectors.sensitiveShapes().detect(text)],
      ['locateSensitive', () => locateSensitive(text)],
      ['whole scan', () => scanPublication([{ kind: 'pr-body', text }], {})]
    ]) {
      const { ms, result } = timed(run);
      assert.ok(ms < BUDGET_MS, `${label} took ${ms.toFixed(0)} ms (budget ${BUDGET_MS} ms)`);
      assert.ok(result, label);
    }
  });
}

test('the maximum size of the worst known input is scanned in a fixed time', () => {
  const text = '\\'.repeat(LIMITS.maxUnitChars);
  const { ms, result } = timed(() => scanPublication([{ kind: 'pr-body', text }], {}));
  assert.ok(ms < 5000, `${ms.toFixed(0)} ms`);
  assert.notEqual(result.status, 'error');
});

test('a diff unit of repeated backslashes is also fast', () => {
  const diff = `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -0,0 +1 @@\n+${'\\'.repeat(SIZE)}\n`;
  const { ms } = timed(() => scanPublication([{ kind: 'diff', text: diff }], {}));
  assert.ok(ms < BUDGET_MS, `${ms.toFixed(0)} ms`);
});

test('input over the unit or total limit is refused, never clear', () => {
  assert.equal(scanPublication([{ kind: 'pr-body', text: 'x'.repeat(LIMITS.maxUnitChars + 1) }]).status, 'error');
  const parts = Array.from({ length: 5 }, () => ({ kind: 'comment', text: 'x'.repeat(LIMITS.maxUnitChars) }));
  assert.equal(scanPublication(parts).reason, 'input-too-large');
  assert.equal(scanPublication([{ kind: 'pr-body', text: 'x'.repeat(LIMITS.maxUnitChars) }]).status, 'clear');
});

test('a scan that runs over its work budget is an error, never clear', () => {
  let tick = 0;
  const slow = { name: 'slow', detect: () => { tick += 100; return []; } };
  const result = scanPublication([{ kind: 'pr-body', text: 'harmless' }, { kind: 'comment', text: 'harmless' }], { detectors: [slow, slow], now: () => tick, budgetMs: 150 });
  assert.deepEqual([result.status, result.blocked, result.reason], ['error', true, 'scan-budget-exceeded']);
  assert.equal(result.findings.length, 0);
  const fine = scanPublication([{ kind: 'pr-body', text: 'harmless' }], { detectors: [{ name: 'fast', detect: () => [] }], now: () => 0, budgetMs: 150 });
  assert.equal(fine.status, 'clear');
});

test('the budget is checked after a detector too, so one slow detector is not trusted as clear', () => {
  let tick = 0;
  const slow = { name: 'slow', detect: () => { tick += 1000; return []; } };
  const result = scanPublication([{ kind: 'pr-body', text: 'harmless' }], { detectors: [slow], now: () => tick, budgetMs: 500 });
  assert.equal(result.reason, 'scan-budget-exceeded');
});

test('an invalid budget falls back to the default instead of disabling the check', () => {
  let tick = 0;
  const slow = { name: 'slow', detect: () => { tick += LIMITS.budgetMs + 1; return []; } };
  for (const budgetMs of [0, -5, NaN, Infinity, 'x', null]) {
    tick = 0;
    const result = scanPublication([{ kind: 'pr-body', text: 'harmless' }], { detectors: [slow], now: () => tick, budgetMs });
    assert.equal(result.reason, 'scan-budget-exceeded', String(budgetMs));
  }
});

test('~\\.ssh style paths are found with single, doubled and forward slashes, and ordinary text is not hit', () => {
  const detect = detectors.localPaths().detect;
  for (const text of ['cat ~/.ssh/id_rsa', 'cat ~\\.ssh\\id_rsa', 'cat ~\\\\.ssh\\\\id_rsa', 'in ~/.aws', 'in ~\\\\.gnupg', '~\\\\\\.kube']) assert.ok(detect(text).length > 0, text);
  for (const text of ['~/.sshd-docs', '~\\.sshx', 'see ~/notes', '~\\\\', 'x ~ y', 'a~/.ssh', '~/']) assert.deepEqual(detect(text), [], text);
});

test('UNC and Windows paths from the earlier fix are still found, in plain and escaped form', () => {
  const detect = detectors.localPaths().detect;
  for (const text of ['\\\\server\\share', '\\\\\\\\server\\\\share', 'x \\\\\\\\wsl$\\\\Ubuntu', 'C:\\Users\\a', 'C:\\\\Users\\\\a', 'at \\\\\\\\server\\\\share\\\\dir', '"\\\\\\\\server\\\\share"']) assert.ok(detect(text).length > 0, text);
  for (const text of ['\\\\', '\\\\\\\\', '\\\\server', 'a\\\\b', 'line\\\\n', '\\\\\\\\ \\\\share']) assert.deepEqual(detect(text), [], text);
});

test('the index and the cap of path hits are kept: first hits in order, and the cap is reported', () => {
  const detect = detectors.localPaths().detect;
  const text = ['/Users/a/x', '\\\\s\\h', 'C:\\z'].join(' ');
  assert.deepEqual(detect(text).map((hit) => hit.index), [0, 11, 17]);
  const many = Array.from({ length: 50 }, (_, i) => `\\\\s${i}\\h${i}`).join(' ');
  const hits = detect(many);
  assert.equal(hits.length, 20);
  assert.equal(hits.truncated, true);
  assert.deepEqual(hits.map((hit) => hit.index), [...hits.map((hit) => hit.index)].sort((a, b) => a - b));
  assert.equal(detect('\\\\s\\h').truncated, undefined);
});

test('a doubled-backslash UNC path keeps the old start rule: after a boundary character it needs a run of three or more, and the hit starts one in', () => {
  const detect = detectors.localPaths().detect;
  const at = (text) => detect(text).map((hit) => hit.index);
  assert.deepEqual(at('x \\\\server\\share'), [2], 'after a space the run starts the match');
  assert.deepEqual(at('x\\\\server\\share'), [], 'two backslashes right after a letter are an escape, not a UNC prefix');
  assert.deepEqual(at('x\\\\\\server\\share'), [2], 'three after a letter: the match starts one in');
  assert.deepEqual(at('file:\\\\\\\\server\\\\share'), [6], 'four after a colon');
  assert.deepEqual(at('file:\\\\server\\share'), [], 'two after a colon');
  assert.deepEqual(at('\\\\server\\share'), [0], 'at the start of the text');
  assert.deepEqual(at('"\\\\server\\share"'), [1]);
});
