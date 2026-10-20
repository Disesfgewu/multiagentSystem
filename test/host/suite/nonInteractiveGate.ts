import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { setExtensionTestMode } from '../../../src/shared/testMode';
import { ACCOUNT_COMMANDS } from '../../../src/accounts/accountCommands';
import { overviewTreeForTests } from '../../../src/overview/overviewView';

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
 * `answer` may instead reply to a recorded prompt (for example with a dialog button), to show what
 * happens after the person agrees; it returns undefined to dismiss.
 */
export async function outsideTestMode<T>(
  body: (prompts: string[]) => Promise<T>,
  answer: (prompt: string) => unknown = () => undefined
): Promise<{ result: T; prompts: string[] }> {
  const ui = vscode.window as unknown as Record<string, unknown>;
  const original = new Map(DIALOGS.map((name) => [name, ui[name]]));
  const prompts: string[] = [];
  for (const name of DIALOGS) {
    ui[name] = async (first: unknown, second: unknown) => {
      const prompt = describe(name, first, second);
      prompts.push(prompt);
      return answer(prompt);
    };
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

type Outcome = { ok: boolean; code?: string; session?: { id: string }; sessions?: Array<{ id?: string; name: string; terminalOpen?: boolean }> };

/**
 * sessions.stop with a caller-supplied id (Refs #192): outside test mode the person confirms the named
 * session first; a dismissed dialog stops nothing. The overview row's own Stop action asks nothing extra.
 */
export async function runCallerStopChecks(workspace: string): Promise<string> {
  const run = <T>(id: string, options: unknown) => Promise.resolve(vscode.commands.executeCommand<T>(id, options));
  const start = async (name: string): Promise<string> => {
    const started = await run<Outcome>('multiagentSystem.sessions.start', { interactive: false, provider: 'claude', name, cwd: workspace, launch: false });
    assert.equal(started.ok, true, JSON.stringify(started));
    return started.session?.id as string;
  };
  const isOpen = async (id: string) => (await run<Outcome>('multiagentSystem.sessions.list', { interactive: false })).sessions?.find((entry) => entry.id === id)?.terminalOpen;
  const first = await start('Caller Stop Target');
  const second = await start('Caller Stop Confirmed');
  try {
    for (const payload of [{ id: first }, { id: first, interactive: false }]) {
      const attempt = await outsideTestMode(() => run<Outcome>('multiagentSystem.sessions.stop', payload));
      assert.deepEqual([attempt.result.ok, attempt.result.code], [false, 'cancelled'], JSON.stringify(payload));
      assert.deepEqual(attempt.prompts, ['Stop session "Caller Stop Target"?'], 'one dialog naming the session');
      assert.equal(await isOpen(first), true, 'a dismissed dialog stops nothing');
    }

    const rows = (await overviewTreeForTests().getChildren()) ?? [];
    const row = rows.find((entry) => entry.label === 'Caller Stop Target');
    assert.ok(row, 'the session has an overview row');
    // A copy of the row is a caller's object, not the row the person clicked.
    const copied = await outsideTestMode(() => run<Outcome>('multiagentSystem.sessions.stop', { ...row }));
    assert.equal(copied.result.code, 'cancelled');
    assert.equal(copied.prompts.length, 1);
    assert.equal(await isOpen(first), true);

    // The overview's inline Stop action passes its own row: the click is the decision, no extra dialog.
    const clicked = await outsideTestMode(() => run<Outcome>('multiagentSystem.sessions.stop', row));
    assert.equal(clicked.result.ok, true, JSON.stringify(clicked.result));
    assert.deepEqual(clicked.prompts, []);
    assert.equal(await isOpen(first), false);

    // Confirming the dialog stops the named session, with exactly one question.
    const confirmed = await outsideTestMode(() => run<Outcome>('multiagentSystem.sessions.stop', { id: second }), (prompt) => (prompt.startsWith('Stop session') ? 'Stop Session' : undefined));
    assert.equal(confirmed.result.ok, true, JSON.stringify(confirmed.result));
    assert.deepEqual(confirmed.prompts, ['Stop session "Caller Stop Confirmed"?']);
    assert.equal(await isOpen(second), false);
  } finally {
    for (const id of [first, second]) if (await isOpen(id)) await run('multiagentSystem.sessions.stop', { id, interactive: false });
  }
  return 'host smoke: outside test mode a caller-supplied sessions.stop id asks the person (cancel keeps the terminal); the overview row Stop asks nothing extra';
}

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

  const statusLineAttempt = await outsideTestMode(() => run<{ ok: boolean; status?: string }>(ACCOUNT_COMMANDS.configureStatusLine, { id: 'acct-does-not-exist', interactive: false, consent: true }));
  assert.equal(statusLineAttempt.result?.ok, false, 'outside test mode configureStatusLine fails closed');
  assert.ok(statusLineAttempt.prompts.length > 0, 'outside test mode configureStatusLine reports to user instead of executing silently');

  // Registration is checked in index.ts; here only that the interactive-only hook bridge command cannot be driven silently.
  const hooksAttempt = await outsideTestMode(() => run<{ ok: boolean; status?: string }>(ACCOUNT_COMMANDS.configureHooks, { id: 'acct-does-not-exist', interactive: false, consent: true, action: 'enable' }));
  assert.equal(hooksAttempt.result?.ok, false, 'outside test mode configureHooks fails closed');
  assert.ok(hooksAttempt.prompts.length > 0, 'outside test mode configureHooks reports to the user instead of executing silently');

  return 'host smoke: outside test mode interactive:false no longer skips the session-start account prompt, account check report, statusLine wizard, or hook bridge command';
}
