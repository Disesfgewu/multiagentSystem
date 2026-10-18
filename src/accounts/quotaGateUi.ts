import * as vscode from 'vscode';
import { accountService, SessionUse } from './accountRuntime';

const { loadPolicy, savePolicy, QuotaDispatcher } = require('./quota-policy') as {
  loadPolicy(store: unknown, id: string): { ok: boolean; policy?: Record<string, unknown>; stored?: boolean };
  savePolicy(store: unknown, id: string, input: unknown): { ok: boolean; reason?: string; problems?: string[] };
  QuotaDispatcher: new () => { running(accountKey: string): number };
};
const { gateLaunch, commitDispatch, describePolicy, describeQuota, describeCurrentState, policyFromInput } = require('./quota-gate') as {
  gateLaunch(input: Record<string, unknown>): { action: 'allow' | 'warn' | 'confirm' | 'block'; allowed: boolean; overridable: boolean; lines: string[]; note: string | null; reasons: Array<{ code: string }> };
  commitDispatch(input: Record<string, unknown>): { ok: true; release: () => void } | { ok: false; code: string; message: string };
  describePolicy(read: unknown): string;
  describeQuota(observations: unknown[], now: Date): string[];
  describeCurrentState(decision: { action: string; lines: string[] }): string;
  policyFromInput(input: Record<string, unknown>): { ok: boolean; policy?: Record<string, unknown>; problems: string[] };
};

/** Usage readings for an account. No verified source is connected yet, so there are none. */
export function quotaObservations(_accountProfileId: string): unknown[] {
  return [];
}

// One dispatcher per window: every gated launch (start or reopen) reserves a slot here before it is
// allowed through, via `commitDispatch` (quota-gate.js), and whoever holds the outcome must call
// `release()` exactly once, when that session's terminal actually closes. This is what makes the
// running-agent limit atomic: two launch requests that both read "not full yet" cannot both then
// also both successfully reserve the last slot, because the reservation itself is the one
// synchronous step that decides and records.
const dispatcher = new QuotaDispatcher();

export type GateOutcome = { ok: true; release: () => void } | { ok: false; code: string; message: string };

/**
 * Applies the account's limits before a new agent starts on it. An account with no limits is never held
 * back, but its active sessions are tracked so later limits count them. Interactive callers can confirm
 * or (for usage limits) override; callers that cannot ask are refused whenever the limits say to ask or
 * to stop. On success, the caller MUST call the returned `release()` once, exactly when the session this
 * launch produced stops or its terminal closes; forgetting to release leaks a slot permanently.
 *
 * Security note: When interactive === false, gateAccountLaunch fails closed.
 * It NEVER bypasses the gate: if the policy blocks or requires confirmation,
 * it immediately stops the agent and returns { ok: false, code: 'quota-gate' }.
 */
export async function gateAccountLaunch(accountProfileId: string, interactive: boolean, sessions: () => SessionUse[]): Promise<GateOutcome> {
  const accounts = await accountService(sessions);
  if (!accounts.ok) return { ok: false, code: 'quota-gate', message: 'Account limits could not be checked because private storage is not ready, so no new agent was started.' };
  const policyRead = loadPolicy(accounts.store, accountProfileId);
  const observations = quotaObservations(accountProfileId);
  const now = new Date();
  if (!policyRead.ok) return { ok: false, code: 'quota-gate', message: 'The saved account limits could not be read, so no new agent was started.' };
  const commit = async (approval?: 'confirm' | 'override'): Promise<GateOutcome> => {
    // Recheck after every await/dialog, then decide and reserve synchronously from fresh inputs.
    const latestAccounts = await accountService(sessions);
    if (!latestAccounts.ok) return { ok: false, code: 'quota-gate', message: 'Account limits could not be read again, so no new agent was started.' };
    const latest = loadPolicy(latestAccounts.store, accountProfileId);
    if (!latest.ok) return { ok: false, code: 'quota-gate', message: 'The saved account limits could not be read, so no new agent was started.' };
    if (latest.stored !== policyRead.stored || JSON.stringify(latest.policy) !== JSON.stringify(policyRead.policy)) {
      return { ok: false, code: 'quota-gate', message: 'Account limits changed while this launch was being checked. Try again to review the current limits.' };
    }
    return commitDispatch({ policyRead: latest, observations: quotaObservations(accountProfileId), now: new Date(), dispatcher, accountKey: accountProfileId, approval });
  };
  if (policyRead.stored !== true) return commit();
  // The running count that decides what to SHOW is a plain read, for responsive dialog wording; the
  // decision that actually GRANTS access is made again, atomically, in commit() above, so a request
  // that waited on a confirmation dialog cannot act on a running count that a concurrent request has
  // since made stale.
  const running = dispatcher.running(accountProfileId);
  const first = gateLaunch({ policyRead, observations, now, running });
  if (first.action === 'allow') return commit();
  const text = [...first.lines, ...(first.note ? ['', first.note] : [])].join('\n');
  if (first.action === 'warn') {
    void vscode.window.showWarningMessage(`Account limits: ${first.lines[0] ?? 'a warning level was reached'}`);
    return commit();
  }
  if (!interactive || !first.overridable) return { ok: false, code: 'quota-gate', message: first.lines[0] ?? 'The account\'s limits stopped this agent.' };
  const confirmOnly = first.action === 'confirm';
  const buttons = first.overridable ? [confirmOnly ? 'Start Anyway' : 'Override and Start'] : [];
  const title = first.action === 'block' ? 'Account limits are holding back new agents.' : 'Account limits ask you to confirm.';
  const answer = await vscode.window.showWarningMessage(title, { modal: true, detail: text }, ...buttons);
  if (answer !== (confirmOnly ? 'Start Anyway' : 'Override and Start')) return { ok: false, code: 'cancelled', message: 'Cancelled.' };
  return commit(confirmOnly ? 'confirm' : 'override');
}

export interface CurrentGate {
  action: 'allow' | 'warn' | 'confirm' | 'block';
  line: string;
  reason?: string;
}

/** What starting a new agent on this account would do right now: `null` when no policy is stored (so
 *  nothing is held back), or the plain action a real launch's gate would take at this instant. Reads
 *  the same dispatcher a real launch commits to, so this can never show a result a real launch
 *  couldn't reach; it only reports and never itself reserves a slot. */
export async function currentGateState(accountProfileId: string, sessions: () => SessionUse[]): Promise<CurrentGate | null> {
  const accounts = await accountService(sessions);
  const policyRead = accounts.ok ? loadPolicy(accounts.store, accountProfileId) : { ok: false };
  if (!policyRead.ok || policyRead.stored !== true) return null;
  const observations = quotaObservations(accountProfileId);
  const now = new Date();
  const running = dispatcher.running(accountProfileId);
  const decision = gateLaunch({ policyRead, observations, now, running });
  return { action: decision.action, line: describeCurrentState(decision), reason: decision.lines[0] };
}

/** Lines for the account details: the limits, what is known about usage, and whether a new agent on
 *  this account would actually be allowed to start right now. */
export async function limitLines(accountProfileId: string, sessions: () => SessionUse[]): Promise<string[]> {
  const accounts = await accountService(sessions);
  const policyRead = accounts.ok ? loadPolicy(accounts.store, accountProfileId) : { ok: false };
  const lines = [describePolicy(policyRead), ...describeQuota(quotaObservations(accountProfileId), new Date())];
  const current = await currentGateState(accountProfileId, sessions);
  if (current) lines.push(current.line);
  return lines;
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
