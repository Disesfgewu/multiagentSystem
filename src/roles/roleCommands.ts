import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { privateStorage } from '../storage/storageCommands';
import { builtIn } from '../providers/registry';

const { validateRoleGroup } = require('./role-group') as { validateRoleGroup(value: unknown): { ok: boolean; problems: Array<{ code: string; path: string }>; group?: RoleGroup } };
const { previewEffectiveRules, formatPreview } = require('./preview') as {
  previewEffectiveRules(value: { roleGroup: RoleGroup; layers: RuleLayers }): { ok: boolean; problems: Array<{ code: string; path: string }> };
  formatPreview(value: unknown): string;
};

type RuleLayer = 'platform' | 'user' | 'project' | 'roleGroup' | 'task';
type Rule = { id: string; type: 'instruction' | 'forbid' | 'require'; text?: string; key?: string; version: number };
type RuleLayers = Partial<Record<Exclude<RuleLayer, 'roleGroup'>, Rule[]>>;
type RoleGroup = {
  id: string; name: string; role: string; provider: string; version: number;
  defaultAccountProfileId: string | null;
  allowedScope: { repositories: string[]; paths: string[] };
  toolPermissions: Record<string, string>;
  memoryScope: { mode: string };
  rules: Rule[];
};
type RoleRecord = { group: RoleGroup; layers: RuleLayers };
type Store = { list(collection: string): any; get(collection: string, id: string): any; put(collection: string, id: string, value: unknown): any; delete(collection: string, id: string): any };

export const ROLE_VIEW = 'multiagentSystem.rolesView';
export const ROLE_COMMANDS = {
  refresh: 'multiagentSystem.roles.refresh',
  create: 'multiagentSystem.roles.create',
  edit: 'multiagentSystem.roles.edit',
  preview: 'multiagentSystem.roles.preview',
  remove: 'multiagentSystem.roles.remove'
} as const;

const message = (reason: unknown): string => `Role group storage is unavailable (${String(reason ?? 'unknown')}).`;
const selectedId = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string'
    ? (value as { id: string }).id : undefined;

async function store(showError = true): Promise<Store | undefined> {
  const handle = privateStorage();
  const opened = await handle?.use();
  if (!opened?.ok) {
    if (showError) void vscode.window.showErrorMessage(message(opened?.reason));
    return undefined;
  }
  return opened.store as Store;
}

function validRecord(value: unknown): value is RoleRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as RoleRecord;
  if (!validateRoleGroup(record.group).ok) return false;
  if (!record.layers || typeof record.layers !== 'object' || Array.isArray(record.layers)) return false;
  return previewEffectiveRules({ roleGroup: record.group, layers: record.layers }).ok;
}

export async function saveRoleRecord(record: RoleRecord): Promise<{ ok: boolean; reason?: string }> {
  if (!validRecord(record)) return { ok: false, reason: 'invalid-role-record' };
  const opened = await store();
  if (!opened) return { ok: false, reason: 'storage-unavailable' };
  const result = opened.put('roleGroups', record.group.id, record);
  if (result.ok) currentTree?.refresh();
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}

class RoleItem extends vscode.TreeItem {
  constructor(readonly roleId: string, group: RoleGroup) {
    super(group.name, vscode.TreeItemCollapsibleState.None);
    this.id = roleId;
    this.description = `${group.role} · ${builtIn.get(group.provider)?.label ?? group.provider} · v${group.version} · CLI not verified`;
    this.tooltip = 'Effective rules can be previewed. CLI injection and tool enforcement have not been verified.';
    this.contextValue = 'multiagentRoleGroup';
    this.iconPath = new vscode.ThemeIcon('organization');
    this.command = { command: ROLE_COMMANDS.preview, title: 'Preview effective rules', arguments: [roleId] };
  }
}

class MessageItem extends vscode.TreeItem {
  constructor(text: string) { super(text); this.iconPath = new vscode.ThemeIcon('info'); }
}

type RoleTreeItem = RoleItem | MessageItem;
class RoleTree implements vscode.TreeDataProvider<RoleTreeItem> {
  private readonly emitter = new vscode.EventEmitter<RoleTreeItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  refresh(): void { this.emitter.fire(undefined); }
  getTreeItem(item: RoleTreeItem): vscode.TreeItem { return item; }
  async getChildren(item?: RoleTreeItem): Promise<RoleTreeItem[]> {
    if (item) return [];
    const opened = await store(false);
    if (!opened) return [new MessageItem('Private role group storage is unavailable.')];
    const listed = opened.list('roleGroups');
    if (!listed.ok) return [new MessageItem(message(listed.reason))];
    if (listed.items.length === 0) return [new MessageItem('No role groups. Use Create Role Group to add one.')];
    return listed.items.map((entry: { id: string; value: unknown }) => validRecord(entry.value) && entry.value.group.id === entry.id
      ? new RoleItem(entry.id, entry.value.group)
      : new MessageItem(`Invalid private role group: ${entry.id}`));
  }
}

let currentTree: RoleTree | undefined;
let testTree: RoleTree | undefined;
let extensionRoot = '';
export function roleTreeForTests(): vscode.TreeDataProvider<RoleTreeItem> {
  if (!testTree) throw new Error('Role tree is only available in Extension Host tests.');
  return testTree;
}

function template(role: string, provider: string, name: string): RoleRecord {
  return { group: {
    id: `role-${randomUUID()}`, name, role, provider, version: 1, defaultAccountProfileId: null,
    allowedScope: { repositories: [], paths: [] }, toolPermissions: {}, memoryScope: { mode: 'off' }, rules: []
  }, layers: {} };
}

async function chooseRecord(value: unknown): Promise<RoleRecord | undefined> {
  const opened = await store();
  if (!opened) return;
  let id = selectedId(value);
  if (!id) {
    const listed = opened.list('roleGroups');
    if (!listed.ok) { void vscode.window.showErrorMessage(message(listed.reason)); return; }
    const choices: Array<{ label: string; description: string; id: string }> = listed.items.filter((entry: { id: string; value: unknown }) =>
      validRecord(entry.value) && entry.value.group.id === entry.id)
      .map((entry: { id: string; value: RoleRecord }) => ({ label: entry.value.group.name, description: entry.value.group.role, id: entry.id }));
    id = (await vscode.window.showQuickPick(choices, { placeHolder: 'Choose a role group' }))?.id;
  }
  if (!id) return;
  const loaded = opened.get('roleGroups', id);
  if (!loaded.ok || !loaded.found || !validRecord(loaded.value) || loaded.value.group.id !== id) {
    void vscode.window.showErrorMessage('The role group could not be read or validated.');
    return;
  }
  return loaded.value;
}

async function create(): Promise<void> {
  const role = await vscode.window.showQuickPick([
    { label: 'PM', value: 'pm' as const }, { label: 'Developer', value: 'worker' as const },
    { label: 'Researcher', value: 'researcher' as const },
    { label: 'Custom role', value: 'custom' as const }
  ], { placeHolder: 'Choose a role' });
  if (!role) return;
  const roleId = role.value === 'custom'
    ? await vscode.window.showInputBox({ prompt: 'Role id (lowercase letters, digits and hyphens)',
      validateInput: (text) => /^[a-z][a-z0-9-]{0,31}$/.test(text) ? undefined : 'Use a lowercase role id.' })
    : role.value;
  if (!roleId) return;
  const provider = await vscode.window.showQuickPick(builtIn.list().map((item: { id: string; label: string }) => ({ label: item.label, id: item.id })),
    { placeHolder: 'Choose the CLI provider' });
  if (!provider) return;
  const name = await vscode.window.showInputBox({ prompt: 'Role group name', value: role.label,
    validateInput: (text) => text.trim() ? undefined : 'Enter a name.' });
  if (!name) return;
  const result = await saveRoleRecord(template(roleId, provider.id, name));
  if (!result.ok) void vscode.window.showErrorMessage(`Could not save role group (${result.reason}).`);
}

function pmPrompt(): string | undefined {
  try {
    const source = fs.readFileSync(path.join(extensionRoot, 'docs', 'PM_SYSTEM_PROMPT.md'), 'utf8');
    return source.match(/```text\r?\n([\s\S]*?)\r?\n```/)?.[1];
  } catch { return undefined; }
}

async function edit(value: unknown): Promise<void> {
  const record = await chooseRecord(value);
  if (!record) return;
  const action = await vscode.window.showQuickPick([
    { label: 'Rename role group', value: 'rename' },
    { label: 'Add instruction', value: 'add' },
    { label: 'Edit instruction', value: 'edit' },
    { label: 'Remove instruction', value: 'remove' },
    { label: 'Use bundled PM system prompt', value: 'pm-template' },
    { label: 'Set tool permission', value: 'tool' },
    { label: 'Set default account profile', value: 'account' },
    { label: 'Set allowed repositories', value: 'repositories' },
    { label: 'Set allowed paths', value: 'paths' }
  ], { placeHolder: `Edit ${record.group.name}` });
  if (!action) return;
  if (action.value === 'rename') {
    const name = await vscode.window.showInputBox({ prompt: 'Role group name', value: record.group.name });
    if (!name) return;
    record.group.name = name;
  } else if (action.value === 'tool') {
    const tool = await vscode.window.showQuickPick(['shell', 'fileWrite', 'network', 'githubRead', 'githubWrite', 'merge']);
    if (!tool) return;
    const level = await vscode.window.showQuickPick(['deny', 'ask', 'allow'], { placeHolder: `Declared permission for ${tool}; CLI enforcement is unverified` });
    if (!level) return;
    record.group.toolPermissions[tool] = level;
  } else if (action.value === 'account') {
    const opened = await store();
    if (!opened) return;
    const listed = opened.list('profiles');
    if (!listed.ok) { void vscode.window.showErrorMessage(message(listed.reason)); return; }
    const choices: Array<{ label: string; description?: string; id: string | null }> = [
      { label: 'No default account', id: null },
      ...listed.items.filter((entry: { value: any }) => entry.value?.provider === record.group.provider)
        .map((entry: { id: string; value: any }) => ({ label: String(entry.value.label), description: entry.id, id: entry.id }))
    ];
    const picked = await vscode.window.showQuickPick(choices, { placeHolder: 'Choose the role default; session assignment is not connected yet' });
    if (!picked) return;
    record.group.defaultAccountProfileId = picked.id;
  } else if (action.value === 'repositories' || action.value === 'paths') {
    const field = action.value;
    const input = await vscode.window.showInputBox({
      prompt: field === 'repositories' ? 'Allowed owner/repository names, separated by commas' : 'Allowed repository-relative paths, separated by commas',
      value: record.group.allowedScope[field].join(', ')
    });
    if (input === undefined) return;
    record.group.allowedScope[field] = input.trim() ? input.split(',').map((part) => part.trim()) : [];
  } else if (action.value === 'pm-template') {
    if (record.group.role !== 'pm') { void vscode.window.showErrorMessage('The bundled PM prompt is for PM role groups.'); return; }
    const text = pmPrompt();
    if (!text) { void vscode.window.showErrorMessage('The bundled PM prompt is unavailable.'); return; }
    record.group.rules = record.group.rules.filter((rule) => rule.id !== 'pm-system-prompt');
    record.group.rules.push({ id: 'pm-system-prompt', type: 'instruction', text, version: 1 });
  } else {
    const layer = await vscode.window.showQuickPick([
      { label: 'System / platform preview', value: 'platform' as const },
      { label: 'Global / user preview', value: 'user' as const },
      { label: 'Project preview', value: 'project' as const },
      { label: 'Role group', value: 'roleGroup' as const },
      { label: 'Task preview', value: 'task' as const }
    ], { placeHolder: 'Choose the instruction layer (preview only)' });
    if (!layer) return;
    const rules = layer.value === 'roleGroup' ? record.group.rules : (record.layers[layer.value] ??= []);
    let target: Rule | undefined;
    if (action.value !== 'add') {
      const picked = await vscode.window.showQuickPick(rules.filter((rule) => rule.type === 'instruction')
        .map((rule) => ({ label: rule.id, description: (rule.text ?? '').slice(0, 80), id: rule.id })));
      if (!picked) return;
      target = rules.find((rule) => rule.id === picked.id);
      if (!target) return;
    }
    if (action.value === 'remove') rules.splice(rules.indexOf(target!), 1);
    else {
      const text = await vscode.window.showInputBox({ prompt: 'Instruction text', value: target?.text ?? '',
        validateInput: (input) => input.trim() ? undefined : 'Enter an instruction.' });
      if (!text) return;
      if (target) { target.text = text; target.version += 1; }
      else rules.push({ id: `instruction-${randomUUID()}`, type: 'instruction', text, version: 1 });
    }
  }
  record.group.version += 1;
  const result = await saveRoleRecord(record);
  if (!result.ok) void vscode.window.showErrorMessage(`Role group was not saved (${result.reason}).`);
}

async function preview(value: unknown): Promise<void> {
  const record = await chooseRecord(value);
  if (!record) return;
  const result = previewEffectiveRules({ roleGroup: record.group, layers: record.layers });
  const text = [
    'CLI application: not verified. These local rules have not been sent to the selected CLI.',
    'Tool permissions: preview only. Broker or isolation is required to enforce them.',
    '', formatPreview(result)
  ].join('\n');
  const document = await vscode.workspace.openTextDocument({ language: 'plaintext', content: text });
  await vscode.window.showTextDocument(document, { preview: true });
}

async function remove(value: unknown): Promise<void> {
  const record = await chooseRecord(value);
  if (!record) return;
  const answer = await vscode.window.showWarningMessage(`Remove role group “${record.group.name}”?`,
    { modal: true, detail: 'The local role group and its preview rules will be deleted.' }, 'Remove Role Group');
  if (answer !== 'Remove Role Group') return;
  const opened = await store();
  if (!opened) return;
  const result = opened.delete('roleGroups', record.group.id);
  if (!result.ok) void vscode.window.showErrorMessage(message(result.reason));
  else currentTree?.refresh();
}

export function registerRoleCommands(context: vscode.ExtensionContext): void {
  extensionRoot = context.extensionPath;
  const tree = new RoleTree();
  currentTree = tree;
  testTree = context.extensionMode === vscode.ExtensionMode.Test ? tree : undefined;
  context.subscriptions.push(
    vscode.window.createTreeView(ROLE_VIEW, { treeDataProvider: tree }),
    vscode.commands.registerCommand(ROLE_COMMANDS.refresh, () => tree.refresh()),
    vscode.commands.registerCommand(ROLE_COMMANDS.create, create),
    vscode.commands.registerCommand(ROLE_COMMANDS.edit, edit),
    vscode.commands.registerCommand(ROLE_COMMANDS.preview, preview),
    vscode.commands.registerCommand(ROLE_COMMANDS.remove, remove)
  );
}
