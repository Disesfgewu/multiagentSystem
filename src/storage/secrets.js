'use strict';

// Credentials never go into the file store. They are kept in the host's secret
// storage (VS Code SecretStorage) and records only hold an opaque `secretRef`.
// This module never reads CLI credential files and has no API that could copy a
// provider's login token: it only stores values the caller hands it.

const REF_PATTERN = /^secret:[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const KEY_PREFIX = 'multiagentSystem';
const DEFAULT_REMOVE_TIMEOUT_MS = 5000;
const DEFAULT_REMOVE_POLL_MS = 25;

class SecretVault {
  // `backend` has the shape of VS Code's SecretStorage: async get/store/delete.
  constructor(backend, namespace, options = {}) {
    const ok = backend && ['get', 'store', 'delete'].every((name) => typeof backend[name] === 'function');
    if (!ok) throw new TypeError('secret backend must provide get, store and delete');
    if (!NAMESPACE.test(namespace || '')) throw new TypeError('invalid namespace');
    const timeout = options.removeTimeoutMs === undefined ? DEFAULT_REMOVE_TIMEOUT_MS : options.removeTimeoutMs;
    const poll = options.removePollMs === undefined ? DEFAULT_REMOVE_POLL_MS : options.removePollMs;
    if (!Number.isFinite(timeout) || timeout < 0) throw new TypeError('removeTimeoutMs must be a non-negative finite number');
    if (!Number.isFinite(poll) || poll <= 0) throw new TypeError('removePollMs must be a positive finite number');
    this.backend = backend;
    this.namespace = namespace;
    this.removeTimeoutMs = timeout;
    this.removePollMs = poll;
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
    const key = this.#key(ref);
    await this.backend.delete(key);
    const deadline = Date.now() + this.removeTimeoutMs;
    while (true) {
      try {
        if ((await this.backend.get(key)) === undefined) return { ok: true };
      } catch {
        return { ok: false, reason: 'remove-unconfirmed' };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { ok: false, reason: 'remove-unconfirmed' };
      await new Promise((resolve) => setTimeout(resolve, Math.min(this.removePollMs, remaining)));
    }
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
