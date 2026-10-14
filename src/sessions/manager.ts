import { randomUUID } from 'node:crypto';
import { SessionError, SessionRegistry } from './registry';

// Session lifecycle on top of SessionRegistry. It does not import `vscode`: native terminals and
// persistence are injected, so the behaviour is tested with fakes. Nothing here is sent to GitHub;
// ids, worktree paths and names are private local data.

/** What the manager needs from a native terminal (vscode.Terminal satisfies it). */
export interface TerminalHandle {
  show(preserveFocus?: boolean): void;
  sendText(text: string, addNewLine?: boolean): void;
  dispose(): void;
}

export interface TerminalHost<T extends TerminalHandle = TerminalHandle> {
  create(options: { name: string; cwd: string }): T;
}

/** Fixed when a session is created; never changed afterwards (an account switch is a new session). */
export interface SessionIdentity {
  id: string;
  repoId: string;
  roleGroupId: string;
  provider: string;
  accountProfileId: string;
  worktree: string;
}

/** One persisted session: identity plus the display name. No runtime state, terminal or token. */
export interface SessionRecord extends SessionIdentity {
  name: string;
}

/**
 * Persistence is injected. `load` returns what `save` was given (or undefined when nothing was
 * stored); the real implementation belongs to the private storage work (#9). The records are
 * private local data and must never leave the machine.
 */
export interface SessionSnapshotStore {
  load(): Promise<unknown>;
  save(records: SessionRecord[]): Promise<void>;
}

export type SessionState = 'unknown' | 'terminal-open' | 'launch-requested' | 'cli-observed' | 'cli-exited' | 'terminal-closed';

export interface SessionView extends SessionIdentity {
  name: string;
  state: SessionState;
  stateLabel: string;
  /** True only while this Extension Host holds a live terminal bound to the session. */
  terminalOpen: boolean;
  observedAt: string | null;
}

export interface ProviderEvent {
  provider: string;
  accountProfileId: string;
  source: string;
  observedAt?: string;
}

export interface ManagerDeps<T extends TerminalHandle> {
  terminals: TerminalHost<T>;
  /** provider id -> executable typed into the terminal. Unknown providers are refused. */
  providers: Readonly<Record<string, string>>;
  resolveProject(cwd: string): Promise<{ repoId: string }>;
  pathExists(path: string): boolean;
  store?: SessionSnapshotStore;
  newId?: () => string;
  newToken?: () => string;
  now?: () => string;
  terminalTitle?: (name: string) => string;
  /** Called when saving fails. Receives no details: they could contain local paths. */
  onPersistError?: () => void;
}

// The registry is plain JavaScript (src/sessions/registry.js); this is the part of it used here.
interface RegistryEntry extends SessionIdentity {
  state: string;
  observedAt: string | null;
  observationSource: string | null;
}

interface Registry {
  create(input: SessionIdentity): RegistryEntry;
  get(id: string): RegistryEntry | null;
  list(repoId?: string): RegistryEntry[];
  attachTerminal(id: string, token: string): RegistryEntry;
  launchRequested(id: string, token: string): RegistryEntry;
  observeCli(id: string, token: string, event: ProviderEvent): RegistryEntry;
  cliExited(id: string, token: string): RegistryEntry;
  terminalClosed(id: string, token: string): RegistryEntry;
  snapshot(): SessionIdentity[];
}

const createRegistry = (now?: () => string): Registry => new SessionRegistry({ now }) as unknown as Registry;
const restoreRegistry = (records: unknown, now?: () => string): Registry =>
  SessionRegistry.restore(records, { now }) as unknown as Registry;

/** No account profile or role group exists yet (#12, #14); sessions say so instead of guessing. */
export const UNASSIGNED = 'unassigned';

const STATE_LABELS: Record<SessionState, string> = {
  unknown: 'Unknown (no evidence since this window started)',
  'terminal-open': 'Shell open, CLI not started',
  'launch-requested': 'CLI launch requested, not confirmed',
  'cli-observed': 'CLI observed (provider event)',
  'cli-exited': 'CLI exited, shell still open',
  'terminal-closed': 'Terminal closed'
};

export function describeState(state: SessionState): string {
  return STATE_LABELS[state];
}

const randomId = (): string => randomUUID();

export class SessionManager<T extends TerminalHandle = TerminalHandle> {
  private registry: Registry;
  private readonly names = new Map<string, string>();
  private readonly bound = new Map<T, { id: string; token: string }>();
  private readonly handles = new Map<string, T>();

  constructor(private readonly deps: ManagerDeps<T>) {
    this.registry = createRegistry(deps.now);
  }

  /**
   * Restores sessions from the store. Every restored session is `unknown`: terminals, tokens and
   * observations are never persisted, so nothing can look active after a restart.
   * A snapshot that cannot be read is rejected as a whole (fail closed) and the manager starts empty.
   */
  async initialize(): Promise<{ restored: number }> {
    const store = this.deps.store;
    if (!store) return { restored: 0 };
    const loaded = await store.load();
    if (loaded === undefined || loaded === null) return { restored: 0 };
    if (!Array.isArray(loaded)) throw new SessionError('invalid-snapshot');
    const records = loaded as Array<Partial<SessionRecord>>;
    this.registry = restoreRegistry(records, this.deps.now);
    this.names.clear();
    for (const record of records) {
      if (typeof record.id === 'string' && typeof record.name === 'string') this.names.set(record.id, record.name);
    }
    return { restored: records.length };
  }

  private executableFor(provider: string): string {
    const executable = Object.prototype.hasOwnProperty.call(this.deps.providers, provider) ? this.deps.providers[provider] : undefined;
    if (!executable) throw new SessionError('provider-unsupported');
    return executable;
  }

  private view(id: string): SessionView {
    const entry = this.registry.get(id);
    if (!entry) throw new SessionError('session-not-found');
    return {
      id: entry.id,
      repoId: entry.repoId,
      roleGroupId: entry.roleGroupId,
      provider: entry.provider,
      accountProfileId: entry.accountProfileId,
      worktree: entry.worktree,
      name: this.names.get(entry.id) || `${entry.provider} session`,
      state: entry.state as SessionState,
      stateLabel: describeState(entry.state as SessionState),
      terminalOpen: this.handles.has(entry.id),
      observedAt: entry.observedAt
    };
  }

  private async persist(): Promise<void> {
    const store = this.deps.store;
    if (!store) return;
    const records = this.registry.snapshot().map((identity) => ({ ...identity, name: this.names.get(identity.id) ?? '' }));
    try {
      await store.save(records);
    } catch {
      this.deps.onPersistError?.();
    }
  }

  /**
   * Creates a session and its native terminal. `launch: false` opens only the shell (state
   * `terminal-open`); otherwise the provider executable is typed and the state is
   * `launch-requested`, which is explicitly not evidence that the CLI is running.
   */
  async start(input: {
    provider: string;
    name: string;
    cwd: string;
    roleGroupId?: string;
    accountProfileId?: string;
    launch?: boolean;
  }): Promise<SessionView> {
    const executable = this.executableFor(input.provider);
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) throw new SessionError('invalid-name');
    const project = await this.deps.resolveProject(input.cwd);
    const identity: SessionIdentity = {
      id: (this.deps.newId ?? randomId)(),
      repoId: project.repoId,
      roleGroupId: input.roleGroupId ?? UNASSIGNED,
      provider: input.provider,
      accountProfileId: input.accountProfileId ?? UNASSIGNED,
      worktree: input.cwd
    };
    const view = this.open(identity, name, executable, input.launch !== false);
    await this.persist();
    return view;
  }

  private open(identity: SessionIdentity, name: string, executable: string, launch: boolean): SessionView {
    const title = this.deps.terminalTitle ? this.deps.terminalTitle(name) : name;
    const terminal = this.deps.terminals.create({ name: title, cwd: identity.worktree });
    const token = (this.deps.newToken ?? randomId)();
    try {
      this.registry.create(identity);
      this.registry.attachTerminal(identity.id, token);
    } catch (error) {
      terminal.dispose();
      throw error;
    }
    this.names.set(identity.id, name);
    this.bound.set(terminal, { id: identity.id, token });
    this.handles.set(identity.id, terminal);
    terminal.show();
    if (launch) {
      terminal.sendText(executable, true);
      this.registry.launchRequested(identity.id, token);
    }
    return this.view(identity.id);
  }

  /** Forward every terminal-close event here. Events for terminals this manager does not track are ignored. */
  handleTerminalClosed(terminal: T): void {
    const binding = this.bound.get(terminal);
    if (!binding) return;
    this.bound.delete(terminal);
    this.handles.delete(binding.id);
    try {
      this.registry.terminalClosed(binding.id, binding.token);
    } catch (error) {
      // A late event from a replaced terminal must not touch a newer attachment.
      if (!(error instanceof SessionError) || error.code !== 'stale-terminal-event') throw error;
    }
  }

  private liveTerminal(id: string): T {
    if (!this.registry.get(id)) throw new SessionError('session-not-found');
    const terminal = this.handles.get(id);
    if (!terminal) throw new SessionError('terminal-not-open');
    return terminal;
  }

  focus(id: string): SessionView {
    this.liveTerminal(id).show(false);
    return this.view(id);
  }

  /** Closes the terminal (and with it the shell and any CLI in it). The state is recorded first; the close event that follows is ignored. */
  stop(id: string): SessionView {
    const terminal = this.liveTerminal(id);
    const binding = this.bound.get(terminal);
    this.bound.delete(terminal);
    this.handles.delete(id);
    if (binding) this.registry.terminalClosed(id, binding.token);
    terminal.dispose();
    return this.view(id);
  }

  /**
   * Opens a NEW session with the same project, role group, provider, account profile and
   * directory. The old session is kept as history and is never reused. The account cannot be
   * changed here: use `start` with another account for that.
   */
  async reopen(id: string, options: { launch?: boolean } = {}): Promise<SessionView> {
    const old = this.registry.get(id);
    if (!old) throw new SessionError('session-not-found');
    if (this.handles.has(id)) throw new SessionError('session-still-open');
    if (!this.deps.pathExists(old.worktree)) throw new SessionError('worktree-missing');
    const executable = this.executableFor(old.provider);
    const identity: SessionIdentity = {
      id: (this.deps.newId ?? randomId)(),
      repoId: old.repoId,
      roleGroupId: old.roleGroupId,
      provider: old.provider,
      accountProfileId: old.accountProfileId,
      worktree: old.worktree
    };
    const view = this.open(identity, this.names.get(id) || `${old.provider} session`, executable, options.launch !== false);
    await this.persist();
    return view;
  }

  /** For provider adapters: a verified provider event confirms the CLI. Account and provider must match the session. */
  observeCli(id: string, event: ProviderEvent): SessionView {
    const terminal = this.liveTerminal(id);
    const binding = this.bound.get(terminal) as { id: string; token: string };
    this.registry.observeCli(id, binding.token, event);
    return this.view(id);
  }

  cliExited(id: string): SessionView {
    const terminal = this.liveTerminal(id);
    const binding = this.bound.get(terminal) as { id: string; token: string };
    this.registry.cliExited(id, binding.token);
    return this.view(id);
  }

  get(id: string): SessionView | null {
    return this.registry.get(id) ? this.view(id) : null;
  }

  list(repoId?: string): SessionView[] {
    return this.registry.list(repoId).map((entry) => this.view(entry.id));
  }
}
