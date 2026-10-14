'use strict';

// Credentials never go into the file store. They are kept in the host's secret
// storage (VS Code SecretStorage) and records only hold an opaque `secretRef`.
// This module never reads CLI credential files and has no API that could copy a
// provider's login token: it only stores values the caller hands it.

const REF_PATTERN = /^secret:[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const KEY_PREFIX = 'multiagentSystem';

class SecretVault {
  // `backend` has the shape of VS Code's SecretStorage: async get/store/delete.
  constructor(backend, namespace) {
    const ok = backend && ['get', 'store', 'delete'].every((name) => typeof backend[name] === 'function');
    if (!ok) throw new TypeError('secret backend must provide get, store and delete');
    if (!NAMESPACE.test(namespace || '')) throw new TypeError('invalid namespace');
    this.backend = backend;
    this.namespace = namespace;
  }

  refFor(id) {
    const ref = `secret:${this.namespace}/${id}`;
    if (!REF_PATTERN.test(ref)) throw new TypeError('invalid secret id');
    return ref;
  }

  #key(ref) {
    if (typeof ref !== 'string' || !REF_PATTERN.test(ref) || !ref.startsWith(`secret:${this.namespace}/`)) {
      throw new TypeError('invalid secret reference');
    }
    return `${KEY_PREFIX}/${ref.slice('secret:'.length)}`;
  }

  async save(id, value) {
    if (typeof value !== 'string' || value === '') throw new TypeError('secret value must be a non-empty string');
    const ref = this.refFor(id);
    await this.backend.store(this.#key(ref), value);
    return { secretRef: ref };
  }

  async read(ref) {
    const value = await this.backend.get(this.#key(ref));
    return value === undefined ? null : value;
  }

  async remove(ref) {
    await this.backend.delete(this.#key(ref));
    return { ok: true };
  }
}

// Binds the pieces a VS Code extension provides. It takes the context object
// structurally so it can be tested without the editor; it has not been run in a
// real Extension Host yet.
function fromExtensionContext(context, namespace = 'default') {
  const storage = context && context.globalStorageUri;
  const dir = storage && typeof storage.fsPath === 'string' ? storage.fsPath : null;
  if (!dir || !context.secrets) throw new TypeError('extension context must provide globalStorageUri and secrets');
  return { storageDir: dir, vault: new SecretVault(context.secrets, namespace) };
}

module.exports = { SecretVault, fromExtensionContext, REF_PATTERN };
