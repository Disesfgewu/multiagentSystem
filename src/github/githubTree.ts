import * as vscode from 'vscode';
import { WorktreeService } from '../projects/worktrees';
import {
  BrowseItem, Category, GitHubAdapter, GitHubController, IssueSummary, PullRequestSummary,
  RepositoryRef, describeReadFailure, describeSnapshot, displayText, parseNumber, parseRepository
} from './controller';

export const GITHUB_TREE_VIEW = 'multiagentSystem.githubView';
export const GITHUB_TREE_COMMANDS = {
  refresh: 'multiagentSystem.github.refreshView',
  openItem: 'multiagentSystem.github.openInEditor'
} as const;

const GITHUB_SIGN_IN_COMMAND = `${'multiagentSystem'}.github.signIn`;

type Node = CategoryNode | EntryNode | MessageNode;

class CategoryNode extends vscode.TreeItem {
  constructor(readonly category: Category) {
    super(category === 'issues' ? 'Issues' : 'Pull requests', vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'multiagentCategory';
    this.iconPath = new vscode.ThemeIcon(category === 'issues' ? 'issues' : 'git-pull-request');
  }
}

class EntryNode extends vscode.TreeItem {
  constructor(readonly category: Category, readonly repository: string, readonly entry: BrowseItem) {
    super(`#${entry.number} ${entry.title}`, vscode.TreeItemCollapsibleState.None);
    this.description = entry.state;
    this.tooltip = `${entry.detail}\n${entry.url}`;
    this.iconPath = new vscode.ThemeIcon(category === 'issues' ? 'issues' : 'git-pull-request');
    this.command = {
      command: GITHUB_TREE_COMMANDS.openItem,
      title: 'Open in editor',
      arguments: [{ category, repository, number: entry.number }]
    };
  }
}

class MessageNode extends vscode.TreeItem {
  constructor(message: string, commandId?: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('info');
    if (commandId) {
      this.command = { command: commandId, title: message };
    }
  }
}

function detailBody(body: string | null | undefined): string {
  if (!body) return '(no description)';
  // This is opened as source text, never rendered as an instruction or executed.
  return body.slice(0, 200_000).replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ');
}

function detailFailure(kind: string, repository: string, number: number, code: string): string {
  return `Could not read ${kind} ${repository}#${number}: ${code}. Refresh the view or check GitHub sign-in.`;
}

export class GitHubTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly categories: CategoryNode[] = [new CategoryNode('issues'), new CategoryNode('pullRequests')];

  constructor(
    private readonly controller: GitHubController,
    private readonly adapter: () => GitHubAdapter,
    private readonly signInCommandId?: string
  ) {}

  refresh(): void { this.changed.fire(undefined); }

  getTreeItem(node: Node): vscode.TreeItem { return node; }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) return this.categories;
    if (!(node instanceof CategoryNode)) return [];
    if (!vscode.workspace.isTrusted) return [new MessageNode('Trust this workspace to read its GitHub origin.')];
    const repository = await this.workspaceRepository();
    if (!repository) return [new MessageNode('Open a GitHub project folder to list its work.')];
    const label = `${repository.owner}/${repository.name}`;
    try {
      // Tree item rendering reads GitHub API without UI dialogs; read-only operation permitted non-interactively.
      const result = await this.controller.browse({ interactive: false, repository: label, kind: node.category });
      if (!result.ok) {
        const command = this.signInCommandId && result.message.includes('Sign In to GitHub') ? this.signInCommandId : undefined;
        return [new MessageNode(result.message, command)];
      }
      const entries: Node[] = result.items.map((item) => new EntryNode(node.category, label, item));
      if (result.note) entries.unshift(new MessageNode(result.note));
      if (entries.length === 0) entries.push(new MessageNode(`No open ${node.category === 'issues' ? 'issues' : 'pull requests'}.`));
      return entries;
    } catch {
      return [new MessageNode('Could not read GitHub. Refresh the view to retry.')];
    }
  }

  async openItem(value: unknown): Promise<void> {
    if (!value || typeof value !== 'object') return;
    const input = value as Record<string, unknown>;
    const category = input.category;
    const repository = parseRepository(input.repository);
    const number = parseNumber(input.number);
    if ((category !== 'issues' && category !== 'pullRequests') || !repository || number === null) return;
    const label = `${repository.owner}/${repository.name}`;
    const reader = this.adapter().useRepository(repository);
    try {
      if (category === 'issues') {
        const result = await reader.getIssue(number);
        if (result.kind !== 'ok' || !result.data) {
          const failureMsg = detailFailure('issue', label, number, describeReadFailure(result, 'issue').message);
          if (this.signInCommandId && failureMsg.includes('Sign In to GitHub')) {
            const cmd = this.signInCommandId;
            void vscode.window.showErrorMessage(failureMsg, 'Sign In to GitHub').then((action) => {
              if (action === 'Sign In to GitHub') void vscode.commands.executeCommand(cmd);
            });
          } else {
            void vscode.window.showErrorMessage(failureMsg);
          }
          return;
        }
        const issue: IssueSummary = result.data;
        await this.showDetail([
          `Issue #${number}: ${displayText(issue.title, 300)}`,
          `Repository: ${label} | State: ${displayText(issue.state, 30)}`,
          `Author: ${displayText(issue.author ?? 'unknown', 80)} | Updated: ${issue.updatedAt ?? 'unknown'}`,
          `Labels: ${issue.labels.map((name) => displayText(name, 80)).join(', ') || '(none)'}`,
          `Assignees: ${issue.assignees.map((name) => displayText(name, 80)).join(', ') || '(none)'}`,
          '', detailBody(issue.body)
        ]);
      } else {
        const [result, snapshot] = await Promise.all([reader.getPullRequest(number), reader.getPullRequestSnapshot(number)]);
        if (result.kind !== 'ok' || !result.data) {
          const failureMsg = detailFailure('pull request', label, number, describeReadFailure(result, 'pull request').message);
          if (this.signInCommandId && failureMsg.includes('Sign In to GitHub')) {
            const cmd = this.signInCommandId;
            void vscode.window.showErrorMessage(failureMsg, 'Sign In to GitHub').then((action) => {
              if (action === 'Sign In to GitHub') void vscode.commands.executeCommand(cmd);
            });
          } else {
            void vscode.window.showErrorMessage(failureMsg);
          }
          return;
        }
        const pull: PullRequestSummary = result.data;
        await this.showDetail([
          `Pull request #${number}: ${displayText(pull.title, 300)}`,
          `Repository: ${label} | State: ${displayText(pull.state, 30)}${pull.draft ? ' (draft)' : ''}`,
          `Author: ${displayText(pull.author ?? 'unknown', 80)} | Updated: ${pull.updatedAt ?? 'unknown'}`,
          `Head: ${pull.headSha} → ${displayText(pull.baseRef, 100)}`,
          '', 'Review and CI', ...describeSnapshot(snapshot), '', 'Description', detailBody(pull.body)
        ]);
      }
    } catch {
      void vscode.window.showErrorMessage(`Could not read ${label}#${number} from GitHub.`);
    }
  }

  private async showDetail(lines: string[]): Promise<void> {
    const document = await vscode.workspace.openTextDocument({ language: 'plaintext', content: lines.join('\n') });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  private async workspaceRepository(): Promise<RepositoryRef | null> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return null;
    try {
      const project = await WorktreeService.open(folder.uri.fsPath);
      return parseRepository(project.githubRepository);
    } catch {
      return null;
    }
  }
}
