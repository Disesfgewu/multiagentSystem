'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { describePermissionMode, MODE_WORDS } = require('../../src/observations/permissionMode');
const { PERMISSION_MODES } = require('../../src/accounts/claudeHookBridge');

const reported = (mode) => ({ mode, since: '2026-10-24T00:00:00.000Z' });

test('auto mode asked for but not in effect is an alert, with why and what to do (#362)', () => {
  const fell = describePermissionMode({ provider: 'claude', requested: 'on', reported: reported('default') });
  assert.equal(fell.text, 'Auto mode is not in effect: Claude Code reports default (asks before actions)');
  assert.equal(fell.attention, true);
  assert.match(fell.lines.join('\n'), /not available to this account, plan or model[\s\S]*classifier cannot be used[\s\S]*too long[\s\S]*Next: reopen the session/);
  for (const mode of PERMISSION_MODES.filter((entry) => entry !== 'auto')) assert.equal(describePermissionMode({ provider: 'claude', requested: 'on', reported: reported(mode) }).attention, true, mode);
});

test('a mode that matches, or one nobody asked to change, is shown plainly (#362)', () => {
  assert.deepEqual(describePermissionMode({ provider: 'claude', requested: 'on', reported: reported('auto') }), { text: 'Permission mode: auto (a classifier approves actions instead of you), reported by Claude Code', attention: false, lines: [] });
  for (const requested of ['off', 'unknown', null]) assert.equal(describePermissionMode({ provider: 'claude', requested, reported: reported('default') }).attention, false, String(requested));
  assert.equal(describePermissionMode({ provider: 'claude', requested: 'on', reported: null }).text, 'Permission mode: not reported yet (Claude Code reports it with its first action)');
  assert.equal(describePermissionMode({ provider: 'claude', requested: 'on', reported: reported('made-up') }).attention, false, 'an unknown value is not reported');
  assert.equal(describePermissionMode({ provider: 'codex', requested: 'on', reported: reported('default') }), null, 'a CLI that reports no mode has no line');
  assert.deepEqual(Object.keys(MODE_WORDS).sort(), [...PERMISSION_MODES].sort(), 'every documented mode has words');
});
