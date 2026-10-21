import { requireInteractive } from '../shared/testMode';

// The body of "Start Custom Provider Terminal", apart from the editor's own pieces (passed in as `ui` and `state`), so it can be
// run and tested without VS Code. Whether the caller may answer for the person is decided HERE from the extension's test mode:
// in an installed extension `requireInteractive` turns `interactive: false` into `true`, so the person picks and confirms.

const { planCustomLaunch } = require('./custom-launch') as {
  planCustomLaunch(input: { providers: unknown[]; id: unknown; trusted: boolean; cwd: unknown; folders: string[]; confirmed: string[] }, options?: object): PlanResult;
};

type Launch = { shellPath: string; shellArgs: string[]; cwd: string; env: Record<string, string | null> };
type PlanResult = { ok: true; label: string; key: string; needsConfirmation: boolean; detail: string; launch: Launch } | { ok: false; reason: string };

export interface CustomStartUi {
  pick(providers: Array<{ id: string; label: string }>): Promise<string | undefined>;
  confirm(label: string, detail: string): Promise<boolean>;
  launch(label: string, launch: Launch): void;
}
export interface CustomStartState {
  confirmed(): string[];
  remember(key: string): void;
}
export type CustomStartArgument = { id?: unknown; interactive?: boolean };

const MAX_REMEMBERED = 50;

export async function runCustomStart(input: {
  arg: CustomStartArgument | undefined;
  providers: Array<{ id: string; label: string; executable: string; args: string[] }>;
  trusted: boolean;
  cwd: string | undefined;
  folders: string[];
  ui: CustomStartUi;
  state: CustomStartState;
  env?: NodeJS.ProcessEnv;
  platform?: string;
}): Promise<{ ok: boolean; code?: string }> {
  const { arg, providers, ui, state } = input;
  if (providers.length === 0) return { ok: false, code: 'no-custom-providers' };
  // Before anything is asked: a workspace that is not trusted starts nothing.
  if (input.trusted !== true) return { ok: false, code: 'workspace-untrusted' };
  // Only the Extension Host tests may answer for the person (the #183 rule).
  const interactive = requireInteractive(arg ?? {}).interactive !== false;
  const id = interactive ? await ui.pick(providers.map((provider) => ({ id: provider.id, label: provider.label }))) : arg?.id;
  if (id === undefined) return { ok: false, code: 'cancelled' };
  const plan = planCustomLaunch(
    { providers, id, trusted: input.trusted, cwd: input.cwd, folders: input.folders, confirmed: state.confirmed() },
    { ...(input.env ? { env: input.env } : {}), ...(input.platform ? { platform: input.platform } : {}) }
  );
  if (!plan.ok) return { ok: false, code: plan.reason };
  if (plan.needsConfirmation && interactive) {
    if (!await ui.confirm(plan.label, plan.detail)) return { ok: false, code: 'cancelled' };
    state.remember(plan.key);
  } else if (plan.needsConfirmation) {
    // A test that answers for the person leaves nothing remembered either.
  }
  ui.launch(plan.label, plan.launch);
  return { ok: true };
}

export const rememberKey = (list: string[], key: string): string[] => [...list.filter((entry) => entry !== key), key].slice(-MAX_REMEMBERED);
