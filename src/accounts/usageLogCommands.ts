import * as vscode from 'vscode';
import { privateStorage } from '../storage/storageCommands';
import { SessionCommands } from '../sessions/sessionCommands';
import { accountService } from './accountRuntime';
import { builtIn } from '../providers/registry';

const { UsageLog, describeLog, exportRows, toCsv, toJson } = require('./usage-log') as {
  UsageLog: new (store: unknown) => { query(filter?: { accountProfileId?: string; sessionId?: string }): { ok: boolean; entries?: any[]; reason?: string } };
  describeLog(entries: any[], options?: { labelFor?: (id: string) => string; providerLabel?: (id: string) => string }): string[];
  exportRows(entries: any[]): unknown[];
  toCsv(rows: unknown[]): string;
  toJson(rows: unknown[]): string;
};

export const USAGE_COMMANDS = {
  showLog: 'multiagentSystem.usage.showLog',
  exportLog: 'multiagentSystem.usage.exportLog'
} as const;
export const USAGE_LOG_SCHEME = 'multiagent-usage-log';

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

async function readEntries(accountId: string): Promise<{ ok: true; entries: any[] } | { ok: false; reason: string }> {
  const opened = await privateStorage()?.use();
  if (!opened?.ok) return { ok: false, reason: 'Private storage is unavailable.' };
  const read = new UsageLog(opened.store).query(accountId === ALL ? {} : { accountProfileId: accountId });
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

class UsageLogDocument implements vscode.TextDocumentContentProvider {
  readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  constructor(private readonly sessions: SessionCommands) {}
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const account = uri.query === ALL || ACCOUNT_ID.test(uri.query) ? uri.query : undefined;
    if (!account) return 'No valid account was selected.\n';
    const read = await readEntries(account);
    if (!read.ok) return `${read.reason}\n`;
    const names = await labels(this.sessions);
    return `${describeLog(read.entries, { labelFor: (id) => names.get(id) ?? 'Account (removed)', providerLabel: (id) => builtIn.get(id)?.label ?? id }).join('\n')}\n`;
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
      const uri = vscode.Uri.from({ scheme: USAGE_LOG_SCHEME, path: '/token-usage-log.txt', query: account });
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
