import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { setExtensionTestMode } from '../../../src/shared/testMode';
import { ACCOUNT_COMMANDS } from '../../../src/accounts/accountCommands';

const DIALOGS = ['showWarningMessage', 'showInformationMessage', 'showErrorMessage', 'showQuickPick', 'showInputBox', 'showWorkspaceFolderPick'] as const;

function describe(name: string, first: unknown, second: unknown): string {
  if (typeof first === 'string') return first;
  const options = (name === 'showQuickPick' ? second : first) as { placeHolder?: string; prompt?: string } | undefined;
  return `${name}: ${options?.prompt ?? options?.placeHolder ?? ''}`;
}

/**
 * Runs `body` as an installed extension would run (not ExtensionMode.Test), so `interactive: false`
 * and similar arguments must no longer be honoured (Refs #183). Every dialog is answered as if the
 * person dismissed it, and recorded, so a forced prompt cannot hang the headless Extension Host.
 */
export async function outsideTestMode<T>(body: (prompts: string[]) => Promise<T>): Promise<{ result: T; prompts: string[] }> {
  const ui = vscode.window as unknown as Record<string, unknown>;
  const original = new Map(DIALOGS.map((name) => [name, ui[name]]));
  const prompts: string[] = [];
  for (const name of DIALOGS) {
    ui[name] = async (first: unknown, second: unknown) => { prompts.push(describe(name, first, second)); return undefined; };
  }
  setExtensionTestMode(false);
  try {
    const result = await body(prompts);
    return { result, prompts: [...prompts] };
  } finally {
    setExtensionTestMode(true);
    for (const name of DIALOGS) ui[name] = original.get(name);
  }
}

type Outcome = { ok: boolean; code?: string; sessions?: Array<{ name: string }> };

/** Session start and account check: a payload cannot start an agent or run a CLI unseen. */
export async function runNonInteractiveGateChecks(workspace: string): Promise<string> {
  const run = <T>(id: string, options: object) => Promise.resolve(vscode.commands.executeCommand<T>(id, options));

  const started = await outsideTestMode(() => run<Outcome>('multiagentSystem.sessions.start', { interactive: false, provider: 'claude', name: 'Bypass Attempt', cwd: workspace, launch: false }));
  assert.deepEqual([started.result.ok, started.result.code], [false, 'cancelled'], 'outside test mode sessions.start asks before starting');
  assert.ok(started.prompts.some((prompt) => prompt.includes('Choose an account for this new session')), started.prompts.join(' | '));
  const listed = await run<Outcome>('multiagentSystem.sessions.list', { interactive: false });
  assert.equal(listed.sessions?.some((session) => session.name === 'Bypass Attempt'), false, 'no session was recorded');
  assert.equal(vscode.window.terminals.some((terminal) => terminal.name === 'Multiagent: Bypass Attempt'), false, 'no terminal was opened');

  const checked = await outsideTestMode(() => run<unknown>(ACCOUNT_COMMANDS.check, { id: 'acct-does-not-exist', interactive: false }));
  assert.equal(checked.result, undefined);
  assert.ok(checked.prompts.length > 0, 'outside test mode account check reports to the person instead of running silently');
  return 'host smoke: outside test mode interactive:false no longer skips the session-start account prompt or the account check report';
}
