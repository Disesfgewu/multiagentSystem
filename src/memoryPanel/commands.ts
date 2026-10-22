import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import * as vscode from 'vscode';
import { privateStorage } from '../storage/storageCommands';
import { accountService } from '../accounts/accountRuntime';
import { resolveProject, SessionCommands } from '../sessions/sessionCommands';

const { MemoryStore } = require('../memory/store') as { MemoryStore: new (options: Record<string, unknown>) => any };
const { defaultDomainFor } = require('../memory/domains') as { defaultDomainFor(id: string): string };
const { groupNotes, candidates, oneLine } = require('../memory/panel') as {
  groupNotes(items: unknown[], roleNames: Record<string, string>, now: number): Array<{ roleGroupId: string; roleName: string; domains: Array<{ domain: string; items: Array<{ id: string; label: string; state: string; stateText: string; injected: boolean; scope: string; source: string; expires: string; full: string }> }> }>;
  candidates(items: unknown[]): Array<{ id: string; content: string; roleGroupId: string; privacyDomain: string }>;
  oneLine(value: unknown, limit: number): string;
};

export const MEMORY_VIEW = 'multiagentSystem.memoryView';
export const MEMORY_COMMANDS = {
  refresh: 'multiagentSystem.memory.refresh',
  add: 'multiagentSystem.memory.add',
  edit: 'multiagentSystem.memory.edit',
  toggle: 'multiagentSystem.memory.toggle',
  remove: 'multiagentSystem.memory.remove',
  suggest: 'multiagentSystem.memory.suggest',
  review: 'multiagentSystem.memory.review'
} as const;

const APPROVER = { kind: 'human', id: 'local-user' } as const;
const REASONS: Record<string, string> = {
  'sensitive-content': 'It looks like it contains a credential, an email address or a local path.',
  'transcript-like': 'It looks like a copied conversation. Save a short note instead.',
  'too-short': 'It is too short to be a useful note.',
  'invalid-length': 'A note must be 1 to 2000 characters.',
  duplicate: 'The same note already exists in this scope.',
  'invalid-scope': 'The scope of the note is not valid.',
  'approver-required': 'A named approver is required.',
  'not-a-candidate': 'That suggestion was already reviewed.'
};
const why = (reason: unknown): string => REASONS[String(reason)] ?? `Refused (${String(reason ?? 'unknown')}).`;

type Handle = { store: any; memory: any; repoId: string; roleNames: Record<string, string> };

/** The private store, the memory store inside it, and this project's repository id; undefined with a message when any is unavailable. */
async function open(showError = true): Promise<Handle | undefined> {
  const opened = await privateStorage()?.use();
  if (!opened?.ok) { if (showError) void vscode.window.showErrorMessage(`Private storage is unavailable (${String(opened?.reason ?? 'unknown')}).`); return undefined; }
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) { if (showError) void vscode.window.showInformationMessage('Open a project folder first: shared memory belongs to a project.'); return undefined; }
  try {
    const dir = nodePath.join((opened.store as { dir: string }).dir, 'memory');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const { repoId } = await resolveProject(folder);
    const memory = new MemoryStore({ dir, repoRoot: folder });
    const roleNames: Record<string, string> = {};
    const groups = (opened.store as any).list('roleGroups');
    for (const entry of groups.ok ? groups.items ?? [] : []) { const group = entry?.value?.group; if (group && typeof group.id === 'string' && typeof group.name === 'string') roleNames[group.id] = group.name; }
    return { store: opened.store, memory, repoId, roleNames };
  } catch { if (showError) void vscode.window.showErrorMessage('Shared memory could not be opened.'); return undefined; }
}

class Row extends vscode.TreeItem {
  constructor(label: string, readonly noteId?: string) { super(label, vscode.TreeItemCollapsibleState.None); }
}
class Group extends vscode.TreeItem {
  constructor(label: string, readonly children: vscode.TreeItem[], expanded = true) { super(label, expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed); }
}

class MemoryTree implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changed = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  refresh(): void { this.changed.fire(undefined); }
  getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }
  async getChildren(item?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (item) return item instanceof Group ? item.children : [];
    if (!vscode.workspace.isTrusted) return [new Row('Trust this workspace to read shared memory.')];
    const handle = await open(false);
    if (!handle) return [new Row('Shared memory is unavailable (open a project folder; private storage must be ready).')];
    const listed = handle.memory.list();
    if (!listed.ok) return [new Row(`Shared memory could not be read (${String(listed.reason)}). Nothing is shown as empty.`)];
    const mine = (listed.items as Array<{ repoId: string }>).filter((note) => note.repoId === handle.repoId);
    if (mine.length === 0) return [new Row('No shared notes for this project yet. Use "Add Shared Memory Note".')];
    const out: vscode.TreeItem[] = [];
    const pending = candidates(mine);
    if (pending.length > 0) out.push(new Group(`Suggestions waiting for review (${pending.length})`, pending.map((note) => { const row = new Row(oneLine(note.content, 70), (note as { id: string }).id); row.description = 'review with "Review Suggested Memory"'; row.iconPath = new vscode.ThemeIcon('lightbulb'); row.tooltip = oneLine(note.content, 2000); return row; })));
    for (const role of groupNotes(mine.filter((note: any) => note.status !== 'candidate'), handle.roleNames, Date.now())) {
      for (const domain of role.domains) {
        out.push(new Group(`${role.roleName} · ${domain.domain}`, domain.items.map((note) => {
          const row = new Row(note.label, note.id);
          row.description = `${note.stateText}${note.injected ? ' · given to new agents of this role' : ''}`;
          row.tooltip = `${note.full}\n\n${note.scope}\nSource: ${note.source}\n${note.expires}\nPrivate to this computer.`;
          row.iconPath = new vscode.ThemeIcon(note.injected ? 'pass' : 'circle-slash');
          return row;
        })));
      }
    }
    return out;
  }
}

let tree: MemoryTree | undefined;

async function pickRole(handle: Handle): Promise<string | undefined> {
  const ids = Object.keys(handle.roleNames).sort();
  if (ids.length === 0) { void vscode.window.showInformationMessage('Create a role group first: shared notes are given to agents by role group.'); return undefined; }
  const picked = await vscode.window.showQuickPick(ids.map((id) => ({ label: handle.roleNames[id], description: id, id })), { placeHolder: 'Which role group should receive this note?', ignoreFocusOut: true });
  return picked?.id;
}

async function pickDomain(): Promise<string | undefined> {
  const choices: Array<{ label: string; description: string; domain: string }> = [{ label: 'CLI default sign-in', description: 'agents without an assigned account', domain: defaultDomainFor('unassigned') }];
  try {
    const available = await accountService(() => []);
    if (available.ok) {
      const listed = available.service.list();
      if (listed.ok) for (const profile of listed.profiles.slice(0, 50)) choices.push({ label: String(profile.label), description: 'account (its own privacy domain)', domain: defaultDomainFor(String(profile.id)) });
    }
  } catch { /* only the default domain is offered */ }
  const picked = await vscode.window.showQuickPick(choices, { placeHolder: 'Whose agents may read it? (each account is its own privacy domain)', ignoreFocusOut: true });
  return picked?.domain;
}

async function pickNote(handle: Handle, filter: (note: any) => boolean, placeHolder: string): Promise<any | undefined> {
  const listed = handle.memory.list();
  if (!listed.ok) { void vscode.window.showErrorMessage(`Shared memory could not be read (${String(listed.reason)}).`); return undefined; }
  const notes = (listed.items as any[]).filter((note) => note.repoId === handle.repoId && filter(note));
  if (notes.length === 0) { void vscode.window.showInformationMessage('There is nothing to choose here.'); return undefined; }
  const picked = await vscode.window.showQuickPick(notes.map((note) => ({ label: oneLine(note.content, 70), description: `${handle.roleNames[note.roleGroupId] ?? note.roleGroupId} · ${note.status}${note.disabled ? ' (off)' : ''}`, id: note.id })), { placeHolder, ignoreFocusOut: true });
  return picked ? notes.find((note) => note.id === picked.id) : undefined;
}

const trusted = (): boolean => {
  if (vscode.workspace.isTrusted) return true;
  void vscode.window.showWarningMessage('Trust this workspace before changing shared memory.');
  return false;
};

const noteText = (prompt: string, value?: string) => vscode.window.showInputBox({ prompt, value, ignoreFocusOut: true, validateInput: (text) => (text.trim() === '' ? 'Enter the note.' : undefined) });

/** Adds a note you wrote yourself: it goes through the same checks as any note, and is adopted in your name only after you confirm. */
async function add(): Promise<void> {
  if (!trusted()) return;
  const handle = await open();
  if (!handle) return;
  const roleGroupId = await pickRole(handle);
  if (!roleGroupId) return;
  const privacyDomain = await pickDomain();
  if (!privacyDomain) return;
  const text = await noteText('A short, durable note for agents of this role (no credentials, paths or copied conversations). Private to this computer.');
  if (!text) return;
  const confirmed = await vscode.window.showWarningMessage('Add this shared note?', { modal: true, detail: `${text.trim()}\n\nRole group: ${handle.roleNames[roleGroupId]}\nPrivacy domain: ${privacyDomain}\n\nAgents of this role started afterwards are told it (the CLI is told; nothing enforces it).` }, 'Add');
  if (confirmed !== 'Add') return;
  const proposed = handle.memory.propose({ repoId: handle.repoId, roleGroupId, privacyDomain, content: text, source: { kind: 'user', ref: 'shared-memory-panel' } });
  if (!proposed.ok) { void vscode.window.showErrorMessage(why(proposed.reason)); return; }
  const adopted = handle.memory.adopt(proposed.id, APPROVER);
  if (!adopted.ok) { void vscode.window.showErrorMessage(why(adopted.reason)); return; }
  tree?.refresh();
  void vscode.window.showInformationMessage('Shared note added. It applies to agents started from now on.');
}

/** Changes a note's text. The new text is a new note (checked like any other); the old one is removed only after the new one is saved. */
async function edit(): Promise<void> {
  if (!trusted()) return;
  const handle = await open();
  if (!handle) return;
  const note = await pickNote(handle, (entry) => entry.status === 'adopted', 'Which note should be changed?');
  if (!note) return;
  const text = await noteText('The new text of this note.', note.content);
  if (!text || text.trim() === note.content.trim()) return;
  const confirmed = await vscode.window.showWarningMessage('Replace this shared note?', { modal: true, detail: `Now:\n${note.content}\n\nNew:\n${text.trim()}\n\nAgents started afterwards are told the new text. Running agents keep what they were started with.` }, 'Replace');
  if (confirmed !== 'Replace') return;
  const proposed = handle.memory.propose({ repoId: note.repoId, roleGroupId: note.roleGroupId, privacyDomain: note.privacyDomain, content: text, source: note.source, ttlMs: note.ttlMs });
  if (!proposed.ok) { void vscode.window.showErrorMessage(`${why(proposed.reason)} The old note was kept.`); return; }
  const adopted = handle.memory.adopt(proposed.id, APPROVER);
  if (!adopted.ok) { handle.memory.remove(proposed.id); void vscode.window.showErrorMessage(`${why(adopted.reason)} The old note was kept.`); return; }
  handle.memory.remove(note.id);
  tree?.refresh();
}

async function toggle(): Promise<void> {
  if (!trusted()) return;
  const handle = await open();
  if (!handle) return;
  const note = await pickNote(handle, (entry) => entry.status === 'adopted', 'Which note should be switched off or on?');
  if (!note) return;
  const off = note.disabled !== true;
  const confirmed = await vscode.window.showWarningMessage(off ? 'Switch this note off?' : 'Switch this note on?', { modal: true, detail: `${note.content}\n\n${off ? 'Agents started afterwards will not be told it. The note is kept.' : 'Agents started afterwards will be told it again.'}` }, off ? 'Switch Off' : 'Switch On');
  if (!confirmed) return;
  const result = off ? handle.memory.disable(note.id) : handle.memory.enable(note.id);
  if (!result.ok) { void vscode.window.showErrorMessage(`The note was not changed (${String(result.reason)}).`); return; }
  tree?.refresh();
}

async function remove(): Promise<void> {
  if (!trusted()) return;
  const handle = await open();
  if (!handle) return;
  const note = await pickNote(handle, () => true, 'Which note should be deleted?');
  if (!note) return;
  const confirmed = await vscode.window.showWarningMessage('Delete this shared note?', { modal: true, detail: `${note.content}\n\nThis cannot be undone.` }, 'Delete');
  if (confirmed !== 'Delete') return;
  const result = handle.memory.remove(note.id);
  if (!result.ok) { void vscode.window.showErrorMessage('The note was not deleted.'); return; }
  tree?.refresh();
}

/**
 * Records something an agent suggested as a SUGGESTION only. There is no automatic channel from a running agent into this store: the person
 * pastes what the agent proposed and says which session it came from. A suggestion is never given to any agent until it is reviewed.
 */
async function suggest(sessions: SessionCommands): Promise<void> {
  if (!trusted()) return;
  const handle = await open();
  if (!handle) return;
  const listed = sessions.list();
  if (listed.length === 0) { void vscode.window.showInformationMessage('No managed session to attribute the suggestion to.'); return; }
  const session = await vscode.window.showQuickPick(listed.map((entry) => ({ label: entry.name, description: entry.provider, id: entry.id, roleGroupId: entry.roleGroupId })), { placeHolder: 'Which agent suggested it?', ignoreFocusOut: true });
  if (!session) return;
  const roleGroupId = session.roleGroupId && session.roleGroupId !== 'unassigned' && handle.roleNames[session.roleGroupId] ? session.roleGroupId : await pickRole(handle);
  if (!roleGroupId) return;
  const text = await noteText('The note the agent suggested (it is only a suggestion until you review it).');
  if (!text) return;
  const proposed = handle.memory.propose({ repoId: handle.repoId, roleGroupId, privacyDomain: defaultDomainFor('unassigned'), content: text, source: { kind: 'agent-suggestion', ref: `session ${oneLine(session.id, 40)}` } });
  if (!proposed.ok) { void vscode.window.showErrorMessage(why(proposed.reason)); return; }
  tree?.refresh();
  void vscode.window.showInformationMessage('Saved as a suggestion. No agent is told it until you review it.');
}

/** Reviews one suggestion: Adopt (in your name) or Reject. Nothing is adopted without this window. */
async function review(): Promise<void> {
  if (!trusted()) return;
  const handle = await open();
  if (!handle) return;
  const note = await pickNote(handle, (entry) => entry.status === 'candidate', 'Which suggestion should be reviewed?');
  if (!note) return;
  const decision = await vscode.window.showWarningMessage('Review this suggested note', { modal: true, detail: `${note.content}\n\nSource: ${note.source?.kind}: ${note.source?.ref}\nRole group: ${handle.roleNames[note.roleGroupId] ?? note.roleGroupId}\n\nAdopting tells agents of this role (started afterwards) this note. Nothing enforces it.` }, 'Adopt', 'Reject');
  if (decision !== 'Adopt' && decision !== 'Reject') return;
  const result = decision === 'Adopt' ? handle.memory.adopt(note.id, APPROVER) : handle.memory.reject(note.id);
  if (!result.ok) { void vscode.window.showErrorMessage(why(result.reason)); return; }
  tree?.refresh();
}

export function registerMemoryCommands(context: vscode.ExtensionContext, sessions: SessionCommands): void {
  tree = new MemoryTree();
  context.subscriptions.push(
    vscode.window.createTreeView(MEMORY_VIEW, { treeDataProvider: tree }),
    // None of these takes an argument: the role group, the text, the choice of note and the confirmation always come from these windows.
    vscode.commands.registerCommand(MEMORY_COMMANDS.refresh, () => tree?.refresh()),
    vscode.commands.registerCommand(MEMORY_COMMANDS.add, () => add()),
    vscode.commands.registerCommand(MEMORY_COMMANDS.edit, () => edit()),
    vscode.commands.registerCommand(MEMORY_COMMANDS.toggle, () => toggle()),
    vscode.commands.registerCommand(MEMORY_COMMANDS.remove, () => remove()),
    vscode.commands.registerCommand(MEMORY_COMMANDS.suggest, () => suggest(sessions)),
    vscode.commands.registerCommand(MEMORY_COMMANDS.review, () => review())
  );
}
