import * as fs from 'node:fs';
import * as path from 'node:path';

const { findOverlaps, summarizeOverlaps } = require('./overlap') as {
  findOverlaps(entries: Array<{ id: string; files: Iterable<string> }>): Array<{ file: string; worktrees: string[]; names: string[]; exact: boolean }>;
  summarizeOverlaps(overlaps: Array<{ file: string; worktrees: string[]; exact: boolean }>, limit?: number): string;
};

// Command logic for the worktree commands. It deliberately does not import `vscode`:
// the editor-specific prompts are injected through `WorktreeUi`, and the Git work is done
// by the existing `WorktreeService` (src/projects/worktrees.js), which is injected through
// `openProject`. Everything shown here is local UI only; nothing is logged or published.

export interface WorktreeInfo {
  path: string;
  headSha: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}

export interface WorktreeProject {
  readonly root: string;
  list(): Promise<WorktreeInfo[]>;
  create(options: { branch: string; target: string; base?: string }): Promise<WorktreeInfo | undefined>;
  remove(target: string): Promise<{ removed: boolean; branch: string | null }>;
  changedFiles(target: string): Promise<{ files: string[]; truncated: boolean }>;
}

export interface WorktreeEntry extends WorktreeInfo {
  primary: boolean;
  current: boolean;
}

export interface WorktreePickItem {
  label: string;
  description: string;
  detail: string;
  entry: WorktreeEntry;
}

export interface WorktreeUi {
  isTrusted(): boolean;
  workspaceFolders(): string[];
  pickProjectFolder(folders: string[]): Promise<string | undefined>;
  pickWorktree(items: WorktreePickItem[], placeholder: string): Promise<WorktreePickItem | undefined>;
  askBranch(validate: (value: string) => string | undefined): Promise<string | undefined>;
  askTarget(defaultPath: string, validate: (value: string) => string | undefined): Promise<string | undefined>;
  confirmRelease(entry: WorktreeEntry): Promise<boolean>;
  /** Asked when a caller, not the input box, chose the folder for a new worktree. */
  confirmCreate(branch: string, target: string): Promise<boolean>;
  offerOpen(entry: WorktreeEntry): Promise<boolean>;
  /** Shows overlapping files; resolves to the one the person chose to open, if any. */
  pickOverlap(items: Array<{ label: string; description: string; detail: string; overlap: OverlapItem }>, placeholder: string): Promise<{ overlap: OverlapItem } | undefined>;
  openFile(file: string): Promise<void>;
  openFolder(folder: string): Promise<void>;
  info(message: string): void;
  error(message: string): void;
}

/** `names[i]` is how worktree `worktrees[i]` spells the file; `exact: false` means the names only differ in case or Unicode form, so it is a possible collision, not a certain one. */
export interface OverlapItem { file: string; worktrees: string[]; folders: string[]; names: string[]; exact: boolean }

export interface WorktreeDeps {
  ui: WorktreeUi;
  openProject(folder: string): Promise<WorktreeProject>;
}

/**
 * Options double as the programmatic form of each command. With `interactive: false` no prompt
 * is ever shown, which is what the Extension Host smoke test uses. Releasing without a prompt
 * additionally requires `confirmed: true`, which has no effect on an interactive call.
 * The registered commands honour `interactive: false` for create and remove only in extension
 * test mode (see src/shared/testMode.ts); elsewhere they always ask.
 */
export interface WorktreeCommandOptions {
  interactive?: boolean;
  folder?: string;
  branch?: string;
  target?: string;
  base?: string;
  path?: string;
  confirmed?: boolean;
}

export type OverlapResult =
  | { ok: true; checked: number; overlaps: OverlapItem[]; unread: string[]; summary: string }
  | CommandFailure
  | CommandCancelled;

export type CommandFailure = { ok: false; code: string; message: string };
export type CommandCancelled = { ok: false; code: 'cancelled'; message: string };
export type ListResult = { ok: true; worktrees: WorktreeEntry[] } | CommandFailure | CommandCancelled;
export type CreateResult = { ok: true; worktree: WorktreeEntry } | CommandFailure | CommandCancelled;
export type RemoveResult = { ok: true; branch: string | null } | CommandFailure | CommandCancelled;

const MESSAGES: Record<string, string> = {
  'path-must-be-absolute': 'The destination must be an absolute path.',
  'worktree-path-overlap':
    'The destination overlaps an existing worktree or the repository data directory. Choose a location outside the repository.',
  'path-unverifiable':
    'The path cannot be verified (a dangling link, a file in the way, or an unreadable parent folder). Nothing was changed.',
  'branch-invalid': 'The branch name is not valid.',
  'base-invalid': 'The base revision is not valid.',
  'primary-worktree-protected': 'The primary worktree cannot be released.',
  'current-worktree-protected': 'This window is inside that worktree. Open another worktree first.',
  'worktree-locked': 'The worktree is locked. Unlock it with Git first; this extension does not force it.',
  'worktree-unavailable': 'The worktree folder is missing or unavailable, so it was not touched.',
  'worktree-has-local-files':
    'Refused: the worktree contains uncommitted changes, untracked files or ignored files. Nothing was deleted. Commit or move them first.',
  'worktree-not-found': 'That folder is not a worktree of this repository.',
  'worktree-output-invalid': 'Git returned a worktree list that could not be read.',
  'target-outside-allowed-roots':
    'Refused: a folder given by a command must be inside the open workspace folder or the managed worktree folder next to the repository. Nothing was created.'
};

const STDERR_LIMIT = 300;

function isWorktreeError(error: unknown): error is Error & { code: string; cause?: { stderr?: unknown } } {
  return error instanceof Error && error.name === 'WorktreeError' && typeof (error as { code?: unknown }).code === 'string';
}

// Git prints progress lines before the reason, so prefer its own "fatal:"/"error:" line.
function gitReason(stderr: unknown): string {
  if (typeof stderr !== 'string') return '';
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const reason = lines.find((line) => /^(fatal|error):/i.test(line)) ?? lines.at(-1);
  return reason ? ` Git said: ${reason.slice(0, STDERR_LIMIT)}` : '';
}

/** Turns a service failure into a message that names the reason (and Git's own words when it has them). */
export function describeFailure(error: unknown): { code: string; message: string } {
  if (isWorktreeError(error)) {
    if (error.code === 'git-command-failed') {
      const detail = gitReason(error.cause?.stderr);
      return { code: error.code, message: `Git could not complete the request.${detail}` };
    }
    return { code: error.code, message: MESSAGES[error.code] ?? `The worktree service refused the request (${error.code}).` };
  }
  const detail = error instanceof Error ? error.message : String(error);
  return { code: 'unexpected-error', message: `Unexpected error: ${detail}` };
}

export function validateBranchInput(value: string): string | undefined {
  const branch = value.trim();
  if (!branch) return 'Enter a branch name.';
  if (branch.startsWith('-')) return 'A branch name cannot start with "-".';
  // eslint-disable-next-line no-control-regex
  if (/[\s\x00-\x1f\x7f~^:?*[\\]/.test(branch) || branch.includes('..') || branch.includes('@{')) {
    return 'The branch name contains characters Git does not allow.';
  }
  if (branch.endsWith('/') || branch.endsWith('.') || branch.endsWith('.lock')) return 'The branch name is not valid.';
  return undefined;
}

export function validateTargetInput(value: string): string | undefined {
  if (!value.trim()) return 'Enter a folder path.';
  if (!path.isAbsolute(value.trim())) return 'Enter an absolute path.';
  return undefined;
}

function slug(branch: string): string {
  const cleaned = branch.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[-.]+|[-.]+$/g, '');
  return cleaned || 'worktree';
}

/** Suggests a folder next to the repository, never inside it (the service rejects nesting). */
export function defaultWorktreeTarget(projectRoot: string, branch: string): string {
  return path.join(managedWorktreeRoot(projectRoot), slug(branch));
}

/** The folder that holds worktrees made from the default suggestion: `<repo>-worktrees` next to the repository. */
export function managedWorktreeRoot(projectRoot: string): string {
  return path.join(path.dirname(projectRoot), `${path.basename(projectRoot)}-worktrees`);
}

// The real path of a folder that may not exist yet: its nearest existing ancestor is resolved
// (following every link) and the missing part appended. A part that exists but cannot be resolved,
// such as a dangling link, gives undefined, so it is never treated as a plain folder name.
function realPathOf(value: string): string | undefined {
  const tail: string[] = [];
  let current = path.resolve(value);
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...tail.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
      try {
        fs.lstatSync(current);
        return undefined; // it exists (a link) but does not resolve
      } catch {
        // Really missing: look at the parent.
      }
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * True when `target` (an absolute path) lies strictly inside one of `roots`, compared by real path,
 * so a link inside a root that points elsewhere does not count as inside.
 */
export function isInsideAllowedRoots(target: string, roots: string[]): boolean {
  if (!path.isAbsolute(target)) return false;
  const real = realPathOf(target);
  if (!real) return false;
  const fold = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value);
  return roots.some((root) => {
    const base = realPathOf(root);
    if (!base) return false;
    const relative = path.relative(fold(base), fold(real));
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  });
}

function sameDirectory(a: string, b: string): boolean {
  const resolve = (value: string): string => {
    try {
      return fs.realpathSync.native(value);
    } catch {
      return path.resolve(value);
    }
  };
  const fold = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value);
  return fold(resolve(a)) === fold(resolve(b));
}

export function describeEntries(worktrees: WorktreeInfo[], projectRoot: string): WorktreeEntry[] {
  return worktrees.map((item, index) => ({ ...item, primary: index === 0, current: sameDirectory(item.path, projectRoot) }));
}

function flags(entry: WorktreeEntry): string {
  const parts: string[] = [];
  if (entry.primary) parts.push('primary');
  if (entry.current) parts.push('this window');
  if (entry.locked) parts.push('locked');
  if (entry.prunable) parts.push('missing');
  if (entry.detached) parts.push('detached');
  return parts.join(' · ');
}

export function toPickItem(entry: WorktreeEntry): WorktreePickItem {
  const branch = entry.branch ?? (entry.detached ? '(detached HEAD)' : '(no branch)');
  const sha = entry.headSha ? entry.headSha.slice(0, 7) : '';
  const description = [sha, flags(entry)].filter(Boolean).join(' · ');
  return { label: branch, description, detail: entry.path, entry };
}

const cancelled = (): CommandCancelled => ({ ok: false, code: 'cancelled', message: 'Cancelled.' });

export class WorktreeController {
  constructor(private readonly deps: WorktreeDeps) {}

  private fail(code: string, message: string, interactive: boolean): CommandFailure {
    if (interactive) this.deps.ui.error(message);
    return { ok: false, code, message };
  }

  private async resolveProject(
    options: WorktreeCommandOptions,
    interactive: boolean
  ): Promise<{ project: WorktreeProject } | CommandFailure | CommandCancelled> {
    const { ui } = this.deps;
    if (!ui.isTrusted()) {
      return this.fail('workspace-untrusted', 'Worktree commands run Git and need a trusted workspace. Trust this workspace first.', interactive);
    }
    let folder = options.folder;
    if (!folder) {
      const folders = ui.workspaceFolders();
      if (folders.length === 0) return this.fail('no-project', 'Open a project folder first.', interactive);
      if (folders.length === 1) folder = folders[0];
      else if (interactive) {
        folder = await ui.pickProjectFolder(folders);
        if (!folder) return cancelled();
      } else {
        return this.fail('no-project', 'More than one folder is open; name the project folder.', false);
      }
    }
    try {
      return { project: await this.deps.openProject(folder) };
    } catch (error) {
      const failure = describeFailure(error);
      const message =
        failure.code === 'git-command-failed' ? 'This folder is not inside a Git repository (or Git is unavailable).' : failure.message;
      return this.fail(failure.code, message, interactive);
    }
  }

  async list(options: WorktreeCommandOptions = {}): Promise<ListResult> {
    const interactive = options.interactive !== false;
    const resolved = await this.resolveProject(options, interactive);
    if (!('project' in resolved)) return resolved;
    const { project } = resolved;
    let entries: WorktreeEntry[];
    try {
      entries = describeEntries(await project.list(), project.root);
    } catch (error) {
      const failure = describeFailure(error);
      return this.fail(failure.code, failure.message, interactive);
    }
    if (!interactive) return { ok: true, worktrees: entries };

    const picked = await this.deps.ui.pickWorktree(entries.map(toPickItem), 'Worktrees of this project: choose one to open it in a new window');
    if (!picked) return { ok: true, worktrees: entries };
    if (picked.entry.current) this.deps.ui.info('This window already shows that worktree.');
    else if (picked.entry.prunable) this.deps.ui.error(MESSAGES['worktree-unavailable']);
    else await this.deps.ui.openFolder(picked.entry.path);
    return { ok: true, worktrees: entries };
  }

  /**
   * Finds files that are being changed in more than one worktree of the project, so two agents are not
   * left to collide silently. Only reads Git (see WorktreeService.changedFiles). A worktree whose changes
   * cannot be read (missing, locked-out, an unreadable base, or a list cut at the limit) is reported as
   * unread, never treated as having no changes.
   */
  async overlaps(options: WorktreeCommandOptions = {}): Promise<OverlapResult> {
    const interactive = options.interactive !== false;
    const resolved = await this.resolveProject(options, interactive);
    if (!('project' in resolved)) return resolved;
    const { project } = resolved;
    let entries: WorktreeEntry[];
    try {
      entries = describeEntries(await project.list(), project.root);
    } catch (error) {
      const failure = describeFailure(error);
      return this.fail(failure.code, failure.message, interactive);
    }
    // A worktree is identified by its folder, never by what it is called: two detached worktrees at the same
    // commit, or two folders on the same branch name, are two worktrees. Names are for display only.
    const identity = (entry: WorktreeEntry): string => realPathOf(entry.path) ?? path.resolve(entry.path);
    const baseLabel = (entry: WorktreeEntry): string => entry.branch ?? (entry.headSha ? `(detached ${entry.headSha.slice(0, 7)})` : '(no branch)');
    const candidates = entries.filter((entry) => !entry.primary && !entry.bare);
    const duplicates = new Set(candidates.map(baseLabel).filter((name, index, all) => all.indexOf(name) !== index));
    const label = (entry: WorktreeEntry): string => (duplicates.has(baseLabel(entry)) ? `${baseLabel(entry)} in ${path.basename(entry.path)}` : baseLabel(entry));
    const read: Array<{ id: string; label: string; files: string[]; folder: string }> = [];
    const unread: string[] = [];
    for (const entry of candidates) {
      // A folder that is missing is a worktree whose changes are unknown, not one without changes.
      if (entry.prunable) { unread.push(label(entry)); continue; }
      try {
        const changed = await project.changedFiles(entry.path);
        if (changed.truncated) unread.push(label(entry));
        else read.push({ id: identity(entry), label: label(entry), files: changed.files, folder: entry.path });
      } catch {
        unread.push(label(entry));
      }
    }
    const byId = new Map(read.map((item) => [item.id, item]));
    const overlaps: OverlapItem[] = findOverlaps(read).map((item) => ({
      file: item.file,
      worktrees: item.worktrees.map((id) => (byId.get(id) as { label: string }).label),
      folders: item.worktrees.map((id) => (byId.get(id) as { folder: string }).folder),
      names: item.names,
      exact: item.exact
    }));
    const base = summarizeOverlaps(overlaps);
    const summary = unread.length > 0 ? `${base} Could not read the changes of ${unread.length} worktree${unread.length === 1 ? '' : 's'} (${unread.join(', ')}), so their overlaps are unknown.` : base;
    const result: OverlapResult = { ok: true, checked: read.length, overlaps, unread, summary };
    if (!interactive) return result;
    if (candidates.length < 2) {
      this.deps.ui.info('Overlap needs at least two worktrees besides the primary one.');
      return result;
    }
    if (overlaps.length === 0) {
      this.deps.ui.info(summary);
      return result;
    }
    const picked = await this.deps.ui.pickOverlap(
      overlaps.map((item) => ({
        label: item.exact ? item.file : `${item.file} (possible)`,
        description: item.exact ? item.worktrees.join(' · ') : item.worktrees.map((name, index) => `${name}: ${item.names[index]}`).join(' · '),
        detail: summary,
        overlap: item
      })),
      'Files changed in more than one worktree: choose one to open it'
    );
    if (picked) {
      const folder = picked.overlap.folders[0];
      // Opened only if the file really lies inside its worktree: compared by real path, so a link in the
      // worktree that points elsewhere (or a junction) is never followed out of it.
      // Each worktree's own spelling is opened from that worktree, never another worktree's spelling from this one.
      const real = realPathOf(path.resolve(folder, picked.overlap.names[0]));
      const realFolder = realPathOf(folder);
      if (real && realFolder && real.startsWith(realFolder + path.sep)) await this.deps.ui.openFile(real);
    }
    return result;
  }

  async create(options: WorktreeCommandOptions = {}): Promise<CreateResult> {
    const interactive = options.interactive !== false;
    const { ui } = this.deps;
    const resolved = await this.resolveProject(options, interactive);
    if (!('project' in resolved)) return resolved;
    const { project } = resolved;

    let branch = options.branch;
    if (branch === undefined) {
      if (!interactive) return this.fail('branch-invalid', 'A branch name is required.', false);
      branch = await ui.askBranch(validateBranchInput);
      if (branch === undefined) return cancelled();
    }
    branch = branch.trim();
    let target = options.target;
    if (target === undefined) {
      if (!interactive) return this.fail('path-must-be-absolute', 'A destination folder is required.', false);
      target = await ui.askTarget(defaultWorktreeTarget(project.root, branch), validateTargetInput);
      if (target === undefined) return cancelled();
    } else {
      // The caller chose the folder, not the person (Refs #192): it must stay inside the workspace
      // or the managed worktree folder, and an interactive call (every call outside the extension's
      // own tests) asks the person before Git writes anything.
      if (typeof target !== 'string' || !path.isAbsolute(target.trim())) {
        return this.fail('path-must-be-absolute', MESSAGES['path-must-be-absolute'], interactive);
      }
      const roots = [...ui.workspaceFolders(), managedWorktreeRoot(project.root)];
      if (!isInsideAllowedRoots(target.trim(), roots)) {
        return this.fail('target-outside-allowed-roots', MESSAGES['target-outside-allowed-roots'], interactive);
      }
      if (interactive && !(await ui.confirmCreate(branch, target.trim()))) return cancelled();
    }

    try {
      const created = await project.create({ branch, target: target.trim(), ...(options.base ? { base: options.base } : {}) });
      if (!created) return this.fail('worktree-output-invalid', 'The worktree was created but could not be found in the list.', interactive);
      const entry: WorktreeEntry = { ...created, primary: false, current: false };
      if (interactive) {
        ui.info(`Created worktree for branch ${branch}.`);
        if (await ui.offerOpen(entry)) await ui.openFolder(entry.path);
      }
      return { ok: true, worktree: entry };
    } catch (error) {
      const failure = describeFailure(error);
      return this.fail(failure.code, failure.message, interactive);
    }
  }

  async remove(options: WorktreeCommandOptions = {}): Promise<RemoveResult> {
    const interactive = options.interactive !== false;
    const { ui } = this.deps;
    const resolved = await this.resolveProject(options, interactive);
    if (!('project' in resolved)) return resolved;
    const { project } = resolved;

    let entry: WorktreeEntry | undefined;
    try {
      const entries = describeEntries(await project.list(), project.root);
      if (options.path !== undefined) {
        entry = entries.find((candidate) => sameDirectory(candidate.path, options.path as string));
        if (!entry) return this.fail('worktree-not-found', MESSAGES['worktree-not-found'], interactive);
      } else if (interactive) {
        const candidates = entries.filter((candidate) => !candidate.primary && !candidate.current);
        if (candidates.length === 0) {
          ui.info('There is no other worktree to release.');
          return cancelled();
        }
        const picked = await ui.pickWorktree(candidates.map(toPickItem), 'Choose a worktree to release (its branch is kept)');
        if (!picked) return cancelled();
        entry = picked.entry;
      } else {
        return this.fail('worktree-not-found', 'The worktree path is required.', false);
      }
    } catch (error) {
      const failure = describeFailure(error);
      return this.fail(failure.code, failure.message, interactive);
    }

    // Releasing deletes a folder: always ask unless the caller states it already confirmed.
    // `confirmed` is honoured only for programmatic (non-interactive) callers; an interactive
    // call is always decided by the confirmation dialog, whatever the options say.
    const confirmed = !interactive && options.confirmed === true;
    if (!confirmed && !(interactive && (await ui.confirmRelease(entry)))) return cancelled();

    try {
      const result = await project.remove(entry.path);
      if (interactive) ui.info(`Released the worktree. Branch ${result.branch ?? '(none)'} was kept.`);
      return { ok: true, branch: result.branch };
    } catch (error) {
      const failure = describeFailure(error);
      return this.fail(failure.code, failure.message, interactive);
    }
  }
}
