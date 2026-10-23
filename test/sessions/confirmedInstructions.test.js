'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { confirmationKey, alreadyConfirmed, remember, MAX_ENTRIES } = require('../../src/sessions/confirmedInstructions');

const digest = (char) => `sha256:${char.repeat(64)}`;

test('only the exact digest confirmed for the same provider and role group counts (#362)', () => {
  const key = confirmationKey('claude', 'worker');
  const map = remember({}, key, digest('a'));
  assert.equal(alreadyConfirmed(map, key, digest('a')), true);
  assert.equal(alreadyConfirmed(map, key, digest('b')), false, 'changed instructions are asked again');
  assert.equal(alreadyConfirmed(map, confirmationKey('codex', 'worker'), digest('a')), false, 'another provider is asked');
  assert.equal(alreadyConfirmed(map, confirmationKey('claude', 'pm'), digest('a')), false, 'another role group is asked');
  assert.equal(confirmationKey('claude', undefined), 'claude|unassigned');
  for (const bad of [null, undefined, 5, [], 'x', { [key]: 'sha256:short' }]) assert.equal(alreadyConfirmed(bad, key, digest('a')), false, JSON.stringify(bad));
  assert.equal(alreadyConfirmed(Object.create({ [key]: digest('a') }), key, digest('a')), false, 'inherited keys do not count');
  assert.equal(alreadyConfirmed(map, null, digest('a')), false);
  assert.equal(alreadyConfirmed(map, key, 'not-a-digest'), false);
  assert.equal(alreadyConfirmed({ [key]: 'not-a-digest' }, key, 'not-a-digest'), false, 'a stored value that is not a digest never matches');
  assert.equal(alreadyConfirmed({ [key]: '' }, key, ''), false);
});

test('keys refuse what cannot be one, and the map stays bounded with the newest kept (#362)', () => {
  for (const [provider, role] of [['', 'x'], ['claude', 'a|b'], ['claude', ' x'], [7, 'x'], ['claude', 'x'.repeat(200)]]) assert.equal(confirmationKey(provider, role), null, `${provider}/${role}`);
  let map = {};
  for (let index = 0; index < MAX_ENTRIES + 20; index += 1) map = remember(map, confirmationKey('claude', `role-${index}`), digest('a'));
  assert.equal(Object.keys(map).length, MAX_ENTRIES);
  assert.equal(alreadyConfirmed(map, confirmationKey('claude', `role-${MAX_ENTRIES + 19}`), digest('a')), true);
  assert.equal(alreadyConfirmed(map, confirmationKey('claude', 'role-0'), digest('a')), false, 'the oldest is dropped');
  const before = { [confirmationKey('claude', 'x')]: digest('a') };
  remember(before, confirmationKey('claude', 'x'), digest('b'));
  assert.equal(before[confirmationKey('claude', 'x')], digest('a'), 'the given map is not changed');
  assert.deepEqual(remember({ junk: 5 }, confirmationKey('claude', 'x'), digest('b')), { 'claude|x': digest('b') }, 'unusable entries are dropped');
});

test('a confirmation is remembered only after the person agreed in the dialog, on start and on reopen (#362)', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/sessions/sessionCommands.ts'), 'utf8').replace(/\r\n/g, '\n');
  const remembers = [...source.matchAll(/await rememberInstructions\(/g)];
  assert.equal(remembers.length, 2, 'once for start, once for reopen');
  for (const use of remembers) {
    const before = source.slice(Math.max(0, use.index - 1500), use.index);
    assert.match(before, /return \{ ok: false, code: 'cancelled', message: 'Cancelled\.' \};\s*\}\s*\}\s*(\/\/[^\n]*\n\s*)?if \(prep\.reviewDigest\) $/, 'right after the dialog, past every cancel');
  }
  assert.equal((source.match(/instructionsConfirmed\(context, [^)]*prep\.reviewDigest\)/g) ?? []).length, 2, 'compared by the review digest, which leaves the codename out');
  assert.doesNotMatch(source, /input\.\w*[Cc]onfirmed\w*/, 'no caller argument can say it was confirmed');
});
