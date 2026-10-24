import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { privateStorage } from '../storage/storageCommands';
import { isExtensionTestMode } from '../shared/testMode';

type Skill = { name: string; description: string; body: string; roles: string[]; state: 'active' | 'disabled' | 'candidate'; source: string; revision: number; usable?: boolean; problem?: string };
type Result<T = Record<string, unknown>> = ({ ok: true } & T) | { ok: false; reason: string };
type Library = {
  list(): Result<{ skills: Skill[] }>;
  get(name: string): Result<{ skill: Skill }>;
  save(raw: Record<string, unknown>, expectedRevision: number): Result<{ skill: Skill }>;
  setState(name: string, state: 'active' | 'disabled'): Result<{ skill: Skill }>;
  setRoles(name: string, roles: string[]): Result<{ skill: Skill }>;
  approve(name: string): Result<{ skill: Skill }>;
  remove(name: string): Result;
};
const { SkillLibrary, parseSkillFile, renderSkillFile, NAME, MAX_DESCRIPTION } = require('./library') as {
  SkillLibrary: new (store: unknown) => Library;
  parseSkillFile(text: string): Result<{ draft: { name: string; description: string; body: string } }>;
  renderSkillFile(skill: { name: string; description: string; body: string }): string;
  NAME: RegExp;
  MAX_DESCRIPTION: number;
};
const { SKILL_TARGETS, planInstall, applyInstall } = require('./workspace-skills') as {
  SKILL_TARGETS: readonly string[];
  planInstall(root: string, entries: Array<{ rel: string; conflictRel: string; content: Buffer; sha256: string }>): { writes: Array<{ rel: string }>; conflicts: string[] };
  applyInstall(root: string, writes: unknown[]): { written: Array<{ path: string }>; conflicts: string[]; error?: Error };
};

/**
 * The skills library (#359) in VS Code: the Knowledge tab of the Workbench lists the skills, and these commands add, edit, turn on
 * and off, give to role groups, remove, approve, bring in the starter skills or the ones already in this repository, and write them
 * into this repository for the CLIs. None of them takes a skill's text from an argument: text comes only from the editor the person
 * saves, or from a file the person picked; a name from the Workbench only says which skill a window is about.
 *
 * Editing: a skill opens as `multiagent-skill:/<name>/SKILL.md`, an ordinary Markdown editor. Saving it (⌘S) checks the text
 * (`library.js`) and keeps it in the private store; a text that does not pass is not saved and the save says why, and a skill that
 * was changed elsewhere since it was opened is not overwritten.
 */

export const SKILL_LIBRARY_COMMANDS = {
  add: 'multiagentSystem.skills.libraryAdd',
  edit: 'multiagentSystem.skills.libraryEdit',
  toggle: 'multiagentSystem.skills.libraryToggle',
  roles: 'multiagentSystem.skills.libraryRoles',
  remove: 'multiagentSystem.skills.libraryRemove',
  approve: 'multiagentSystem.skills.libraryApprove',
  addStarters: 'multiagentSystem.skills.libraryAddStarters',
  importRepository: 'multiagentSystem.skills.libraryImport',
  exportRepository: 'multiagentSystem.skills.libraryExport'
} as const;
export const SKILL_SCHEME = 'multiagent-skill';

async function openLibrary(): Promise<{ library: Library; store: unknown } | null> {
  try {
    const opened = await privateStorage()?.use();
    if (!opened?.ok) { void vscode.window.showErrorMessage('The private storage could not be opened, so the skills library cannot be read.'); return null; }
    return { library: new SkillLibrary(opened.store), store: opened.store };
  } catch {
    void vscode.window.showErrorMessage('The private storage could not be opened, so the skills library cannot be read.');
    return null;
  }
}

const REASONS: Record<string, string> = {
  'invalid-name': 'the name must be lower-case letters, digits and dashes (up to 64)',
  'invalid-description': `the description must be one line of up to ${MAX_DESCRIPTION} characters`,
  'invalid-body': 'the steps are empty or longer than 16 KB',
  'name-taken': 'a skill with this name already exists',
  'stale-revision': 'it was changed elsewhere since it was opened; open it again',
  'too-many-skills': 'the library already has 50 skills',
  'no-front-matter': 'the file must start with a front matter (--- name: …, description: … ---)',
  'name-changed': 'the name in the file is not the name of this skill; add a new skill to use another name',
  'candidate-not-approved': 'an agent\'s suggestion must be approved first'
};
const explain = (reason: string): string => {
  if (REASONS[reason]) return REASONS[reason];
  const text = /^(description|body)-(.+)$/.exec(reason);
  if (text) {
    const what = text[1] === 'body' ? 'the steps' : 'the description';
    if (text[2] === 'unsafe-characters') return `${what} contain control or invisible characters`;
    if (text[2] === 'injection-suspected') return `${what} contain wording that tells an agent to ignore its rules`;
    if (text[2] === 'marker-forged') return `${what} contain one of this extension's own message markers`;
    if (text[2].startsWith('sensitive:')) return `${what} contain something that looks private (${text[2].slice('sensitive:'.length)})`;
  }
  return reason;
};

// ---- the editor ------------------------------------------------------------------------------------------------------

const skillUri = (name: string): vscode.Uri => vscode.Uri.from({ scheme: SKILL_SCHEME, path: `/${name}/SKILL.md` });
const isFolder = (uri: vscode.Uri): boolean => uri.path === '/' || uri.path === '' || /^\/[a-z0-9][a-z0-9-]{0,63}\/?$/.test(uri.path);
const nameOf = (uri: vscode.Uri): string | null => {
  const match = /^\/([a-z0-9][a-z0-9-]{0,63})\/SKILL\.md$/.exec(uri.path);
  return match ? match[1] : null;
};

/** The skills as files: read from and saved to the library. A new skill exists as a draft until it is saved once. */
class SkillFileSystem implements vscode.FileSystemProvider {
  private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changed.event;
  // The revision each skill was read at, so a save never overwrites a change made elsewhere; and drafts of new skills.
  private readonly revisions = new Map<string, number>();
  readonly drafts = new Map<string, { description: string }>();

  watch(): vscode.Disposable { return new vscode.Disposable(() => undefined); }
  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    // The root and each skill's folder are folders (VS Code looks at a file's folder before it saves it).
    if (isFolder(uri)) return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    const content = await this.readFile(uri);
    return { type: vscode.FileType.File, ctime: 0, mtime: Date.now(), size: content.byteLength };
  }
  readDirectory(): [string, vscode.FileType][] { return []; }
  createDirectory(uri: vscode.Uri): void { if (!isFolder(uri)) throw vscode.FileSystemError.NoPermissions('Skills are added from the Knowledge tab.'); }
  delete(): void { throw vscode.FileSystemError.NoPermissions('Skills are removed from the Knowledge tab.'); }
  rename(): void { throw vscode.FileSystemError.NoPermissions('A skill keeps its name.'); }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const name = nameOf(uri);
    if (!name) throw vscode.FileSystemError.FileNotFound(uri);
    const opened = await openLibrary();
    if (!opened) throw vscode.FileSystemError.Unavailable('The private storage could not be opened.');
    const found = opened.library.get(name);
    if (found.ok) {
      this.revisions.set(name, found.skill.revision);
      return Buffer.from(renderSkillFile(found.skill), 'utf8');
    }
    const draft = this.drafts.get(name);
    if (draft) {
      this.revisions.set(name, 0);
      return Buffer.from(renderSkillFile({ name, description: draft.description, body: '1. The first step.\n2. The next step.\n\nWrite the commands an agent can run as they are, in code blocks.' }), 'utf8');
    }
    throw vscode.FileSystemError.FileNotFound(uri);
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const name = nameOf(uri);
    if (!name) throw vscode.FileSystemError.NoPermissions('This is not a skill.');
    const parsed = parseSkillFile(Buffer.from(content).toString('utf8'));
    if (!parsed.ok) throw vscode.FileSystemError.NoPermissions(`Not saved: ${explain(parsed.reason)}.`);
    if (parsed.draft.name !== name) throw vscode.FileSystemError.NoPermissions(`Not saved: ${explain('name-changed')}.`);
    const opened = await openLibrary();
    if (!opened) throw vscode.FileSystemError.Unavailable('The private storage could not be opened.');
    const current = opened.library.get(name);
    const kept = current.ok ? { roles: current.skill.roles, state: current.skill.state, source: current.skill.source, ...(current.skill.source === 'agent' && current.skill.state !== 'candidate' ? { approved: true } : {}) } : { roles: [], state: 'active', source: 'owner' };
    const saved = opened.library.save({ ...parsed.draft, ...kept }, this.revisions.get(name) ?? (current.ok ? -1 : 0));
    if (!saved.ok) throw vscode.FileSystemError.NoPermissions(`Not saved: ${explain(saved.reason)}.`);
    this.revisions.set(name, saved.skill.revision);
    const wasNew = this.drafts.delete(name);
    this.changed.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    changedLibrary.fire();
    if (wasNew) void vscode.window.showInformationMessage(`The skill “${name}” is saved. No role group gets it yet: choose them with Role groups… in the Knowledge tab.`);
  }
}

const changedLibrary = new vscode.EventEmitter<void>();
/** Fires after the library changed, so the Workbench draws its Knowledge tab again. */
export const onDidChangeSkillLibrary = changedLibrary.event;
let fileSystem: SkillFileSystem | undefined;

/** What the Workbench's Knowledge tab lists: each skill's name, one line, state, the names of its role groups, and why it cannot be used. */
export async function skillLibrarySummary(): Promise<{ ok: true; skills: Array<{ name: string; description: string; state: string; source: string; usable: boolean; problem: string | null; roles: string[] }> } | { ok: false; reason: string }> {
  try {
    const opened = await privateStorage()?.use();
    if (!opened?.ok) return { ok: false, reason: 'storage-unavailable' };
    const listed = new SkillLibrary(opened.store).list();
    if (!listed.ok) return { ok: false, reason: listed.reason };
    const groups = roleGroupNames(opened.store);
    return { ok: true, skills: listed.skills.map((skill) => ({ name: skill.name, description: skill.description ?? '', state: skill.state ?? 'unknown', source: skill.source ?? 'unknown', usable: skill.usable === true, problem: skill.usable ? null : explain(skill.problem ?? 'invalid'), roles: (skill.roles ?? []).map((id) => groups.get(id) ?? `${id} (role group removed)`) })) };
  } catch { return { ok: false, reason: 'storage-unavailable' }; }
}

// The role groups by id, with their names. Only those two fields are read, so one record that does not pass the role checks does
// not hide every other role group from this list (a skill given to it simply reaches no agent until it is fixed).
function roleGroupNames(store: unknown): Map<string, string> {
  const listed = (store as { list(collection: string): { ok: boolean; items?: Array<{ id: string; value: any }> } }).list('roleGroups');
  const names = new Map<string, string>();
  for (const item of listed.ok && Array.isArray(listed.items) ? listed.items : []) {
    const group = item && item.value && item.value.group;
    if (group && typeof group.id === 'string' && group.id === item.id && typeof group.name === 'string' && group.name.trim() !== '') names.set(item.id, group.name.trim().slice(0, 80));
  }
  return names;
}

// ---- the commands -----------------------------------------------------------------------------------------------------

async function pickSkill(library: Library, placeHolder: string, filter: (skill: Skill) => boolean = () => true): Promise<Skill | undefined> {
  const listed = library.list();
  if (!listed.ok) { void vscode.window.showErrorMessage(`The skills library could not be read (${listed.reason}).`); return undefined; }
  const skills = listed.skills.filter(filter);
  if (skills.length === 0) { void vscode.window.showInformationMessage('There is no skill to choose here.'); return undefined; }
  const picked = await vscode.window.showQuickPick(skills.map((skill) => ({ label: skill.name, description: skill.state, detail: skill.description, skill })), { placeHolder, ignoreFocusOut: true });
  return picked?.skill;
}

/** The skill a command is about: the name the Workbench gave (only a name, checked), or one the person picks. */
async function chosen(library: Library, value: unknown, placeHolder: string, filter?: (skill: Skill) => boolean): Promise<Skill | undefined> {
  const name = value && typeof value === 'object' && typeof (value as { name?: unknown }).name === 'string' ? (value as { name: string }).name : undefined;
  if (name !== undefined) {
    if (!NAME.test(name)) return undefined;
    const found = library.get(name);
    if (!found.ok) { void vscode.window.showErrorMessage(`The skill “${name}” could not be read (${explain(found.reason)}).`); return undefined; }
    return !filter || filter(found.skill) ? found.skill : undefined;
  }
  return pickSkill(library, placeHolder, filter);
}

async function add(): Promise<Result> {
  const opened = await openLibrary();
  if (!opened || !fileSystem) return { ok: false, reason: 'storage-unavailable' };
  const name = await vscode.window.showInputBox({ prompt: 'The skill\'s name: lower-case letters, digits and dashes, for example run-tests', ignoreFocusOut: true, validateInput: (value) => !NAME.test(value) ? 'Use lower-case letters, digits and dashes (up to 64).' : opened.library.get(value).ok ? 'A skill with this name already exists.' : undefined });
  if (!name) return { ok: false, reason: 'cancelled' };
  const description = await vscode.window.showInputBox({ prompt: 'When should an agent use it? One line: this is all an agent is told about the skill.', ignoreFocusOut: true, validateInput: (value) => value.trim() === '' || value.length > MAX_DESCRIPTION || /[\r\n]/.test(value) ? `One line of up to ${MAX_DESCRIPTION} characters.` : undefined });
  if (!description) return { ok: false, reason: 'cancelled' };
  fileSystem.drafts.set(name, { description: description.trim() });
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(skillUri(name)), { preview: false });
  void vscode.window.showInformationMessage(`Write the steps of “${name}”, then save (⌘S / Ctrl+S): it is checked and kept in the library.`);
  return { ok: true };
}

async function edit(value: unknown): Promise<Result> {
  const opened = await openLibrary();
  if (!opened) return { ok: false, reason: 'storage-unavailable' };
  const skill = await chosen(opened.library, value, 'Edit which skill?');
  if (!skill) return { ok: false, reason: 'cancelled' };
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(skillUri(skill.name)), { preview: false });
  return { ok: true };
}

async function toggle(value: unknown): Promise<Result> {
  const opened = await openLibrary();
  if (!opened) return { ok: false, reason: 'storage-unavailable' };
  const skill = await chosen(opened.library, value, 'Turn which skill on or off?', (entry) => entry.state !== 'candidate');
  if (!skill) return { ok: false, reason: 'cancelled' };
  const result = opened.library.setState(skill.name, skill.state === 'active' ? 'disabled' : 'active');
  if (!result.ok) { void vscode.window.showErrorMessage(`Not changed: ${explain(result.reason)}.`); return result; }
  changedLibrary.fire();
  void vscode.window.showInformationMessage(result.skill.state === 'active' ? `“${skill.name}” is on: agents of its role groups are told about it when they start.` : `“${skill.name}” is off: no agent is told about it.`);
  return { ok: true };
}

async function roles(value: unknown): Promise<Result> {
  const opened = await openLibrary();
  if (!opened) return { ok: false, reason: 'storage-unavailable' };
  const skill = await chosen(opened.library, value, 'Which skill?');
  if (!skill) return { ok: false, reason: 'cancelled' };
  const groups = roleGroupNames(opened.store);
  if (groups.size === 0) { void vscode.window.showInformationMessage('There is no role group yet. Create one in the Agents tab first.'); return { ok: false, reason: 'no-role-groups' }; }
  const picked = await vscode.window.showQuickPick([...groups].map(([id, name]) => ({ label: name, id, picked: skill.roles.includes(id) })), { placeHolder: `Which role groups get “${skill.name}”? Agents of these role groups are told about it when they start.`, canPickMany: true, ignoreFocusOut: true });
  if (!picked) return { ok: false, reason: 'cancelled' };
  const result = opened.library.setRoles(skill.name, picked.map((entry) => entry.id));
  if (!result.ok) { void vscode.window.showErrorMessage(`Not changed: ${explain(result.reason)}.`); return result; }
  changedLibrary.fire();
  return { ok: true };
}

async function remove(value: unknown): Promise<Result> {
  const opened = await openLibrary();
  if (!opened) return { ok: false, reason: 'storage-unavailable' };
  const skill = await chosen(opened.library, value, 'Remove which skill?');
  if (!skill) return { ok: false, reason: 'cancelled' };
  const answer = await vscode.window.showWarningMessage(`Remove the skill “${skill.name}” from the library?`, { modal: true, detail: 'Agents started from now on are no longer told about it. Copies already written into a repository stay there.' }, 'Remove Skill');
  if (answer !== 'Remove Skill') return { ok: false, reason: 'cancelled' };
  const result = opened.library.remove(skill.name);
  if (!result.ok) { void vscode.window.showErrorMessage(`Not removed: ${explain(result.reason)}.`); return result; }
  changedLibrary.fire();
  return { ok: true };
}

async function approve(value: unknown): Promise<Result> {
  const opened = await openLibrary();
  if (!opened) return { ok: false, reason: 'storage-unavailable' };
  const skill = await chosen(opened.library, value, 'Approve which suggested skill?', (entry) => entry.state === 'candidate');
  if (!skill) return { ok: false, reason: 'cancelled' };
  const answer = await vscode.window.showWarningMessage(`Approve the skill “${skill.name}” that an agent suggested?`, { modal: true, detail: `${skill.description}\n\nRead its steps first (Edit). Once approved it is an ordinary skill; no role group gets it until you choose them.` }, 'Approve Skill');
  if (answer !== 'Approve Skill') return { ok: false, reason: 'cancelled' };
  const result = opened.library.approve(skill.name);
  if (!result.ok) { void vscode.window.showErrorMessage(`Not approved: ${explain(result.reason)}.`); return result; }
  changedLibrary.fire();
  return { ok: true };
}

/** Skill files to bring into the library: each checked; one whose name is taken, or that does not pass, is listed and left out. */
async function bringIn(files: Array<{ label: string; text: string }>, source: 'starter' | 'repository', title: string): Promise<Result<{ added: string[] }>> {
  const opened = await openLibrary();
  if (!opened) return { ok: false, reason: 'storage-unavailable' };
  const candidates: Array<{ label: string; description: string; detail: string; picked: boolean; draft: { name: string; description: string; body: string } }> = [];
  const refused: string[] = [];
  for (const file of files) {
    const parsed = parseSkillFile(file.text);
    if (!parsed.ok) { refused.push(`${file.label}: ${explain(parsed.reason)}`); continue; }
    if (opened.library.get(parsed.draft.name).ok) { refused.push(`${parsed.draft.name}: already in the library`); continue; }
    candidates.push({ label: parsed.draft.name, description: file.label, detail: parsed.draft.description, picked: true, draft: parsed.draft });
  }
  if (candidates.length === 0) { void vscode.window.showInformationMessage(`No skill to add.${refused.length ? ` ${refused.join('; ')}.` : ''}`); return { ok: true, added: [] }; }
  const picked = await vscode.window.showQuickPick(candidates, { placeHolder: title, canPickMany: true, ignoreFocusOut: true });
  if (!picked || picked.length === 0) return { ok: false, reason: 'cancelled' };
  const added: string[] = [];
  for (const entry of picked) {
    const saved = opened.library.save({ ...entry.draft, roles: [], state: 'active', source }, 0);
    if (saved.ok) added.push(entry.label); else refused.push(`${entry.label}: ${explain(saved.reason)}`);
  }
  changedLibrary.fire();
  void vscode.window.showInformationMessage(`Added ${added.length} skill${added.length === 1 ? '' : 's'} to the library. No role group gets them yet: choose them with Role groups… in the Knowledge tab.${refused.length ? ` Not added: ${refused.join('; ')}.` : ''}`);
  return { ok: true, added };
}

function workspaceFolder(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.find((entry) => entry.uri.scheme === 'file');
  return folder && vscode.workspace.isTrusted ? folder.uri.fsPath : undefined;
}

/** Skill files in a folder of `<name>/SKILL.md`, read without following links and with a size limit. */
function readSkillFolder(root: string): Array<{ label: string; text: string }> {
  const out: Array<{ label: string; text: string }> = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries.slice(0, 100)) {
    if (!entry.isDirectory() || !NAME.test(entry.name)) continue;
    const file = path.join(root, entry.name, 'SKILL.md');
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 32 * 1024) continue;
      out.push({ label: path.relative(path.dirname(path.dirname(root)), file).split(path.sep).join('/'), text: fs.readFileSync(file, 'utf8') });
    } catch { /* not a skill */ }
  }
  return out;
}

let starterRoot = '';
async function addStarters(): Promise<Result> {
  return bringIn(readSkillFolder(starterRoot).map((file) => ({ ...file, label: 'starter skill' })), 'starter', 'Add which starter skills to the library?');
}

async function importRepository(): Promise<Result> {
  const root = workspaceFolder();
  if (!root) { void vscode.window.showInformationMessage('Open a trusted project folder to bring in its skills.'); return { ok: false, reason: 'no-workspace' }; }
  const files = SKILL_TARGETS.flatMap((target) => readSkillFolder(path.join(root, ...target.split('/'))));
  return bringIn(files, 'repository', 'Bring which of this repository\'s skills into the library?');
}

/** Writes the chosen skills into this repository for the CLIs, never over a file that is there; what is written is asked first. */
async function exportRepository(): Promise<Result<{ written: string[] }>> {
  const root = workspaceFolder();
  if (!root) { void vscode.window.showInformationMessage('Open a trusted project folder to write skills into it.'); return { ok: false, reason: 'no-workspace' }; }
  const opened = await openLibrary();
  if (!opened) return { ok: false, reason: 'storage-unavailable' };
  const listed = opened.library.list();
  if (!listed.ok) return listed;
  const usable = listed.skills.filter((skill) => skill.usable && skill.state !== 'candidate');
  if (usable.length === 0) { void vscode.window.showInformationMessage('The library has no skill to write.'); return { ok: true, written: [] }; }
  const picked = await vscode.window.showQuickPick(usable.map((skill) => ({ label: skill.name, detail: skill.description, picked: skill.state === 'active', skill })), { placeHolder: 'Write which skills into this repository (.claude/skills for Claude Code, .agents/skills for Codex)?', canPickMany: true, ignoreFocusOut: true });
  if (!picked || picked.length === 0) return { ok: false, reason: 'cancelled' };
  const crypto = require('node:crypto') as typeof import('node:crypto');
  const entries = picked.flatMap(({ skill }) => SKILL_TARGETS.map((target) => {
    const content = Buffer.from(renderSkillFile(skill), 'utf8');
    return { rel: `${target}/${skill.name}/SKILL.md`, conflictRel: `${target}/${skill.name}`, content, sha256: crypto.createHash('sha256').update(content).digest('hex') };
  }));
  let plan: ReturnType<typeof planInstall>;
  try { plan = planInstall(root, entries); } catch (error) { void vscode.window.showErrorMessage(`Nothing was written: ${(error as Error).message}`); return { ok: false, reason: 'refused' }; }
  if (plan.writes.length === 0) { void vscode.window.showInformationMessage(`Nothing to write: every chosen skill is already there (${plan.conflicts.join(', ')}). Existing files are never replaced.`); return { ok: true, written: [] }; }
  const answer = await vscode.window.showWarningMessage(`Write ${plan.writes.length} skill file${plan.writes.length === 1 ? '' : 's'} into this repository?`, { modal: true, detail: `Will write:\n${plan.writes.map((entry) => entry.rel).join('\n')}${plan.conflicts.length ? `\n\nWill NOT write (already there; never replaced):\n${plan.conflicts.join('\n')}` : ''}\n\nThey become part of the repository when you commit them.` }, 'Write Skills');
  if (answer !== 'Write Skills') return { ok: false, reason: 'cancelled' };
  const applied = applyInstall(root, plan.writes);
  if (applied.error) void vscode.window.showErrorMessage(`Writing stopped: ${applied.error.message}`);
  else void vscode.window.showInformationMessage(`Wrote ${applied.written.length} skill file${applied.written.length === 1 ? '' : 's'}.`);
  return { ok: !applied.error, written: applied.written.map((entry) => entry.path) } as Result<{ written: string[] }>;
}

/** For the extension's own host tests: the editor's file system, to save a skill's text as the editor does. */
export function skillFileSystemForTests(): SkillFileSystem {
  if (!isExtensionTestMode() || !fileSystem) throw new Error('This is only exposed in Extension Host tests.');
  return fileSystem;
}

export function registerSkillLibraryCommands(context: vscode.ExtensionContext): void {
  starterRoot = path.join(context.extensionPath, 'resources', 'agent-skills');
  fileSystem = new SkillFileSystem();
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(SKILL_SCHEME, fileSystem, { isCaseSensitive: true }),
    // A name from the Workbench says only which skill; every window and confirmation is this extension's own.
    vscode.commands.registerCommand(SKILL_LIBRARY_COMMANDS.add, () => add()),
    vscode.commands.registerCommand(SKILL_LIBRARY_COMMANDS.edit, (value?: unknown) => edit(value)),
    vscode.commands.registerCommand(SKILL_LIBRARY_COMMANDS.toggle, (value?: unknown) => toggle(value)),
    vscode.commands.registerCommand(SKILL_LIBRARY_COMMANDS.roles, (value?: unknown) => roles(value)),
    vscode.commands.registerCommand(SKILL_LIBRARY_COMMANDS.remove, (value?: unknown) => remove(value)),
    vscode.commands.registerCommand(SKILL_LIBRARY_COMMANDS.approve, (value?: unknown) => approve(value)),
    vscode.commands.registerCommand(SKILL_LIBRARY_COMMANDS.addStarters, () => addStarters()),
    vscode.commands.registerCommand(SKILL_LIBRARY_COMMANDS.importRepository, () => importRepository()),
    vscode.commands.registerCommand(SKILL_LIBRARY_COMMANDS.exportRepository, () => exportRepository()),
    changedLibrary
  );
}
