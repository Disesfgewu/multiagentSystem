import * as fs from 'node:fs';
import * as path from 'node:path';

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
  offerOpen(entry: WorktreeEntry): Promise<boolean>;
  openFolder(folder: string): Promise<void>;
  info(message: string): void;
  error(message: string): void;
}

export interface WorktreeDeps {
  ui: WorktreeUi;
  openProject(folder: string): Promise<WorktreeProject>;
}

/**
 * Options double as the programmatic form of each command. With `interactive: false` no prompt
 * is ever shown, which is what the Extension Host smoke test uses. Releasing without a prompt
 * additionally requires `confirmed: true`, which has no effect on an interactive call.
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
  'worktree-output-invalid': 'Git returned a worktree list that could not be read.'
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
  return path.join(path.dirname(projectRoot), `${path.basename(projectRoot)}-worktrees`, slug(branch));
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
