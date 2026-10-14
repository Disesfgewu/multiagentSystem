'use strict';

// The registry keeps only local session metadata. A VS Code Terminal object and
// its binding token exist in memory; neither is suitable for GitHub or for a
// persisted claim that a CLI is still running after the Extension Host restarts.
class SessionError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SessionError';
    this.code = code;
  }
}

const STATES = Object.freeze({
  UNKNOWN: 'unknown',
  TERMINAL_OPEN: 'terminal-open',
  LAUNCH_REQUESTED: 'launch-requested',
  CLI_OBSERVED: 'cli-observed',
  CLI_EXITED: 'cli-exited',
  TERMINAL_CLOSED: 'terminal-closed'
});

function required(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new SessionError(`invalid-${field}`);
  return value;
}

function copy(entry) {
  return {
    id: entry.id,
    repoId: entry.repoId,
    roleGroupId: entry.roleGroupId,
    provider: entry.provider,
    accountProfileId: entry.accountProfileId,
    worktree: entry.worktree,
    state: entry.state,
    observedAt: entry.observedAt,
    observationSource: entry.observationSource
  };
}

class SessionRegistry {
  constructor({ now = () => new Date().toISOString() } = {}) {
    this.now = now;
    this.entries = new Map();
    this.bindings = new Map();
    this.retiredTokens = new Set();
  }

  create(input) {
    const entry = {
      id: required(input?.id, 'id'),
      repoId: required(input?.repoId, 'repo-id'),
      roleGroupId: required(input?.roleGroupId, 'role-group-id'),
      provider: required(input?.provider, 'provider'),
      accountProfileId: required(input?.accountProfileId, 'account-profile-id'),
      worktree: required(input?.worktree, 'worktree'),
      state: STATES.UNKNOWN,
      observedAt: null,
      observationSource: null
    };
    if (this.entries.has(entry.id)) throw new SessionError('session-exists');
    this.entries.set(entry.id, entry);
    return copy(entry);
  }

  get(id) {
    const entry = this.entries.get(id);
    return entry ? copy(entry) : null;
  }

  list(repoId) {
    return [...this.entries.values()]
      .filter((entry) => repoId === undefined || entry.repoId === repoId)
      .map(copy);
  }

  #entry(id) {
    const entry = this.entries.get(id);
    if (!entry) throw new SessionError('session-not-found');
    return entry;
  }

  // The adapter supplies an opaque, process-local binding token for each
  // native terminal. Reopening requires a new token and clears old evidence.
  attachTerminal(id, token) {
    const entry = this.#entry(id);
    required(token, 'terminal-token');
    if (this.retiredTokens.has(token)) throw new SessionError('terminal-token-reused');
    for (const [otherId, otherToken] of this.bindings) {
      if (otherId !== id && otherToken === token) throw new SessionError('terminal-already-bound');
    }
    if (this.bindings.get(id) === token) throw new SessionError('terminal-already-bound');
    if (this.bindings.has(id)) this.retiredTokens.add(this.bindings.get(id));
    this.bindings.set(id, token);
    entry.state = STATES.TERMINAL_OPEN;
    entry.observedAt = null;
    entry.observationSource = null;
    return copy(entry);
  }

  #bound(id, token) {
    const entry = this.#entry(id);
    if (!this.bindings.has(id) || this.bindings.get(id) !== token) {
      throw new SessionError('stale-terminal-event');
    }
    return entry;
  }

  launchRequested(id, token) {
    const entry = this.#bound(id, token);
    if (entry.state !== STATES.TERMINAL_OPEN && entry.state !== STATES.CLI_EXITED) {
      throw new SessionError('invalid-transition');
    }
    entry.state = STATES.LAUNCH_REQUESTED;
    entry.observedAt = null;
    entry.observationSource = null;
    return copy(entry);
  }

  // Only a provider observation can assert that the CLI is present. Sending a
  // command to a shell, or seeing the shell itself, is insufficient evidence.
  observeCli(id, token, { provider, accountProfileId, source, observedAt } = {}) {
    const entry = this.#bound(id, token);
    if (entry.state !== STATES.LAUNCH_REQUESTED && entry.state !== STATES.CLI_OBSERVED) {
      throw new SessionError('invalid-transition');
    }
    if (provider !== entry.provider || accountProfileId !== entry.accountProfileId) {
      throw new SessionError('account-binding-mismatch');
    }
    if (source !== 'provider-event') throw new SessionError('observation-unverified');
    const stamp = observedAt ?? this.now();
    if (typeof stamp !== 'string' || !Number.isFinite(Date.parse(stamp))) {
      throw new SessionError('invalid-observed-at');
    }
    if (Date.parse(stamp) > Date.parse(this.now())) throw new SessionError('future-observation');
    entry.state = STATES.CLI_OBSERVED;
    entry.observedAt = stamp;
    entry.observationSource = source;
    return copy(entry);
  }

  cliExited(id, token) {
    const entry = this.#bound(id, token);
    if (entry.state !== STATES.CLI_OBSERVED && entry.state !== STATES.LAUNCH_REQUESTED) {
      throw new SessionError('invalid-transition');
    }
    entry.state = STATES.CLI_EXITED;
    entry.observedAt = null;
    entry.observationSource = null;
    return copy(entry);
  }

  terminalClosed(id, token) {
    const entry = this.#bound(id, token);
    this.bindings.delete(id);
    this.retiredTokens.add(token);
    entry.state = STATES.TERMINAL_CLOSED;
    entry.observedAt = null;
    entry.observationSource = null;
    return copy(entry);
  }

  // Persist only through the caller's private storage. On restart every
  // runtime status becomes unknown until new terminal/provider evidence arrives.
  snapshot() {
    return this.list().map(({ state, observedAt, observationSource, ...identity }) => identity);
  }

  static restore(snapshot, options) {
    if (!Array.isArray(snapshot)) throw new SessionError('invalid-snapshot');
    const registry = new SessionRegistry(options);
    for (const item of snapshot) registry.create(item);
    return registry;
  }
}

module.exports = { SessionRegistry, SessionError, STATES };
