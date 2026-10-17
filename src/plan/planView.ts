import * as vscode from 'vscode';
import { parsePlan, PlanSection, PlanTask, PlanReportLink } from './parser';
import { OVERVIEW_VIEW } from '../overview/overviewView';
import { REPORT_COMMANDS } from '../reports/reportsView';
import { WorktreeService } from '../projects/worktrees';
import { githubReaderFor } from '../github/githubCommands';

const { describeEvidence } = require('./evidence') as {
  describeEvidence(input: { field: 'dependency' | 'evidence'; done: boolean; kind: 'issue' | 'pullRequest'; live: unknown }): { state: string; conflict: boolean };
};

export interface PlanEvidenceReader {
  getIssue(number: number): Promise<{ kind: string; data?: { state: string } }>;
  getPullRequest(number: number): Promise<{ kind: string; data?: { state: string; merged: boolean; draft: boolean } }>;
}
export interface PlanEvidenceDeps {
  repository(): Promise<string | null>;
  readerFor(repository: string): PlanEvidenceReader | null;
  now(): Date;
}
const realPlanEvidenceDeps: PlanEvidenceDeps = {
  async repository() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || !vscode.workspace.isTrusted) return null;
    try {
      const project = await WorktreeService.open(folder.uri.fsPath);
      const name = typeof project.githubRepository === 'string' ? project.githubRepository.replace(/^github\.com\//i, '') : null;
      return name && /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(name) ? name : null;
    } catch {
      return null;
    }
  },
  readerFor: (repository) => githubReaderFor(repository) as unknown as PlanEvidenceReader | null,
  now: () => new Date()
};
let planEvidenceDeps: PlanEvidenceDeps = realPlanEvidenceDeps;
/** Replaces where live Issue/PR state is read from. Only the Extension Host test does this. */
export function setPlanEvidenceDepsForTests(next: PlanEvidenceDeps | undefined): void { planEvidenceDeps = next ?? realPlanEvidenceDeps; }

/**
 * The live state of one Core Plan reference, read only when its TODO is expanded (never for every
 * TODO at once). A read that fails, or a project with no connected GitHub repository, is unknown:
 * it never promotes a dependency into a conflict, and it never clears one either.
 */
async function planEvidenceStatus(task: PlanTask, link: PlanReportLink): Promise<{ state: string; conflict: boolean; readAt: string | null }> {
  const unknown = () => ({ ...describeEvidence({ field: link.field, done: task.done, kind: link.kind, live: null }), readAt: null });
  // Every step here — finding the repository, getting a reader, reading the item — can fail or throw
  // for reasons outside this module's control (no workspace, an untrusted workspace, a network error,
  // a broken test double). None of that may crash the whole tree: it all collapses to "unknown".
  try {
    const repository = await planEvidenceDeps.repository();
    const reader = repository ? planEvidenceDeps.readerFor(repository) : null;
    if (!reader) return unknown();
    const result = link.kind === 'issue' ? await reader.getIssue(link.number) : await reader.getPullRequest(link.number);
    const live = result.kind === 'ok' ? result.data ?? null : null;
    return { ...describeEvidence({ field: link.field, done: task.done, kind: link.kind, live }), readAt: live ? planEvidenceDeps.now().toISOString() : null };
  } catch {
    return unknown();
  }
}

export const PLAN_VIEW = 'multiagentSystem.planView';
export const PLAN_COMMANDS = {
  refresh: 'multiagentSystem.plan.refresh',
  filter: 'multiagentSystem.plan.filter',
  open: 'multiagentSystem.plan.open',
  create: 'multiagentSystem.plan.create',
  returnToOverview: 'multiagentSystem.plan.returnToOverview'
} as const;

const TEMPLATE = `# Project Core Plan

Public project goals and decisions only. Keep agent runtime identities, account usage, private prompts, memory, and credentials out of this file.

## M1 — MVP

- [ ] M1-001 Describe the first verifiable result. Owner: PM; dependency: none; evidence: pending; next decision: accept or revise.
- [ ] M1-002 Link the corresponding Issue and PR. Owner: PM; dependency: M1-001; evidence: pending; next decision: review latest head and CI.

## Decisions

- [ ] DEC-001 Review the first result. Owner: project owner; dependency: M1-002; evidence: pending; next decision: pass or request changes.
`;

type Node = SectionNode | TaskNode | MessageNode | ReportNode;
type TaskFilter = 'all' | 'open' | 'done';
const FILTER_LABELS: Record<TaskFilter, string> = { all: 'All TODOs', open: 'Open TODOs', done: 'Recorded TODOs' };

class SectionNode extends vscode.TreeItem {
  constructor(readonly section: PlanSection, readonly visibleTasks: PlanTask[]) {
    super(section.title, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${section.tasks.filter((task) => !task.done).length} open / ${section.tasks.length} total`;
    this.iconPath = new vscode.ThemeIcon('list-tree');
  }
}
class TaskNode extends vscode.TreeItem {
  constructor(readonly task: PlanTask) {
    super(`${task.id} ${task.title}`, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = task.done ? 'recorded' : 'open';
    this.tooltip = task.title;
    this.iconPath = new vscode.ThemeIcon(task.done ? 'pass' : 'circle-outline');
    this.command = { command: PLAN_COMMANDS.open, title: 'Open this TODO', arguments: [{ line: task.line }] };
  }
}
class ReportNode extends vscode.TreeItem {
  constructor(kind: 'issue' | 'pullRequest', number: number, field: 'dependency' | 'evidence', status: { state: string; conflict: boolean; readAt: string | null }) {
    super(`${kind === 'issue' ? 'Issue' : 'PR'} #${number}`, vscode.TreeItemCollapsibleState.None);
    const fieldWord = field === 'evidence' ? 'delivery acceptance evidence' : 'dependency (informational only)';
    this.description = status.conflict ? `⚠ ${status.state}: needs human review` : status.state;
    this.tooltip = [
      `${fieldWord}, live state: ${status.state}${status.readAt ? ` (read ${status.readAt})` : ' (not read: no connected GitHub repository, or the read failed)'}.`,
      status.conflict
        ? 'The checkbox and this live state disagree. Nothing was changed automatically: decide and edit the plan yourself.'
        : 'Read the GitHub report inside this editor. This link does not certify that the TODO is complete.'
    ].join(' ');
    this.iconPath = new vscode.ThemeIcon(status.conflict ? 'warning' : kind === 'issue' ? 'issues' : 'git-pull-request');
    this.command = { command: REPORT_COMMANDS.open, title: 'Read linked report', arguments: [{ kind, number }] };
  }
}
class MessageNode extends vscode.TreeItem {
  constructor(message: string, command?: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('info');
    if (command) this.command = { command, title: message };
  }
}
function planUri(): vscode.Uri | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder && vscode.Uri.joinPath(folder.uri, 'docs', 'MASTER_PLAN.md');
}
class PlanTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  filter: TaskFilter = 'all';
  refresh(): void { this.changed.fire(undefined); }
  setFilter(filter: TaskFilter): void { this.filter = filter; this.refresh(); }
  getTreeItem(node: Node): vscode.TreeItem { return node; }
  async getChildren(node?: Node): Promise<Node[]> {
    if (node instanceof SectionNode) return node.visibleTasks.map((task) => new TaskNode(task));
    if (node instanceof TaskNode) {
      if (!node.task.reports.length) return [new MessageNode('待連結：在依賴／證據欄位加入 Issue #12 或 PR #7。')];
      // Fetched only now, for this one task's own (typically one or two) links, never for every
      // TODO in the plan at once: expanding one TODO must not fan out a request per every TODO.
      const statuses = await Promise.all(node.task.reports.map((link) => planEvidenceStatus(node.task, link)));
      return node.task.reports.map((link, index) => new ReportNode(link.kind, link.number, link.field, statuses[index]));
    }
    if (node) return [];
    const uri = planUri();
    if (!uri) return [new MessageNode('Open a project folder to read its core plan.')];
    try {
      const open = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
      const source = open ? open.getText() : new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      const parsed = parsePlan(source);
      const rows: Node[] = parsed.errors.slice(0, 5).map((error) => new MessageNode(error, PLAN_COMMANDS.open));
      if (parsed.errors.length > 5) rows.push(new MessageNode(`${parsed.errors.length - 5} more format errors; open the plan.`, PLAN_COMMANDS.open));
      if (parsed.sections.length) {
        for (const section of parsed.sections) {
          const visible = section.tasks.filter((task) => this.filter === 'all' || (this.filter === 'done' ? task.done : !task.done));
          if (visible.length) rows.push(new SectionNode(section, visible));
        }
        if (rows.length === 0) rows.push(new MessageNode(`No ${this.filter === 'done' ? 'recorded' : 'open'} TODOs in this plan.`, PLAN_COMMANDS.filter));
      }
      else if (!parsed.errors.length) rows.push(new MessageNode('No numbered TODOs yet. Open the plan to add one.', PLAN_COMMANDS.open));
      return rows;
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') return [new MessageNode('No core plan yet. Create one for this project.', PLAN_COMMANDS.create)];
      return [new MessageNode('Could not read the core plan. Open it to inspect the error.', PLAN_COMMANDS.open)];
    }
  }
}
let testTree: PlanTree | undefined;
export function planTreeForTests(): vscode.TreeDataProvider<Node> {
  if (!testTree) throw new Error('Plan tree is only exposed in Extension Host tests.');
  return testTree;
}
export function registerPlanView(context: vscode.ExtensionContext): void {
  const tree = new PlanTree();
  testTree = context.extensionMode === vscode.ExtensionMode.Test ? tree : undefined;
  const view = vscode.window.createTreeView(PLAN_VIEW, { treeDataProvider: tree });
  view.description = FILTER_LABELS[tree.filter];
  context.subscriptions.push(
    view,
    vscode.workspace.onDidChangeTextDocument((event) => { if (event.document.uri.toString() === planUri()?.toString()) tree.refresh(); }),
    vscode.workspace.onDidSaveTextDocument((document) => { if (document.uri.toString() === planUri()?.toString()) tree.refresh(); }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => tree.refresh()),
    view.onDidChangeVisibility((event) => { if (event.visible) tree.refresh(); }),
    vscode.commands.registerCommand(PLAN_COMMANDS.refresh, () => tree.refresh()),
    vscode.commands.registerCommand(PLAN_COMMANDS.filter, async (value?: TaskFilter) => {
      let selected: TaskFilter | undefined = value;
      if (selected === undefined) {
        const picked = await vscode.window.showQuickPick((Object.keys(FILTER_LABELS) as TaskFilter[]).map((id) => ({
          label: FILTER_LABELS[id], id, description: id === tree.filter ? 'current' : undefined
        })), { placeHolder: 'Show which Core Plan TODOs?' });
        selected = picked?.id;
      }
      if (selected !== 'all' && selected !== 'open' && selected !== 'done') return;
      tree.setFilter(selected);
      view.description = FILTER_LABELS[selected];
    }),
    vscode.commands.registerCommand(PLAN_COMMANDS.open, async (value?: { line?: number }) => {
      const uri = planUri();
      if (!uri) { void vscode.window.showErrorMessage('Open a project folder first.'); return; }
      try {
        const document = await vscode.workspace.openTextDocument(uri);
        const requested = Number.isInteger(value?.line) ? value!.line! : 0;
        const line = Math.max(0, Math.min(document.lineCount - 1, requested));
        await vscode.window.showTextDocument(document, { preview: true, selection: new vscode.Range(line, 0, line, 0) });
      } catch {
        void vscode.window.showErrorMessage('Could not open docs/MASTER_PLAN.md in this project.');
      }
    }),
    vscode.commands.registerCommand(PLAN_COMMANDS.create, async () => {
      const uri = planUri();
      if (!uri) { void vscode.window.showErrorMessage('Open a project folder first.'); return; }
      try {
        await vscode.workspace.fs.stat(uri);
      } catch (error) {
        if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
          void vscode.window.showErrorMessage('Could not check the core plan path.');
          return;
        }
        try {
          await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
          await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(TEMPLATE));
        } catch {
          void vscode.window.showErrorMessage('Could not create docs/MASTER_PLAN.md in this project.');
          return;
        }
      }
      tree.refresh();
      await vscode.commands.executeCommand(PLAN_COMMANDS.open);
    }),
    vscode.commands.registerCommand(PLAN_COMMANDS.returnToOverview, async () => {
      await vscode.commands.executeCommand(`${OVERVIEW_VIEW}.focus`);
    })
  );
}
