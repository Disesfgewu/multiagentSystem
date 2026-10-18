import { randomUUID } from 'node:crypto';
import { SessionError, SessionRegistry } from './registry';
import { modelArguments, normalizeRequestedModel } from '../providers/modelSelection';
import { formatShellCommandLine } from '../terminals/shellCommand';
import { cleanupSessionPlan } from './managedInstructions';

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
  create(options: { name: string; cwd: string; env?: Record<string, string | null> }): T;
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
  requestedModel?: string;
  instructionDigest?: string;
  instructionMethod?: string;
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

export type SessionInstructionState = 'prepared' | 'launch-requested' | 'cli-observed' | 'manual' | 'unsupported' | 'unknown' | 'none';

export interface SessionInstructionsInput {
  plan?: any;
  digest?: string | null;
  method?: string;
  argv?: string[];
  injectionState?: 'prepared' | 'launch-requested' | 'manual' | 'unsupported' | 'none';
  injectionStatusLabel?: string;
}

export interface SessionView extends SessionIdentity {
  name: string;
  /** A launch request, not a provider observation or an availability guarantee. */
  requestedModel?: string | null;
  state: SessionState;
  stateLabel: string;
  /** True only while this Extension Host holds a live terminal bound to the session. */
  terminalOpen: boolean;
  observedAt: string | null;
  instructionState?: SessionInstructionState;
  instructionStatusLabel?: string;
  instructionDigest?: string | null;
  instructionMethod?: string | null;
  /** Fresh, verified provider evidence only. It is never persisted with the session record. */
  providerObservation?: any;
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
  /** Preflight only; a true result is not proof that the CLI later started. */
  executableAvailable?: (executable: string) => boolean;
  resolveProject(cwd: string): Promise<{ repoId: string }>;
  /** True only for an existing directory. */
  directoryExists(path: string): boolean;
  store?: SessionSnapshotStore;
  newId?: () => string;
  newToken?: () => string;
  now?: () => string;
  terminalTitle?: (name: string) => string;
  detectShellType?: () => 'posix' | 'powershell' | 'cmd';
  /** Called when saving fails. Receives no details: they could contain local paths. */
  onPersistError?: () => void;
  /**
   * Called once when saving is switched off because saved sessions could not be read or loaded.
   * While blocked nothing is saved, so the unreadable data is never overwritten.
   */
  onPersistenceBlocked?: () => void;
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

const MAX_NAME = 80;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** One rule for every name, whether typed now or restored from a snapshot. */
export function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name === '' || name.length > MAX_NAME || CONTROL.test(name) ? null : name;
}

export class SessionManager<T extends TerminalHandle = TerminalHandle> {
  private registry: Registry;
  private readonly names = new Map<string, string>();
  private readonly models = new Map<string, string>();
  private readonly instructionStates = new Map<string, SessionInstructionState>();
  private readonly instructionLabels = new Map<string, string>();
  private readonly instructionDigests = new Map<string, string>();
  private readonly instructionMethods = new Map<string, string>();
  private readonly activePlans = new Map<string, any>();
  private readonly bound = new Map<T, { id: string; token: string }>();
  private readonly handles = new Map<string, T>();
  // Saving is allowed only after the saved sessions were read successfully (or when there is no
  // store). Anything else would overwrite data that was never read.
  private loaded = false;
  private blockedNotified = false;
  private initializing: Promise<{ restored: number }> | undefined;
  // start/reopen calls that are past the "wait for the load" gate and have not finished. Their
  // sessions would be replaced if the snapshot were restored over them, so they forbid it.
  private inFlight = 0;

  constructor(private readonly deps: ManagerDeps<T>) {
    this.registry = createRegistry(deps.now);
  }

  /**
   * Restores sessions from the store. Every restored session is `unknown`: terminals, tokens and
   * observations are never persisted, so nothing can look active after a restart.
   *
   * Fail closed: if the store cannot be loaded or its content cannot be read, the manager starts
   * empty and SAVING STAYS OFF, so the unreadable data is never overwritten. It runs once, and only
   * before any session exists or is being created (`sessions-exist` otherwise, also when one appears
   * while it loads). `start` and `reopen` that begin after it started wait for it to finish.
   */
  initialize(): Promise<{ restored: number }> {
    if (this.initializing) return Promise.reject(new SessionError('already-initialized'));
    if (this.registry.list().length > 0 || this.inFlight > 0) return Promise.reject(new SessionError('sessions-exist'));
    this.initializing = this.load();
    return this.initializing;
  }

  private async load(): Promise<{ restored: number }> {
    const store = this.deps.store;
    if (!store) {
      this.loaded = true;
      return { restored: 0 };
    }
    let loaded: unknown;
    try {
      loaded = await store.load();
    } catch {
      throw this.block('store-unavailable');
    }
    if (loaded === undefined || loaded === null) {
      this.loaded = true;
      return { restored: 0 };
    }
    if (!Array.isArray(loaded)) throw this.block('invalid-snapshot');
    const records = loaded as Array<Partial<SessionRecord>>;
    // A session created while the snapshot was loading (a call that was already past the gate)
    // would be replaced by the restored registry and become unmanageable. Refuse, and keep saving off.
    if (this.registry.list().length > 0 || this.inFlight > 0) throw this.block('sessions-exist');
    try {
      for (const record of records) normalizeRequestedModel(record.provider ?? '', record.requestedModel);
      this.registry = restoreRegistry(records, this.deps.now);
    } catch {
      throw this.block('invalid-snapshot');
    }
    this.names.clear();
    this.models.clear();
    this.instructionDigests.clear();
    this.instructionMethods.clear();
    for (const record of records) {
      const name = cleanName(record.name);
      if (typeof record.id === 'string' && name !== null) this.names.set(record.id, name);
      if (typeof record.id === 'string' && typeof record.requestedModel === 'string') this.models.set(record.id, record.requestedModel);
      if (typeof record.id === 'string' && typeof record.instructionDigest === 'string') this.instructionDigests.set(record.id, record.instructionDigest);
      if (typeof record.id === 'string' && typeof record.instructionMethod === 'string') this.instructionMethods.set(record.id, record.instructionMethod);
      if (typeof record.id === 'string') {
        this.instructionStates.set(record.id, 'unknown');
        this.instructionLabels.set(record.id, 'Instructions unknown (restored from previous session)');
      }
    }
    this.loaded = true;
    return { restored: records.length };
  }

  private block(code: string): Error {
    this.notifyBlocked();
    return new SessionError(code);
  }

  private notifyBlocked(): void {
    if (this.blockedNotified) return;
    this.blockedNotified = true;
    this.deps.onPersistenceBlocked?.();
  }

  /** Start and reopen queue behind a load that is still running, so nothing is replaced under them. */
  private async ready(): Promise<void> {
    if (!this.initializing) return;
    try {
      await this.initializing;
    } catch {
      // Saving is already blocked; sessions still work in memory.
    }
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
      requestedModel: this.models.get(entry.id) ?? null,
      state: entry.state as SessionState,
      stateLabel: describeState(entry.state as SessionState),
      terminalOpen: this.handles.has(entry.id),
      observedAt: entry.observedAt,
      instructionState: this.instructionStates.get(entry.id) ?? 'none',
      instructionStatusLabel: this.instructionLabels.get(entry.id) ?? 'No instructions configured',
      instructionDigest: this.instructionDigests.get(entry.id) ?? null,
      instructionMethod: this.instructionMethods.get(entry.id) ?? null
    };
  }

  private async persist(): Promise<void> {
    const store = this.deps.store;
    if (!store) return;
    if (!this.loaded) {
      this.notifyBlocked();
      return;
    }
    const records = this.registry.snapshot().map((identity) => ({
      ...identity,
      name: this.names.get(identity.id) ?? '',
      ...(this.models.has(identity.id) ? { requestedModel: this.models.get(identity.id)! } : {}),
      ...(this.instructionDigests.has(identity.id) ? { instructionDigest: this.instructionDigests.get(identity.id)! } : {}),
      ...(this.instructionMethods.has(identity.id) ? { instructionMethod: this.instructionMethods.get(identity.id)! } : {})
    }));
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
    id?: string;
    roleGroupId?: string;
    accountProfileId?: string;
    env?: Record<string, string | null>;
    launch?: boolean;
    requestedModel?: string | null;
    instructions?: SessionInstructionsInput;
  }): Promise<SessionView> {
    const executable = this.executableFor(input.provider);
    const requestedModel = normalizeRequestedModel(input.provider, input.requestedModel);
    const name = cleanName(input.name);
    if (!name) throw new SessionError('invalid-name');
    if (typeof input.cwd !== 'string' || !this.deps.directoryExists(input.cwd)) throw new SessionError('worktree-missing');
    await this.ready();
    this.inFlight += 1;
    let identity: SessionIdentity | undefined;
    try {
      const project = await this.deps.resolveProject(input.cwd);
      identity = {
        id: input.id ?? (this.deps.newId ?? randomId)(),
        repoId: project.repoId,
        roleGroupId: input.roleGroupId ?? UNASSIGNED,
        provider: input.provider,
        accountProfileId: input.accountProfileId ?? UNASSIGNED,
        worktree: input.cwd
      };
      this.open(identity, name, executable, input.launch !== false, input.env, requestedModel, input.instructions);
      await this.persist();
      return this.view(identity.id);
    } catch (error) {
      if (input.instructions?.plan) {
        cleanupSessionPlan(input.instructions.plan);
      }
      if (identity) {
        this.activePlans.delete(identity.id);
        if (this.handles.has(identity.id)) {
          const term = this.handles.get(identity.id);
          this.handles.delete(identity.id);
          if (term) {
            this.bound.delete(term);
            term.dispose();
          }
        }
      }
      throw error;
    } finally {
      this.inFlight -= 1;
    }
  }

  private open(
    identity: SessionIdentity,
    name: string,
    executable: string,
    launch: boolean,
    env?: Record<string, string | null>,
    requestedModel: string | null = null,
    instructions?: SessionInstructionsInput
  ): SessionView {
    const modelArgs = modelArguments(identity.provider, requestedModel);
    const instructionArgs = instructions?.argv ?? [];
    const allArgs = [...modelArgs, ...instructionArgs];
    if (launch && this.deps.executableAvailable && !this.deps.executableAvailable(executable)) {
      throw new SessionError('executable-not-found');
    }
    const title = this.deps.terminalTitle ? this.deps.terminalTitle(name) : name;
    const terminal = this.deps.terminals.create({ name: title, cwd: identity.worktree, ...(env ? { env } : {}) });
    const token = (this.deps.newToken ?? randomId)();
    try {
      this.registry.create(identity);
      this.registry.attachTerminal(identity.id, token);
    } catch (error) {
      terminal.dispose();
      throw error;
    }
    this.names.set(identity.id, name);
    if (requestedModel !== null) this.models.set(identity.id, requestedModel);
    if (instructions?.digest) this.instructionDigests.set(identity.id, instructions.digest);
    if (instructions?.method && instructions.method !== 'none') this.instructionMethods.set(identity.id, instructions.method);
    if (instructions?.plan) this.activePlans.set(identity.id, instructions.plan);

    if (instructions) {
      if (instructions.injectionState === 'manual') {
        this.instructionStates.set(identity.id, 'manual');
        this.instructionLabels.set(identity.id, instructions.injectionStatusLabel ?? 'Manual instructions paste required');
      } else if (instructions.injectionState === 'unsupported') {
        this.instructionStates.set(identity.id, 'unsupported');
        this.instructionLabels.set(identity.id, instructions.injectionStatusLabel ?? 'Provider does not support instructions');
      } else if (instructions.injectionState === 'prepared') {
        this.instructionStates.set(identity.id, launch ? 'launch-requested' : 'prepared');
        this.instructionLabels.set(identity.id, launch ? 'CLI launch requested with prepared injection arguments; awaiting CLI evidence' : 'Instructions prepared (shell not launched)');
      } else {
        this.instructionStates.set(identity.id, 'none');
        this.instructionLabels.set(identity.id, 'No instructions configured');
      }
    }

    this.bound.set(terminal, { id: identity.id, token });
    this.handles.set(identity.id, terminal);
    terminal.show();
    if (launch) {
      const shellType = this.deps.detectShellType?.();
      const commandLine = formatShellCommandLine(executable, allArgs, { shellType });
      terminal.sendText(commandLine, true);
      this.registry.launchRequested(identity.id, token);
    }
    return this.view(identity.id);
  }

  /**
   * Forward every terminal-close event here. Events for terminals this manager does not track are
   * ignored. Returns the session id that closed, so a caller holding a per-session resource (such
   * as a quota dispatch reservation) can release exactly that one, or null when this event named no
   * session of this manager's.
   */
  handleTerminalClosed(terminal: T): string | null {
    const binding = this.bound.get(terminal);
    if (!binding) return null;
    this.bound.delete(terminal);
    this.handles.delete(binding.id);
    const plan = this.activePlans.get(binding.id);
    if (plan) {
      cleanupSessionPlan(plan);
      this.activePlans.delete(binding.id);
    }
    try {
      this.registry.terminalClosed(binding.id, binding.token);
    } catch (error) {
      // A late event from a replaced terminal must not touch a newer attachment.
      if (!(error instanceof SessionError) || error.code !== 'stale-terminal-event') throw error;
    }
    return binding.id;
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
    const plan = this.activePlans.get(id);
    if (plan) {
      cleanupSessionPlan(plan);
      this.activePlans.delete(id);
    }
    try {
      if (binding) this.registry.terminalClosed(id, binding.token);
    } finally {
      // The terminal is released and forgotten even if recording the state failed.
      this.bound.delete(terminal);
      this.handles.delete(id);
      terminal.dispose();
    }
    return this.view(id);
  }

  /**
   * Opens a NEW session with the same project, role group, provider, account profile and
   * directory. The old session is kept as history and is never reused. The account cannot be
   * changed here: use `start` with another account for that.
   */
  async reopen(
    id: string,
    options: {
      newId?: string;
      launch?: boolean;
      acknowledgeUnknown?: boolean;
      env?: Record<string, string | null>;
      instructions?: SessionInstructionsInput;
    } = {}
  ): Promise<SessionView> {
    await this.ready();
    this.inFlight += 1;
    let identity: SessionIdentity | undefined;
    let shouldCleanupPlanOnError = true;
    try {
      const old = this.registry.get(id);
      if (!old) throw new SessionError('session-not-found');
      if (this.handles.has(id)) throw new SessionError('session-still-open');
      // After a restart a terminal from before may still be running a CLI in this folder, and this
      // window cannot see it. Reopening then risks a second writer, so it needs an explicit yes.
      if (old.state === 'unknown' && options.acknowledgeUnknown !== true) {
        shouldCleanupPlanOnError = false;
        throw new SessionError('confirm-unknown-reopen');
      }
      if (!this.deps.directoryExists(old.worktree)) throw new SessionError('worktree-missing');
      const executable = this.executableFor(old.provider);
      identity = {
        id: options.newId ?? (this.deps.newId ?? randomId)(),
        repoId: old.repoId,
        roleGroupId: old.roleGroupId,
        provider: old.provider,
        accountProfileId: old.accountProfileId,
        worktree: old.worktree
      };
      this.open(identity, this.names.get(id) || `${old.provider} session`, executable, options.launch !== false, options.env, this.models.get(id) ?? null, options.instructions);
      await this.persist();
      return this.view(identity.id);
    } catch (error) {
      if (shouldCleanupPlanOnError && options.instructions?.plan) {
        cleanupSessionPlan(options.instructions.plan);
      }
      if (identity) {
        this.activePlans.delete(identity.id);
        if (this.handles.has(identity.id)) {
          const term = this.handles.get(identity.id);
          this.handles.delete(identity.id);
          if (term) {
            this.bound.delete(term);
            term.dispose();
          }
        }
      }
      throw error;
    } finally {
      this.inFlight -= 1;
    }
  }

  /** For provider adapters: a verified provider event confirms the CLI. Account and provider must match the session. */
  observeCli(id: string, event: ProviderEvent & { instructionEvidence?: boolean; digest?: string }): SessionView {
    const terminal = this.liveTerminal(id);
    const binding = this.bound.get(terminal) as { id: string; token: string };
    this.registry.observeCli(id, binding.token, event);
    if (event.instructionEvidence === true || (event.digest && event.digest === this.instructionDigests.get(id))) {
      this.instructionStates.set(id, 'cli-observed');
      this.instructionLabels.set(id, 'CLI evidence recorded');
    }
    return this.view(id);
  }

  cliExited(id: string): SessionView {
    const terminal = this.liveTerminal(id);
    const binding = this.bound.get(terminal) as { id: string; token: string };
    this.registry.cliExited(id, binding.token);
    const plan = this.activePlans.get(id);
    if (plan) {
      cleanupSessionPlan(plan);
      this.activePlans.delete(id);
    }
    const prevState = this.instructionStates.get(id);
    if (prevState && prevState !== 'none') {
      this.instructionLabels.set(id, 'CLI exited (instructions file cleaned up; reopen as new session to relaunch)');
    }
    return this.view(id);
  }

  get(id: string): SessionView | null {
    return this.registry.get(id) ? this.view(id) : null;
  }

  list(repoId?: string): SessionView[] {
    return this.registry.list(repoId).map((entry) => this.view(entry.id));
  }
}
