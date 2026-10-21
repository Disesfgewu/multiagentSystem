import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { privateStorage } from '../storage/storageCommands';
import { SessionCommands } from '../sessions/sessionCommands';
import { isExtensionTestMode } from '../shared/testMode';

const { BroadcastStore } = require('./store') as {
  BroadcastStore: new (store: Store) => {
    list(): { ok: boolean; items?: Broadcast[]; reason?: string };
    get(id: string): { ok: boolean; broadcast?: Broadcast; reason?: string };
    listDeliveries(): { ok: boolean; items?: Array<{ broadcastId: string }>; reason?: string };
    recordDelivery(raw: unknown): { ok: boolean; reason?: string };
    create(raw: unknown): { ok: boolean; broadcast?: Broadcast; reason?: string; problems?: string[]; scan?: unknown };
    revoke(id: string, revokedAt: string): { ok: boolean; broadcast?: Broadcast; reason?: string };
  };
};
const { planDelivery, describePlan, summarizeDeliveries } = require('./deliver') as {
  planDelivery(input: { broadcast: Broadcast; sessions: unknown[]; roleOf: (session: any) => string | undefined; now: Date }): { ok: true; prompt: string; recipients: Array<{ id: string; name: string; provider: string; decision: 'send' | 'unknown' | 'skip'; reason: string }> } | { ok: false; reason: string };
  describePlan(plan: unknown): string[];
  summarizeDeliveries(records: unknown[], broadcastId: string): string;
};
const { scanBroadcastText, isLive, targetLabel, broadcastStatus, formatBroadcast } = require('./model') as {
  scanBroadcastText(text: string): { status: string };
  isLive(broadcast: Broadcast, now: Date): boolean;
  targetLabel(target: Target): string;
  broadcastStatus(broadcast: Broadcast, now: Date): string;
  formatBroadcast(broadcast: Broadcast, now: Date, deliverySummary?: string): string;
};
const { roleProviderChoices } = require('../roles/provider-choices') as {
  roleProviderChoices(): Array<{ id: string; label: string; detail: string }>;
};

type Target = { scope: 'all' } | { scope: 'roleGroup'; role: string } | { scope: 'provider'; provider: string } | { scope: 'agent'; agentId: string };
type Broadcast = { id: string; version: number; target: Target; text: string; createdAt: string; expiresAt: string | null; revokedAt: string | null };
type Store = { get(collection: string, id: string): any; list(collection: string): any; transact(work: (tx: any) => unknown): any };

export const BROADCAST_VIEW = 'multiagentSystem.broadcastsView';
export const BROADCAST_SCHEME = 'multiagent-broadcast';
export const BROADCAST_COMMANDS = {
  refresh: 'multiagentSystem.broadcasts.refresh',
  send: 'multiagentSystem.broadcasts.send',
  deliver: 'multiagentSystem.broadcasts.deliver',
  revoke: 'multiagentSystem.broadcasts.revoke',
  details: 'multiagentSystem.broadcasts.details'
} as const;

const ROLE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const EXPIRY_CHOICES: Array<{ label: string; detail: string; hours: number | null }> = [
  { label: 'Until revoked', detail: 'Remains a local notice until revoked.', hours: null },
  { label: '1 hour', detail: '', hours: 1 },
  { label: '4 hours', detail: '', hours: 4 },
  { label: '24 hours', detail: '', hours: 24 }
];

async function store(showError = true): Promise<Store | undefined> {
  const handle = privateStorage();
  const opened = await handle?.use();
  if (!opened?.ok) {
    if (showError) void vscode.window.showErrorMessage(`Private broadcast storage is unavailable (${String(opened?.reason ?? 'unknown')}).`);
    return undefined;
  }
  return opened.store as Store;
}

class BroadcastItem extends vscode.TreeItem {
  constructor(readonly broadcast: Broadcast, now: Date, delivery: string) {
    super(broadcast.text.length > 60 ? `${broadcast.text.slice(0, 60)}…` : broadcast.text, vscode.TreeItemCollapsibleState.None);
    const status = broadcastStatus(broadcast, now);
    this.description = `${targetLabel(broadcast.target)} · ${status} · delivery: ${delivery}`;
    this.tooltip = [
      `Sent: ${broadcast.createdAt}`,
      `Target: ${targetLabel(broadcast.target)}`,
      `Status: ${status}`,
      broadcast.expiresAt ? `Expires: ${broadcast.expiresAt}` : 'No expiry: stays in effect until revoked',
      broadcast.revokedAt ? `Revoked: ${broadcast.revokedAt}` : null,
      '',
      `Version: ${broadcast.version}`,
      `Delivery: ${delivery}. Included in the effective instructions of sessions started after it was saved. "Typed into" is not proof that the CLI read it.`,
      '',
      broadcast.text
    ].filter((line): line is string => line !== null).join('\n');
    this.iconPath = new vscode.ThemeIcon(status === 'active' ? 'megaphone' : status === 'revoked' ? 'circle-slash' : 'clock');
    this.contextValue = status === 'active' ? 'multiagentBroadcastActive' : 'multiagentBroadcast';
    this.command = { command: BROADCAST_COMMANDS.details, title: 'Read full local notice', arguments: [broadcast.id] };
  }
}

class MessageItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('info');
  }
}

class BroadcastTree implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changed = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  refresh(): void { this.changed.fire(undefined); detailsProvider?.refresh(); }
  getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }
  async getChildren(): Promise<vscode.TreeItem[]> {
    const opened = await store(false);
    if (!opened) return [new MessageItem('Private broadcast storage is unavailable.')];
    const listed = new BroadcastStore(opened).list();
    if (!listed.ok) return [new MessageItem(`Broadcasts could not be read (${listed.reason ?? 'unknown'}).`)];
    const items = listed.items ?? [];
    if (items.length === 0) return [new MessageItem('No local broadcast notices yet. Use "Create Broadcast Notice" to add one, then "Send Broadcast to Agents" to type it into running agents.')];
    const now = new Date();
    const deliveries = new BroadcastStore(opened).listDeliveries();
    const records = deliveries.ok ? deliveries.items ?? [] : null;
    return [...items].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)).map((broadcast) => new BroadcastItem(broadcast, now, records === null ? 'unknown (the log could not be read)' : summarizeDeliveries(records, broadcast.id)));
  }
}

let testTree: BroadcastTree | undefined;
/** The delivery command, run against the given sessions: only in the extension's own host tests (a real terminal with a synthetic CLI). */
export function deliverBroadcastForTests(sessions: SessionCommands): Promise<void> {
  if (!isExtensionTestMode()) throw new Error('This is only exposed in Extension Host tests.');
  return deliver(sessions);
}

export function broadcastTreeForTests(): vscode.TreeDataProvider<vscode.TreeItem> {
  if (!testTree) throw new Error('The broadcast list is only exposed in Extension Host tests.');
  return testTree;
}

/**
 * Sends one broadcast. This is the only place a broadcast can be created, and it takes no arguments
 * at all: target, text and expiry are always collected here, from this one interactive dialog
 * sequence, in this VS Code window, every single time. There is no way to call this with a target or
 * text already filled in, because accepting one would reopen exactly the self-declared-role bypass
 * the product forbids — a command that can be driven by a pre-filled payload is a command that
 * something other than the person at this keyboard could trigger.
 */
async function send(sessions: SessionCommands): Promise<void> {
  const scopeChoice = await vscode.window.showQuickPick([
    { label: 'Every agent', detail: 'Applies to all providers and role groups.', value: 'all' as const },
    { label: 'A role group', detail: 'Applies only to agents with this role (e.g. pm, worker, researcher).', value: 'roleGroup' as const },
    { label: 'A provider', detail: 'Targets agents using this CLI.', value: 'provider' as const },
    { label: 'An open session', detail: 'Record a notice for one session. This does not deliver it to the CLI.', value: 'agent' as const }
  ], { placeHolder: 'Who should receive this broadcast?', ignoreFocusOut: true });
  if (!scopeChoice) return;

  let target: Target;
  if (scopeChoice.value === 'roleGroup') {
    const role = await vscode.window.showInputBox({
      prompt: 'Role id (e.g. pm, worker, researcher)', ignoreFocusOut: true,
      validateInput: (value) => ROLE_ID.test(value) ? undefined : 'Use a lowercase role id, such as worker.'
    });
    if (!role) return;
    target = { scope: 'roleGroup', role };
  } else if (scopeChoice.value === 'agent') {
    const available = sessions.list().filter((session) => session.terminalOpen);
    if (available.length === 0) { void vscode.window.showInformationMessage('No managed sessions have an open terminal.'); return; }
    const selected = await vscode.window.showQuickPick(available.map((session) => ({ label: session.name, description: `${session.provider} · ${session.stateLabel}`, id: session.id })), { placeHolder: 'Which session should this local notice target?', ignoreFocusOut: true });
    if (!selected) return;
    target = { scope: 'agent', agentId: selected.id };
  } else if (scopeChoice.value === 'provider') {
    const provider = await vscode.window.showQuickPick(roleProviderChoices(), { placeHolder: 'Which provider?', ignoreFocusOut: true });
    if (!provider) return;
    target = { scope: 'provider', provider: provider.id };
  } else {
    target = { scope: 'all' };
  }

  const text = await vscode.window.showInputBox({
    prompt: `Local notice for ${targetLabel(target)}. It is saved locally; run "Send Broadcast to Agents" to type it into running agents.`,
    ignoreFocusOut: true,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (trimmed === '') return 'Enter the broadcast text.';
      if (Array.from(trimmed).length > 2000) return 'Keep the broadcast to 2000 characters or fewer.';
      if (scanBroadcastText(trimmed).status !== 'clear') return 'This text was blocked by the content scan (it may contain a credential, local path or other private fragment).';
      return undefined;
    }
  });
  if (!text) return;

  const expiry = await vscode.window.showQuickPick(EXPIRY_CHOICES, { placeHolder: 'How long should this broadcast stay in effect?', ignoreFocusOut: true });
  if (!expiry) return;

  const now = new Date();
  const expiresAt = expiry.hours === null ? null : new Date(now.getTime() + expiry.hours * 60 * 60 * 1000).toISOString();
  const confirmed = await vscode.window.showWarningMessage(
    'Save this local broadcast notice?',
    { modal: true, detail: `Target: ${targetLabel(target)}\nExpires: ${expiresAt ?? 'until revoked'}\n\n${text.trim()}\n\nSaved locally. Agents started after it is saved receive it in their instructions; "Send Broadcast to Agents" types it into running agent CLIs. Nothing is typed by saving.` },
    'Save Notice'
  );
  if (confirmed !== 'Save Notice') return;

  const opened = await store();
  if (!opened) return;
  const created = new BroadcastStore(opened).create({
    id: randomUUID(), version: 1, target, text: text.trim(), createdAt: now.toISOString(), expiresAt, revokedAt: null
  });
  if (!created.ok) {
    void vscode.window.showErrorMessage(`The broadcast could not be sent (${created.reason ?? 'unknown'}).`);
    return;
  }
  currentTree?.refresh();
  void vscode.window.showInformationMessage(`Local notice saved for ${targetLabel(target)}. Nothing was typed into any CLI yet.`);
}

/**
 * Revokes one broadcast. Like `send`, this takes no payload: the broadcast to revoke is always
 * chosen from a list presented right here, never passed in by a caller.
 */
async function revoke(): Promise<void> {
  const opened = await store();
  if (!opened) return;
  const broadcasts = new BroadcastStore(opened);
  const listed = broadcasts.list();
  if (!listed.ok) { void vscode.window.showErrorMessage(`Broadcasts could not be read (${listed.reason ?? 'unknown'}).`); return; }
  const now = new Date();
  const active = (listed.items ?? []).filter((broadcast) => isLive(broadcast, now));
  if (active.length === 0) { void vscode.window.showInformationMessage('There are no active broadcasts to revoke.'); return; }
  const picked = await vscode.window.showQuickPick(
    active.map((broadcast) => ({ label: broadcast.text.length > 60 ? `${broadcast.text.slice(0, 60)}…` : broadcast.text, description: targetLabel(broadcast.target), id: broadcast.id })),
    { placeHolder: 'Which broadcast should be revoked?', ignoreFocusOut: true }
  );
  if (!picked) return;
  const selected = active.find((broadcast) => broadcast.id === picked.id);
  if (!selected) return;
  const confirmed = await vscode.window.showWarningMessage(
    'Revoke this local notice?', { modal: true, detail: `Target: ${targetLabel(selected.target)}\nVersion: ${selected.version}\n\n${selected.text}\n\nIt will no longer appear in current matching previews. This cannot be undone. No CLI delivery or withdrawal is connected.` }, 'Revoke'
  );
  if (confirmed !== 'Revoke') return;
  const latestStore = await store();
  if (!latestStore) return;
  const result = new BroadcastStore(latestStore).revoke(picked.id, new Date().toISOString());
  if (!result.ok) { void vscode.window.showErrorMessage(`The broadcast could not be revoked (${result.reason ?? 'unknown'}).`); return; }
  currentTree?.refresh();
  void vscode.window.showInformationMessage('Broadcast revoked.');
}

/**
 * "Send Broadcast to Agents": types one stored, live broadcast into the running agent CLIs it targets (issue #295). Like `send`
 * and `revoke` it takes NO argument: the broadcast is chosen from a list shown here, the recipients are worked out here from
 * the broadcast's own target and the sessions' evidence, and the person confirms the complete prompt and the list in a modal
 * every time. It sends only to sessions whose CLI the extension has fresh evidence is waiting for input; every other session
 * is skipped with a reason and the outcome of each is recorded.
 */
async function deliver(sessions: SessionCommands): Promise<void> {
  const opened = await store();
  if (!opened) return;
  const broadcasts = new BroadcastStore(opened);
  const listed = broadcasts.list();
  if (!listed.ok) { void vscode.window.showErrorMessage(`Broadcasts could not be read (${listed.reason ?? 'unknown'}).`); return; }
  const now = new Date();
  const active = (listed.items ?? []).filter((broadcast) => isLive(broadcast, now));
  if (active.length === 0) { void vscode.window.showInformationMessage('There are no active broadcasts to send.'); return; }
  const picked = await vscode.window.showQuickPick(
    active.map((broadcast) => ({ label: broadcast.text.length > 60 ? `${broadcast.text.slice(0, 60)}…` : broadcast.text, description: targetLabel(broadcast.target), id: broadcast.id })),
    { placeHolder: 'Which broadcast should be typed into the running agents?', ignoreFocusOut: true }
  );
  if (!picked) return;
  const selected = active.find((broadcast) => broadcast.id === picked.id);
  if (!selected) return;

  // The role of a session is read from its role group right now (the broadcast names a role, a session names a role group).
  const roleOf = (session: { roleGroupId?: string }): string | undefined => {
    if (!session.roleGroupId || session.roleGroupId === 'unassigned') return undefined;
    try {
      const loaded = opened.get('roleGroups', session.roleGroupId);
      return loaded?.ok && loaded.found ? loaded.value?.group?.role : undefined;
    } catch { return undefined; }
  };
  const plan = planDelivery({ broadcast: selected, sessions: sessions.list(), roleOf, now });
  if (!plan.ok) { void vscode.window.showErrorMessage(`This broadcast cannot be sent (${plan.reason}).`); return; }
  if (plan.recipients.length === 0) { void vscode.window.showInformationMessage("No open session matches this broadcast's target."); return; }
  const waitingIds = new Set(plan.recipients.filter((entry) => entry.decision === 'send').map((entry) => entry.id));
  const unknownIds = new Set(plan.recipients.filter((entry) => entry.decision === 'unknown').map((entry) => entry.id));
  if (waitingIds.size === 0 && unknownIds.size === 0) {
    void vscode.window.showInformationMessage('No session can receive this broadcast now.', { modal: true, detail: describePlan(plan).join('\n') });
    return;
  }
  // Sessions that are waiting are the default. Sessions whose state is unknown (no hook evidence: Codex, agy, a custom provider, a
  // Claude without the hook bridge) are only included when the person presses the second, explicit button.
  const sendWaiting = 'Send Now';
  const sendUnknown = waitingIds.size > 0 ? 'Also Send to Unknown' : 'Send to Unknown Anyway';
  const buttons = [...(waitingIds.size > 0 ? [sendWaiting] : []), ...(unknownIds.size > 0 ? [sendUnknown] : [])];
  const confirmed = await vscode.window.showWarningMessage(
    'Type this broadcast into the running agents?',
    { modal: true, detail: describePlan(plan).join('\n') },
    ...buttons
  );
  if (confirmed !== sendWaiting && confirmed !== sendUnknown) return;
  const includeUnknown = confirmed === sendUnknown;
  const allowedIds = new Set([...(confirmed === sendWaiting || includeUnknown ? waitingIds : []), ...(includeUnknown ? unknownIds : [])]);

  // The broadcast is read again from the store: if it was revoked or changed while the window was open, nothing is typed.
  const again = new BroadcastStore(await store() ?? opened).get(selected.id);
  const stillTheSame = again.ok && (again as { broadcast?: Broadcast }).broadcast !== undefined && isLive((again as { broadcast: Broadcast }).broadcast, new Date())
    && (again as { broadcast: Broadcast }).broadcast.text === selected.text && (again as { broadcast: Broadcast }).broadcast.version === selected.version;
  // Sessions change while a dialog is open: decide again from fresh evidence, and type only into a session that was shown to the
  // person as a recipient they allowed, and whose state is still what they agreed to.
  const fresh = stillTheSame ? planDelivery({ broadcast: selected, sessions: sessions.list(), roleOf, now: new Date() }) : { ok: false as const, reason: 'broadcast-changed' };
  if (!fresh.ok) { void vscode.window.showErrorMessage(`This broadcast can no longer be sent (${fresh.reason}).`); return; }
  const results: Array<{ sessionId: string; provider: string; outcome: 'sent' | 'skipped'; reason: string }> = [];
  for (const entry of fresh.recipients) {
    const allowed = allowedIds.has(entry.id) && (entry.decision === 'send' || (entry.decision === 'unknown' && includeUnknown));
    if (allowed) {
      try {
        sessions.sendPrompt(entry.id, fresh.prompt);
        results.push({ sessionId: entry.id, provider: entry.provider, outcome: 'sent', reason: entry.decision === 'unknown' ? 'sent-unknown-state' : entry.reason });
      } catch {
        results.push({ sessionId: entry.id, provider: entry.provider, outcome: 'skipped', reason: 'send-failed' });
      }
    } else {
      // Not allowed by the person, not shown, or no longer in the state they agreed to: not typed, and the record says why.
      results.push({ sessionId: entry.id, provider: entry.provider, outcome: 'skipped', reason: entry.decision === 'send' ? 'state-unknown' : entry.reason });
    }
  }
  const latest = await store();
  if (latest) {
    const recorded = new BroadcastStore(latest).recordDelivery({ id: randomUUID(), broadcastId: selected.id, version: selected.version, at: new Date().toISOString(), results });
    if (!recorded.ok) void vscode.window.showWarningMessage(`The delivery was done but its record could not be saved (${recorded.reason ?? 'unknown'}).`);
  }
  currentTree?.refresh();
  const sent = results.filter((entry) => entry.outcome === 'sent').length;
  void vscode.window.showInformationMessage(`Typed into ${sent} of ${results.length} session${results.length === 1 ? '' : 's'}. "Typed" is not proof that the CLI read it; see Administrator Broadcasts for the log.`);
}

let currentTree: BroadcastTree | undefined;
let detailsProvider: BroadcastDetails | undefined;

class BroadcastDetails implements vscode.TextDocumentContentProvider {
  readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  refresh(): void {
    for (const document of vscode.workspace.textDocuments) if (document.uri.scheme === BROADCAST_SCHEME) this.changed.fire(document.uri);
  }
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const match = /^[a-z0-9][a-z0-9-]{0,63}$/.exec(uri.query)?.[0];
    if (!match || match !== uri.query) return 'No valid local notice was selected.\n';
    const opened = await store(false);
    if (!opened) return 'Private broadcast storage is unavailable.\n';
    const listed = new BroadcastStore(opened).list();
    if (!listed.ok) return 'Local notices could not be read.\n';
    const broadcast = listed.items?.find((item) => item.id === match);
    if (!broadcast) return 'This local notice is unavailable.\n';
    const deliveries = new BroadcastStore(opened).listDeliveries();
    return formatBroadcast(broadcast, new Date(), deliveries.ok ? summarizeDeliveries(deliveries.items ?? [], broadcast.id) : 'unknown (the log could not be read)');
  }
}

export function registerBroadcastCommands(context: vscode.ExtensionContext, sessions: SessionCommands): void {
  const tree = new BroadcastTree();
  const provider = new BroadcastDetails();
  detailsProvider = provider;
  currentTree = tree;
  testTree = context.extensionMode === vscode.ExtensionMode.Test ? tree : undefined;
  context.subscriptions.push(
    vscode.window.createTreeView(BROADCAST_VIEW, { treeDataProvider: tree }),
    vscode.workspace.registerTextDocumentContentProvider(BROADCAST_SCHEME, provider),
    provider.changed,
    vscode.commands.registerCommand(BROADCAST_COMMANDS.details, async (id?: unknown) => {
      if (typeof id !== 'string') return;
      const document = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: BROADCAST_SCHEME, path: '/local-notice.txt', query: id }));
      await vscode.window.showTextDocument(document, { preview: true });
    }),
    vscode.commands.registerCommand(BROADCAST_COMMANDS.refresh, () => tree.refresh()),
    vscode.commands.registerCommand(BROADCAST_COMMANDS.send, () => send(sessions)),
    // Takes no argument at all, like `send` and `revoke`: nothing a caller passes can pick the broadcast, the recipients or skip the confirmation.
    vscode.commands.registerCommand(BROADCAST_COMMANDS.deliver, () => deliver(sessions)),
    vscode.commands.registerCommand(BROADCAST_COMMANDS.revoke, revoke)
  );
}
