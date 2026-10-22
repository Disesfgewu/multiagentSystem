import { test, TestContext } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fsSync from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  WorktreeController,
  WorktreeDeps,
  WorktreeInfo,
  WorktreePickItem,
  WorktreeProject,
  WorktreeUi,
  defaultWorktreeTarget,
  describeFailure,
  isInsideAllowedRoots,
  managedWorktreeRoot,
  validateBranchInput,
  validateTargetInput
} from '../../src/projects/worktreeController';
import { WorktreeService } from '../../src/projects/worktrees';

const run = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run('git', args, { cwd, encoding: 'utf8' })).stdout.trim();
}

interface Fixture {
  temporary: string;
  root: string;
}

// A real temporary repository with synthetic content only.
async function repository(t: TestContext): Promise<Fixture> {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'multiagent-wtcmd-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'repo with space 帳號');
  const empty = path.join(temporary, 'empty-template');
  await fs.mkdir(root);
  await fs.mkdir(empty);
  await git(root, 'init', '-b', 'main', `--template=${empty}`);
  await git(root, 'config', 'user.name', 'Synthetic Test');
  await git(root, 'config', 'user.email', 'synthetic@example.test');
  await git(root, 'config', 'commit.gpgsign', 'false');
  await git(root, 'config', 'core.hooksPath', empty);
  await fs.writeFile(path.join(root, 'file.txt'), 'initial\n');
  await fs.writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
  await git(root, 'add', 'file.txt', '.gitignore');
  await git(root, 'commit', '-m', 'initial');
  return { temporary, root };
}

class FakeUi implements WorktreeUi {
  trusted = true;
  folders: string[] = [];
  pickedFolder: string | undefined;
  pickWorktreeBy: (items: WorktreePickItem[]) => WorktreePickItem | undefined = () => undefined;
  branch: string | undefined;
  target: string | undefined;
  confirm = false;
  open = false;
  opened: string[] = [];
  infos: string[] = [];
  errors: string[] = [];
  shownItems: WorktreePickItem[] = [];
  askedTargetDefault: string | undefined;
  confirmCalls = 0;

  isTrusted = (): boolean => this.trusted;
  workspaceFolders = (): string[] => this.folders;
  pickProjectFolder = async (): Promise<string | undefined> => this.pickedFolder;
  pickWorktree = async (items: WorktreePickItem[]): Promise<WorktreePickItem | undefined> => {
    this.shownItems = items;
    return this.pickWorktreeBy(items);
  };
  askBranch = async (): Promise<string | undefined> => this.branch;
  askTarget = async (defaultPath: string): Promise<string | undefined> => {
    this.askedTargetDefault = defaultPath;
    return this.target ?? defaultPath;
  };
  confirmRelease = async (): Promise<boolean> => {
    this.confirmCalls += 1;
    return this.confirm;
  };
  confirmCreateAnswer = true;
  createConfirms: Array<[string, string]> = [];
  confirmCreate = async (branch: string, target: string): Promise<boolean> => {
    this.createConfirms.push([branch, target]);
    return this.confirmCreateAnswer;
  };
  offerOpen = async (): Promise<boolean> => this.open;
  openFolder = async (folder: string): Promise<void> => {
    this.opened.push(folder);
  };
  overlapChoice: ((items: Array<{ label: string }>) => number | undefined) = () => undefined;
  shownOverlaps: Array<{ label: string; description: string; detail: string }> = [];
  openedFiles: string[] = [];
  pickOverlap = async (items: Array<{ label: string; description: string; detail: string; overlap: any }>): Promise<{ overlap: any } | undefined> => {
    this.shownOverlaps = items;
    const index = this.overlapChoice(items);
    return index === undefined ? undefined : items[index];
  };
  openFile = async (file: string): Promise<void> => {
    this.openedFiles.push(file);
  };
  info = (message: string): void => {
    this.infos.push(message);
  };
  error = (message: string): void => {
    this.errors.push(message);
  };
}

interface Harness {
  ui: FakeUi;
  controller: WorktreeController;
  removeCalls: string[];
  opened: string[];
}

function harness(root: string): Harness {
  const ui = new FakeUi();
  ui.folders = [root];
  const removeCalls: string[] = [];
  const opened: string[] = [];
  const deps: WorktreeDeps = {
    ui,
    openProject: async (folder) => {
      opened.push(folder);
      const service = (await WorktreeService.open(folder)) as WorktreeProject;
      return {
        root: service.root,
        list: () => service.list(),
        create: (options) => service.create(options),
        remove: (target) => {
          removeCalls.push(target);
          return service.remove(target);
        },
        changedFiles: (target) => service.changedFiles(target)
      };
    }
  };
  return { ui, controller: new WorktreeController(deps), removeCalls, opened };
}

test('failure messages name the reason; Git stderr is shown for Git failures only', () => {
  for (const code of ['worktree-has-local-files', 'worktree-locked', 'worktree-path-overlap', 'primary-worktree-protected', 'current-worktree-protected', 'path-unverifiable', 'branch-invalid', 'worktree-not-found']) {
    const error = Object.assign(new Error(code), { name: 'WorktreeError', code });
    const described = describeFailure(error);
    assert.equal(described.code, code);
    assert.ok(described.message.length > 20 && described.message !== code, code);
  }
  const git = Object.assign(new Error('git-command-failed'), { name: 'WorktreeError', code: 'git-command-failed', cause: { stderr: "Preparing worktree (new branch 'x')\nfatal: a branch named x already exists\nhint: more" } });
  assert.match(describeFailure(git).message, /a branch named x already exists/);
  assert.doesNotMatch(describeFailure(git).message, /hint|Preparing/);
  const noFatal = Object.assign(new Error('x'), { name: 'WorktreeError', code: 'git-command-failed', cause: { stderr: 'first\nlast line\n' } });
  assert.match(describeFailure(noFatal).message, /last line/);
  assert.equal(describeFailure(Object.assign(new Error('x'), { name: 'WorktreeError', code: 'git-command-failed' })).message, 'Git could not complete the request.');
  assert.equal(describeFailure(new Error('boom')).code, 'unexpected-error');
  assert.equal(describeFailure('text').code, 'unexpected-error');
});

test('prompt validation rejects what Git or the service would refuse', () => {
  for (const bad of ['', '  ', '-force', 'a b', 'a..b', 'a~1', 'a:b', 'x/', 'x.lock', 'a@{1}']) assert.ok(validateBranchInput(bad), JSON.stringify(bad));
  for (const good of ['feature/issue-10', 'fix_1.2', '帳號/功能']) assert.equal(validateBranchInput(good), undefined, good);
  assert.ok(validateTargetInput(''));
  assert.ok(validateTargetInput('relative/path'));
  assert.equal(validateTargetInput(path.join(os.tmpdir(), 'x')), undefined);
});

test('the suggested folder is next to the repository, never inside it', () => {
  const root = path.join(os.tmpdir(), 'my repo');
  const target = defaultWorktreeTarget(root, 'feature/issue 10: 帳號');
  assert.equal(path.dirname(path.dirname(target)), path.dirname(root));
  assert.ok(path.relative(root, target).startsWith('..'));
  assert.equal(path.basename(target), 'feature-issue-10-帳號');
  assert.equal(path.basename(defaultWorktreeTarget(root, '///')), 'worktree');
});

test('an untrusted workspace is refused before any Git work starts', async (t) => {
  const { root } = await repository(t);
  const h = harness(root);
  h.ui.trusted = false;
  for (const result of [await h.controller.list(), await h.controller.create({ branch: 'x', target: path.join(root, '..', 'x') }), await h.controller.remove({ path: root })]) {
    assert.equal(result.ok, false);
    assert.equal((result as { code: string }).code, 'workspace-untrusted');
  }
  assert.deepEqual(h.opened, [], 'the Git service is never opened');
  assert.equal(h.ui.errors.length, 3);
});

test('project resolution: no folder, several folders, and a folder that is not a repository', async (t) => {
  const { root, temporary } = await repository(t);
  const h = harness(root);
  h.ui.folders = [];
  assert.equal(((await h.controller.list()) as { code: string }).code, 'no-project');

  h.ui.folders = [root, temporary];
  const programmatic = await h.controller.list({ interactive: false });
  assert.equal((programmatic as { code: string }).code, 'no-project');
  assert.equal(h.ui.errors.length, 1, 'only the interactive failure was shown');

  h.ui.pickedFolder = undefined;
  assert.equal(((await h.controller.list()) as { code: string }).code, 'cancelled');
  h.ui.pickedFolder = root;
  assert.equal((await h.controller.list()).ok, true);

  const plain = path.join(temporary, 'not a repo');
  await fs.mkdir(plain);
  h.ui.folders = [plain];
  const notRepo = await h.controller.list();
  assert.equal(notRepo.ok, false);
  assert.match((notRepo as { message: string }).message, /not inside a Git repository/);
});

test('list: marks primary and current, opens another worktree in a new window, handles current and cancel', async (t) => {
  const { root, temporary } = await repository(t);
  const h = harness(root);
  const other = path.join(managedWorktreeRoot(root), 'worker 空白');
  assert.equal((await h.controller.create({ interactive: false, branch: 'feature/a', target: other })).ok, true);

  const plain = await h.controller.list({ interactive: false });
  assert.ok(plain.ok);
  assert.deepEqual(plain.worktrees.map((w) => [w.branch, w.primary, w.current]), [['main', true, true], ['feature/a', false, false]]);

  h.ui.pickWorktreeBy = (items) => items.find((item) => item.entry.branch === 'feature/a');
  await h.controller.list();
  assert.equal(h.ui.opened.length, 1);
  assert.equal(await fs.realpath(h.ui.opened[0]), await fs.realpath(other));
  assert.match(h.ui.shownItems[0].description, /primary/);
  assert.match(h.ui.shownItems[0].description, /this window/);
  assert.equal(h.ui.shownItems[1].detail, h.ui.shownItems[1].entry.path);

  h.ui.opened.length = 0;
  h.ui.pickWorktreeBy = (items) => items[0];
  await h.controller.list();
  assert.deepEqual(h.ui.opened, [], 'the worktree of this window is not re-opened');
  assert.match(h.ui.infos.at(-1) ?? '', /already shows/);

  h.ui.pickWorktreeBy = () => undefined;
  await h.controller.list();
  assert.deepEqual(h.ui.opened, []);
});

test('create: asks for branch and folder, suggests a folder outside the repo, creates a real worktree and can open it', async (t) => {
  const { root } = await repository(t);
  const h = harness(root);
  h.ui.branch = 'feature/new';
  h.ui.open = true;
  const result = await h.controller.create();
  assert.ok(result.ok);
  assert.equal(result.worktree.branch, 'feature/new');
  assert.ok(path.relative(root, h.ui.askedTargetDefault as string).startsWith('..'));
  assert.equal((await fs.stat(path.join(result.worktree.path, '.git'))).isFile(), true);
  assert.equal(h.ui.opened.length, 1);
  assert.equal(await git(root, 'rev-parse', '--verify', 'refs/heads/feature/new') !== '', true);
  // Git reports forward-slash paths on Windows, so compare resolved directories, not strings.
  const fold = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value);
  assert.equal(fold(await fs.realpath(result.worktree.path)), fold(await fs.realpath(h.ui.askedTargetDefault as string)), 'created in the suggested folder');

  h.ui.branch = 'feature/second';
  h.ui.open = false;
  h.ui.opened.length = 0;
  assert.ok((await h.controller.create()).ok);
  assert.deepEqual(h.ui.opened, [], 'not opened unless the user asks');
});

test('create: cancelling a prompt creates nothing', async (t) => {
  const { root } = await repository(t);
  const h = harness(root);
  h.ui.branch = undefined;
  assert.equal(((await h.controller.create()) as { code: string }).code, 'cancelled');
  assert.equal((await git(root, 'worktree', 'list', '--porcelain')).split('worktree ').length - 1, 1);
});

test('create: Git and path conflicts are reported with the reason and change nothing', async (t) => {
  const { root, temporary } = await repository(t);
  const h = harness(root);
  const first = path.join(managedWorktreeRoot(root), 'one');
  assert.ok((await h.controller.create({ interactive: false, branch: 'feature/taken', target: first })).ok);

  const sameBranch = await h.controller.create({ branch: 'feature/taken', target: path.join(managedWorktreeRoot(root), 'two') });
  assert.equal(sameBranch.ok, false);
  assert.equal((sameBranch as { code: string }).code, 'git-command-failed');
  assert.match((sameBranch as { message: string }).message, /already exists/i);
  await assert.rejects(fs.stat(path.join(managedWorktreeRoot(root), 'two')));

  const inside = await h.controller.create({ branch: 'feature/inside', target: path.join(root, 'inside') });
  assert.equal((inside as { code: string }).code, 'worktree-path-overlap');
  assert.equal(await git(root, 'branch', '--list', 'feature/inside'), '');

  const relative = await h.controller.create({ branch: 'feature/rel', target: 'relative/dir' });
  assert.equal((relative as { code: string }).code, 'path-must-be-absolute');
  const bad = await h.controller.create({ branch: '--force', target: path.join(managedWorktreeRoot(root), 'bad') });
  assert.equal((bad as { code: string }).code, 'branch-invalid');
  assert.equal(h.ui.errors.length, 4);
});

test('create: a caller-supplied folder is confirmed and must stay inside the workspace or the managed folder (Refs #192)', async (t) => {
  const { root, temporary } = await repository(t);
  const h = harness(root);
  const count = async (): Promise<number> => (await git(root, 'worktree', 'list', '--porcelain')).split('worktree ').length - 1;

  // Outside both roots: refused before any prompt or Git work, interactive or not.
  const outside = path.join(temporary, 'elsewhere');
  for (const interactive of [true, false]) {
    const refused = await h.controller.create({ interactive, branch: `feature/out-${interactive}`, target: outside });
    assert.equal((refused as { code: string }).code, 'target-outside-allowed-roots');
  }
  assert.deepEqual(h.ui.createConfirms, []);
  await assert.rejects(fs.stat(outside));

  // A link inside the managed folder that points outside it does not count as inside.
  const managed = managedWorktreeRoot(root);
  await fs.mkdir(managed, { recursive: true });
  await fs.mkdir(path.join(temporary, 'escape'));
  await fs.symlink(path.join(temporary, 'escape'), path.join(managed, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const viaLink = await h.controller.create({ branch: 'feature/link', target: path.join(managed, 'link', 'wt') });
  assert.equal((viaLink as { code: string }).code, 'target-outside-allowed-roots');
  await assert.rejects(fs.stat(path.join(temporary, 'escape', 'wt')));
  const dotdot = await h.controller.create({ branch: 'feature/dotdot', target: path.join(managed, '..', 'escape', 'wt2') });
  assert.equal((dotdot as { code: string }).code, 'target-outside-allowed-roots');

  // Inside the managed folder, an interactive caller-supplied folder asks; declining creates nothing.
  const inside = path.join(managed, 'caller');
  h.ui.confirmCreateAnswer = false;
  const declined = await h.controller.create({ branch: 'feature/caller', target: inside });
  assert.equal((declined as { code: string }).code, 'cancelled');
  assert.deepEqual(h.ui.createConfirms, [['feature/caller', inside]]);
  await assert.rejects(fs.stat(inside));
  assert.equal(await git(root, 'branch', '--list', 'feature/caller'), '');
  assert.equal(await count(), 1);

  h.ui.confirmCreateAnswer = true;
  assert.ok((await h.controller.create({ branch: 'feature/caller', target: inside })).ok);
  assert.equal(h.ui.createConfirms.length, 2);
  assert.equal(await count(), 2);

  // A folder typed by the person in the input box is the person's own choice: no second question.
  h.ui.branch = 'feature/typed';
  h.ui.target = path.join(managed, 'typed');
  assert.ok((await h.controller.create()).ok);
  assert.equal(h.ui.createConfirms.length, 2);
});

test('isInsideAllowedRoots compares real paths and needs a strict descendant', async (t) => {
  const { temporary } = await repository(t);
  const base = path.join(temporary, 'base');
  await fs.mkdir(base);
  assert.equal(isInsideAllowedRoots(path.join(base, 'a', 'b'), [base]), true, 'a missing folder below the root');
  assert.equal(isInsideAllowedRoots(base, [base]), false, 'the root itself');
  assert.equal(isInsideAllowedRoots(path.join(temporary, 'base-other', 'x'), [base]), false, 'a sibling with the same prefix');
  assert.equal(isInsideAllowedRoots('relative/x', [base]), false);
  assert.equal(isInsideAllowedRoots(path.join(base, 'x'), []), false);
  if (process.platform !== 'win32') {
    await fs.symlink(path.join(temporary, 'missing-target'), path.join(base, 'dangling'));
    assert.equal(isInsideAllowedRoots(path.join(base, 'dangling', 'x'), [base]), false, 'a dangling link is not a folder name');
  }
});

test('create without prompts needs every argument', async (t) => {
  const { root } = await repository(t);
  const h = harness(root);
  assert.equal(((await h.controller.create({ interactive: false })) as { code: string }).code, 'branch-invalid');
  assert.equal(((await h.controller.create({ interactive: false, branch: 'x' })) as { code: string }).code, 'path-must-be-absolute');
  assert.deepEqual(h.ui.errors, []);
});

test('release: the picker never offers the primary or the current worktree; a clean worktree is released and its branch kept', async (t) => {
  const { root, temporary } = await repository(t);
  const h = harness(root);
  const target = path.join(managedWorktreeRoot(root), 'worker');
  assert.ok((await h.controller.create({ interactive: false, branch: 'feature/release', target })).ok);

  h.ui.pickWorktreeBy = (items) => items[0];
  h.ui.confirm = true;
  const result = await h.controller.remove();
  assert.ok(result.ok);
  assert.equal(result.branch, 'feature/release');
  assert.deepEqual(h.ui.shownItems.map((item) => item.entry.branch), ['feature/release']);
  await assert.rejects(fs.stat(target));
  assert.ok(await git(root, 'rev-parse', '--verify', 'refs/heads/feature/release'));
  assert.match(h.ui.infos.at(-1) ?? '', /branch feature\/release was kept/i);

  h.ui.shownItems = [];
  const none = await h.controller.remove();
  assert.equal((none as { code: string }).code, 'cancelled');
  assert.match(h.ui.infos.at(-1) ?? '', /no other worktree/i);
});

for (const kind of ['tracked', 'untracked', 'ignored'] as const) {
  test(`release: a worktree with ${kind} local files is refused with the reason and left untouched`, async (t) => {
    const { root, temporary } = await repository(t);
    const h = harness(root);
    const target = path.join(managedWorktreeRoot(root), 'worker');
    assert.ok((await h.controller.create({ interactive: false, branch: 'feature/dirty', target })).ok);
    const name = kind === 'tracked' ? 'file.txt' : kind === 'ignored' ? 'ignored.txt' : 'untracked.txt';
    await fs.writeFile(path.join(target, name), 'local content');

    h.ui.pickWorktreeBy = (items) => items[0];
    h.ui.confirm = true;
    const result = await h.controller.remove();
    assert.equal(result.ok, false);
    assert.equal((result as { code: string }).code, 'worktree-has-local-files');
    assert.match(h.ui.errors.at(-1) ?? '', /Nothing was deleted/);
    assert.equal(await fs.readFile(path.join(target, name), 'utf8'), 'local content');

    // Even a caller that states it confirmed gets no way around the refusal.
    const forced = await h.controller.remove({ interactive: false, path: target, confirmed: true });
    assert.equal((forced as { code: string }).code, 'worktree-has-local-files');
    assert.equal(await fs.readFile(path.join(target, name), 'utf8'), 'local content');
    assert.ok(h.removeCalls.every((call) => typeof call === 'string'), 'remove is called with a path only: no force option exists');
  });
}

test('release: declining the confirmation, or releasing without prompts but without confirmed, removes nothing', async (t) => {
  const { root, temporary } = await repository(t);
  const h = harness(root);
  const target = path.join(managedWorktreeRoot(root), 'worker');
  assert.ok((await h.controller.create({ interactive: false, branch: 'feature/keep', target })).ok);

  h.ui.pickWorktreeBy = (items) => items[0];
  h.ui.confirm = false;
  assert.equal(((await h.controller.remove()) as { code: string }).code, 'cancelled');
  assert.equal(h.ui.confirmCalls, 1);
  assert.equal(((await h.controller.remove({ interactive: false, path: target })) as { code: string }).code, 'cancelled');
  assert.deepEqual(h.removeCalls, []);
  assert.equal((await fs.stat(target)).isDirectory(), true);

  assert.ok((await h.controller.remove({ interactive: false, path: target, confirmed: true })).ok);
});

test('release: primary, current, locked and unknown folders are refused with their reasons', async (t) => {
  const { root, temporary } = await repository(t);
  const h = harness(root);
  const target = path.join(managedWorktreeRoot(root), 'worker');
  assert.ok((await h.controller.create({ interactive: false, branch: 'feature/locked', target })).ok);

  const primary = await h.controller.remove({ interactive: false, path: root, confirmed: true });
  assert.equal((primary as { code: string }).code, 'primary-worktree-protected');

  await git(root, 'worktree', 'lock', target);
  const locked = await h.controller.remove({ interactive: false, path: target, confirmed: true });
  assert.equal((locked as { code: string }).code, 'worktree-locked');
  await git(root, 'worktree', 'unlock', target);

  const unknown = await h.controller.remove({ interactive: false, path: path.join(temporary, 'nowhere'), confirmed: true });
  assert.equal((unknown as { code: string }).code, 'worktree-not-found');
  assert.equal(((await h.controller.remove({ interactive: false })) as { code: string }).code, 'worktree-not-found');

  // From inside the linked worktree, that worktree is the current one and is protected.
  const inner = harness(target);
  const current = await inner.controller.remove({ interactive: false, path: target, confirmed: true });
  assert.equal((current as { code: string }).code, 'current-worktree-protected');
  assert.equal((await fs.stat(target)).isDirectory(), true);
});

test('an interactive release ignores confirmed:true and is decided by the dialog alone', async (t) => {
  const { root, temporary } = await repository(t);
  const h = harness(root);
  const target = path.join(managedWorktreeRoot(root), 'worker');
  assert.ok((await h.controller.create({ interactive: false, branch: 'feature/dialog', target })).ok);

  h.ui.confirm = false;
  const declined = await h.controller.remove({ path: target, confirmed: true });
  assert.equal((declined as { code: string }).code, 'cancelled');
  assert.equal(h.ui.confirmCalls, 1, 'the dialog was shown despite confirmed:true');
  assert.equal((await fs.stat(target)).isDirectory(), true);

  h.ui.confirm = true;
  assert.ok((await h.controller.remove({ path: target, confirmed: true })).ok);
  assert.equal(h.ui.confirmCalls, 2);
});

test('a workspace folder inside a worktree still identifies that worktree as this window', async (t) => {
  const { root, temporary } = await repository(t);
  const sub = path.join(root, 'src', 'nested');
  await fs.mkdir(sub, { recursive: true });
  const h = harness(sub);
  const target = path.join(managedWorktreeRoot(root), 'worker');
  assert.ok((await h.controller.create({ interactive: false, branch: 'feature/sub', target })).ok);

  const listed = await h.controller.list({ interactive: false });
  assert.ok(listed.ok);
  assert.deepEqual(listed.worktrees.map((w) => [w.branch, w.current]), [['main', true], ['feature/sub', false]]);

  const protectedCurrent = await h.controller.remove({ interactive: false, path: root, confirmed: true });
  assert.ok(['primary-worktree-protected', 'current-worktree-protected'].includes((protectedCurrent as { code: string }).code));

  // The same from a subfolder of the linked worktree: it is the current one and stays protected.
  const linkedSub = path.join(target, 'inner');
  await fs.mkdir(linkedSub);
  const inLinked = harness(linkedSub);
  const result = await inLinked.controller.remove({ interactive: false, path: target, confirmed: true });
  assert.equal((result as { code: string }).code, 'current-worktree-protected');
  const entries = await inLinked.controller.list({ interactive: false });
  assert.ok(entries.ok);
  assert.deepEqual(entries.worktrees.map((w) => [w.branch, w.current]), [['main', false], ['feature/sub', true]]);
  assert.equal((await fs.stat(target)).isDirectory(), true);
});

async function twoWorktrees(t: { after(fn: () => Promise<void>): void }, edits: { a: Record<string, string>; b: Record<string, string>; commitB?: boolean }) {
  const { temporary, root } = await repository(t as any);
  await fs.writeFile(path.join(root, 'shared.txt'), 'base\n');
  await fs.writeFile(path.join(root, 'only-a.txt'), 'base\n');
  await git(root, 'add', '-A');
  await git(root, 'commit', '-m', 'base files');
  const service = (await WorktreeService.open(root)) as any;
  const a = path.join(temporary, 'wt-a');
  const b = path.join(temporary, 'wt-b');
  await service.create({ branch: 'feat/a', target: a });
  await service.create({ branch: 'feat/b', target: b });
  for (const [dir, files] of [[a, edits.a], [b, edits.b]] as Array<[string, Record<string, string>]>) {
    for (const [name, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await fs.writeFile(path.join(dir, name), content);
    }
  }
  if (edits.commitB) {
    await git(b, 'add', '-A');
    await git(b, 'commit', '-m', 'b work');
  }
  return { root, a, b, temporary };
}

test('files changed in two worktrees are reported, whether committed, edited or new, and the others are not', async (t) => {
  const { root } = await twoWorktrees(t as any, {
    a: { 'shared.txt': 'a edit\n', 'only-a.txt': 'a edit\n', 'new/both.txt': 'a\n' },
    b: { 'shared.txt': 'b edit\n', 'new/both.txt': 'b\n', 'only-b.txt': 'b\n' },
    commitB: false
  });
  const h = harness(root);
  const result = await h.controller.overlaps({ interactive: false });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.overlaps.map((item) => [item.file, item.worktrees]), [['new/both.txt', ['feat/a', 'feat/b']], ['shared.txt', ['feat/a', 'feat/b']]]);
  assert.deepEqual([result.checked, result.unread], [2, []]);
  assert.match(result.summary, /^2 files are being changed in more than one worktree: new\/both\.txt, shared\.txt\.$/);
});

test('committed work counts as much as uncommitted work, and a clean pair has no overlap', async (t) => {
  const { root } = await twoWorktrees(t as any, { a: { 'shared.txt': 'a\n' }, b: { 'shared.txt': 'b\n' }, commitB: true });
  const h = harness(root);
  const both = await h.controller.overlaps({ interactive: false });
  assert.deepEqual(both.ok && both.overlaps.map((item) => item.file), ['shared.txt']);
  const { root: other } = await twoWorktrees(t as any, { a: { 'only-a.txt': 'a\n' }, b: { 'only-b.txt': 'b\n' } });
  const none = await harness(other).controller.overlaps({ interactive: false });
  assert.deepEqual(none.ok && [none.overlaps, none.summary], [[], 'No file is being changed in more than one worktree.']);
});

test('a worktree that cannot be read is unknown, not empty: its overlaps are never claimed absent', async (t) => {
  const { root, b } = await twoWorktrees(t as any, { a: { 'shared.txt': 'a\n' }, b: { 'shared.txt': 'b\n' } });
  await fs.rm(path.join(b, '.git'), { force: true });
  const result = await harness(root).controller.overlaps({ interactive: false });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.unread, ['feat/b']);
  assert.deepEqual(result.overlaps, []);
  assert.match(result.summary, /Could not read the changes of 1 worktree \(feat\/b\), so their overlaps are unknown\./);
});

test('a list cut at the limit is unknown, because a partial list could hide an overlap', async (t) => {
  const { root } = await twoWorktrees(t as any, { a: { 'shared.txt': 'a\n' }, b: { 'shared.txt': 'b\n' } });
  const h = harness(root);
  const result = await h.controller.overlaps({ interactive: false });
  assert.equal(result.ok && result.unread.length, 0);
  const service = (await WorktreeService.open(root)) as any;
  const tiny = await service.changedFiles(path.join(path.dirname(root), 'wt-a'), { limit: 0 });
  assert.deepEqual([tiny.files, tiny.truncated], [[], true]);
});

test('the person is shown the overlapping files and the chosen one is opened from its worktree', async (t) => {
  const { root, a } = await twoWorktrees(t as any, { a: { 'shared.txt': 'a\n' }, b: { 'shared.txt': 'b\n' } });
  const h = harness(root);
  h.ui.overlapChoice = () => 0;
  const result = await h.controller.overlaps({});
  assert.equal(result.ok, true);
  assert.deepEqual(h.ui.shownOverlaps.map((item) => [item.label, item.description]), [['shared.txt', 'feat/a · feat/b']]);
  assert.deepEqual(h.ui.openedFiles.map((file) => path.relative(fsSync.realpathSync.native(a), fsSync.realpathSync.native(file))), ['shared.txt']);
  h.ui.openedFiles = [];
  h.ui.overlapChoice = () => undefined;
  await h.controller.overlaps({});
  assert.deepEqual(h.ui.openedFiles, [], 'nothing opens without a choice');
});

test('with fewer than two other worktrees the person is told there is nothing to compare, and an untrusted workspace is refused', async (t) => {
  const { temporary, root } = await repository(t as any);
  const h = harness(root);
  await h.controller.overlaps({});
  assert.match(h.ui.infos.join('\n'), /needs at least two worktrees besides the primary/);
  h.ui.trusted = false;
  const refused = await h.controller.overlaps({ interactive: false });
  assert.deepEqual([refused.ok, (refused as any).code], [false, 'workspace-untrusted']);
  void temporary;
});

test('a changed-file list cut at the limit makes that worktree unknown in the report, never "no overlap"', async () => {
  const ui = new FakeUi();
  ui.folders = ['/synthetic/repo'];
  const entry = (p: string, branch: string): WorktreeInfo => ({ path: p, headSha: 'a'.repeat(40), branch, detached: false, bare: false, locked: false, prunable: false });
  const project = {
    root: '/synthetic/repo',
    list: async () => [entry('/synthetic/repo', 'main'), entry('/synthetic/wt-a', 'feat/a'), entry('/synthetic/wt-b', 'feat/b')],
    create: async () => undefined,
    remove: async () => ({ removed: true, branch: null }),
    changedFiles: async (target: string) => ({ files: ['shared.txt'], truncated: target.endsWith('wt-a') })
  } as WorktreeProject;
  const controller = new WorktreeController({ ui, openProject: async () => project });
  const result = await controller.overlaps({ interactive: false });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.unread, ['feat/a']);
  assert.deepEqual(result.overlaps, [], 'one readable worktree has nothing to overlap with, and that is said as unknown, not as clear');
  assert.match(result.summary, /Could not read the changes of 1 worktree \(feat\/a\)/);
});

test('two detached worktrees at the same commit are two worktrees: their shared file is reported, with names that tell them apart', async (t) => {
  const { temporary, root } = await repository(t as any);
  await fs.writeFile(path.join(root, 'same.ts'), 'base\n');
  await git(root, 'add', '-A');
  await git(root, 'commit', '-m', 'base');
  const first = path.join(temporary, 'detached-one');
  const second = path.join(temporary, 'detached-two');
  await git(root, 'worktree', 'add', '--detach', first);
  await git(root, 'worktree', 'add', '--detach', second);
  await fs.writeFile(path.join(first, 'same.ts'), 'first agent\n');
  await fs.writeFile(path.join(second, 'same.ts'), 'second agent\n');
  const h = harness(root);
  const result = await h.controller.overlaps({ interactive: false });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual([result.checked, result.unread, result.overlaps.length], [2, [], 1], 'the shared file is not lost to a shared display name');
  const [overlap] = result.overlaps;
  assert.equal(overlap.file, 'same.ts');
  assert.equal(new Set(overlap.worktrees).size, 2, `two distinct names: ${overlap.worktrees.join(' | ')}`);
  assert.deepEqual(overlap.worktrees.map((name) => /^\(detached [a-f0-9]{7}\) in detached-(one|two)$/.test(name)), [true, true]);
  assert.deepEqual(new Set(overlap.folders.map((folder) => fsSync.realpathSync.native(folder))), new Set([first, second].map((folder) => fsSync.realpathSync.native(folder))));
});

test('choosing an overlap opens the file from the worktree it was listed under, and only if it really lies inside that worktree', { skip: process.platform === 'win32' }, async (t) => {
  const { temporary, root } = await repository(t as any);
  await fs.writeFile(path.join(root, 'same.ts'), 'base\n');
  await fs.writeFile(path.join(root, 'link.ts'), 'base\n');
  await git(root, 'add', '-A');
  await git(root, 'commit', '-m', 'base');
  const first = path.join(temporary, 'detached-one');
  const second = path.join(temporary, 'detached-two');
  await git(root, 'worktree', 'add', '--detach', first);
  await git(root, 'worktree', 'add', '--detach', second);
  await fs.writeFile(path.join(first, 'same.ts'), 'first agent\n');
  await fs.writeFile(path.join(second, 'same.ts'), 'second agent\n');
  const h = harness(root);
  h.ui.overlapChoice = () => 0;
  await h.controller.overlaps({});
  assert.equal(h.ui.openedFiles.length, 1);
  const opened = fsSync.realpathSync.native(h.ui.openedFiles[0]);
  const folders = h.ui.shownOverlaps.length ? [first, second].map((folder) => fsSync.realpathSync.native(folder)) : [];
  assert.ok(folders.some((folder) => opened === path.join(folder, 'same.ts')), 'it is the file of one of the listed worktrees');
  // A tracked file that is replaced by a link to something outside the worktree is never followed out of it.
  const outside = path.join(temporary, 'outside-secret.txt');
  await fs.writeFile(outside, 'private\n');
  for (const dir of [first, second]) {
    await fs.rm(path.join(dir, 'link.ts'));
    await fs.symlink(outside, path.join(dir, 'link.ts'));
  }
  h.ui.openedFiles = [];
  h.ui.overlapChoice = (items) => items.findIndex((item) => item.label === 'link.ts');
  await h.controller.overlaps({});
  assert.deepEqual(h.ui.openedFiles, [], 'a link out of the worktree is not opened');
});

test('names that differ only in case are reported as a possible collision with each worktree\'s own spelling, and the person is told it is not confirmed', async (t) => {
  const { root, a } = await twoWorktrees(t as any, { a: { 'Guide.md': 'a\n', 'shared.txt': 'a\n' }, b: { 'guide.md': 'b\n', 'shared.txt': 'b\n' } });
  const h = harness(root);
  const plain = await h.controller.overlaps({ interactive: false });
  assert.equal(plain.ok, true);
  if (!plain.ok) return;
  const byName = Object.fromEntries(plain.overlaps.map((item) => [item.file, item]));
  assert.deepEqual([byName['shared.txt'].exact, byName['shared.txt'].names], [true, ['shared.txt', 'shared.txt']]);
  assert.deepEqual([byName['Guide.md'].exact, byName['Guide.md'].names, byName['Guide.md'].worktrees], [false, ['Guide.md', 'guide.md'], ['feat/a', 'feat/b']]);
  assert.match(plain.summary, /1 file is being changed in more than one worktree: shared\.txt\./);
  assert.match(plain.summary, /1 name differs only in letter case or Unicode form between worktrees and may be the same file on a case-insensitive or normalizing file system \(not confirmed\): Guide\.md\./);
  assert.equal(/more than one worktree: [^.]*Guide/.test(plain.summary), false, 'never listed as certain');
  // The picker marks it as possible and shows both spellings; opening uses the first worktree's own spelling from that worktree.
  h.ui.overlapChoice = (items) => items.findIndex((item) => item.label.startsWith('Guide.md'));
  await h.controller.overlaps({});
  const shown = h.ui.shownOverlaps.find((item) => item.label.startsWith('Guide.md'));
  assert.equal(shown?.label, 'Guide.md (possible)');
  assert.equal(shown?.description, 'feat/a: Guide.md · feat/b: guide.md');
  assert.equal(h.ui.openedFiles.length, 1);
  assert.equal(path.basename(h.ui.openedFiles[0]), 'Guide.md', 'its own spelling, not the other worktree\'s');
  assert.equal(path.relative(fsSync.realpathSync.native(a), h.ui.openedFiles[0]), 'Guide.md', 'from the worktree that spells it that way');
});

test('create can skip the "open in a window" question, so a caller that starts an agent next is never held by a notification', async (t) => {
  const { root } = await repository(t);
  const h = harness(root);
  const managed = managedWorktreeRoot(root);
  let asked = 0;
  // A notification the person never answers: its promise never ends.
  h.ui.offerOpen = (): Promise<boolean> => { asked += 1; return new Promise(() => {}); };
  const quick = await Promise.race([
    h.controller.create({ interactive: true, branch: 'feature/no-offer', target: path.join(managed, 'no-offer'), offerOpen: false }),
    new Promise<'held'>((resolve) => setTimeout(() => resolve('held'), 15000).unref())
  ]);
  assert.notEqual(quick, 'held', 'create returned without waiting for the question');
  assert.ok((quick as { ok: boolean }).ok);
  assert.equal(asked, 0, 'the question was not asked');
  assert.deepEqual(h.ui.opened, [], 'and nothing was opened');
  // Without the option the question is still asked, as before.
  h.ui.offerOpen = async (): Promise<boolean> => { asked += 1; return false; };
  assert.ok((await h.controller.create({ interactive: true, branch: 'feature/with-offer', target: path.join(managed, 'with-offer') })).ok);
  assert.equal(asked, 1);
  // Any value other than the boolean false keeps the question.
  for (const value of [0, null, 'false', undefined] as never[]) {
    asked = 0;
    assert.ok((await h.controller.create({ interactive: true, branch: `feature/odd-${String(value)}`, target: path.join(managed, `odd-${String(value)}`), offerOpen: value })).ok);
    assert.equal(asked, 1, String(value));
  }
});

test('skipping the "open in a window" question never skips the confirmation of the folder: a refusal still creates nothing', async (t) => {
  const { root, temporary } = await repository(t);
  const h = harness(root);
  const managed = managedWorktreeRoot(root);
  const target = path.join(managed, 'refused-with-offer-skipped');
  h.ui.confirmCreateAnswer = false;
  const result = await h.controller.create({ interactive: true, branch: 'feature/refused', target, offerOpen: false });
  assert.equal((result as { ok: boolean }).ok, false);
  assert.equal((result as { cancelled?: boolean }).cancelled ?? (result as { code?: string }).code === 'cancelled', true, 'the refusal is reported as a cancellation');
  assert.deepEqual(h.ui.createConfirms, [['feature/refused', target]], 'the confirmation was asked');
  await assert.rejects(fs.stat(target), 'nothing was created');
  void temporary;
});
