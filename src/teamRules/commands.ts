import * as vscode from 'vscode';
import { privateStorage } from '../storage/storageCommands';

type Rule = { id: string; type: 'instruction'; text: string };
type Doc = { version: number; updatedAt: string | null; rules: Rule[] };
type Store = { get(collection: string, id: string): any; transact(work: (tx: any) => unknown): any };

const { TeamRulesStore } = require('./store') as { TeamRulesStore: new (store: Store) => { get(): { ok: true; doc: Doc } | { ok: false; reason: string }; save(next: unknown, expectedVersion: number): { ok: boolean; reason?: string } } };
const { applyEdit, describeTeamRules, suggestionsFor, MAX_TEXT_CHARS } = require('./model') as {
  applyEdit(doc: Doc, change: unknown, now: Date): { ok: true; doc: Doc } | { ok: false; reason: string };
  describeTeamRules(doc: Doc): string;
  suggestionsFor(doc: Doc): Array<{ key: string; label: string; text: string }>;
  MAX_TEXT_CHARS: number;
};

export const TEAM_RULES_COMMANDS = { edit: 'multiagentSystem.teamRules.edit' } as const;

/** The one-line summary the Command Center shows, read from the private store; unknown when it cannot be read. */
export async function teamRulesSummary(): Promise<string> {
  try {
    const opened = await privateStorage()?.use();
    if (!opened?.ok) return 'Team rules: unknown (private storage is unavailable).';
    const loaded = new TeamRulesStore(opened.store as Store).get();
    return loaded.ok ? describeTeamRules(loaded.doc) : 'Team rules: unknown (the stored list could not be read).';
  } catch { return 'Team rules: unknown.'; }
}

const REFUSALS: Record<string, string> = {
  'sensitive-text': 'The rule looks like it contains a credential, an email address or a local path. Rules are typed into every agent\'s instructions, so none of those belong in one.',
  'invalid-text': 'The rule must be 1 to 1000 characters of plain text without hidden or control characters.',
  'too-many-rules': 'There can be at most 50 team rules.',
  'rule-not-found': 'That rule no longer exists.',
  'stale-version': 'The team rules changed in another window. Open Edit Team Rules again; your change was not saved.',
  'invalid-team-rules-record': 'The stored team rules are damaged and were not changed.'
};

const short = (text: string): string => (text.length > 70 ? `${text.slice(0, 70)}…` : text);

/**
 * "Edit Team Rules" (issue #306): the one list every agent started afterwards is given, ahead of its role group's rules. It takes
 * NO argument: the rule text, the choice of rule and the confirmation all come from this window, so nothing a caller passes can
 * write a rule that every agent will then be told. Running agents keep what they were started with.
 */
async function edit(): Promise<void> {
  if (!vscode.workspace.isTrusted) { void vscode.window.showWarningMessage('Trust this workspace before editing team rules.'); return; }
  const opened = await privateStorage()?.use();
  if (!opened?.ok) { void vscode.window.showErrorMessage(`Private storage is unavailable (${String(opened?.reason ?? 'unknown')}).`); return; }
  const store = new TeamRulesStore(opened.store as Store);
  const loaded = store.get();
  if (!loaded.ok) { void vscode.window.showErrorMessage(`The team rules could not be read (${loaded.reason}). Nothing was changed.`); return; }
  const doc = loaded.doc;
  // A suggested rule (#362) is offered until it is in the list; adding it goes through the same confirmation as any other rule.
  const suggestions = suggestionsFor(doc);
  const action = await vscode.window.showQuickPick([
    ...suggestions.map((rule) => ({ label: `Add the suggested rule: ${rule.label}`, detail: rule.text, value: 'suggested' as const, text: rule.text })),
    { label: 'Add a rule', detail: describeTeamRules(doc), value: 'add' as const },
    { label: 'Edit a rule', value: 'edit' as const },
    { label: 'Remove a rule', value: 'remove' as const }
  ], { placeHolder: 'Team rules: given to every agent started after the change', ignoreFocusOut: true });
  if (!action) return;
  let change: { kind: string; id?: string; text?: string };
  let summary: string;
  if (action.value === 'suggested' && 'text' in action) {
    change = { kind: 'add', text: action.text };
    summary = `Add this suggested rule (agents decide routine matters themselves instead of stopping to ask):\n\n${action.text}`;
  } else if (action.value === 'add') {
    const text = await vscode.window.showInputBox({ prompt: `A rule every agent is told to follow (up to ${MAX_TEXT_CHARS} characters). The CLI is told; nothing enforces it.`, ignoreFocusOut: true, validateInput: (value) => (value.trim() === '' ? 'Enter the rule.' : undefined) });
    if (!text) return;
    change = { kind: 'add', text: text.trim() };
    summary = `Add this rule:\n\n${text.trim()}`;
  } else {
    if (doc.rules.length === 0) { void vscode.window.showInformationMessage('There are no team rules yet.'); return; }
    const picked = await vscode.window.showQuickPick(doc.rules.map((rule) => ({ label: short(rule.text), description: rule.id, id: rule.id })), { placeHolder: action.value === 'edit' ? 'Which rule?' : 'Which rule should be removed?', ignoreFocusOut: true });
    if (!picked) return;
    const rule = doc.rules.find((entry) => entry.id === picked.id);
    if (!rule) return;
    if (action.value === 'remove') {
      change = { kind: 'remove', id: rule.id };
      summary = `Remove this rule:\n\n${rule.text}`;
    } else {
      const text = await vscode.window.showInputBox({ prompt: 'The new text of this rule.', value: rule.text, ignoreFocusOut: true, validateInput: (value) => (value.trim() === '' ? 'Enter the rule.' : undefined) });
      if (!text) return;
      change = { kind: 'edit', id: rule.id, text: text.trim() };
      summary = `Change this rule:\n\n${rule.text}\n\nto:\n\n${text.trim()}`;
    }
  }
  const next = applyEdit(doc, change, new Date());
  if (!next.ok) { void vscode.window.showErrorMessage(REFUSALS[next.reason] ?? `The change was refused (${next.reason}).`); return; }
  const confirmed = await vscode.window.showWarningMessage(
    'Change the rules every agent is given?', { modal: true, detail: `${summary}\n\nAgents started after this get the new list (version ${next.doc.version}). Agents that are already running keep what they were started with. The CLI is only told these rules; this extension does not enforce them.` }, 'Save');
  if (confirmed !== 'Save') return;
  const saved = store.save(next.doc, doc.version);
  if (!saved.ok) { void vscode.window.showErrorMessage(REFUSALS[saved.reason ?? ''] ?? `The team rules were not saved (${saved.reason ?? 'unknown'}).`); return; }
  void vscode.window.showInformationMessage(`Team rules saved (version ${next.doc.version}). They apply to agents started from now on.`);
}

export function registerTeamRulesCommands(context: vscode.ExtensionContext): void {
  // No argument is read: the rule, the choice of rule and the confirmation always come from this window.
  context.subscriptions.push(vscode.commands.registerCommand(TEAM_RULES_COMMANDS.edit, () => edit()));
}
