import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  allowNonInteractive,
  resolveInteractive,
  EXTENSION_MODE_PRODUCTION,
  EXTENSION_MODE_DEVELOPMENT,
  EXTENSION_MODE_TEST
} from '../../src/shared/executionMode';

test('allowNonInteractive returns true strictly in ExtensionMode.Test', () => {
  assert.equal(allowNonInteractive({ extensionMode: EXTENSION_MODE_TEST }), true);
  assert.equal(allowNonInteractive({ extensionMode: EXTENSION_MODE_PRODUCTION }), false);
  assert.equal(allowNonInteractive({ extensionMode: EXTENSION_MODE_DEVELOPMENT }), false);
  assert.equal(allowNonInteractive(undefined), false);
  assert.equal(allowNonInteractive({} as any), false);
});

test('non-interactive bypass classification: mutating commands reject interactive:false in non-test mode', () => {
  const prodContext = { extensionMode: EXTENSION_MODE_PRODUCTION };
  const devContext = { extensionMode: EXTENSION_MODE_DEVELOPMENT };

  for (const ctx of [prodContext, devContext, undefined]) {
    // 1. Worktree commands:
    // - create and remove write to disk or delete directories -> MUST be interactive
    assert.equal(resolveInteractive(ctx, false), true, 'worktree mutating commands must not bypass');

    // 2. Session commands:
    // - launch, stop, reopen mutate terminal and process state -> MUST be interactive
    assert.equal(resolveInteractive(ctx, false), true, 'session mutating commands must not bypass');

    // 3. Account commands:
    // - limits mutates policy and quotas -> MUST be interactive
    assert.equal(resolveInteractive(ctx, false), true, 'account limits must not bypass');

    // 4. Setup commands:
    // - clearStorage, migrateStorage, recoverStorageLock mutate storage -> MUST be interactive
    assert.equal(resolveInteractive(ctx, false), true, 'setup storage commands must not bypass');
  }
});

test('non-interactive bypass classification: test mode honours interactive:false for test automation', () => {
  const testContext = { extensionMode: EXTENSION_MODE_TEST };
  assert.equal(allowNonInteractive(testContext), true);
  assert.equal(resolveInteractive(testContext, false), false);
  assert.equal(resolveInteractive(testContext, true), true);
});
