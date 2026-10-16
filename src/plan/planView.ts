import * as vscode from 'vscode';
import { parsePlan, PlanSection, PlanTask } from './parser';
import { OVERVIEW_VIEW } from '../overview/overviewView';

export const PLAN_VIEW = 'multiagentSystem.planView';
export const PLAN_COMMANDS = {
  refresh: 'multiagentSystem.plan.refresh',
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

type Node = SectionNode | TaskNode | MessageNode;

class SectionNode extends vscode.TreeItem {
  constructor(readonly section: PlanSection) {
    super(section.title, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${section.tasks.filter((task) => !task.done).length} open / ${section.tasks.length} total`;
    this.iconPath = new vscode.ThemeIcon('list-tree');
  }
}
class TaskNode extends vscode.TreeItem {
  constructor(readonly task: PlanTask) {
    super(`${task.id} ${task.title}`, vscode.TreeItemCollapsibleState.None);
    this.description = task.done ? 'recorded' : 'open';
    this.tooltip = task.title;
    this.iconPath = new vscode.ThemeIcon(task.done ? 'pass' : 'circle-outline');
    this.command = { command: PLAN_COMMANDS.open, title: 'Open this TODO', arguments: [{ line: task.line }] };
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
  refresh(): void { this.changed.fire(undefined); }
  getTreeItem(node: Node): vscode.TreeItem { return node; }
  async getChildren(node?: Node): Promise<Node[]> {
    if (node instanceof SectionNode) return node.section.tasks.map((task) => new TaskNode(task));
    if (node) return [];
    const uri = planUri();
    if (!uri) return [new MessageNode('Open a project folder to read its core plan.')];
    try {
      const open = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
      const source = open ? open.getText() : new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      const parsed = parsePlan(source);
      const rows: Node[] = parsed.errors.slice(0, 5).map((error) => new MessageNode(error, PLAN_COMMANDS.open));
      if (parsed.errors.length > 5) rows.push(new MessageNode(`${parsed.errors.length - 5} more format errors; open the plan.`, PLAN_COMMANDS.open));
      if (parsed.sections.length) rows.push(...parsed.sections.map((section) => new SectionNode(section)));
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
  context.subscriptions.push(
    view,
    vscode.workspace.onDidChangeTextDocument((event) => { if (event.document.uri.toString() === planUri()?.toString()) tree.refresh(); }),
    vscode.workspace.onDidSaveTextDocument((document) => { if (document.uri.toString() === planUri()?.toString()) tree.refresh(); }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => tree.refresh()),
    view.onDidChangeVisibility((event) => { if (event.visible) tree.refresh(); }),
    vscode.commands.registerCommand(PLAN_COMMANDS.refresh, () => tree.refresh()),
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
