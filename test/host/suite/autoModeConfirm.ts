import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { confirmAutoModeOnce } from '../../../src/sessions/sessionCommands';

/** The one-time auto-mode window, with a stand-in for the extension's remembered state and the window answered by the test. */
export async function runAutoModeConfirmChecks(): Promise<void> {
  const memory = new Map<string, unknown>();
  const context = { globalState: { get: (key: string) => memory.get(key), update: async (key: string, value: unknown) => { memory.set(key, value); } } } as unknown as vscode.ExtensionContext;
  const ui = vscode.window as any;
  const original = ui.showWarningMessage;
  const shown: Array<{ message: string; detail: string; buttons: string[] }> = [];
  let answer: string | undefined;
  ui.showWarningMessage = async (message: string, options: { detail?: string; modal?: boolean }, ...buttons: string[]) => { assert.equal(options.modal, true); shown.push({ message, detail: String(options.detail ?? ''), buttons }); return answer; };
  const on = { auto: { state: 'on' }, lines: ['Auto mode: on (won\'t ask for each approval)'] };
  try {
    for (const quiet of [{ auto: { state: 'off' }, lines: [] }, { auto: { state: 'unknown' }, lines: [] }, { auto: undefined, lines: [] }]) assert.equal(await confirmAutoModeOnce(context, quiet as never), true);
    assert.equal(shown.length, 0, 'auto mode off, unknown or not applicable asks nothing');
    answer = undefined;
    assert.equal(await confirmAutoModeOnce(context, on as never), false, 'dismissing starts nothing');
    assert.equal(memory.size, 0, 'and remembers nothing');
    assert.ok(shown[0].detail.includes('Auto mode: on') && shown[0].detail.includes('agents.autoMode'), 'the window says what it means and how to turn it off');
    answer = 'I Understand, Continue';
    assert.equal(await confirmAutoModeOnce(context, on as never), true);
    assert.equal(memory.size, 1);
    shown.length = 0;
    answer = undefined;
    assert.equal(await confirmAutoModeOnce(context, on as never), true, 'asked once');
    assert.equal(shown.length, 0);
  } finally { ui.showWarningMessage = original; }
  console.log('host smoke: the first auto-mode launch asks once, declining starts nothing and is not remembered, and the answer is remembered per user');
}
