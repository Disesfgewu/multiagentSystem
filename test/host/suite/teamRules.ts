import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { privateStorage } from '../../../src/storage/storageCommands';
import { TeamRulesStore } from '../../../src/teamRules/store';

/** "Edit Team Rules" in a real Extension Host: the windows are answered by the test; the result is read back from the private store. */
export async function runTeamRulesChecks(): Promise<void> {
  const opened = await privateStorage()?.use();
  assert.ok(opened?.ok);
  const rules = new TeamRulesStore(opened.store as any);
  const before = (rules.get() as { doc: { version: number; rules: Array<{ text: string }> } }).doc;
  const ui = vscode.window as any;
  const original = { pick: ui.showQuickPick, input: ui.showInputBox, warning: ui.showWarningMessage, info: ui.showInformationMessage, error: ui.showErrorMessage };
  let confirm: string | undefined;
  const shown: string[] = [];
  const errors: string[] = [];
  ui.showQuickPick = async (items: any[]) => items.find((item) => item.value === 'add');
  ui.showInputBox = async () => 'Check the host smoke rule.';
  ui.showWarningMessage = async (message: string, options: { detail?: string }, ...buttons: string[]) => { shown.push(`${message}\n${options?.detail ?? ''}`); return buttons.includes(String(confirm)) ? confirm : undefined; };
  ui.showInformationMessage = async () => undefined;
  ui.showErrorMessage = async (message: string) => { errors.push(message); return undefined; };
  try {
    // Dismissing the confirmation saves nothing.
    confirm = undefined;
    await vscode.commands.executeCommand('multiagentSystem.teamRules.edit', { rules: ['injected'], text: 'injected' });
    assert.equal((rules.get() as any).doc.version, before.version, 'no confirmation, no change');
    assert.ok(shown[0]?.includes('Check the host smoke rule.') && shown[0].includes('not enforce'), 'the person saw the rule and that it is not enforced');

    // Confirming saves one new version with exactly the typed rule; an argument changes nothing.
    confirm = 'Save';
    await vscode.commands.executeCommand('multiagentSystem.teamRules.edit', { rules: ['injected'], text: 'injected' });
    const after = (rules.get() as any).doc as { version: number; rules: Array<{ text: string }> };
    assert.equal(after.version, before.version + 1);
    assert.deepEqual(after.rules.slice(before.rules.length).map((rule) => rule.text), ['Check the host smoke rule.']);
    assert.equal(errors.length, 0);
  } finally {
    // Leave the store as it was found.
    const restore = (rules.get() as any).doc;
    if (restore.version !== before.version) {
      const emptied = { ...before, version: restore.version + 1, updatedAt: new Date().toISOString() };
      rules.save(emptied, restore.version);
    }
    ui.showQuickPick = original.pick;
    ui.showInputBox = original.input;
    ui.showWarningMessage = original.warning;
    ui.showInformationMessage = original.info;
    ui.showErrorMessage = original.error;
  }
  console.log('host smoke: Edit Team Rules saves exactly the typed rule as a new version only after the confirmation, and ignores arguments');
}

/**
 * #362: Edit Team Rules offers the suggested "decide routine matters yourself" rule until it is in the list; it is added only after
 * the same confirmation as any rule, and then no longer offered.
 */
export async function runSuggestedTeamRuleChecks(): Promise<void> {
  const opened = await privateStorage()?.use();
  assert.ok(opened?.ok);
  const rules = new TeamRulesStore(opened.store as any);
  const before = (rules.get() as { doc: { version: number; rules: Array<{ text: string }> } }).doc;
  const ui = vscode.window as any;
  const original = { pick: ui.showQuickPick, warning: ui.showWarningMessage, info: ui.showInformationMessage };
  const offered: string[][] = [];
  let confirm: string | undefined;
  const shown: string[] = [];
  ui.showQuickPick = async (items: any[]) => { offered.push(items.map((item) => item.label)); return items.find((item) => item.value === 'suggested'); };
  ui.showWarningMessage = async (message: string, options: { detail?: string }, ...buttons: string[]) => { shown.push(`${message}\n${options?.detail ?? ''}`); return buttons.includes(String(confirm)) ? confirm : undefined; };
  ui.showInformationMessage = async () => undefined;
  const suggested = '例行決定自行判斷並繼續，不要停下來詢問；只有在無法繼續、會刪除資料、或會對外發佈時才詢問管理者。';
  try {
    confirm = undefined;
    await vscode.commands.executeCommand('multiagentSystem.teamRules.edit');
    assert.ok(offered[0]?.includes('Add the suggested rule: Decide routine matters yourself'), JSON.stringify(offered[0]));
    assert.ok(shown[0]?.includes(suggested), 'the person sees the whole rule before it is saved');
    assert.equal((rules.get() as any).doc.version, before.version, 'not confirmed: not added');
    confirm = 'Save';
    await vscode.commands.executeCommand('multiagentSystem.teamRules.edit');
    const after = (rules.get() as any).doc as { version: number; rules: Array<{ text: string }> };
    assert.deepEqual(after.rules.slice(before.rules.length).map((rule) => rule.text), [suggested]);
    offered.length = 0;
    await vscode.commands.executeCommand('multiagentSystem.teamRules.edit');
    assert.equal(offered[0]?.some((label) => label.startsWith('Add the suggested rule')), false, 'once added it is no longer offered');
  } finally {
    const restore = (rules.get() as any).doc;
    if (restore.version !== before.version) rules.save({ ...before, version: restore.version + 1, updatedAt: new Date().toISOString() }, restore.version);
    ui.showQuickPick = original.pick;
    ui.showWarningMessage = original.warning;
    ui.showInformationMessage = original.info;
  }
  console.log('host smoke: Edit Team Rules offers the suggested "decide routine matters yourself" rule, adds it only after the confirmation, and stops offering it once added');
}
