'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SecretVault, fromExtensionContext, REF_PATTERN } = require('../../src/storage/secrets');

function memoryBackend() {
  const map = new Map();
  return {
    map,
    async get(key) { return map.get(key); },
    async store(key, value) { map.set(key, value); },
    async delete(key) { map.delete(key); }
  };
}

test('secrets round-trip through the backend and the caller only gets an opaque reference', async () => {
  const backend = memoryBackend();
  const vault = new SecretVault(backend, 'accounts');
  const saved = await vault.save('profile-1', 'synthetic-value-1');
  assert.deepEqual(saved, { secretRef: 'secret:accounts/profile-1' });
  assert.match(saved.secretRef, REF_PATTERN);
  assert.equal(await vault.read(saved.secretRef), 'synthetic-value-1');
  assert.equal(JSON.stringify(saved).includes('synthetic'), false);
  assert.deepEqual([...backend.map.keys()], ['multiagentSystem/accounts/profile-1']);
  await vault.remove(saved.secretRef);
  assert.equal(await vault.read(saved.secretRef), null);
});

test('references outside the namespace, malformed references and empty values are refused', async () => {
  const vault = new SecretVault(memoryBackend(), 'accounts');
  await assert.rejects(() => vault.read('secret:other/profile-1'), TypeError);
  await assert.rejects(() => vault.read('profile-1'), TypeError);
  await assert.rejects(() => vault.read('secret:accounts/../x'), TypeError);
  await assert.rejects(() => vault.remove('secret:accounts/'), TypeError);
  await assert.rejects(() => vault.save('../x', 'v'), TypeError);
  await assert.rejects(() => vault.save('ok', ''), TypeError);
  await assert.rejects(() => vault.save('ok', 5), TypeError);
  assert.throws(() => new SecretVault({}, 'accounts'), TypeError);
  assert.throws(() => new SecretVault(memoryBackend(), '../x'), TypeError);
});

test('error messages never contain the secret value', async () => {
  const backend = memoryBackend();
  backend.store = async () => { throw new Error('backend refused'); };
  const vault = new SecretVault(backend, 'accounts');
  await assert.rejects(() => vault.save('p1', 'synthetic-secret-value'), (error) => !error.message.includes('synthetic'));
});

test('the extension context adapter takes the storage path and the secret store', () => {
  const backend = memoryBackend();
  const bound = fromExtensionContext({ globalStorageUri: { fsPath: '/synthetic/storage' }, secrets: backend }, 'accounts');
  assert.equal(bound.storageDir, '/synthetic/storage');
  assert.ok(bound.vault instanceof SecretVault);
  assert.throws(() => fromExtensionContext({ secrets: backend }), TypeError);
  assert.throws(() => fromExtensionContext({ globalStorageUri: { fsPath: '/x' } }), TypeError);
  assert.throws(() => fromExtensionContext(null), TypeError);
});

test('the storage code has no path to a provider CLI credential file', () => {
  const dir = path.join(__dirname, '..', '..', 'src', 'storage');
  const forbidden = [/\.credentials\.json/, /auth\.json/, /\.claude\.json/, /Keychain/i, /security\s+find-/i,
    /CLAUDE_CONFIG_DIR/, /CODEX_HOME/, /\.codex/, /child_process/];
  for (const name of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    for (const pattern of forbidden) assert.equal(pattern.test(text), false, `${name} mentions ${pattern}`);
  }
});
