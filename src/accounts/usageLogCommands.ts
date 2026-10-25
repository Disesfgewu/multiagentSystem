import * as vscode from 'vscode';
import { privateStorage } from '../storage/storageCommands';
import { SessionCommands } from '../sessions/sessionCommands';
import { accountService } from './accountRuntime';
import { builtIn } from '../providers/registry';

const { UsageLog, describeLog, exportRows, toCsv, toJson, addressOf, parseAddress, sessionsByRecency, compareSessions, comparisonAddress, parseComparison } = require('./usage-log') as {
  compareSessions(entries: any[], first: string, second: string, options?: { nameOf?: (id: string) => string }): string[] | null;
  comparisonAddress(account: string, first: string, second: string): string;
  parseComparison(query: string): { account: string; first: string; second: string } | undefined;
  sessionsByRecency(entries: any[], limit?: number): string[];
  addressOf(account: string, session?: string): string;
  parseAddress(query: string): { account: string; session?: string } | undefined;
  UsageLog: new (store: unknown) => { query(filter?: { accountProfileId?: string; sessionId?: string }): { ok: boolean; entries?: any[]; reason?: string } };
  describeLog(entries: any[], options?: { labelFor?: (id: string) => string; providerLabel?: (id: string) => string; sessionLabel?: string | null }): string[];
  exportRows(entries: any[]): unknown[];
  toCsv(rows: unknown[]): string;
  toJson(rows: unknown[]): string;
};

export const USAGE_COMMANDS = {
  showLog: 'multiagentSystem.usage.showLog',
  compare: 'multiagentSystem.usage.compareSessions',
  exportLog: 'multiagentSystem.usage.exportLog'
} as const;
export const USAGE_LOG_SCHEME = 'multiagent-usage-log';
const COMPARE_PATH = '/token-usage-compare.txt';

const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,100}$/;
const ALL = '*';
async function labels(sessions: SessionCommands): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const result = await accountService(() => sessions.list());
    if (!result.ok) return map;
    const loaded = result.service.list();
    if (loaded.ok) for (const profile of loaded.profiles) map.set(profile.id, String(profile.label));
  } catch { /* a missing label is shown as "Account" */ }
  return map;
}

async function readEntries(accountId: string, sessionId?: string): Promise<{ ok: true; entries: any[] } | { ok: false; reason: string }> {
  const opened = await privateStorage()?.use();
  if (!opened?.ok) return { ok: false, reason: 'Private storage is unavailable.' };
  const read = new UsageLog(opened.store).query({ ...(accountId === ALL ? {} : { accountProfileId: accountId }), ...(sessionId ? { sessionId } : {}) });
  return read.ok ? { ok: true, entries: read.entries ?? [] } : { ok: false, reason: `The usage log could not be read (${read.reason ?? 'unknown'}).` };
}

/** One account, or all of them, chosen from a list shown here: a caller-supplied id only picks an item that must exist in the list. */
async function pickAccount(sessions: SessionCommands, given: unknown): Promise<string | undefined> {
  const names = await labels(sessions);
  if (typeof given === 'string' && ACCOUNT_ID.test(given) && names.has(given)) return given;
  const picked = await vscode.window.showQuickPick(
    [{ label: 'All accounts', id: ALL }, ...[...names].map(([id, label]) => ({ label, id }))],
    { placeHolder: 'Whose token usage?', ignoreFocusOut: true }
  );
  return picked?.id;
}

/** How a session is called in the picker and the log: its name while it is known, otherwise a short form of its id. */
async function sessionName(sessions: SessionCommands, id: string): Promise<string> {
  const known = sessions.list().find((entry) => entry.id === id);
  return known ? `${known.name} (${id.slice(0, 8)})` : `session ${id.slice(0, 8)} (no longer open)`;
}

/** All of the account's sessions, or one of those that appear in its log. A session that is not in the log cannot be chosen. */
async function pickSession(sessions: SessionCommands, account: string): Promise<{ cancelled: boolean; session?: string }> {
  const read = await readEntries(account);
  if (!read.ok) { void vscode.window.showErrorMessage(read.reason); return { cancelled: true }; }
  const all = new Set(read.entries.map((entry) => String(entry.sessionId)));
  const ids = sessionsByRecency(read.entries, 50);
  if (ids.length < 2) return { cancelled: false };
  const items = [{ label: 'All sessions', id: undefined as string | undefined, description: ids.length < all.size ? `the ${ids.length} most recent of ${all.size} sessions in the log` : `${ids.length} sessions in the log` }, ...(await Promise.all(ids.map(async (id) => ({ label: await sessionName(sessions, id), id: id as string | undefined, description: `${read.entries.filter((entry) => entry.sessionId === id).length} readings` }))))];
  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Which session? (the log has more than one)', ignoreFocusOut: true });
  return picked ? { cancelled: false, session: picked.id } : { cancelled: true };
}

/** One short line for the session picker: what it was given at its start, from its readings. */
function describeGiven(entries: any[], id: string): string {
  const given = entries.find((entry) => entry.sessionId === id && entry.given)?.given;
  return given ? `given about ${Number(given.tokens).toLocaleString('en-US')} tokens at start${Number.isSafeInteger(given.skills) ? `, ${given.skills} skill${given.skills === 1 ? '' : 's'}` : ''}` : 'what it was given is unknown';
}

class UsageLogDocument implements vscode.TextDocumentContentProvider {
  readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  constructor(private readonly sessions: SessionCommands) {}
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    if (uri.path === COMPARE_PATH) {
      const chosen = parseComparison(uri.query);
      if (!chosen) return 'No valid pair of sessions was selected.\n';
      const read = await readEntries(chosen.account);
      if (!read.ok) return `${read.reason}\n`;
      const names = new Map<string, string>();
      for (const id of [chosen.first, chosen.second]) names.set(id, await sessionName(this.sessions, id));
      const lines = compareSessions(read.entries, chosen.first, chosen.second, { nameOf: (id) => names.get(id) ?? id });
      return lines ? `${lines.join('\n')}\n` : 'One of the two sessions has no reading in the usage log any more.\n';
    }
    const address = parseAddress(uri.query);
    if (!address) return 'No valid account was selected.\n';
    const read = await readEntries(address.account, address.session);
    if (!read.ok) return `${read.reason}\n`;
    const names = await labels(this.sessions);
    return `${describeLog(read.entries, { labelFor: (id) => names.get(id) ?? 'Account (removed)', providerLabel: (id) => builtIn.get(id)?.label ?? id, sessionLabel: address.session ? await sessionName(this.sessions, address.session) : null }).join('\n')}\n`;
  }
}

export function registerUsageLogCommands(context: vscode.ExtensionContext, sessions: SessionCommands): void {
  const provider = new UsageLogDocument(sessions);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(USAGE_LOG_SCHEME, provider),
    provider.changed,
    // Read-only views of the person's own private data. `showLog` may be given an account id (the account row does), but it
    // only selects an account that exists; nothing a caller passes writes, sends or exports anything.
    vscode.commands.registerCommand(USAGE_COMMANDS.showLog, async (given?: unknown) => {
      const account = await pickAccount(sessions, typeof given === 'object' && given !== null && 'id' in given ? (given as { id: unknown }).id : given);
      if (!account) return;
      const chosen = await pickSession(sessions, account);
      if (chosen.cancelled) return;
      const uri = vscode.Uri.from({ scheme: USAGE_LOG_SCHEME, path: '/token-usage-log.txt', query: addressOf(account, chosen.session) });
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: true });
    }),
    // Two sessions of the log side by side (#359): chosen from the sessions that have readings, then opened as a read-only document.
    vscode.commands.registerCommand(USAGE_COMMANDS.compare, async () => {
      const account = await pickAccount(sessions, undefined);
      if (!account) return;
      const read = await readEntries(account);
      if (!read.ok) { void vscode.window.showErrorMessage(read.reason); return; }
      const ids = sessionsByRecency(read.entries, 50);
      if (ids.length < 2) { void vscode.window.showInformationMessage('The usage log has fewer than two sessions with readings for this choice, so there is nothing to compare yet.'); return; }
      const items = await Promise.all(ids.map(async (id) => ({ label: await sessionName(sessions, id), id, description: describeGiven(read.entries, id) })));
      const first = await vscode.window.showQuickPick(items, { placeHolder: 'First session to compare', ignoreFocusOut: true });
      if (!first) return;
      const second = await vscode.window.showQuickPick(items.filter((item) => item.id !== first.id), { placeHolder: `Compare "${first.label}" with which session?`, ignoreFocusOut: true });
      if (!second) return;
      const uri = vscode.Uri.from({ scheme: USAGE_LOG_SCHEME, path: COMPARE_PATH, query: comparisonAddress(account, first.id, second.id) });
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: true });
    }),
    // Opens the masked rows in an untitled editor; nothing is written to a file by the extension, and the person saves it, or not.
    vscode.commands.registerCommand(USAGE_COMMANDS.exportLog, async () => {
      const account = await pickAccount(sessions, undefined);
      if (!account) return;
      const format = await vscode.window.showQuickPick([{ label: 'CSV', value: 'csv' as const }, { label: 'JSON', value: 'json' as const }], { placeHolder: 'Export format (accounts and sessions are masked)', ignoreFocusOut: true });
      if (!format) return;
      const read = await readEntries(account);
      if (!read.ok) { void vscode.window.showErrorMessage(read.reason); return; }
      const rows = exportRows(read.entries);
      const document = await vscode.workspace.openTextDocument({ content: format.value === 'csv' ? toCsv(rows) : toJson(rows), language: format.value === 'csv' ? 'csv' : 'json' });
      await vscode.window.showTextDocument(document, { preview: false });
    })
  );
}
