'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { launchNote } = require('../../src/sessions/launchNote');
const { formatClearPrefix } = require('../../out/src/terminals/shellCommand');

test('the launch note holds only fixed words, a built-in provider name and an issued codename (#357)', () => {
  assert.equal(launchNote('claude', 'Worker-01'), 'Multiagent: starting Claude Code (Worker-01)');
  assert.equal(launchNote('codex', 'PM-12'), 'Multiagent: starting Codex CLI (PM-12)');
  assert.equal(launchNote('agy', undefined), 'Multiagent: starting agy');
  // A custom provider's id is the person's own text: it is not typed into the terminal.
  assert.equal(launchNote('my-custom; rm -rf ~', 'Worker-01'), 'Multiagent: starting an agent CLI (Worker-01)');
  assert.equal(launchNote('__proto__', undefined), 'Multiagent: starting an agent CLI');
  for (const codename of ['worker-01', 'Worker-1', 'Worker-01 & del', 'Worker-01\nx', '$(id)-01', 7]) assert.equal(launchNote('claude', codename), 'Multiagent: starting Claude Code', String(codename));
  // Even a built-in label with other characters would not be used.
  const odd = { has: () => true, get: () => ({ label: 'Claude <b>Code</b>' }) };
  assert.equal(launchNote('claude', 'Worker-01', odd), 'Multiagent: starting an agent CLI (Worker-01)');
});

test('the clear never decides whether the command runs: every shell joins it with an unconditional separator (#357)', () => {
  for (const shell of ['posix', 'powershell', 'cmd']) {
    const prefix = formatClearPrefix('Multiagent: starting Claude Code (Worker-01)', shell);
    assert.equal(prefix.includes('&&') || prefix.includes('||'), false, `${shell}: nothing conditional`);
    assert.ok(prefix.endsWith('; ') || prefix.endsWith('& '), `${shell}: what follows always runs`);
  }
});

test('on a POSIX shell the command still runs when clear is missing or fails (#357)', { skip: process.platform === 'win32' }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-clear-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const prefix = formatClearPrefix('Multiagent: starting Claude Code (Worker-01)', 'posix');
  // No clear on PATH at all.
  const missing = execFileSync('/bin/sh', ['-c', `${prefix}echo launched`], { env: { PATH: path.join(dir, 'nothing-here') }, encoding: 'utf8' });
  assert.match(missing, /Multiagent: starting Claude Code \(Worker-01\)\nlaunched\n$/);
  // A clear that fails.
  fs.writeFileSync(path.join(dir, 'clear'), '#!/bin/sh\nexit 3\n', { mode: 0o755 });
  const failing = execFileSync('/bin/sh', ['-c', `${prefix}echo launched`], { env: { PATH: dir }, encoding: 'utf8' });
  assert.match(failing, /launched\n$/);
});
