import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { isExtensionTestMode } from '../shared/testMode';

type PostKind = 'comment' | 'review' | 'inline';
type Known = { links: number; files: number; inline: Set<number>; posts: Set<string>; kind?: Kind };
type Message = { type: string; link?: number; file?: number; id?: number; text?: string; tellPm?: boolean; post?: PostKind; who?: 'pm' | 'agent'; decision?: 'approve' | 'request_changes'; reason?: 'completed' | 'not_planned' };
const { renderPage, parsePageMessage } = require('./github-page') as {
  renderPage(input: { nonce: string }): string;
  parsePageMessage(raw: unknown, known: Known): { ok: true; message: Message } | { ok: false; reason: string };
};
type Ability = { ok: boolean; code?: string; reason: string | null };
const { abilitiesFor } = require('./page-actions') as { abilitiesFor(input: { kind: Kind; writer: boolean; trusted: boolean; version: boolean; facts: unknown }): Record<string, Ability> };
const { safeHref, parseMarkdown } = require('./markdown') as { safeHref(raw: unknown, base: unknown): string | null; parseMarkdown(text: unknown, options?: Record<string, unknown>): { blocks: unknown[]; truncated: boolean; links: string[] } };
const { nextPoll, POLL_MS } = require('../talk/conversation') as { nextPoll(input: unknown): { delayMs: number; note: string }; POLL_MS: number };

type Kind = 'issue' | 'pullRequest';
type Post = { id: number; kind: 'comment' | 'review' };
type PageModel = {
  kind: Kind; number: number; links: string[]; commentsRead?: string; posts: Post[];
  pr: { files: Array<{ filename: string }>; inline: Array<{ id: number; file: number | null; line: number | null }> } | null;
};
export type PageSource = {
  // `version`: what the page's decisions are bound to (the head shown, or the Issue's digest); `facts`: what turns them on or off (#383).
  read(kind: Kind, number: number): Promise<{ ok: true; model: PageModel; repository: string; version?: string | null; facts?: unknown } | { ok: false; text: string }>;
  openFileDiff(kind: Kind, number: number, filename: string, line?: number): Thenable<unknown>;
  openText(kind: Kind, number: number): Thenable<unknown>;
};
/** What the page can do that writes to GitHub or types into a terminal (#353). Given by the Talk to PM module, with all of its checks. */
export type PageActions = {
  trusted(): boolean;
  comment(target: { kind: Kind; number: number }, text: string, tellPm: boolean, afterPost: () => void): Promise<{ ok: boolean; code?: string }>;
  ask(target: { kind: Kind; number: number }, post: { post: PostKind; id: number }, who: 'pm' | 'agent'): Promise<{ ok: boolean; code?: string }>;
};
/** The decisions of the page (#383): review, merge, delete branch, close. Given by the reports module, each through its existing function. */
export type PageAction = 'approve' | 'requestChanges' | 'merge' | 'deleteBranch' | 'closeCompleted' | 'closeNotPlanned';
export type PageWrites = { run(target: { repository: string; kind: Kind; number: number; version: string }, action: PageAction, typed: string): Promise<{ ok: boolean; code?: string }> };
let writes: PageWrites | null = null;
export function setPageWrites(next: PageWrites | null): void { writes = next; }
/** The decisions in use (the host tests put back what they replaced). */
export function currentPageWrites(): PageWrites | null { return writes; }
let actions: PageActions | null = null;
export function setPageActions(next: PageActions | null): void { actions = next; }
/** The actions in use (the host tests put back what they replaced). */
export function currentPageActions(): PageActions | null { return actions; }

export const GITHUB_PAGE_VIEW_TYPE = 'multiagentSystem.githubPage';

// Every post of a page, by kind and id: what "Discuss with PM" and "Ask an agent" may name, and how new ones are found.
const postKeys = (model: PageModel): string[] => [
  ...model.posts.map((post) => `${post.kind}:${post.id}`),
  ...(model.pr ? model.pr.inline.map((entry) => `inline:${entry.id}`) : [])
];

/**
 * One editor tab per Issue or pull request (#353), showing it as GitHub does: Markdown rendered, each post with the extension's own
 * badge for who wrote it, and for a pull request its head, CI, changed files and line comments. Below the conversation the owner
 * writes a comment (with a preview) and posts it, or posts it and tells the PM; on any post the owner can ask the PM or an agent to
 * read it and reply. Every one of these goes through the existing flows (publication check and confirmation, read-back,
 * confirmAndType), and only in a trusted workspace. While the page is visible it is read again every 45 seconds (longer after
 * failures), and posts that arrived since it was opened are marked new.
 *
 * The page can ask for exactly the messages `parsePageMessage` accepts. A link, a file, a line comment or a post is named by a number
 * the extension gave the page; the address of a link is looked up here and checked again before the browser opens it. Text comes from
 * the page only as what the person typed in the comment box, and is shown whole in the confirmation before it is posted.
 */
class GitHubPage {
  private model: PageModel | null = null;
  private repository: string | null = null;
  private version: string | null = null;
  private facts: unknown = null;
  private abilities: Record<string, Ability> = {};
  private readonly disposables: vscode.Disposable[] = [];
  private reading = 0;
  private seen: Set<string> | null = null;
  private readonly fresh = new Set<string>();
  private delayMs = POLL_MS;
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(readonly panel: vscode.WebviewPanel, readonly kind: Kind, readonly number: number, private readonly source: PageSource, onDispose: () => void) {
    panel.webview.html = renderPage({ nonce: randomBytes(16).toString('base64url') });
    this.disposables.push(
      panel.webview.onDidReceiveMessage((raw: unknown) => { void this.handle(raw); }),
      // A page in a hidden tab is not read; it is read again as soon as it is shown.
      panel.onDidChangeViewState(() => { if (panel.visible && !this.timer) void this.load(); }),
      panel.onDidDispose(() => { this.disposed = true; this.stop(); onDispose(); for (const item of this.disposables) item.dispose(); })
    );
  }

  /** What this page was last given (for tests: the page model, never the HTML), and which posts are marked new. */
  get shown(): PageModel | null { return this.model; }
  get shownAbilities(): Record<string, Ability> { return this.abilities; }
  get newPosts(): string[] { return [...this.fresh]; }
  get nextReadMs(): number { return this.delayMs; }

  async load(): Promise<void> {
    this.stop();
    const generation = ++this.reading;
    let result: Awaited<ReturnType<PageSource['read']>>;
    try { result = await this.source.read(this.kind, this.number); } catch { result = { ok: false, text: 'It could not be read from GitHub. Try again.' }; }
    // A later read wins: an answer that arrives after a newer one started is dropped.
    if (generation !== this.reading || this.disposed) return;
    const planned = nextPoll({ previousMs: this.delayMs, result: { kind: result.ok ? (result.model.commentsRead ?? 'ok') : 'invalid' } });
    this.delayMs = planned.delayMs;
    if (!result.ok) {
      // What was shown stays shown; the page says the last reading failed.
      if (this.model) this.post(planned.note);
      else void this.panel.webview.postMessage({ type: 'page', error: result.text });
    } else {
      // The first reading only learns what exists; after that, a post that was not there before is new until the page is closed.
      const keys = postKeys(result.model);
      if (this.seen === null) this.seen = new Set(keys);
      else for (const key of keys) if (!this.seen.has(key)) { this.seen.add(key); this.fresh.add(key); }
      this.model = result.model;
      this.repository = result.repository;
      this.version = typeof result.version === 'string' ? result.version : null;
      this.facts = result.facts ?? null;
      this.panel.title = `${this.kind === 'issue' ? 'Issue' : 'PR'} #${this.number}`;
      this.post(planned.note);
    }
    this.schedule();
  }

  private post(note: string): void {
    if (!this.model) return;
    const trusted = actions !== null && actions.trusted();
    // Which decisions are on, from the checks of this reading; what the page is told is also what a click is held to.
    this.abilities = abilitiesFor({ kind: this.kind, writer: writes !== null, trusted, version: this.version !== null, facts: this.facts });
    void this.panel.webview.postMessage({
      type: 'page', model: this.model, readAt: new Date().toISOString(), note, fresh: [...this.fresh], abilities: this.abilities,
      write: trusted ? { ok: true } : { ok: false, reason: actions === null ? 'Writing is not available in this window.' : 'Trust this workspace to comment or ask an agent; until then this page only reads.' }
    });
  }

  private schedule(): void {
    if (this.disposed || !this.panel.visible) return;
    this.timer = setTimeout(() => { this.timer = undefined; if (this.panel.visible) void this.load(); }, this.delayMs);
  }

  stop(): void { if (this.timer) { clearTimeout(this.timer); this.timer = undefined; } }

  async handle(raw: unknown): Promise<{ ok: boolean; reason?: string; code?: string }> {
    const model = this.model;
    const known: Known = {
      links: model ? model.links.length : 0, files: model?.pr ? model.pr.files.length : 0,
      inline: new Set(model?.pr ? model.pr.inline.map((entry) => entry.id) : []), posts: new Set(model ? postKeys(model) : []), kind: this.kind
    };
    const parsed = parsePageMessage(raw, known);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    const message = parsed.message;
    const target = { kind: this.kind, number: this.number };
    switch (message.type) {
      case 'ready':
      case 'refresh':
        await this.load();
        return { ok: true };
      case 'openText':
        await this.source.openText(this.kind, this.number);
        return { ok: true };
      case 'openOnGitHub': {
        if (!this.repository) return { ok: false, reason: 'not-read' };
        await vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${this.repository}/${this.kind === 'issue' ? 'issues' : 'pull'}/${this.number}`));
        return { ok: true };
      }
      case 'openLink': {
        // Checked again here: the page names an index, the address is this page's own and must still be one the page may open.
        const url = model && this.repository ? safeHref(model.links[message.link as number], `https://github.com/${this.repository}/`) : null;
        if (!url) return { ok: false, reason: 'unsafe-link' };
        await vscode.env.openExternal(vscode.Uri.parse(url, true));
        return { ok: true };
      }
      case 'openFile': {
        const file = model?.pr?.files[message.file as number];
        if (!file) return { ok: false, reason: 'unknown-file' };
        await this.source.openFileDiff(this.kind, this.number, file.filename);
        return { ok: true };
      }
      case 'openInline': {
        const entry = model?.pr?.inline.find((comment) => comment.id === message.id);
        const file = entry && entry.file !== null ? model?.pr?.files[entry.file] : undefined;
        if (!entry || !file) return { ok: false, reason: 'unknown-comment' };
        await this.source.openFileDiff(this.kind, this.number, file.filename, entry.line ?? undefined);
        return { ok: true };
      }
      case 'preview': {
        // The preview is drawn from the same tree as every post, so it shows exactly what the text will look like here.
        const base = this.repository ? `https://github.com/${this.repository}/${this.kind === 'issue' ? 'issues' : 'pull'}/${this.number}` : undefined;
        void this.panel.webview.postMessage({ type: 'preview', body: parseMarkdown(message.text, { base, links: [] }) });
        return { ok: true };
      }
      case 'comment': {
        if (!actions || !actions.trusted()) return { ok: false, reason: 'untrusted' };
        if ((message.text as string).trim() === '') return { ok: false, reason: 'empty' };
        const done = await actions.comment(target, message.text as string, message.tellPm === true, () => { void this.panel.webview.postMessage({ type: 'posted' }); void this.load(); });
        return { ok: done.ok, code: done.code };
      }
      case 'ask': {
        if (!actions || !actions.trusted()) return { ok: false, reason: 'untrusted' };
        const done = await actions.ask(target, { post: message.post as PostKind, id: message.id as number }, message.who as 'pm' | 'agent');
        return { ok: done.ok, code: done.code };
      }
      case 'review':
      case 'merge':
      case 'deleteBranch':
      case 'close': {
        const action: PageAction = message.type === 'review' ? (message.decision === 'approve' ? 'approve' : 'requestChanges')
          : message.type === 'close' ? (message.reason === 'completed' ? 'closeCompleted' : 'closeNotPlanned') : message.type;
        if (!writes || !actions || !actions.trusted()) return { ok: false, reason: 'untrusted' };
        // A button the page showed off is refused here too, whatever the page sent; then the function checks everything again.
        if (this.abilities[action]?.ok !== true) return { ok: false, reason: 'not-allowed', code: this.abilities[action]?.code ?? 'unknown' };
        if (!this.repository || !this.version) return { ok: false, reason: 'not-read' };
        const done = await writes.run({ repository: this.repository, kind: this.kind, number: this.number, version: this.version }, action, message.type === 'review' ? (message.text as string) : '');
        // A review that was sent empties the comment box it was written in, as a comment does.
        if (done.ok && message.type === 'review') void this.panel.webview.postMessage({ type: 'posted' });
        // Read again whatever happened: the page shows the new state (merged, closed, the new review) or what stopped it.
        await this.load();
        return { ok: done.ok, ...(done.code !== undefined ? { code: done.code } : {}) };
      }
      default:
        return { ok: false, reason: 'unknown-command' };
    }
  }
}

const pages = new Map<string, GitHubPage>();
const keyOf = (kind: Kind, number: number): string => `${kind}:${number}`;

/**
 * After something that changes what the pages may do (a publisher or merge authority set, a decision made from the text report), each
 * open page is read again: a visible one now, a hidden one as soon as it is shown, so no button keeps a reason that no longer holds.
 */
export function readOpenPagesAgain(): void {
  for (const page of pages.values()) {
    if (page.panel.visible) void page.load();
    else page.stop();
  }
}

// A pull request page was opened (#357): the Workbench's first steps count it as reviewing one with the PM.
const openedPullRequest = new vscode.EventEmitter<number>();
export const onDidOpenPullRequestPage = openedPullRequest.event;

/** Opens the page of one Issue or pull request, or brings its open tab to the front and reads it again. */
export async function openGitHubPage(source: PageSource, value: unknown): Promise<{ ok: boolean; code?: string }> {
  const input = value && typeof value === 'object' ? (value as { kind?: unknown; number?: unknown }) : {};
  const kind = input.kind === 'issue' || input.kind === 'pullRequest' ? input.kind : null;
  const number = typeof input.number === 'number' && Number.isSafeInteger(input.number) && input.number > 0 ? input.number : null;
  if (!kind || number === null) return { ok: false, code: 'invalid-report' };
  const key = keyOf(kind, number);
  if (kind === 'pullRequest') openedPullRequest.fire(number);
  const open = pages.get(key);
  if (open) {
    open.panel.reveal(vscode.ViewColumn.Active);
    await open.load();
    return { ok: true };
  }
  // The comment being written is kept while the tab is in the background.
  const panel = vscode.window.createWebviewPanel(GITHUB_PAGE_VIEW_TYPE, `${kind === 'issue' ? 'Issue' : 'PR'} #${number}`, vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true, enableFindWidget: true });
  const page = new GitHubPage(panel, kind, number, source, () => pages.delete(key));
  pages.set(key, page);
  // The page asks for its data with "ready" once its script runs; reading now as well shows it sooner.
  await page.load();
  return { ok: true };
}

/** For the extension's own tests: what the open page of an item shows, which posts are new, and the page's message handler. */
export function githubPageForTests(kind: Kind, number: number): { model: PageModel | null; abilities: Record<string, Ability>; newPosts: string[]; nextReadMs: number; send(raw: unknown): Promise<{ ok: boolean; reason?: string; code?: string }>; reload(): Promise<void>; stop(): void } | null {
  if (!isExtensionTestMode()) throw new Error('This is only exposed in Extension Host tests.');
  const page = pages.get(keyOf(kind, number));
  return page ? { get model() { return page.shown; }, get abilities() { return page.shownAbilities; }, get newPosts() { return page.newPosts; }, get nextReadMs() { return page.nextReadMs; }, send: (raw) => page.handle(raw), reload: () => page.load(), stop: () => page.stop() } : null;
}
