import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { WorktreeService } from '../projects/worktrees';
import { githubReaderFor } from '../github/githubCommands';
import { privateStorage } from '../storage/storageCommands';
import { configureMergeAuthority, configurePublicFeedback, mergePullRequestReport, readMergeAuthority, reviewPullRequestReport, sendPublicFeedback, setPublicFeedbackTestMode } from './publicFeedback';

const { readFeedback, saveFeedback } = require('./feedback-store') as {
  readFeedback(store: unknown, target: Record<string, unknown>): { state: string; record?: { note: string; headSha: string | null; updatedAt: string; revision: number } };
  saveFeedback(store: unknown, target: Record<string, unknown>, input: Record<string, unknown>, expectedRevision: number | null): { ok: boolean; reason?: string };
};
const { classifyPullRequest, classifyIssue, CATEGORIES, CATEGORY_LABELS } = require('./decision-queue') as {
  classifyPullRequest(pr: unknown, snapshot: unknown): string;
  classifyIssue(issue: unknown): string;
  CATEGORIES: string[];
  CATEGORY_LABELS: Record<string, string>;
};

type ReportFile = { filename: string; status: string; patch: string | null };
const { buildIssueReport, buildPullRequestReport, neighbour, render, line, fileBulletLines } = require('./report') as {
  buildIssueReport(input: Record<string, unknown>): { title: string; lines: string[] };
  buildPullRequestReport(input: Record<string, unknown>): { title: string; lines: string[]; files?: ReportFile[] };
  neighbour(numbers: number[], current: number, step: number): number | null;
  render(report: { lines: string[] }): string;
  line(value: unknown, limit?: number): string;
  fileBulletLines(lines: string[], filenames: string[]): Array<{ lineNumber: number; filename: string }>;
};

export const REPORT_SCHEME = 'multiagent-report';
export const DIFF_SCHEME = 'multiagent-report-diff';
export const REPORT_VIEWS = { issues: 'multiagentSystem.issuesReportView', pullRequests: 'multiagentSystem.prsReportView' } as const;
export const REPORT_COMMANDS = {
  open: 'multiagentSystem.reports.open',
  next: 'multiagentSystem.reports.next',
  previous: 'multiagentSystem.reports.previous',
  back: 'multiagentSystem.reports.backToOverview',
  backToList: 'multiagentSystem.reports.backToList',
  showDiff: 'multiagentSystem.reports.showDiff',
  openFileDiff: 'multiagentSystem.reports.openFileDiff',
  refresh: 'multiagentSystem.reports.refresh',
  feedback: 'multiagentSystem.reports.feedback',
  publicFeedback: 'multiagentSystem.reports.publicFeedback',
  reviewPullRequest: 'multiagentSystem.reports.reviewPullRequest',
  mergePullRequest: 'multiagentSystem.reports.mergePullRequest',
  configurePublisher: 'multiagentSystem.reports.configurePublisher',
  configureMergeAuthority: 'multiagentSystem.reports.configureMergeAuthority'
} as const;

type Kind = 'issue' | 'pullRequest';
type Result = { kind: string; data?: any };
// The read-only calls a report needs. The real reader is the GitHub read adapter (GET only).
export interface ReportReader {
  listIssues(filter: { state: 'open' | 'closed' }): Promise<Result>;
  getIssue(number: number): Promise<Result>;
  getIssueComments(number: number): Promise<Result>;
  listPullRequests(filter: { state: 'open' | 'closed' }): Promise<Result>;
  getPullRequest(number: number, opts?: { forceRefresh?: boolean }): Promise<Result>;
  getPullRequestFiles(number: number, opts?: { forceRefresh?: boolean }): Promise<Result>;
  getPullRequestSnapshot(number: number): Promise<any>;
  getReviews(number: number): Promise<Result>;
}
export interface ReportDeps {
  repository(): Promise<string | null>;
  readerFor(repository: string): ReportReader | null;
  promptFeedback?(value: string): Thenable<string | undefined>;
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
  readerFor: (repository) => githubReaderFor(repository) as unknown as ReportReader | null,
  promptFeedback: (value) => vscode.window.showInputBox({ prompt: 'Feedback saved only on this machine; nothing is sent to GitHub', value, ignoreFocusOut: true })
};
let deps: ReportDeps = realDeps;
let readGeneration = 0;
/** Replaces where reports are read from. Only the Extension Host test does this. */
export function setReportDepsForTests(next: ReportDeps | undefined): void { deps = next ?? realDeps; readGeneration += 1; }

const order: Record<Kind, number[]> = { issue: [], pullRequest: [] };

async function localFeedback(repository: string, kind: Kind, number: number): Promise<ReturnType<typeof readFeedback>> {
  try {
    const opened = await privateStorage()?.use();
    return opened?.ok ? readFeedback(opened.store, { repository, kind, number }) : { state: 'unknown' };
  } catch { return { state: 'unknown' }; }
}

async function mergeAuthoritySection(): Promise<string> {
  const mode = await readMergeAuthority();
  if (mode === 'pm') return '\nMERGE AUTHORITY\nPM allowed: guarded merge requires current-head PM approval, passing CI, resolved threads, supported branch rules, and a clear publication scan.\n';
  if (mode === 'human') return '\nMERGE AUTHORITY\nHuman only (default): PM merge is refused.\n';
  return '\nMERGE AUTHORITY\nUnknown: merge authority policy could not be read from private storage (fails closed).\n';
}

async function withFeedback(report: string, repository: string, kind: Kind, number: number, currentHead: string | null): Promise<string> {
  const found = await localFeedback(repository, kind, number);
  const authority = kind === 'pullRequest' ? await mergeAuthoritySection() : '';
  if (found.state === 'unknown') return `${report}\nLOCAL FEEDBACK\nUnknown: private feedback could not be read.\n${authority}`;
  if (found.state === 'missing') return `${report}\nLOCAL FEEDBACK\nNone saved on this machine. Nothing was sent to GitHub.\n${authority}`;
  const record = found.record!;
  const stale = kind === 'pullRequest' && record.headSha !== currentHead;
  return `${report}\nLOCAL FEEDBACK\nSaved only on this machine${stale ? ' · STALE: written for another head' : ''}. Nothing was sent to GitHub. Open Save Local Feedback to read or edit the private note.\n${authority}`;
}

class Message extends vscode.TreeItem {
  constructor(text: string) { super(text, vscode.TreeItemCollapsibleState.None); this.iconPath = new vscode.ThemeIcon('info'); }
}

class Category extends vscode.TreeItem {
  constructor(readonly entries: Entry[], label: string) {
    super(`${label} (${entries.length})`, entries.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon('list-tree');
  }
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
  private view: vscode.TreeView<vscode.TreeItem> | undefined;
  constructor(private readonly kind: Kind) {}
  /** The badge is set here, not at creation, because `createTreeView` needs this provider first. */
  setView(view: vscode.TreeView<vscode.TreeItem>): void { this.view = view; }
  refresh(): void { order[this.kind] = []; this.changed.fire(undefined); }
  getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }

  // No source, or a source that could not be read in full, means the count is unknown: the badge is
  // cleared rather than showing a stale or guessed number. Only a complete, de-duplicated read sets it.
  private setBadge(count: number | null): void {
    if (!this.view) return;
    this.view.badge = count !== null && count > 0 ? { value: count, tooltip: `${count} item(s) need a decision or more evidence` } : undefined;
  }

  async getChildren(item?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (item) return item instanceof Category ? item.entries : [];
    const generation = readGeneration;
    const what = this.kind === 'issue' ? 'Issues' : 'Pull requests';
    if (!vscode.workspace.isTrusted) { this.setBadge(null); return [new Message('Trust this workspace to read its GitHub work.')]; }
    const repository = await deps.repository();
    if (!repository) { this.setBadge(null); return [new Message('Open a project folder that has a GitHub origin to read its reports.')]; }
    const reader = deps.readerFor(repository);
    if (!reader) { this.setBadge(null); return [new Message('GitHub could not be reached for this project.')]; }
    let result: Result;
    let closed: Result;
    try {
      [result, closed] = this.kind === 'issue'
        ? await Promise.all([reader.listIssues({ state: 'open' }), reader.listIssues({ state: 'closed' })])
        : await Promise.all([reader.listPullRequests({ state: 'open' }), reader.listPullRequests({ state: 'closed' })]);
    } catch {
      this.setBadge(null);
      return [new Message(`${what} could not be read. Refresh to retry.`)];
    }
    // Only a complete answer is a list; an incomplete one is never shown as if it were the whole.
    const itemsOf = (answer: Result): any[] | null => {
      if (!answer || (answer.kind !== 'ok' && answer.kind !== 'empty')) return null;
      if (answer.kind === 'empty') return answer.data === undefined || (Array.isArray(answer.data) && answer.data.length === 0) ? [] : null;
      return Array.isArray(answer.data) && answer.data.every((entry: any) => entry && Number.isSafeInteger(entry.number) && entry.number > 0) ? answer.data : null;
    };
    const openItems = itemsOf(result);
    const closedItems = itemsOf(closed);
    if (!openItems || !closedItems) {
      if (generation === readGeneration) order[this.kind] = [];
      this.setBadge(null);
      const failed = openItems === null ? result : closed;
      return [new Message(incompleteMessage(what, failed?.kind === 'ok' || failed?.kind === 'empty' ? 'invalid' : failed?.kind ?? 'invalid'))];
    }
    const all = [...openItems, ...closedItems];
    if (new Set(all.map((entry) => entry.number)).size !== all.length) { this.setBadge(null); return [new Message(incompleteMessage(what, 'duplicate'))]; }
    const rows: Record<string, Entry[]> = Object.fromEntries(CATEGORIES.map((category: string) => [category, []]));
    const snapshots = this.kind === 'pullRequest' ? await Promise.all(openItems.map(async (entry) => {
      try { return await reader.getPullRequestSnapshot(entry.number); } catch { return { status: 'unavailable' }; }
    })) : [];
    for (const [index, entry] of all.entries()) {
      const category = this.kind === 'issue' ? classifyIssue(entry) : classifyPullRequest(entry, index < openItems.length ? snapshots[index] : null);
      const detail = this.kind === 'issue' ? line(entry.state, 30) : `${line(entry.state, 30)} · ${line(entry.headRepository, 80) || 'source unknown'} · ${line(entry.headSha, 40) || 'head unknown'}`;
      rows[category].push(new Entry(this.kind, entry.number, entry.title, detail));
    }
    if (generation === readGeneration) order[this.kind] = CATEGORIES.flatMap((category: string) => rows[category].map((entry) => entry.number));
    // "Needs a decision" is everything not yet passed or processed (closed/merged): pending plus
    // explicit changes-requested, the two categories that still require the user's attention.
    this.setBadge(rows.pending.length + rows.changes.length);
    if (all.length === 0) return [new Message(`No ${what.toLowerCase()} were reported.`)];
    return CATEGORIES.map((category: string) => new Category(rows[category], CATEGORY_LABELS[category]));
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

type ReportEvidence = { repository: string; kind: Kind; number: number; headSha: string | null; version: string; files: ReportFile[] };
type ReportResult = { text: string; evidence: ReportEvidence | null };

/** Builds one report and records exactly which repository/head its text represents. */
async function reportResult(kind: Kind, number: number): Promise<ReportResult> {
  const repository = await deps.repository();
  if (!repository) return { text: 'No GitHub project is open, so this report cannot be read.\n', evidence: null };
  const reader = deps.readerFor(repository);
  if (!reader) return { text: 'GitHub could not be reached for this project.\n', evidence: null };
  try {
    if (kind === 'issue') {
      const [issue, comments, pullRequests] = await Promise.all([reader.getIssue(number), reader.getIssueComments(number), reader.listPullRequests({ state: 'open' })]);
      if (issue.kind !== 'ok' || !issue.data) return { text: `Issue #${number} could not be read (${line(issue.kind, 30)}). Refresh the list and try again.\n`, evidence: null };
      const version = createHash('sha256').update(`${issue.data.title}\0${issue.data.body ?? ''}`).digest('hex');
      return { text: await withFeedback(render(buildIssueReport({ repository, issue: issue.data, comments, pullRequests })), repository, kind, number, null), evidence: { repository, kind, number, headSha: null, version, files: [] } };
    }
    const [pullRequest, snapshot, reviews, comments] = await Promise.all([reader.getPullRequest(number), reader.getPullRequestSnapshot(number), reader.getReviews(number), reader.getIssueComments(number)]);
    if (pullRequest.kind !== 'ok' || !pullRequest.data) return { text: `Pull request #${number} could not be read (${line(pullRequest.kind, 30)}). Refresh the list and try again.\n`, evidence: null };
    // The files endpoint is keyed by PR number and has no head SHA. Read the head before and
    // after the files, so a concurrent push cannot attach a new patch to the old report head.
    let files: Result = { kind: 'not_read' };
    let afterFiles: Result = { kind: 'not_read' };
    try {
      files = await reader.getPullRequestFiles(number, { forceRefresh: true });
      afterFiles = await reader.getPullRequest(number, { forceRefresh: true });
    } catch {
      // Keep the description and review readable. The diff cannot be assigned to this head.
    }
    const beforeHead = pullRequest.data.headSha;
    const filesHeadVerified = typeof beforeHead === 'string' && /^[a-f0-9]{40}$/i.test(beforeHead) &&
      afterFiles.kind === 'ok' && typeof afterFiles.data?.headSha === 'string' &&
      afterFiles.data.headSha.toLowerCase() === beforeHead.toLowerCase();
    const headSha = typeof beforeHead === 'string' && /^[a-f0-9]{40}$/i.test(beforeHead) ? beforeHead : null;
    const built = buildPullRequestReport({ repository, pullRequest: pullRequest.data, snapshot, reviews, comments, files, filesHeadVerified });
    return { text: await withFeedback(render(built), repository, kind, number, beforeHead), evidence: headSha ? { repository, kind, number, headSha, version: headSha.toLowerCase(), files: Array.isArray(built.files) ? built.files : [] } : null };
  } catch {
    return { text: `${kind === 'issue' ? 'Issue' : 'Pull request'} #${number} could not be read from GitHub. Refresh the list and try again.\n`, evidence: null };
  }
}

/** Failures are written into the report, not thrown. */
export async function reportText(kind: Kind, number: number): Promise<string> { return (await reportResult(kind, number)).text; }

class ReportContent implements vscode.TextDocumentContentProvider {
  readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  private readonly evidence = new Map<string, ReportEvidence>();
  evidenceFor(uri: vscode.Uri): ReportEvidence | null { return this.evidence.get(uri.toString()) ?? null; }
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const target = parse(uri);
    if (!target) return 'This report address is not valid.\n';
    const result = await reportResult(target.kind, target.number);
    if (result.evidence) this.evidence.set(uri.toString(), result.evidence);
    else this.evidence.delete(uri.toString());
    return result.text;
  }
}

function diffUri(reportUri: vscode.Uri, filename: string): vscode.Uri {
  const base = filename.split('/').pop() || 'file';
  return vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${base}.diff`, query: `report=${encodeURIComponent(reportUri.toString())}&file=${encodeURIComponent(filename)}` });
}

function parseDiffUri(uri: vscode.Uri): { reportUri: string; filename: string } | null {
  const params = new URLSearchParams(uri.query);
  const reportUri = params.get('report');
  const filename = params.get('file');
  return reportUri && filename ? { reportUri, filename } : null;
}

/**
 * One file's unified diff, rendered on its own so it can be opened from a link in the PR report
 * without hunting through a 12-file preview. Reads the same cached file list the open report used,
 * never a fresh fetch: a link always shows the patch for the head the report is currently displaying.
 */
class DiffContent implements vscode.TextDocumentContentProvider {
  constructor(private readonly content: ReportContent) {}
  provideTextDocumentContent(uri: vscode.Uri): string {
    const target = parseDiffUri(uri);
    if (!target) return 'This diff address is not valid.\n';
    const evidence = this.content.evidenceFor(vscode.Uri.parse(target.reportUri));
    if (!evidence) return 'The pull request report this diff came from is no longer open. Open the report again and click the file once more.\n';
    const file = evidence.files.find((entry) => entry.filename === target.filename);
    if (!file) return `No changed-file entry named "${target.filename}" was found in the currently shown report. It may have been refreshed since this diff was opened.\n`;
    const header = `${file.filename} (${file.status}) — from the pull request report currently open, head ${evidence.headSha ?? 'unknown'}.\n\n`;
    return header + (file.patch !== null ? file.patch : 'Patch unavailable (binary file or GitHub omitted it).\n');
  }
}

/** Turns each "CHANGED FILES AND DIFF" bullet into a link to that one file's diff, syntax-highlighted on its own. */
class ReportFileLinks implements vscode.DocumentLinkProvider {
  constructor(private readonly content: ReportContent) {}
  provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
    if (document.uri.scheme !== REPORT_SCHEME) return [];
    const target = parse(document.uri);
    if (!target || target.kind !== 'pullRequest') return [];
    const evidence = this.content.evidenceFor(document.uri);
    if (!evidence || evidence.files.length === 0) return [];
    const lines: string[] = [];
    for (let i = 0; i < document.lineCount; i += 1) lines.push(document.lineAt(i).text);
    return fileBulletLines(lines, evidence.files.map((entry) => entry.filename)).map(({ lineNumber, filename }) => {
      const text = lines[lineNumber];
      const start = text.indexOf(filename);
      const range = new vscode.Range(lineNumber, start, lineNumber, start + filename.length);
      return new vscode.DocumentLink(range, vscode.Uri.parse(
        `command:${REPORT_COMMANDS.openFileDiff}?${encodeURIComponent(JSON.stringify({ reportUri: document.uri.toString(), filename }))}`
      ));
    });
  }
}

async function openFileDiff(value: unknown): Promise<{ ok: boolean; code?: string }> {
  const input = value && typeof value === 'object' ? (value as { reportUri?: unknown; filename?: unknown }) : {};
  if (typeof input.reportUri !== 'string' || typeof input.filename !== 'string') return { ok: false, code: 'invalid-file-diff' };
  let reportUri: vscode.Uri;
  try { reportUri = vscode.Uri.parse(input.reportUri); } catch { return { ok: false, code: 'invalid-file-diff' }; }
  if (reportUri.scheme !== REPORT_SCHEME) return { ok: false, code: 'invalid-file-diff' };
  const document = await vscode.workspace.openTextDocument(diffUri(reportUri, input.filename));
  await vscode.languages.setTextDocumentLanguage(document, 'diff');
  await vscode.window.showTextDocument(document, { preview: true });
  return { ok: true };
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

let testViews: Record<Kind, vscode.TreeView<vscode.TreeItem>> | undefined;
/** The activity-bar badge each list currently shows: how many items still need a decision or more evidence. */
export function reportBadgeForTests(kind: Kind): number | undefined {
  if (!testViews) throw new Error('The report lists are available only in Extension Host tests.');
  return testViews[kind].badge?.value;
}

export function registerReports(context: vscode.ExtensionContext): void {
  setPublicFeedbackTestMode(context.extensionMode === vscode.ExtensionMode.Test);
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
  const issueView = vscode.window.createTreeView(REPORT_VIEWS.issues, { treeDataProvider: trees.issue });
  const pullRequestView = vscode.window.createTreeView(REPORT_VIEWS.pullRequests, { treeDataProvider: trees.pullRequest });
  trees.issue.setView(issueView);
  trees.pullRequest.setView(pullRequestView);
  testViews = context.extensionMode === vscode.ExtensionMode.Test ? { issue: issueView, pullRequest: pullRequestView } : undefined;
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(REPORT_SCHEME, content),
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, new DiffContent(content)),
    vscode.languages.registerDocumentLinkProvider({ scheme: REPORT_SCHEME }, new ReportFileLinks(content)),
    issueView,
    pullRequestView,
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    vscode.commands.registerCommand(REPORT_COMMANDS.open, open),
    vscode.commands.registerCommand(REPORT_COMMANDS.openFileDiff, openFileDiff),
    vscode.commands.registerCommand(REPORT_COMMANDS.next, () => step(1)),
    vscode.commands.registerCommand(REPORT_COMMANDS.previous, () => step(-1)),
    vscode.commands.registerCommand(REPORT_COMMANDS.backToList, async () => {
      const target = activeTarget();
      if (!target) return { ok: false, code: 'no-report-open' };
      await vscode.commands.executeCommand((target.kind === 'issue' ? REPORT_VIEWS.issues : REPORT_VIEWS.pullRequests) + '.focus');
      return { ok: true };
    }),
    vscode.commands.registerCommand(REPORT_COMMANDS.showDiff, async () => {
      const editor = vscode.window.activeTextEditor;
      const target = activeTarget();
      if (!editor || target?.kind !== 'pullRequest') return { ok: false, code: 'no-pr-report-open' };
      const offset = editor.document.getText().indexOf('CHANGED FILES AND DIFF (plain text preview)');
      if (offset < 0) return { ok: false, code: 'diff-unavailable' };
      const position = editor.document.positionAt(offset);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.AtTop);
      return { ok: true };
    }),
    vscode.commands.registerCommand(REPORT_COMMANDS.refresh, refresh),
    vscode.commands.registerCommand(REPORT_COMMANDS.configurePublisher, async () => {
      const result = await configurePublicFeedback();
      if (result.ok) void vscode.window.showInformationMessage('Public feedback publisher configured in private storage.');
      else if (result.code !== 'cancelled') void vscode.window.showErrorMessage(`Could not configure public feedback: ${result.code ?? 'unknown'}.`);
      return result;
    }),
    vscode.commands.registerCommand(REPORT_COMMANDS.configureMergeAuthority, async (value?: unknown) => {
      const isTest = context.extensionMode === vscode.ExtensionMode.Test;
      const input = value && typeof value === 'object' ? value as { mode?: unknown; interactive?: unknown } : {};
      const interactive = isTest ? (input.interactive === false ? false : true) : true;
      const result = await configureMergeAuthority({ mode: input.mode, interactive });
      if (result.ok) {
        refresh();
        if (interactive) void vscode.window.showInformationMessage(`Pull request merge authority set to "${result.mode}".`);
      } else if (interactive && result.code !== 'cancelled') {
        void vscode.window.showErrorMessage(`Could not configure pull request merge authority: ${result.code ?? 'unknown'}.`);
      }
      return result;
    }),
    vscode.commands.registerCommand(REPORT_COMMANDS.publicFeedback, async (value?: unknown) => {
      const isTest = context.extensionMode === vscode.ExtensionMode.Test;
      const input = value && typeof value === 'object' ? value as { body?: unknown; interactive?: unknown } : {};
      const interactive = isTest ? (input.interactive === false ? false : true) : true;
      const uri = vscode.window.activeTextEditor?.document.uri;
      const target = uri?.scheme === REPORT_SCHEME ? content.evidenceFor(uri) : null;
      if (!target) return { ok: false, code: 'report-evidence-unavailable' };
      const result = await sendPublicFeedback({ repository: target.repository, kind: target.kind, number: target.number, version: target.version }, { body: input.body, interactive });
      if (result.ok) {
        refresh();
        if (interactive) void vscode.window.showInformationMessage(result.code === 'already-sent' ? 'This exact public feedback was already sent.' : 'Public feedback sent and verified for this report.');
      } else if (interactive && result.code !== 'cancelled') {
        if (result.code === 'publisher-not-configured' || result.code === 'publisher-identity-changed') {
          void vscode.window.showErrorMessage(`Public feedback was not sent: ${result.code}.`, 'Configure PM Publisher').then((picked) => {
            if (picked === 'Configure PM Publisher') void vscode.commands.executeCommand(REPORT_COMMANDS.configurePublisher);
          });
        } else {
          void vscode.window.showErrorMessage(`Public feedback was not sent: ${result.code ?? 'unknown'}.`);
        }
      }
      return result;
    }),
    vscode.commands.registerCommand(REPORT_COMMANDS.reviewPullRequest, async (value?: unknown) => {
      const isTest = context.extensionMode === vscode.ExtensionMode.Test;
      const input = value && typeof value === 'object' ? value as { decision?: unknown; body?: unknown; interactive?: unknown } : {};
      const interactive = isTest ? (input.interactive === false ? false : true) : true;
      const uri = vscode.window.activeTextEditor?.document.uri;
      const target = uri?.scheme === REPORT_SCHEME ? content.evidenceFor(uri) : null;
      if (!target || target.kind !== 'pullRequest') return { ok: false, code: 'no-pr-report-open' };
      const result = await reviewPullRequestReport({ repository: target.repository, kind: target.kind, number: target.number, version: target.version }, { decision: input.decision, body: input.body, interactive });
      if (result.ok) {
        refresh();
        if (interactive) void vscode.window.showInformationMessage(result.code === 'already-reviewed' ? 'This formal pull request review was already submitted for this head.' : 'Formal pull request review submitted and verified for this head.');
      } else if (interactive && result.code !== 'cancelled') {
        void vscode.window.showErrorMessage(`Formal pull request review was not submitted: ${result.code ?? 'unknown'}.`);
      }
      return result;
    }),
    vscode.commands.registerCommand(REPORT_COMMANDS.mergePullRequest, async (value?: unknown) => {
      const isTest = context.extensionMode === vscode.ExtensionMode.Test;
      const input = value && typeof value === 'object' ? value as { interactive?: unknown } : {};
      const interactive = isTest ? (input.interactive === false ? false : true) : true;
      const uri = vscode.window.activeTextEditor?.document.uri;
      const target = uri?.scheme === REPORT_SCHEME ? content.evidenceFor(uri) : null;
      if (!target || target.kind !== 'pullRequest') return { ok: false, code: 'no-pr-report-open' };
      const result = await mergePullRequestReport({ repository: target.repository, kind: target.kind, number: target.number, version: target.version }, { interactive });
      if (result.ok) {
        refresh();
        if (interactive) void vscode.window.showInformationMessage(result.code === 'already-merged' ? 'This pull request head was already merged.' : 'Pull request merged and verified for this head.');
      } else if (interactive && result.code !== 'cancelled') {
        if (result.code === 'human-merge-required') {
          void vscode.window.showErrorMessage('Pull request merge was refused: human-merge-required (default merge authority is Human only).', 'Configure Merge Authority').then((picked) => {
            if (picked === 'Configure Merge Authority') void vscode.commands.executeCommand(REPORT_COMMANDS.configureMergeAuthority);
          });
        } else {
          void vscode.window.showErrorMessage(`Pull request was not merged: ${result.code ?? 'unknown'}.`);
        }
      }
      return result;
    }),
    vscode.commands.registerCommand(REPORT_COMMANDS.feedback, async (value?: unknown) => {
      const isTest = context.extensionMode === vscode.ExtensionMode.Test;
      const requested = value && typeof value === 'object' ? value as { kind?: unknown; number?: unknown; note?: unknown; interactive?: unknown } : {};
      const interactive = isTest ? (requested.interactive === false ? false : true) : true;
      const requestedKind = requested.kind === 'issue' || requested.kind === 'pullRequest' ? requested.kind : null;
      const requestedNumber = typeof requested.number === 'number' && Number.isSafeInteger(requested.number) && requested.number > 0 ? requested.number : null;
      const target: { kind: Kind; number: number } | null = requestedKind && requestedNumber !== null ? { kind: requestedKind, number: requestedNumber } : activeTarget();
      if (!target) return { ok: false, code: 'no-report-open' };
      const activeUri = vscode.window.activeTextEditor?.document.uri;
      const shown = activeUri?.scheme === REPORT_SCHEME ? content.evidenceFor(activeUri) : null;
      if (!shown || shown.kind !== target.kind || shown.number !== target.number) return { ok: false, code: 'report-evidence-unavailable' };
      const repository = shown.repository;
      const opened = await privateStorage()?.use();
      if (!opened?.ok) return { ok: false, code: 'private-storage-unavailable' };
      const key = { repository, kind: target.kind, number: target.number };
      const current = readFeedback(opened.store, key);
      if (current.state === 'unknown') return { ok: false, code: 'feedback-unreadable' };
      const note = !interactive ? requested.note : await (deps.promptFeedback?.(current.record?.note ?? '') ?? realDeps.promptFeedback!(current.record?.note ?? ''));
      if (note === undefined) return { ok: false, code: 'cancelled' };
      const currentRepository = await deps.repository();
      if (currentRepository !== repository) return { ok: false, code: 'report-context-changed' };
      let headSha = shown.headSha;
      if (target.kind === 'pullRequest') {
        const reader = deps.readerFor(repository);
        const read = reader ? await reader.getPullRequest(target.number, { forceRefresh: true }) : null;
        const currentHead = read?.kind === 'ok' && typeof read.data?.headSha === 'string' && /^[a-f0-9]{40}$/i.test(read.data.headSha) ? read.data.headSha : null;
        if (!currentHead || !headSha) return { ok: false, code: 'head-unavailable' };
        if (currentHead.toLowerCase() !== headSha.toLowerCase()) return { ok: false, code: 'head-changed' };
      }
      const saved = saveFeedback(opened.store, key, { note, headSha }, current.record?.revision ?? null);
      if (!saved.ok) return { ok: false, code: saved.reason ?? 'feedback-save-failed' };
      content.changed.fire(reportUri(target.kind, target.number));
      if (interactive) void vscode.window.showInformationMessage('Feedback saved only on this machine. Nothing was sent to GitHub.');
      return { ok: true };
    }),
    vscode.commands.registerCommand(REPORT_COMMANDS.back, async () => {
      // Back to the agents: close the report that is open and bring the overview forward.
      if (activeTarget()) await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      await vscode.commands.executeCommand('multiagentSystem.overviewView.focus');
      return { ok: true };
    })
  );
}
