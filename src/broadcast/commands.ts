import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { privateStorage } from '../storage/storageCommands';

const { BroadcastStore } = require('./store') as {
  BroadcastStore: new (store: Store) => {
    list(): { ok: boolean; items?: Broadcast[]; reason?: string };
    create(raw: unknown): { ok: boolean; broadcast?: Broadcast; reason?: string; problems?: string[]; scan?: unknown };
    revoke(id: string, revokedAt: string): { ok: boolean; broadcast?: Broadcast; reason?: string };
  };
};
const { scanBroadcastText, isLive } = require('./model') as {
  scanBroadcastText(text: string): { status: string };
  isLive(broadcast: Broadcast, now: Date): boolean;
};
const { roleProviderChoices } = require('../roles/provider-choices') as {
  roleProviderChoices(): Array<{ id: string; label: string; detail: string }>;
};

type Target = { scope: 'all' } | { scope: 'roleGroup'; role: string } | { scope: 'provider'; provider: string } | { scope: 'agent'; agentId: string };
type Broadcast = { id: string; version: number; target: Target; text: string; createdAt: string; expiresAt: string | null; revokedAt: string | null };
type Store = { get(collection: string, id: string): any; list(collection: string): any; transact(work: (tx: any) => unknown): any };

export const BROADCAST_VIEW = 'multiagentSystem.broadcastsView';
export const BROADCAST_COMMANDS = {
  refresh: 'multiagentSystem.broadcasts.refresh',
  send: 'multiagentSystem.broadcasts.send',
  revoke: 'multiagentSystem.broadcasts.revoke'
} as const;

const ROLE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const EXPIRY_CHOICES: Array<{ label: string; detail: string; hours: number | null }> = [
  { label: 'Until revoked', detail: 'Stays in effect for new or reopened sessions until you revoke it.', hours: null },
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

function targetLabel(target: Target): string {
  if (target.scope === 'all') return 'Every agent';
  if (target.scope === 'roleGroup') return `Role group: ${target.role}`;
  if (target.scope === 'provider') return `Provider: ${target.provider}`;
  return `Agent: ${target.agentId}`;
}

function statusOf(broadcast: Broadcast, now: Date): string {
  if (broadcast.revokedAt !== null) return 'revoked';
  if (broadcast.expiresAt !== null && Date.parse(broadcast.expiresAt) <= now.getTime()) return 'expired';
  return 'active';
}

class BroadcastItem extends vscode.TreeItem {
  constructor(readonly broadcast: Broadcast, now: Date) {
    super(broadcast.text.length > 60 ? `${broadcast.text.slice(0, 60)}…` : broadcast.text, vscode.TreeItemCollapsibleState.None);
    const status = statusOf(broadcast, now);
    this.description = `${targetLabel(broadcast.target)} · ${status}`;
    this.tooltip = [
      `Sent: ${broadcast.createdAt}`,
      `Target: ${targetLabel(broadcast.target)}`,
      `Status: ${status}`,
      broadcast.expiresAt ? `Expires: ${broadcast.expiresAt}` : 'No expiry: stays in effect until revoked',
      broadcast.revokedAt ? `Revoked: ${broadcast.revokedAt}` : null,
      '',
      'This applies only to new or reopened sessions. It cannot change what an already-running agent is doing, and there is no evidence that any CLI actually read or followed it.'
    ].filter((line): line is string => line !== null).join('\n');
    this.iconPath = new vscode.ThemeIcon(status === 'active' ? 'megaphone' : status === 'revoked' ? 'circle-slash' : 'clock');
    this.contextValue = status === 'active' ? 'multiagentBroadcastActive' : 'multiagentBroadcast';
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
  refresh(): void { this.changed.fire(undefined); }
  getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }
  async getChildren(): Promise<vscode.TreeItem[]> {
    const opened = await store(false);
    if (!opened) return [new MessageItem('Private broadcast storage is unavailable.')];
    const listed = new BroadcastStore(opened).list();
    if (!listed.ok) return [new MessageItem(`Broadcasts could not be read (${listed.reason ?? 'unknown'}).`)];
    const items = listed.items ?? [];
    if (items.length === 0) return [new MessageItem('No broadcasts sent yet. Use "Send Broadcast" to send one to some or all agents.')];
    const now = new Date();
    return [...items].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)).map((broadcast) => new BroadcastItem(broadcast, now));
  }
}

let testTree: BroadcastTree | undefined;
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
async function send(): Promise<void> {
  const scopeChoice = await vscode.window.showQuickPick([
    { label: 'Every agent', detail: 'Applies to all providers and role groups.', value: 'all' as const },
    { label: 'A role group', detail: 'Applies only to agents with this role (e.g. pm, worker, researcher).', value: 'roleGroup' as const },
    { label: 'A provider', detail: 'Applies only to agents using this CLI.', value: 'provider' as const }
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
  } else if (scopeChoice.value === 'provider') {
    const provider = await vscode.window.showQuickPick(roleProviderChoices(), { placeHolder: 'Which provider?', ignoreFocusOut: true });
    if (!provider) return;
    target = { scope: 'provider', provider: provider.id };
  } else {
    target = { scope: 'all' };
  }

  const text = await vscode.window.showInputBox({
    prompt: `Broadcast to ${targetLabel(target)}. This is only a local instruction: there is no proof any CLI will read it.`,
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
    'Send this broadcast?',
    { modal: true, detail: `To: ${targetLabel(target)}\nExpires: ${expiresAt ?? 'until revoked'}\n\n${text.trim()}\n\nThis is a local-only instruction. It only reaches new or reopened sessions, never one already running; there is no proof any CLI will read or follow it.` },
    'Send Broadcast'
  );
  if (confirmed !== 'Send Broadcast') return;

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
  void vscode.window.showInformationMessage(`Broadcast sent to ${targetLabel(target)}.`);
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
  const confirmed = await vscode.window.showWarningMessage(
    'Revoke this broadcast?', { modal: true, detail: 'New or reopened sessions will no longer carry it. This cannot be undone, and it does not reach any session that already applied it.' }, 'Revoke'
  );
  if (confirmed !== 'Revoke') return;
  const result = broadcasts.revoke(picked.id, new Date().toISOString());
  if (!result.ok) { void vscode.window.showErrorMessage(`The broadcast could not be revoked (${result.reason ?? 'unknown'}).`); return; }
  currentTree?.refresh();
  void vscode.window.showInformationMessage('Broadcast revoked.');
}

let currentTree: BroadcastTree | undefined;

export function registerBroadcastCommands(context: vscode.ExtensionContext): void {
  const tree = new BroadcastTree();
  currentTree = tree;
  testTree = context.extensionMode === vscode.ExtensionMode.Test ? tree : undefined;
  context.subscriptions.push(
    vscode.window.createTreeView(BROADCAST_VIEW, { treeDataProvider: tree }),
    vscode.commands.registerCommand(BROADCAST_COMMANDS.refresh, () => tree.refresh()),
    vscode.commands.registerCommand(BROADCAST_COMMANDS.send, send),
    vscode.commands.registerCommand(BROADCAST_COMMANDS.revoke, revoke)
  );
}
