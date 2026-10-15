import * as vscode from 'vscode';
import { accountService, SessionUse } from './accountRuntime';

const { loadPolicy, savePolicy } = require('./quota-policy') as {
  loadPolicy(store: unknown, id: string): { ok: boolean; policy?: Record<string, unknown>; stored?: boolean };
  savePolicy(store: unknown, id: string, input: unknown): { ok: boolean; reason?: string; problems?: string[] };
};
const { gateLaunch, describePolicy, describeQuota, policyFromInput } = require('./quota-gate') as {
  gateLaunch(input: Record<string, unknown>): { action: 'allow' | 'warn' | 'confirm' | 'block'; allowed: boolean; overridable: boolean; lines: string[]; note: string | null; reasons: Array<{ code: string }> };
  describePolicy(read: unknown): string;
  describeQuota(observations: unknown[], now: Date): string[];
  policyFromInput(input: Record<string, unknown>): { ok: boolean; policy?: Record<string, unknown>; problems: string[] };
};

/** Usage readings for an account. No verified source is connected yet, so there are none. */
export function quotaObservations(_accountProfileId: string): unknown[] {
  return [];
}

export type GateOutcome = { ok: true } | { ok: false; code: string; message: string };

/**
 * Applies the account's limits before a new agent starts on it. An account with no limits is never held
 * back. Interactive callers can confirm or (for usage limits) override; callers that cannot ask are refused
 * whenever the limits say to ask or to stop.
 */
export async function gateAccountLaunch(accountProfileId: string, interactive: boolean, sessions: () => SessionUse[]): Promise<GateOutcome> {
  const accounts = await accountService(sessions);
  if (!accounts.ok) return { ok: false, code: 'quota-gate', message: 'Account limits could not be checked because private storage is not ready, so no new agent was started.' };
  const policyRead = loadPolicy(accounts.store, accountProfileId);
  const running = sessions().filter((entry) => entry.accountProfileId === accountProfileId && entry.terminalOpen).length;
  const now = new Date();
  const first = gateLaunch({ policyRead, observations: quotaObservations(accountProfileId), now, running });
  if (first.action === 'allow') return { ok: true };
  const text = [...first.lines, ...(first.note ? ['', first.note] : [])].join('\n');
  if (first.action === 'warn') {
    void vscode.window.showWarningMessage(`Account limits: ${first.lines[0] ?? 'a warning level was reached'}`);
    return { ok: true };
  }
  if (!interactive) return { ok: false, code: 'quota-gate', message: first.lines[0] ?? 'The account\'s limits stopped this agent.' };
  const confirmOnly = first.action === 'confirm';
  const buttons = first.overridable ? [confirmOnly ? 'Start Anyway' : 'Override and Start'] : [];
  const title = first.action === 'block' ? 'Account limits are holding back new agents.' : 'Account limits ask you to confirm.';
  const answer = await vscode.window.showWarningMessage(title, { modal: true, detail: text }, ...buttons);
  if (!answer) return { ok: false, code: 'cancelled', message: 'Cancelled.' };
  const approved = gateLaunch({ policyRead, observations: quotaObservations(accountProfileId), now, running, approval: confirmOnly ? 'confirm' : 'override' });
  return approved.allowed ? { ok: true } : { ok: false, code: 'quota-gate', message: 'The account\'s limits stopped this agent.' };
}

/** Lines for the account details: the limits and what is known about usage. */
export async function limitLines(accountProfileId: string, sessions: () => SessionUse[]): Promise<string[]> {
  const accounts = await accountService(sessions);
  const policyRead = accounts.ok ? loadPolicy(accounts.store, accountProfileId) : { ok: false };
  return [describePolicy(policyRead), ...describeQuota(quotaObservations(accountProfileId), new Date())];
}

/** Lets the person set the limits for one account. `input` is used instead of asking when given (tests). */
export async function editLimits(accountProfileId: string, label: string, sessions: () => SessionUse[], input?: { warn?: string; block?: string; max?: string; unknownQuota?: string }): Promise<{ ok: boolean; reason?: string; problems?: string[]; cancelled?: boolean }> {
  const accounts = await accountService(sessions);
  if (!accounts.ok) return { ok: false, reason: 'storage-unavailable' };
  let values = input;
  if (!values) {
    const current = loadPolicy(accounts.store, accountProfileId);
    const policy = current.ok && current.stored ? current.policy ?? {} : {};
    const ask = (prompt: string, value: unknown): Thenable<string | undefined> => vscode.window.showInputBox({ prompt, value: value === undefined ? '' : String(value), placeHolder: 'leave empty for none', ignoreFocusOut: true });
    const warn = await ask(`“${label}”: warn when usage reaches this percent (0–100)`, policy.warnAtPercent);
    if (warn === undefined) return { ok: false, cancelled: true };
    const block = await ask(`“${label}”: stop starting new agents at this percent (0–100)`, policy.blockAtPercent);
    if (block === undefined) return { ok: false, cancelled: true };
    const max = await ask(`“${label}”: at most this many agents running at once (1–64)`, policy.maxConcurrent);
    if (max === undefined) return { ok: false, cancelled: true };
    const unknown = await vscode.window.showQuickPick([
      { label: 'Ask me first', detail: 'When usage is unknown, a new agent needs your confirmation. (Recommended)', value: 'require-confirmation' },
      { label: 'Do not start new agents', detail: 'When usage is unknown, new agents are held back until you override.', value: 'block' }
    ], { placeHolder: 'What should happen when this account\'s usage is unknown?', ignoreFocusOut: true });
    if (!unknown) return { ok: false, cancelled: true };
    values = { warn, block, max, unknownQuota: unknown.value };
  }
  const parsed = policyFromInput(values);
  if (!parsed.ok) {
    if (!input) void vscode.window.showErrorMessage(parsed.problems.join(' '));
    return { ok: false, problems: parsed.problems };
  }
  const saved = savePolicy(accounts.store, accountProfileId, parsed.policy);
  if (!saved.ok) {
    if (!input) void vscode.window.showErrorMessage('The limits could not be saved.');
    return { ok: false, reason: saved.reason };
  }
  return { ok: true };
}

/** Removes the saved limits (the account is then never held back). */
export async function clearLimits(accountProfileId: string, sessions: () => SessionUse[]): Promise<boolean> {
  const accounts = await accountService(sessions);
  if (!accounts.ok) return false;
  const store = accounts.store as { delete(collection: string, id: string): { ok: boolean } };
  return store.delete('policies', `quota-${accountProfileId}`).ok;
}
