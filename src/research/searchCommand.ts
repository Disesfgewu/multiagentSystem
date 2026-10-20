import { requireInteractive } from '../shared/testMode';

// The body of the "Research: Search Papers" command, apart from the editor's dialogs (passed in as `ui`), so it can be
// run and tested without VS Code. Whether the caller may answer for the person is decided HERE, from the extension's
// test mode: in an installed extension `requireInteractive` turns `interactive: false` into `true`, so the person is
// asked and no argument can pick the server, type the query or confirm it.

const { runSearchFlow, searchGiven } = require('./search-flow') as {
  runSearchFlow(input: { lifecycle: unknown; ui: SearchUi; given?: { serverId?: unknown; tool?: unknown; query?: unknown } }): Promise<{ ok: boolean; code?: string; truncated?: boolean }>;
  searchGiven(arg: unknown, options: { testMode: boolean }): { serverId?: unknown; tool?: unknown; query?: unknown } | undefined;
};

export interface SearchUi {
  pick(choices: Array<{ serverId: string; tool: string }>): Promise<{ serverId: string; tool: string } | undefined>;
  promptQuery(): Promise<string | undefined>;
  confirm(text: string): Promise<boolean>;
  show(result: { payload: string; truncated: boolean }): Promise<void> | void;
}

export type SearchArgument = { serverId?: unknown; tool?: unknown; query?: unknown; interactive?: boolean };

export async function runSearchCommand(arg: SearchArgument | undefined, lifecycle: unknown, ui: SearchUi): Promise<{ outcome: { ok: boolean; code?: string; truncated?: boolean }; interactive: boolean }> {
  const interactive = requireInteractive(arg ?? {}).interactive !== false;
  const given = searchGiven(arg, { testMode: !interactive });
  return { outcome: await runSearchFlow({ lifecycle, ui, given }), interactive };
}
