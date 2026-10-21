'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { customProvidersFrom } = require('../../src/providers/custom-providers');
const { diagnose, formatDiagnosticReport } = require('../../src/setup/diagnostics');
const { PrivateStore } = require('../../src/storage/private-store');
const { AccountProfileService } = require('../../src/accounts/profile-service');
const { sandbox, COLLECTIONS } = require('../storage/helpers');

// Values a person might put in a custom provider: none of them may reach a diagnostic, a masked export or a stored record.
const ID = 'zz-secretid-7f3a';
const EXECUTABLE = 'zz-secret-exe-9d';
const ARGUMENT = '--zz-secret-arg=1f2e';
const ENV_VALUE = 'zz-secret-env-value-55aa';
const SENTINELS = [ID, EXECUTABLE, ARGUMENT, ENV_VALUE, 'ZZ_SECRET_ENV_NAME'];
const entry = { id: ID, label: 'Zz Label', executable: EXECUTABLE, args: [ARGUMENT] };
const seenIn = (value) => { const text = JSON.stringify(value); return SENTINELS.filter((sentinel) => text.includes(sentinel)); };

test('environment variables cannot be given to a custom provider at all, so their names and values have nowhere to go', () => {
  const read = customProvidersFrom([{ ...entry, env: { ZZ_SECRET_ENV_NAME: ENV_VALUE } }]);
  assert.deepEqual(read.providers, []);
  assert.deepEqual(read.rejected, [{ index: 0, code: 'provider-unknown-field' }]);
  assert.deepEqual(seenIn(read), [], 'the rejection does not repeat them');
});

test('the diagnostic report and its text never mention a custom provider, even when the inputs name one', () => {
  const report = diagnose({
    vscodeVersion: '1.95.0',
    nodeVersion: '20.20.2',
    executables: { claude: true, codex: false, [ID]: true, [EXECUTABLE]: true },
    managedTools: { [ID]: { state: 'ready' } },
    profiles: [],
    now: () => 0
  });
  assert.deepEqual(report.providers.map((provider) => provider.id).sort(), ['agy', 'claude', 'codex'], 'only the built-in providers are listed');
  assert.deepEqual(seenIn(report), []);
  assert.deepEqual(seenIn(formatDiagnosticReport(report)), []);
});

test('an account profile can only be for a built-in provider, and a masked export masks a custom id even if a record somehow names one', (t) => {
  const box = sandbox(t);
  const store = new PrivateStore({ dir: box.dir, repoRoot: box.repoRoot, collections: COLLECTIONS });
  const service = new AccountProfileService({ store, sessions: () => [], now: () => new Date('2026-10-21T00:00:00.000Z') });
  const created = service.create({ provider: ID, label: 'Zz', configDir: box.root });
  assert.equal(created.ok, false, 'an account profile can only be for a built-in provider');
  assert.deepEqual(seenIn(created), []);
  // A record that did name a custom provider (stored by something that does not check) is still masked in the export.
  store.put('sessions', 'session-1', { provider: ID, name: ARGUMENT, requestedModel: EXECUTABLE });
  assert.deepEqual(seenIn(store.exportMasked()), [], 'nothing of a custom provider is in the masked export');
  assert.deepEqual(seenIn(store.status()), []);
});
