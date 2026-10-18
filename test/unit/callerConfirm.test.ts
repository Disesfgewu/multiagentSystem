import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { callerArgumentNeedsConfirmation } from '../../src/shared/callerConfirm';
import { isOwnUiItem, markOwnUiItem } from '../../src/shared/uiOrigin';

test('a caller-named target needs the person outside test mode, unless it is the extension\'s own row (Refs #192)', () => {
  assert.equal(callerArgumentNeedsConfirmation({ supplied: true, fromOwnUi: false, testMode: false }), true);
  assert.equal(callerArgumentNeedsConfirmation({ supplied: true, fromOwnUi: true, testMode: false }), false, 'the clicked row is the decision');
  assert.equal(callerArgumentNeedsConfirmation({ supplied: true, fromOwnUi: false, testMode: true }), false, 'the extension\'s own tests');
  assert.equal(callerArgumentNeedsConfirmation({ supplied: false, fromOwnUi: false, testMode: false }), false, 'a picker already asked');
  // Anything but literal true for the escape hatches still asks.
  assert.equal(callerArgumentNeedsConfirmation({ supplied: true, fromOwnUi: 'yes' as unknown as boolean, testMode: 1 as unknown as boolean }), true);
});

test('only objects the extension marked count as its own UI items; copies and look-alikes do not', () => {
  const row = markOwnUiItem({ id: 'session-1', contextValue: 'multiagentOverviewAgentLive' });
  assert.equal(isOwnUiItem(row), true);
  assert.equal(isOwnUiItem({ ...row }), false, 'a copy is a caller object');
  assert.equal(isOwnUiItem(Object.create(row)), false, 'an object inheriting from the row is not the row');
  assert.equal(isOwnUiItem({ id: 'session-1', contextValue: 'multiagentOverviewAgentLive' }), false);
  for (const value of [undefined, null, 'session-1', 1]) assert.equal(isOwnUiItem(value), false);
});
