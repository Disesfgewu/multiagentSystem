// What "start a session" does about isolation (issue #25), apart from the editor's own pieces (passed in as `ui`), so it can be
// run and tested without VS Code. Advice mode is the default and changes nothing. Enforced mode is only ever the person's own
// choice in their user settings; when it is chosen and cannot be provided, the launch is refused, never run without it.

const { prepareEnforcedLaunch } = require('./enforced-launch') as {
  prepareEnforcedLaunch(input: Record<string, unknown>): Promise<
    | { ok: true; wrapCommand(executable: string, args: string[]): { executable: string; args: string[] }; env: Record<string, string | null>; summary: string[]; dispose(): Promise<void> }
    | { ok: false; code: string; reasons: string[]; notice: string }
  >;
};

export type Wrap = (executable: string, args: string[]) => { executable: string; args: string[] };
export type EnforcedStartResult =
  | { kind: 'advisory' }
  | { kind: 'enforced'; wrap: Wrap; env: Record<string, string | null>; dispose(): Promise<void> }
  | { kind: 'refused'; code: string; message: string };

export interface EnforcedStartUi {
  /** Shown before an enforced launch: what is proven and what is not. Resolves true only when the person goes ahead. */
  confirm(lines: string[]): Promise<boolean>;
  /** Runs the (slow) preparation with a progress indicator. */
  progress<T>(work: () => Promise<T>): Promise<T>;
}

const REFUSALS: Record<string, string> = {
  'isolation-mode-invalid': 'The isolation mode setting is not "advisory" or "enforced", so nothing was started. Fix multiagentSystem.isolation.mode in your user settings.',
  'platform-not-supported-win32': 'Windows does not support managed isolation yet (a restricted token cannot block the network), so nothing was started. Set multiagentSystem.isolation.mode back to advisory in your user settings to start.',
  'platform-not-supported': 'Managed isolation is only available on macOS for now, so nothing was started. Set multiagentSystem.isolation.mode back to advisory in your user settings to start.',
  'storage-unavailable': 'Enforced isolation needs the extension\'s private storage, which is unavailable, so nothing was started.',
  'cancelled': 'Cancelled.'
};

/**
 * @param input.mode the user-level value of `multiagentSystem.isolation.mode` (undefined when the person never set it)
 * @param input.allowedDomains the user-level value of `multiagentSystem.isolation.allowedDomains`
 * @param input.interactive false only when an Extension Host test answers for the person (the caller decides that with `requireInteractive`)
 * @param input.cwd the folder the CLI will work in; its git directories are protected like the ones the harness probed
 * @param input.storageDir a folder inside the extension's private storage, or undefined when there is none
 */
export async function prepareIsolationForStart(input: {
  mode: unknown;
  allowedDomains: unknown;
  interactive: boolean;
  storageDir: string | undefined;
  home: string;
  cwd: string;
  platform?: string;
  createHarness: (options: { tmpRoot: string }) => unknown;
  ui: EnforcedStartUi;
  prepare?: typeof prepareEnforcedLaunch;
}): Promise<EnforcedStartResult> {
  if (input.mode === undefined || input.mode === 'advisory') return { kind: 'advisory' };
  if (input.mode !== 'enforced') return { kind: 'refused', code: 'isolation-mode-invalid', message: REFUSALS['isolation-mode-invalid'] };
  // Before anything else: no storage lookup, no progress indicator, no probe, no script. Windows is advisory only (#26): its
  // restricted token keeps credential files and variables out of reach but cannot stop network use, so enforced can never be proven.
  const platform = input.platform ?? process.platform;
  if (platform !== 'darwin') return { kind: 'refused', code: 'platform-not-supported', message: REFUSALS[platform === 'win32' ? 'platform-not-supported-win32' : 'platform-not-supported'] };
  if (!input.storageDir) return { kind: 'refused', code: 'storage-unavailable', message: REFUSALS['storage-unavailable'] };
  const prepared = await input.ui.progress(() => (input.prepare ?? prepareEnforcedLaunch)({
    ...(input.platform ? { platform: input.platform } : {}),
    allowedDomains: input.allowedDomains,
    storageDir: input.storageDir,
    home: input.home,
    cwd: input.cwd,
    createHarness: input.createHarness
  }));
  if (!prepared.ok) {
    // Short codes only: the reasons are channel names, never paths or accounts.
    const why = prepared.reasons.length > 0 ? `\nReasons: ${prepared.reasons.join(', ')}` : '';
    return { kind: 'refused', code: prepared.code, message: `${prepared.notice}${why}` };
  }
  if (input.interactive) {
    const lines = [
      ...prepared.summary,
      'This is the enforced mode you chose in your settings. Starting with it is not the same as the CLI working through it.'
    ];
    if (!await input.ui.confirm(lines)) {
      await prepared.dispose();
      return { kind: 'refused', code: 'cancelled', message: REFUSALS['cancelled'] };
    }
  }
  return { kind: 'enforced', wrap: prepared.wrapCommand, env: prepared.env, dispose: prepared.dispose };
}
