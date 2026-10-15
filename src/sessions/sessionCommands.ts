import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { PROVIDERS, errorMessage, terminalTitle } from '../agents';
import { WorktreeService } from '../projects/worktrees';
import { SessionManager, SessionView } from './manager';
import { accountService, launchEnvironment } from '../accounts/accountRuntime';

export const SESSION_COMMANDS = {
  list: 'multiagentSystem.sessions.list',
  start: 'multiagentSystem.sessions.start',
  focus: 'multiagentSystem.sessions.focus',
  stop: 'multiagentSystem.sessions.stop',
  reopen: 'multiagentSystem.sessions.reopen'
} as const;

const MESSAGES: Record<string, string> = {
  'provider-unsupported': 'That CLI provider is not supported.',
  'invalid-name': 'Enter a session name.',
  'session-not-found': 'That session no longer exists.',
  'terminal-not-open': 'The session has no open terminal in this window.',
  'session-still-open': 'The session still has an open terminal. Stop it first, or focus it.',
  'worktree-missing': 'The folder does not exist, so no terminal was started there.',
  'invalid-snapshot': 'Saved sessions could not be read. They were left untouched and nothing will be saved in this window.',
  'store-unavailable': 'Saved sessions could not be loaded. They were left untouched and nothing will be saved in this window.',
  'confirm-unknown-reopen': 'This session\'s earlier terminal may still be running in that folder. Confirm to open a new one anyway.'
};

export interface SessionCommandOptions {
  interactive?: boolean;
  id?: string;
  provider?: string;
  name?: string;
  cwd?: string;
  /** false opens only the shell and types nothing (used by the Extension Host smoke test). */
  launch?: boolean;
  /** Needed to reopen a session whose earlier terminal this window cannot see. */
  acknowledgeUnknown?: boolean;
  accountProfileId?: string;
}

export type SessionOutcome =
  | { ok: true; session?: SessionView; sessions?: SessionView[] }
  | { ok: false; code: string; message: string };

export interface SessionCommands {
  launch(options: SessionCommandOptions): Promise<SessionOutcome>;
  launchWithAccount(options: SessionCommandOptions): Promise<SessionOutcome>;
  list(): SessionView[];
  onDidChange(listener: () => void): vscode.Disposable;
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

// The repo identity is a private local value. It never goes to GitHub.
async function resolveProject(cwd: string): Promise<{ repoId: string }> {
  try {
    const service = await WorktreeService.open(cwd);
    return { repoId: service.githubRepository ?? `local:${digest(service.commonDir)}` };
  } catch {
    return { repoId: `folder:${digest(cwd)}` };
  }
}

function failure(error: unknown, interactive: boolean): SessionOutcome {
  const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'unexpected-error';
  const message = MESSAGES[code] ?? `Unexpected error: ${errorMessage(error)}`;
  if (interactive) void vscode.window.showErrorMessage(message);
  return { ok: false, code, message };
}

function workspaceFolder(): string | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders.length === 1 ? folders[0].uri.fsPath : undefined;
}

export function registerSessionCommands(context: vscode.ExtensionContext): SessionCommands {
  const changed = new vscode.EventEmitter<void>();
  context.subscriptions.push(changed);
  const manager = new SessionManager<vscode.Terminal>({
    terminals: {
      create: ({ name, cwd, env }) => vscode.window.createTerminal({ name, cwd, env, location: vscode.TerminalLocation.Editor })
    },
    providers: Object.fromEntries(PROVIDERS.map((provider) => [provider.executable, provider.executable])),
    resolveProject,
    directoryExists: (target) => {
      try {
        return fs.statSync(target).isDirectory();
      } catch {
        return false;
      }
    },
    terminalTitle,
    // No private storage exists yet (#9), so sessions live only while this window is open.
    onPersistError: () => void vscode.window.showWarningMessage('Session records could not be saved.'),
    onPersistenceBlocked: () =>
      void vscode.window.showWarningMessage('Saved sessions could not be read, so sessions are not being saved in this window. The saved data was left untouched.')
  });

  const options = (value: unknown): SessionCommandOptions =>
    value && typeof value === 'object' ? (value as SessionCommandOptions) : {};

  async function launch(input: SessionCommandOptions): Promise<SessionOutcome> {
    const interactive = input.interactive !== false;
    try {
      const cwd = input.cwd ?? workspaceFolder();
      if (!cwd) throw Object.assign(new Error('no folder'), { code: 'no-folder' });
      let accountProfileId = input.accountProfileId;
      const provider = input.provider ?? '';
      if (!accountProfileId && interactive && (provider === 'claude' || provider === 'codex')) {
        const available = await accountService(() => manager.list());
        if (!available.ok) return failure(Object.assign(new Error(available.message), { code: available.code }), true);
        const listed = available.service.list();
        if (!listed.ok) return failure(Object.assign(new Error(listed.message), { code: listed.code }), true);
        const profiles = listed.profiles.filter((profile: { provider: string }) => profile.provider === provider);
        const choice = await vscode.window.showQuickPick([
          { label: 'Use the CLI default account', description: 'Not isolated or verified by this extension', id: 'unassigned' },
          ...profiles.map((profile: { id: string; label: string }) => ({ label: profile.label, description: 'Account identity: unknown until observed', id: profile.id }))
        ], { placeHolder: 'Choose an account for this new session' });
        if (!choice) return { ok: false, code: 'cancelled', message: 'Cancelled.' };
        accountProfileId = choice.id === 'unassigned' ? undefined : choice.id;
      }
      return await startWithAccount({ ...input, provider, cwd, accountProfileId });
    } catch (error) {
      if ((error as { code?: string })?.code === 'no-folder') {
        const message = 'Open a single project folder first.';
        if (interactive) void vscode.window.showErrorMessage(message);
        return { ok: false, code: 'no-folder', message };
      }
      return failure(error, interactive);
    }
  }

  async function startWithAccount(input: SessionCommandOptions): Promise<SessionOutcome> {
    const interactive = input.interactive !== false;
    try {
      const cwd = input.cwd ?? workspaceFolder();
      if (!cwd) throw Object.assign(new Error('no folder'), { code: 'no-folder' });
      const provider = input.provider ?? '';
      let env: Record<string, string | null> | undefined;
      if (input.accountProfileId) {
        const prepared = await launchEnvironment(input.accountProfileId, provider, () => manager.list());
        if (!prepared.ok) return failure(Object.assign(new Error(prepared.message), { code: prepared.code }), interactive);
        if (interactive) {
          const answer = await vscode.window.showWarningMessage(
            'Account isolation is not verified for this CLI on this machine.',
            { modal: true, detail: 'The extension sets the provider configuration directory for this new terminal and removes inherited credential overrides. Confirm the CLI uses that directory before entering sensitive work.' },
            'Continue'
          );
          if (answer !== 'Continue') return { ok: false, code: 'cancelled', message: 'Cancelled.' };
        }
        env = prepared.env;
      }
      const session = await manager.start({
        provider,
        name: input.name ?? '',
        cwd,
        accountProfileId: input.accountProfileId,
        env,
        launch: input.launch
      });
      changed.fire();
      return { ok: true, session };
    } catch (error) {
      return failure(error, interactive);
    }
  }

  async function pickSession(placeholder: string, filter: (session: SessionView) => boolean): Promise<SessionView | undefined> {
    const sessions = manager.list().filter(filter);
    if (sessions.length === 0) {
      void vscode.window.showInformationMessage('No matching sessions.');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      sessions.map((session) => ({
        label: session.name,
        description: `${session.provider} · ${session.stateLabel}`,
        detail: `account: ${session.accountProfileId} · ${session.worktree}`,
        session
      })),
      { placeHolder: placeholder, matchOnDescription: true, matchOnDetail: true }
    );
    return picked?.session;
  }

  async function act(action: 'focus' | 'stop' | 'reopen', value: unknown): Promise<SessionOutcome> {
    const input = options(value);
    const interactive = input.interactive !== false;
    try {
      let id = input.id;
      if (!id) {
        if (!interactive) throw Object.assign(new Error('id'), { code: 'session-not-found' });
        const wantsOpen = action !== 'reopen';
        const picked = await pickSession(`Choose a session to ${action}`, (session) => session.terminalOpen === wantsOpen);
        if (!picked) return { ok: false, code: 'cancelled', message: 'Cancelled.' };
        id = picked.id;
      }
      let session: SessionView;
      if (action === 'focus') session = manager.focus(id);
      else if (action === 'stop') session = manager.stop(id);
      else {
        const prior = manager.list().find((entry) => entry.id === id);
        let env: Record<string, string | null> | undefined;
        if (prior && prior.accountProfileId !== 'unassigned') {
          const prepared = await launchEnvironment(prior.accountProfileId, prior.provider, () => manager.list());
          if (!prepared.ok) return failure(Object.assign(new Error(prepared.message), { code: prepared.code }), interactive);
          if (interactive) {
            const answer = await vscode.window.showWarningMessage(
              'Account isolation is not verified for this CLI on this machine.',
              { modal: true, detail: 'The profile will be revalidated and its configuration directory applied to the new terminal.' },
              'Continue'
            );
            if (answer !== 'Continue') return { ok: false, code: 'cancelled', message: 'Cancelled.' };
          }
          env = prepared.env;
        }
        try {
          session = await manager.reopen(id, { launch: input.launch, acknowledgeUnknown: input.acknowledgeUnknown, env });
        } catch (error) {
          // The earlier terminal may still be running in the folder: ask before starting a second one.
          if (!interactive || (error as { code?: string })?.code !== 'confirm-unknown-reopen') throw error;
          const answer = await vscode.window.showWarningMessage(
            'A terminal from before this window started may still be running in the same folder.',
            { modal: true, detail: 'Opening another one could mean two agents writing to the same files. Check the terminals first.' },
            'Open Anyway'
          );
          if (answer !== 'Open Anyway') return { ok: false, code: 'cancelled', message: 'Cancelled.' };
          session = await manager.reopen(id, { launch: input.launch, acknowledgeUnknown: true, env });
        }
      }
      changed.fire();
      return { ok: true, session };
    } catch (error) {
      return failure(error, interactive);
    }
  }

  async function list(value: unknown): Promise<SessionOutcome> {
    const input = options(value);
    if (input.interactive === false) return { ok: true, sessions: manager.list() };
    const picked = await pickSession('Sessions in this window (state is shown only when there is evidence)', () => true);
    if (!picked) return { ok: true, sessions: manager.list() };
    const actions = picked.terminalOpen ? ['Focus Terminal', 'Stop Terminal'] : ['Reopen as New Session'];
    const choice = await vscode.window.showQuickPick(actions, { placeHolder: `${picked.name}: ${picked.stateLabel}` });
    if (choice === 'Focus Terminal') await act('focus', { id: picked.id });
    else if (choice === 'Stop Terminal') await act('stop', { id: picked.id });
    else if (choice === 'Reopen as New Session') await act('reopen', { id: picked.id });
    return { ok: true, sessions: manager.list() };
  }

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => { manager.handleTerminalClosed(terminal); changed.fire(); }),
    vscode.commands.registerCommand(SESSION_COMMANDS.list, (value?: unknown) => list(value)),
    vscode.commands.registerCommand(SESSION_COMMANDS.start, (value?: unknown) => launch(options(value))),
    vscode.commands.registerCommand(SESSION_COMMANDS.focus, (value?: unknown) => act('focus', value)),
    vscode.commands.registerCommand(SESSION_COMMANDS.stop, (value?: unknown) => act('stop', value)),
    vscode.commands.registerCommand(SESSION_COMMANDS.reopen, (value?: unknown) => act('reopen', value))
  );

  void manager.initialize().catch((error) => failure(error, true));
  return { launch, launchWithAccount: startWithAccount, list: () => manager.list(), onDidChange: (listener) => changed.event(listener) };
}
