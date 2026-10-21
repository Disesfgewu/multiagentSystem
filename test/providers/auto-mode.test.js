'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveAutoMode, describeAutoMode, AUTO_MODE_ARGUMENTS } = require('../../src/providers/auto-mode');

test('auto mode is on by default, with the documented flags of each provider that has them', () => {
  assert.deepEqual(resolveAutoMode({ provider: 'claude' }), { state: 'on', args: ['--permission-mode', 'auto'], label: "Auto mode: on (won't ask for each approval) — passed: --permission-mode auto" });
  assert.deepEqual(resolveAutoMode({ provider: 'codex' }).args, ['--sandbox', 'workspace-write', '--ask-for-approval', 'never']);
  assert.deepEqual(resolveAutoMode({ provider: 'claude', setting: 'on' }).args, ['--permission-mode', 'auto']);
});

test('the stronger bypass flags are never passed', () => {
  const all = JSON.stringify(AUTO_MODE_ARGUMENTS) + JSON.stringify(['claude', 'codex'].map((provider) => resolveAutoMode({ provider })));
  for (const word of ['dangerously', 'yolo', 'bypassPermissions', 'full-auto', 'danger-full-access']) assert.equal(all.includes(word), false, word);
});

test('off asks as usual: no flags', () => {
  for (const provider of ['claude', 'codex', 'agy']) assert.deepEqual(resolveAutoMode({ provider, setting: 'off' }), { state: 'off', args: [], label: 'Auto mode: off (the CLI asks for approval as usual)' });
});

test('one provider can be overridden either way', () => {
  assert.deepEqual(resolveAutoMode({ provider: 'claude', setting: 'on', overrides: { claude: 'off' } }).args, []);
  assert.deepEqual(resolveAutoMode({ provider: 'codex', setting: 'on', overrides: { claude: 'off' } }).args, AUTO_MODE_ARGUMENTS.codex);
  assert.deepEqual(resolveAutoMode({ provider: 'codex', setting: 'off', overrides: { codex: 'on' } }).args, AUTO_MODE_ARGUMENTS.codex);
});

test('a provider with no documented flag (or an unknown one) gets none and is shown as unknown, not guessed', () => {
  for (const provider of ['agy', 'opencode', 'custom-x', '', undefined, null, 5, '__proto__', 'constructor', 'toString']) {
    const result = resolveAutoMode({ provider });
    assert.equal(result.state, 'unknown', String(provider));
    assert.deepEqual(result.args, []);
    assert.match(result.label, /no documented flag/);
  }
});

test('a setting that cannot be read is treated as off and says so: it never makes an agent less careful', () => {
  for (const setting of ['ON', 'yes', '', null, true, 1, {}, []]) {
    const result = resolveAutoMode({ provider: 'claude', setting });
    assert.equal(result.state, 'off', JSON.stringify(setting));
    assert.deepEqual(result.args, []);
    assert.match(result.label, /not "on" or "off"/);
  }
  assert.equal(resolveAutoMode({ provider: 'claude', setting: 'on', overrides: { claude: 'maybe' } }).state, 'off');
  for (const overrides of [null, 'x', 5, [], undefined]) assert.equal(resolveAutoMode({ provider: 'claude', setting: 'on', overrides }).state, 'on');
  assert.equal(resolveAutoMode({ provider: 'claude', setting: 'on', overrides: Object.create({ claude: 'off' }) }).state, 'on', 'inherited keys are not overrides');
});

test('the lines on screen say the CLI will not ask, and what that means for isolation', () => {
  const on = resolveAutoMode({ provider: 'claude' });
  const advisory = describeAutoMode(on, 'advisory').join('\n');
  assert.match(advisory, /Auto mode: on/);
  assert.match(advisory, /--permission-mode auto/);
  assert.match(advisory, /does not stop to ask/);
  assert.match(advisory, /No isolation protects this session/);
  assert.match(advisory, /not verified/);
  assert.match(advisory, /multiagentSystem\.agents\.autoMode/);
  const enforced = describeAutoMode(on, 'enforced').join('\n');
  assert.match(enforced, /inside the sandbox/);
  assert.doesNotMatch(enforced, /No isolation protects/);
  assert.deepEqual(describeAutoMode(resolveAutoMode({ provider: 'claude', setting: 'off' }), 'advisory'), ['Auto mode: off (the CLI asks for approval as usual)']);
  assert.match(describeAutoMode(resolveAutoMode({ provider: 'agy' }), 'advisory').join('\n'), /no documented flag/);
});

test('the module records its official sources and the date they were read', () => {
  const source = require('node:fs').readFileSync(require.resolve('../../src/providers/auto-mode'), 'utf8');
  for (const url of ['https://code.claude.com/docs/en/cli-reference', 'https://code.claude.com/docs/en/permission-modes', 'https://developers.openai.com/codex/cli/reference']) assert.ok(source.includes(url), url);
  assert.match(source, /read 2026-10-21/);
});
