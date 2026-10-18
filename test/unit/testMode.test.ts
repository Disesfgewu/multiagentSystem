import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { allowNonInteractive, isExtensionTestMode, requireInteractive, setExtensionTestMode } from '../../src/shared/testMode';

test('outside test mode a caller cannot ask to skip prompts', () => {
  setExtensionTestMode(false);
  assert.equal(isExtensionTestMode(), false);
  assert.equal(allowNonInteractive(true), false);
  assert.equal(allowNonInteractive(false), false);
  const forced = requireInteractive({ interactive: false, confirmed: true, id: 'x' });
  assert.deepEqual(forced, { interactive: true, confirmed: true, id: 'x' }, 'interactive is forced on; other fields are left for the command to judge');
});

test('in test mode interactive:false is honoured and nothing else changes', () => {
  setExtensionTestMode(true);
  try {
    assert.equal(isExtensionTestMode(), true);
    assert.equal(allowNonInteractive(true), true);
    assert.equal(allowNonInteractive(false), false);
    const options = { interactive: false, confirmed: true };
    assert.equal(requireInteractive(options), options);
  } finally {
    setExtensionTestMode(false);
  }
});

test('options without interactive:false pass through unchanged in either mode', () => {
  for (const mode of [false, true]) {
    setExtensionTestMode(mode);
    const none = { id: 'a' } as { id: string; interactive?: boolean };
    const yes = { interactive: true };
    assert.equal(requireInteractive(none), none);
    assert.equal(requireInteractive(yes), yes);
  }
  setExtensionTestMode(false);
});

test('only a real boolean true enables test mode', () => {
  setExtensionTestMode('true' as unknown as boolean);
  assert.equal(isExtensionTestMode(), false);
  setExtensionTestMode(1 as unknown as boolean);
  assert.equal(isExtensionTestMode(), false);
});
