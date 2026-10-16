import * as vscode from 'vscode';
import { WorktreeService } from '../projects/worktrees';
import { githubReaderFor } from '../github/githubCommands';

const { buildIssueReport, buildPullRequestReport, neighbour, render, line } = require('./report') as {
  buildIssueReport(input: Record<string, unknown>): { title: string; lines: string[] };
  buildPullRequestReport(input: Record<string, unknown>): { title: string; lines: string[] };
  neighbour(numbers: number[], current: number, step: number): number | null;
  render(report: { lines: string[] }): string;
  line(value: unknown, limit?: number): string;
};

export const REPORT_SCHEME = 'multiagent-report';
export const REPORT_VIEWS = { issues: 'multiagentSystem.issuesReportView', pullRequests: 'multiagentSystem.prsReportView' } as const;
export const REPORT_COMMANDS = {
  open: 'multiagentSystem.reports.open',
  next: 'multiagentSystem.reports.next',
  previous: 'multiagentSystem.reports.previous',
  back: 'multiagentSystem.reports.backToOverview',
  refresh: 'multiagentSystem.reports.refresh'
} as const;

type Kind = 'issue' | 'pullRequest';
type Result = { kind: string; data?: any };
// The read-only calls a report needs. The real reader is the GitHub read adapter (GET only).
export interface ReportReader {
  listIssues(filter: { state: 'open' }): Promise<Result>;
  getIssue(number: number): Promise<Result>;
  getIssueComments(number: number): Promise<Result>;
  listPullRequests(filter: { state: 'open' }): Promise<Result>;
  getPullRequest(number: number): Promise<Result>;
  getPullRequestFiles(number: number): Promise<Result>;
  getPullRequestSnapshot(number: number): Promise<any>;
  getReviews(number: number): Promise<Result>;
}
export interface ReportDeps {
  repository(): Promise<string | null>;
  readerFor(repository: string): ReportReader | null;
}

const realDeps: ReportDeps = {
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
  readerFor: (repository) => githubReaderFor(repository) as unknown as ReportReader | null
};
let deps: ReportDeps = realDeps;
let readGeneration = 0;
/** Replaces where reports are read from. Only the Extension Host test does this. */
export function setReportDepsForTests(next: ReportDeps | undefined): void { deps = next ?? realDeps; readGeneration += 1; }

const order: Record<Kind, number[]> = { issue: [], pullRequest: [] };

class Message extends vscode.TreeItem {
  constructor(text: string) { super(text, vscode.TreeItemCollapsibleState.None); this.iconPath = new vscode.ThemeIcon('info'); }
}

class Entry extends vscode.TreeItem {
  constructor(kind: Kind, readonly number: number, title: string, detail: string) {
    super(`#${number} ${line(title, 120) || '(no title)'}`, vscode.TreeItemCollapsibleState.None);
    this.description = detail;
    this.iconPath = new vscode.ThemeIcon(kind === 'issue' ? 'issues' : 'git-pull-request');
    this.tooltip = 'Read this report inside the editor. It only reads: nothing is approved, merged or changed.';
    this.command = { command: REPORT_COMMANDS.open, title: 'Read report', arguments: [{ kind, number }] };
  }
}

const incompleteMessage = (what: string, kind: string): string => ({
  partial: `${what} could only be partly read, so the list is not shown. Refresh to retry.`,
  truncated: `${what} are more than could be read at once, so the list is not shown as complete.`,
  denied: `${what} could not be read: sign in to GitHub or check access.`,
  rate_limited: `${what} could not be read: GitHub asked for a pause. Refresh later.`,
  offline: `${what} could not be read: no connection.`
} as Record<string, string>)[kind] ?? `${what} could not be read (${line(kind, 30)}). Refresh to retry.`;

class ReportsTree implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changed = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  constructor(private readonly kind: Kind) {}
  refresh(): void { this.changed.fire(undefined); }
  getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }

  async getChildren(item?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (item) return [];
    const generation = readGeneration;
    const what = this.kind === 'issue' ? 'Issues' : 'Pull requests';
    if (!vscode.workspace.isTrusted) return [new Message('Trust this workspace to read its GitHub work.')];
    const repository = await deps.repository();
    if (!repository) return [new Message('Open a project folder that has a GitHub origin to read its reports.')];
    const reader = deps.readerFor(repository);
    if (!reader) return [new Message('GitHub could not be reached for this project.')];
    let result: Result;
    try {
      result = this.kind === 'issue' ? await reader.listIssues({ state: 'open' }) : await reader.listPullRequests({ state: 'open' });
    } catch {
      return [new Message(`${what} could not be read. Refresh to retry.`)];
    }
    // Only a complete answer is a list; an incomplete one is never shown as if it were the whole.
    if (!result || (result.kind !== 'ok' && result.kind !== 'empty')) { if (generation === readGeneration) order[this.kind] = []; return [new Message(incompleteMessage(what, result?.kind ?? 'invalid'))]; }
    const malformed = result.kind === 'ok'
      ? !Array.isArray(result.data) || result.data.some((entry: any) => !entry || !Number.isSafeInteger(entry.number) || entry.number < 1)
      : result.data !== undefined && (!Array.isArray(result.data) || result.data.length !== 0);
    if (malformed) { if (generation === readGeneration) order[this.kind] = []; return [new Message(incompleteMessage(what, 'invalid'))]; }
    const items: any[] = result.kind === 'empty' ? [] : result.data;
    if (generation === readGeneration) order[this.kind] = items.map((entry) => entry.number);
    if (items.length === 0) return [new Message(`No open ${what.toLowerCase()}.`)];
    return items.map((entry) => new Entry(this.kind, entry.number, entry.title, this.kind === 'issue'
      ? `${Array.isArray(entry.labels) && entry.labels.length ? entry.labels.slice(0, 2).map((label: unknown) => line(label, 20)).join(', ') : 'open'}`
      : `${entry.draft ? 'draft' : 'open'}${typeof entry.headRef === 'string' ? ` · ${line(entry.headRef, 30)}` : ''}`));
  }
}

function parse(uri: vscode.Uri): { kind: Kind; number: number } | null {
  const params = new URLSearchParams(uri.query);
  const kind = params.get('kind');
  const number = Number(params.get('n'));
  if ((kind !== 'issue' && kind !== 'pullRequest') || !Number.isSafeInteger(number) || number < 1) return null;
  return { kind, number };
}

export function reportUri(kind: Kind, number: number): vscode.Uri {
  return vscode.Uri.from({ scheme: REPORT_SCHEME, path: `/${kind === 'issue' ? 'issue' : 'pull-request'}-${number}.txt`, query: `kind=${kind}&n=${number}` });
}

/** Builds the report text for one item by reading GitHub now. Failures are written into the report, not thrown. */
export async function reportText(kind: Kind, number: number): Promise<string> {
  const repository = await deps.repository();
  if (!repository) return 'No GitHub project is open, so this report cannot be read.\n';
  const reader = deps.readerFor(repository);
  if (!reader) return 'GitHub could not be reached for this project.\n';
  try {
    if (kind === 'issue') {
      const [issue, comments, pullRequests] = await Promise.all([reader.getIssue(number), reader.getIssueComments(number), reader.listPullRequests({ state: 'open' })]);
      if (issue.kind !== 'ok' || !issue.data) return `Issue #${number} could not be read (${line(issue.kind, 30)}). Refresh the list and try again.\n`;
      return render(buildIssueReport({ repository, issue: issue.data, comments, pullRequests }));
    }
    const [pullRequest, snapshot, reviews, comments] = await Promise.all([reader.getPullRequest(number), reader.getPullRequestSnapshot(number), reader.getReviews(number), reader.getIssueComments(number)]);
    if (pullRequest.kind !== 'ok' || !pullRequest.data) return `Pull request #${number} could not be read (${line(pullRequest.kind, 30)}). Refresh the list and try again.\n`;
    // The files endpoint is keyed by PR number and has no head SHA. Read the head before and
    // after the files, so a concurrent push cannot attach a new patch to the old report head.
    let files: Result = { kind: 'not_read' };
    let afterFiles: Result = { kind: 'not_read' };
    try {
      files = await reader.getPullRequestFiles(number);
      afterFiles = await reader.getPullRequest(number);
    } catch {
      // Keep the description and review readable. The diff cannot be assigned to this head.
    }
    const beforeHead = pullRequest.data.headSha;
    const filesHeadVerified = typeof beforeHead === 'string' && /^[a-f0-9]{40}$/i.test(beforeHead) &&
      afterFiles.kind === 'ok' && typeof afterFiles.data?.headSha === 'string' &&
      afterFiles.data.headSha.toLowerCase() === beforeHead.toLowerCase();
    return render(buildPullRequestReport({ repository, pullRequest: pullRequest.data, snapshot, reviews, comments, files, filesHeadVerified }));
  } catch {
    return `${kind === 'issue' ? 'Issue' : 'Pull request'} #${number} could not be read from GitHub. Refresh the list and try again.\n`;
  }
}

class ReportContent implements vscode.TextDocumentContentProvider {
  readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const target = parse(uri);
    return target ? reportText(target.kind, target.number) : 'This report address is not valid.\n';
  }
}

function activeTarget(): { kind: Kind; number: number } | null {
  const uri = vscode.window.activeTextEditor?.document.uri;
  return uri && uri.scheme === REPORT_SCHEME ? parse(uri) : null;
}

async function open(value: unknown): Promise<{ ok: boolean; code?: string }> {
  const input = value && typeof value === 'object' ? (value as { kind?: unknown; number?: unknown }) : {};
  const kind = input.kind === 'issue' || input.kind === 'pullRequest' ? input.kind : null;
  const number = typeof input.number === 'number' && Number.isSafeInteger(input.number) && input.number > 0 ? input.number : null;
  if (!kind || number === null) return { ok: false, code: 'invalid-report' };
  const document = await vscode.workspace.openTextDocument(reportUri(kind, number));
  await vscode.window.showTextDocument(document, { preview: true });
  return { ok: true };
}

async function step(direction: 1 | -1): Promise<{ ok: boolean; number?: number; code?: string }> {
  const target = activeTarget();
  if (!target) return { ok: false, code: 'no-report-open' };
  const next = neighbour(order[target.kind], target.number, direction);
  if (next === null) return { ok: false, code: 'no-list' };
  const result = await open({ kind: target.kind, number: next });
  return result.ok ? { ok: true, number: next } : result;
}

let testTrees: Record<Kind, vscode.TreeDataProvider<vscode.TreeItem>> | undefined;
export function reportTreeForTests(kind: Kind): vscode.TreeDataProvider<vscode.TreeItem> {
  if (!testTrees) throw new Error('The report lists are available only in Extension Host tests.');
  return testTrees[kind];
}

export function registerReports(context: vscode.ExtensionContext): void {
  const content = new ReportContent();
  const trees = { issue: new ReportsTree('issue'), pullRequest: new ReportsTree('pullRequest') };
  testTrees = context.extensionMode === vscode.ExtensionMode.Test ? trees : undefined;
  const refresh = (): void => {
    trees.issue.refresh();
    trees.pullRequest.refresh();
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.scheme === REPORT_SCHEME) content.changed.fire(document.uri);
    }
  };
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(REPORT_SCHEME, content),
    vscode.window.createTreeView(REPORT_VIEWS.issues, { treeDataProvider: trees.issue }),
    vscode.window.createTreeView(REPORT_VIEWS.pullRequests, { treeDataProvider: trees.pullRequest }),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    vscode.commands.registerCommand(REPORT_COMMANDS.open, open),
    vscode.commands.registerCommand(REPORT_COMMANDS.next, () => step(1)),
    vscode.commands.registerCommand(REPORT_COMMANDS.previous, () => step(-1)),
    vscode.commands.registerCommand(REPORT_COMMANDS.refresh, refresh),
    vscode.commands.registerCommand(REPORT_COMMANDS.back, async () => {
      // Back to the agents: close the report that is open and bring the overview forward.
      if (activeTarget()) await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      await vscode.commands.executeCommand('multiagentSystem.overviewView.focus');
      return { ok: true };
    })
  );
}
