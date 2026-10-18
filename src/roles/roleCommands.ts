import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { privateStorage } from '../storage/storageCommands';
import { builtIn } from '../providers/registry';
import { accountService } from '../accounts/accountRuntime';
import type { SessionCommands } from '../sessions/sessionCommands';
import { requireInteractive } from '../shared/testMode';

const { RoleStore, validRecord } = require('./role-store') as {
  RoleStore: new (store: Store) => { list(): any; get(id: string): any; save(record: RoleRecord, options?: { expectedRevision?: number }): any };
  validRecord(value: unknown, id?: string): value is RoleRecord;
};
const { editRoleRecord } = require('./edit-role') as {
  editRoleRecord(record: RoleRecord, change: Record<string, unknown>): { ok: boolean; record?: RoleRecord; reason?: string };
};
const { selectRoleProfiles } = require('./account-choices') as {
  selectRoleProfiles(profiles: unknown, provider: string): { ok: boolean; reason?: string; profiles?: Array<{ id: string; label: string }> };
};
const { previewEffectiveRules, formatPreview } = require('./preview') as {
  previewEffectiveRules(value: { roleGroup: RoleGroup; layers: RuleLayers }): { ok: boolean; digest?: string; problems: Array<{ code: string; path: string }> };
  formatPreview(value: unknown, options?: { injection?: unknown; catalog?: unknown[]; allowlist?: Record<string, string[]>; includeResearchSkills?: boolean; workspaceRoot?: string; consentedServerIds?: string[] }): string;
};
const { injectionStatus } = require('./injection-status') as { injectionStatus(input: { provider: string }): { state: string; label: string; reason: string } };
const { roleProviderChoices } = require('./provider-choices') as { roleProviderChoices(): Array<{ id: string; label: string; detail: string }> };
const { BroadcastStore } = require('../broadcast/store') as { BroadcastStore: new (store: Store) => { list(): { ok: boolean; items?: unknown[]; reason?: string } } };
const { liveBroadcastRules, broadcastPreviewLines } = require('../broadcast/model') as {
  liveBroadcastRules(items: unknown, context: { role: string; provider: string }, now: Date): Rule[];
  broadcastPreviewLines(items: unknown, context: { role: string; provider: string }, now: Date): string[];
};
const { TEMPLATES, buildFromTemplate, describeRoleGroup } = require('./templates') as {
  describeRoleGroup(record: RoleRecord, options?: { catalog?: unknown[]; allowlist?: Record<string, string[]>; includeResearchSkills?: boolean; workspaceRoot?: string; consentedServerIds?: string[] }): string;
  TEMPLATES: Record<string, { id: string; title: string; summary: string; defaultName: string; role: string | null; toolPermissions: Record<string, string> }>;
  buildFromTemplate(input: { templateId: string; provider: string; name: string; role?: string; newId: string }): { ok: boolean; record?: RoleRecord; problems?: Array<{ code: string; path: string }> };
};
const { toolHelp, levelHelp, fieldHelp, ENFORCEMENT_NOTE } = require('./field-help') as {
  toolHelp(tool: string): string | null; levelHelp(level: string): string | null; fieldHelp(field: string): string | null; ENFORCEMENT_NOTE: string;
};
const { checkPromptInjection, validateResearchDeliverable } = require('../research/ethics') as {
  checkPromptInjection(text: string): { hasInjection: boolean; matches: string[] };
  validateResearchDeliverable(deliverable: unknown, options?: { target?: string }): { ok: boolean; code: string };
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
type RoleRecord = { group: RoleGroup; layers: RuleLayers; revision?: number };
type Store = { list(collection: string): any; get(collection: string, id: string): any; transact(work: (tx: any) => unknown): any; delete(collection: string, id: string): any };

export const ROLE_VIEW = 'multiagentSystem.rolesView';
export const ROLE_COMMANDS = {
  refresh: 'multiagentSystem.roles.refresh',
  create: 'multiagentSystem.roles.create',
  edit: 'multiagentSystem.roles.edit',
  preview: 'multiagentSystem.roles.preview',
  remove: 'multiagentSystem.roles.remove',
  start: 'multiagentSystem.roles.start'
} as const;

const message = (reason: unknown): string => `Role group storage is unavailable (${String(reason ?? 'unknown')}).`;
const selectedId = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string'
    ? (value as { id: string }).id : undefined;

async function accountChoices(provider: string): Promise<{ ok: true; profiles: Array<{ id: string; label: string }> } | { ok: false; reason: string }> {
  const available = await accountService(() => []);
  if (!available.ok) return { ok: false, reason: available.code };
  const listed = available.service.list();
  if (!listed.ok) return { ok: false, reason: listed.code };
  const selected = selectRoleProfiles(listed.profiles, provider);
  return selected.ok && Array.isArray(selected.profiles)
    ? { ok: true, profiles: selected.profiles }
    : { ok: false, reason: selected.reason ?? 'invalid-account-list' };
}

async function store(showError = true): Promise<Store | undefined> {
  const handle = privateStorage();
  const opened = await handle?.use();
  if (!opened?.ok) {
    if (showError) void vscode.window.showErrorMessage(message(opened?.reason));
    return undefined;
  }
  return opened.store as Store;
}

export async function saveRoleRecord(record: RoleRecord, expectedRevision?: number): Promise<{ ok: boolean; reason?: string }> {
  if (!record || typeof record !== 'object') return { ok: false, reason: 'invalid-role-record' };
  if ((record as any).researchFindings !== undefined) {
    const deliverableCheck = validateResearchDeliverable((record as any).researchFindings, { target: 'instructions' });
    if (!deliverableCheck.ok) return { ok: false, reason: deliverableCheck.code };
  }
  if (typeof record.group?.name === 'string' && checkPromptInjection(record.group.name).hasInjection) {
    return { ok: false, reason: 'prompt-injection-detected' };
  }
  for (const rule of Array.isArray(record.group?.rules) ? record.group.rules : []) {
    if (rule?.type === 'instruction' && typeof rule.text === 'string' && checkPromptInjection(rule.text).hasInjection) {
      return { ok: false, reason: 'prompt-injection-detected' };
    }
  }
  for (const list of Object.values(record.layers ?? {})) {
    for (const rule of Array.isArray(list) ? list : []) {
      if (rule?.type === 'instruction' && typeof rule.text === 'string' && checkPromptInjection(rule.text).hasInjection) {
        return { ok: false, reason: 'prompt-injection-detected' };
      }
    }
  }
  if (!validRecord(record)) return { ok: false, reason: 'invalid-role-record' };
  const opened = await store();
  if (!opened) return { ok: false, reason: 'storage-unavailable' };
  const result = new RoleStore(opened).save(record, { expectedRevision });
  if (result.ok) { currentTree?.refresh(); previewChanged?.(record.group.id); }
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
    const listed = new RoleStore(opened).list();
    if (!listed.ok) return [new MessageItem(message(listed.reason))];
    if (listed.items.length === 0) return [new MessageItem('No role groups. Use Create Role Group to add one.')];
    return listed.items.map((entry: { id: string; record: RoleRecord }) => new RoleItem(entry.id, entry.record.group));
  }
}

let currentTree: RoleTree | undefined;
let previewChanged: ((id: string) => void) | undefined;
let testTree: RoleTree | undefined;
let extensionRoot = '';
export function roleTreeForTests(): vscode.TreeDataProvider<RoleTreeItem> {
  if (!testTree) throw new Error('Role tree is only available in Extension Host tests.');
  return testTree;
}

async function chooseRecord(value: unknown): Promise<RoleRecord | undefined> {
  const opened = await store();
  if (!opened) return;
  let id = selectedId(value);
  if (!id) {
    const listed = new RoleStore(opened).list();
    if (!listed.ok) { void vscode.window.showErrorMessage(message(listed.reason)); return; }
    const choices: Array<{ label: string; description: string; id: string }> = listed.items
      .map((entry: { id: string; record: RoleRecord }) => ({ label: entry.record.group.name, description: entry.record.group.role, id: entry.id }));
    id = (await vscode.window.showQuickPick(choices, { placeHolder: 'Choose a role group' }))?.id;
  }
  if (!id) return;
  const loaded = new RoleStore(opened).get(id);
  if (!loaded.ok) {
    void vscode.window.showErrorMessage('The role group could not be read or validated.');
    return;
  }
  return loaded.record;
}

export const PREVIEW_SCHEME = 'multiagent-role-preview';

async function create(): Promise<void> {
  const picked = await vscode.window.showQuickPick(Object.values(TEMPLATES).map((template) => ({
    label: template.title, detail: template.summary, template
  })), { placeHolder: 'Start from a template (you can change everything afterwards)', ignoreFocusOut: true });
  if (!picked) return;
  const template = picked.template;
  let roleId: string | undefined;
  if (template.role === null) {
    roleId = await vscode.window.showInputBox({ prompt: `Role id: ${fieldHelp('role')} Use lowercase letters, digits and hyphens.`,
      validateInput: (text) => /^[a-z][a-z0-9-]{0,31}$/.test(text) ? undefined : 'Use a lowercase role id such as researcher.' });
    if (!roleId) return;
  }
  const provider = await vscode.window.showQuickPick(roleProviderChoices(),
    { placeHolder: fieldHelp('provider') ?? 'Choose the CLI provider', ignoreFocusOut: true });
  if (!provider) return;
  const name = await vscode.window.showInputBox({ prompt: fieldHelp('name') ?? 'Role group name', value: template.defaultName,
    validateInput: (text) => text.trim() ? undefined : 'Enter a name.' });
  if (!name) return;
  const built = buildFromTemplate({ templateId: template.id, provider: provider.id, name, role: roleId, newId: `role-${randomUUID()}` });
  if (!built.ok || !built.record) { void vscode.window.showErrorMessage('The role group could not be built from this template.'); return; }
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const answer = await vscode.window.showInformationMessage(`Create role group “${built.record.group.name}”?`,
    { modal: true, detail: describeRoleGroup(built.record, { includeResearchSkills: true, workspaceRoot }) }, 'Create Role Group');
  if (answer !== 'Create Role Group') return;
  const result = await saveRoleRecord(built.record);
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
  const expectedRevision = record.revision;
  const help = (field: string): string | undefined => fieldHelp(field) ?? undefined;
  const action = await vscode.window.showQuickPick([
    { label: 'Rename role group', detail: help('name'), value: 'rename' },
    { label: 'Add instruction', detail: help('instructions'), value: 'add' },
    { label: 'Edit instruction', detail: help('instructions'), value: 'edit' },
    { label: 'Remove instruction', detail: help('instructions'), value: 'remove' },
    { label: 'Use bundled PM system prompt', detail: 'Add the bundled PM instructions to this private role group.', value: 'pm-template' },
    { label: 'Set tool permission', detail: `${fieldHelp('tools')} ${ENFORCEMENT_NOTE}`, value: 'tool' },
    { label: 'Set default account profile', detail: help('defaultAccount'), value: 'account' },
    { label: 'Set allowed repositories', detail: help('repositories'), value: 'repositories' },
    { label: 'Set allowed paths', detail: help('paths'), value: 'paths' },
    { label: 'Set memory scope', detail: help('memory'), value: 'memory' }
  ], { placeHolder: `Edit ${record.group.name}` });
  if (!action) return;
  let change: Record<string, unknown>;
  if (action.value === 'rename') {
    const name = await vscode.window.showInputBox({ prompt: fieldHelp('name') ?? 'Role group name', value: record.group.name });
    if (!name) return;
    change = { kind: 'rename', name };
  } else if (action.value === 'tool') {
    const tool = await vscode.window.showQuickPick(['shell', 'fileWrite', 'network', 'githubRead', 'githubWrite', 'merge'].map((name) => ({
      label: name, description: record.group.toolPermissions[name] ?? 'deny', detail: toolHelp(name) ?? undefined
    })), { placeHolder: fieldHelp('tools') ?? 'Choose a tool', ignoreFocusOut: true });
    if (!tool) return;
    const level = await vscode.window.showQuickPick(['deny', 'ask', 'allow'].map((name) => ({
      label: name, detail: levelHelp(name) ?? undefined
    })), { placeHolder: `What may this role do with ${tool.label}? ${ENFORCEMENT_NOTE}`, ignoreFocusOut: true });
    if (!level) return;
    change = { kind: 'tool', tool: tool.label, level: level.label };
  } else if (action.value === 'account') {
    const isolation = builtIn.capability(record.group.provider, 'accountIsolation');
    if (isolation === 'unknown' || isolation === 'unsupported') {
      if (!record.group.defaultAccountProfileId) {
        void vscode.window.showWarningMessage('Account isolation is not verified for this CLI, so a default account cannot be assigned.');
        return;
      }
      const answer = await vscode.window.showWarningMessage(
        'Account isolation is not verified for this CLI. Clear this role group’s unsupported default account?',
        { modal: true }, 'Clear Default Account');
      if (answer !== 'Clear Default Account') return;
      change = { kind: 'account', profileId: null };
    } else {
      const listed = await accountChoices(record.group.provider);
      if (!listed.ok) { void vscode.window.showErrorMessage(`Account profiles could not be read (${listed.reason}).`); return; }
      const choices: Array<{ label: string; description?: string; id: string | null }> = [
        { label: 'No default account', id: null },
        ...listed.profiles.map((profile) => ({ label: profile.label, id: profile.id }))
      ];
      const picked = await vscode.window.showQuickPick(choices, { placeHolder: `${fieldHelp('defaultAccount')} Running sessions keep their original account.` });
      if (!picked) return;
      change = { kind: 'account', profileId: picked.id };
    }
  } else if (action.value === 'memory') {
    const picked = await vscode.window.showQuickPick([
      { label: 'Off', detail: 'Do not use saved project notes for this role.', mode: 'off' },
      { label: 'Role group', detail: `${fieldHelp('memory')} ${ENFORCEMENT_NOTE}`, mode: 'role-group' }
    ], { placeHolder: fieldHelp('memory') ?? 'Set memory scope', ignoreFocusOut: true });
    if (!picked) return;
    change = { kind: 'memory', mode: picked.mode };
  } else if (action.value === 'repositories' || action.value === 'paths') {
    const field = action.value;
    const input = await vscode.window.showInputBox({
      prompt: `${fieldHelp(field)} ${field === 'repositories' ? 'Enter owner/repository names' : 'Enter repository-relative paths'}, separated by commas.`,
      value: record.group.allowedScope[field].join(', ')
    });
    if (input === undefined) return;
    change = { kind: field, entries: input.trim() ? input.split(',').map((part) => part.trim()) : [] };
  } else if (action.value === 'pm-template') {
    if (record.group.role !== 'pm') { void vscode.window.showErrorMessage('The bundled PM prompt is for PM role groups.'); return; }
    const text = pmPrompt();
    if (!text) { void vscode.window.showErrorMessage('The bundled PM prompt is unavailable.'); return; }
    change = { kind: 'pm-template', text };
  } else {
    const layer = await vscode.window.showQuickPick([
      { label: 'System / platform preview', value: 'platform' as const },
      { label: 'Global / user preview', value: 'user' as const },
      { label: 'Project preview', value: 'project' as const },
      { label: 'Role group', value: 'roleGroup' as const },
      { label: 'Task preview', value: 'task' as const }
    ], { placeHolder: `${fieldHelp('instructions')} Choose the source layer for the preview.` });
    if (!layer) return;
    const rules = layer.value === 'roleGroup' ? record.group.rules : (record.layers[layer.value] ?? []);
    let target: Rule | undefined;
    if (action.value !== 'add') {
      const picked = await vscode.window.showQuickPick(rules.filter((rule) => rule.type === 'instruction')
        .map((rule) => ({ label: rule.id, description: (rule.text ?? '').slice(0, 80), id: rule.id })));
      if (!picked) return;
      target = rules.find((rule) => rule.id === picked.id);
      if (!target) return;
    }
    if (action.value === 'remove') change = { kind: 'remove', layer: layer.value, ruleId: target?.id };
    else {
      const text = await vscode.window.showInputBox({ prompt: `${fieldHelp('instructions')} ${ENFORCEMENT_NOTE}`, value: target?.text ?? '',
        validateInput: (input) => input.trim() ? undefined : 'Enter an instruction.' });
      if (!text) return;
      change = { kind: action.value, layer: layer.value, ruleId: target?.id, text };
    }
  }
  const edited = editRoleRecord(record, change);
  if (!edited.ok || !edited.record) { void vscode.window.showErrorMessage(`Role group edit was rejected (${edited.reason}).`); return; }
  const result = await saveRoleRecord(edited.record, expectedRevision);
  if (!result.ok) void vscode.window.showErrorMessage(result.reason === 'stale-revision'
    ? 'This role group changed during editing. Reload it and try again; your edit was not saved.'
    : `Role group was not saved (${result.reason}).`);
}

/** The preview text for one role group. Built when a document is opened, from private storage, and kept nowhere else. */
export async function previewText(id: string): Promise<string> {
  const opened = await store(false);
  if (!opened) return 'Private role group storage is unavailable, so there is nothing to preview.\n';
  const loaded = new RoleStore(opened).get(id);
  if (!loaded.ok) return 'The role group could not be read or validated.\n';
  // A broadcast failure never blocks reading this role group's own preview: it only means the
  // administrator-broadcast line below cannot say what applies right now, and says so plainly
  // instead of silently composing the preview as if no broadcast existed.
  const broadcasts = new BroadcastStore(opened).list();
  const broadcastNow = new Date();
  const broadcastContext = { role: loaded.record.group.role, provider: loaded.record.group.provider };
  const broadcastNote = broadcasts.ok
    ? null
    : `Administrator broadcasts: unknown (${broadcasts.reason ?? 'could not be read'}). Any live broadcast for this role group is NOT reflected below.`;
  const userLayer = [
    ...(loaded.record.layers.user ?? []),
    ...(broadcasts.ok ? liveBroadcastRules(broadcasts.items, broadcastContext, broadcastNow) : [])
  ];
  const result = previewEffectiveRules({ roleGroup: loaded.record.group, layers: { ...loaded.record.layers, user: userLayer } });
  const status = injectionStatus({ provider: loaded.record.group.provider });
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return [
    'PRIVATE — shown on this computer only. This holds the text of your instructions: do not paste it into GitHub, issues or logs.',
    'This preview is read-only and cannot be saved to a file.',
    ...(broadcastNote ? [broadcastNote] : []),
    ...(broadcasts.ok ? broadcastPreviewLines(broadcasts.items, broadcastContext, broadcastNow) : []),
    '',
    formatPreview(result, { injection: status, includeResearchSkills: true, workspaceRoot })
  ].join('\n');
}

class PreviewProvider implements vscode.TextDocumentContentProvider {
  readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const id = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(uri.query) ? uri.query : '';
    return id ? previewText(id) : 'No role group was named.\n';
  }
}

export function previewUri(id: string): vscode.Uri {
  return vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: '/effective-rules.txt', query: id });
}

async function preview(value: unknown): Promise<void> {
  const record = await chooseRecord(value);
  if (!record) return;
  // A virtual document has no file behind it: it cannot be saved, so private rules cannot be written into a repository.
  const document = await vscode.workspace.openTextDocument(previewUri(record.group.id));
  await vscode.window.showTextDocument(document, { preview: true });
}

type StartOptions = { id?: string; interactive?: boolean; accountProfileId?: string | null; name?: string; cwd?: string; launch?: boolean };

/**
 * Starts a new agent with this role group and an account. The role group is assigned to the NEW session;
 * a running session keeps whatever it was started with. Rules are not sent to the CLI by this step.
 */
async function startWithRole(sessions: SessionCommands, value: unknown): Promise<unknown> {
  // It launches an agent on an account: outside test mode it always asks (account, confirmations).
  const options: StartOptions = requireInteractive(value && typeof value === 'object' && !(value instanceof vscode.TreeItem) ? (value as StartOptions) : {});
  const interactive = options.interactive !== false;
  const record = await chooseRecord(options.id ?? value);
  if (!record) return { ok: false, code: 'cancelled', message: 'Cancelled.' };
  const group = record.group;
  if (group.defaultAccountProfileId && !['verified', 'unverified'].includes(builtIn.capability(group.provider, 'accountIsolation'))) {
    const message = 'This role group names a default account, but account isolation is not verified for its CLI. Clear the default account before starting it.';
    if (interactive) void vscode.window.showErrorMessage(message);
    return { ok: false, code: 'role-group-account-isolation-unknown', message };
  }
  let accountProfileId: string | undefined = typeof options.accountProfileId === 'string' ? options.accountProfileId : undefined;
  if (options.accountProfileId === undefined && !interactive && group.defaultAccountProfileId) accountProfileId = group.defaultAccountProfileId;
  if (options.accountProfileId === undefined && interactive) {
    const isolation = builtIn.capability(group.provider, 'accountIsolation');
    if (isolation === 'unknown' || isolation === 'unsupported') {
      const answer = await vscode.window.showWarningMessage(
        '此 provider 的帳號隔離未驗證；此身份組無法指派獨立帳號。',
        { modal: true, detail: '將使用 CLI 預設登入；身份核實與額度資訊也維持未知。身份組規則需依預覽的注入狀態手動處理。' },
        'Use CLI Default');
      if (answer !== 'Use CLI Default') return { ok: false, code: 'cancelled', message: 'Cancelled.' };
    } else {
      const listed = await accountChoices(group.provider);
      if (!listed.ok) { void vscode.window.showErrorMessage(`Account profiles could not be read (${listed.reason}).`); return { ok: false, code: 'storage-unavailable', message: 'Account profiles could not be read.' }; }
      if (group.defaultAccountProfileId && !listed.profiles.some((profile) => profile.id === group.defaultAccountProfileId)) {
        void vscode.window.showErrorMessage('This role group\'s default account is missing. Edit the role group and choose an available account.');
        return { ok: false, code: 'default-profile-missing', message: 'This role group\'s default account is missing.' };
      }
      const choices = [
        ...listed.profiles.map((profile) => ({ label: profile.label, description: profile.id === group.defaultAccountProfileId ? 'this role\'s default account' : 'identity unknown until the CLI reports it', id: profile.id as string | undefined })),
        { label: 'Use the CLI default account', description: 'Not isolated or verified by this extension', id: undefined as string | undefined }
      ].sort((a, b) => Number(b.description === 'this role\'s default account') - Number(a.description === 'this role\'s default account'));
      const picked = await vscode.window.showQuickPick(choices, { placeHolder: `Which account should “${group.name}” use?`, ignoreFocusOut: true });
      if (!picked) return { ok: false, code: 'cancelled', message: 'Cancelled.' };
      accountProfileId = picked.id;
    }
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  const cwd = options.cwd ?? (folders.length === 1 ? folders[0].uri.fsPath : undefined);
  if (!cwd) {
    if (interactive) void vscode.window.showErrorMessage('Open a single project folder first.');
    return { ok: false, code: 'no-folder', message: 'Open a single project folder first.' };
  }
  return sessions.launchWithAccount({ interactive, provider: group.provider, name: options.name ?? group.name, cwd, accountProfileId, roleGroupId: group.id, launch: options.launch });
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

export function registerRoleCommands(context: vscode.ExtensionContext, sessions: SessionCommands): void {
  extensionRoot = context.extensionPath;
  const tree = new RoleTree();
  currentTree = tree;
  testTree = context.extensionMode === vscode.ExtensionMode.Test ? tree : undefined;
  const provider = new PreviewProvider();
  previewChanged = (id) => provider.changed.fire(previewUri(id));
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, provider),
    vscode.window.createTreeView(ROLE_VIEW, { treeDataProvider: tree }),
    vscode.commands.registerCommand(ROLE_COMMANDS.refresh, () => tree.refresh()),
    vscode.commands.registerCommand(ROLE_COMMANDS.create, create),
    vscode.commands.registerCommand(ROLE_COMMANDS.edit, edit),
    vscode.commands.registerCommand(ROLE_COMMANDS.preview, preview),
    vscode.commands.registerCommand(ROLE_COMMANDS.remove, remove),
    vscode.commands.registerCommand(ROLE_COMMANDS.start, (value?: unknown) => startWithRole(sessions, value))
  );
}
