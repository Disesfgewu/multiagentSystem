import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { isExtensionTestMode } from '../shared/testMode';

const { renderPage, parsePageMessage } = require('./github-page') as {
  renderPage(input: { nonce: string }): string;
  parsePageMessage(raw: unknown, known: { links: number; files: number; inline: Set<number> }): { ok: true; message: { type: string; link?: number; file?: number; id?: number } } | { ok: false; reason: string };
};
const { safeHref } = require('./markdown') as { safeHref(raw: unknown, base: unknown): string | null };

type Kind = 'issue' | 'pullRequest';
type PageModel = {
  kind: Kind; number: number; links: string[];
  pr: { files: Array<{ filename: string }>; inline: Array<{ id: number; file: number | null; line: number | null }> } | null;
};
export type PageSource = {
  read(kind: Kind, number: number): Promise<{ ok: true; model: PageModel; repository: string } | { ok: false; text: string }>;
  openFileDiff(kind: Kind, number: number, filename: string, line?: number): Thenable<unknown>;
  openText(kind: Kind, number: number): Thenable<unknown>;
};

export const GITHUB_PAGE_VIEW_TYPE = 'multiagentSystem.githubPage';

/**
 * One editor tab per Issue or pull request (#353), showing it as GitHub does: Markdown rendered, each post with the extension's own
 * badge for who wrote it, and for a pull request its head, CI, changed files and line comments. It only reads in this version. The
 * page can ask for exactly the messages `parsePageMessage` accepts, each naming a link, a file or a line comment by a number the
 * extension gave it; the address of a link is looked up here and checked again before the browser opens it.
 */
class GitHubPage {
  private model: PageModel | null = null;
  private repository: string | null = null;
  private readonly disposables: vscode.Disposable[] = [];
  private reading = 0;

  constructor(readonly panel: vscode.WebviewPanel, readonly kind: Kind, readonly number: number, private readonly source: PageSource, onDispose: () => void) {
    panel.webview.html = renderPage({ nonce: randomBytes(16).toString('base64url') });
    this.disposables.push(
      panel.webview.onDidReceiveMessage((raw: unknown) => { void this.handle(raw); }),
      panel.onDidDispose(() => { onDispose(); for (const item of this.disposables) item.dispose(); })
    );
  }

  /** What this page was last given (for tests: the page model, never the HTML). */
  get shown(): PageModel | null { return this.model; }

  async load(): Promise<void> {
    const generation = ++this.reading;
    let result: Awaited<ReturnType<PageSource['read']>>;
    try { result = await this.source.read(this.kind, this.number); } catch { result = { ok: false, text: 'It could not be read from GitHub. Try again.' }; }
    // A later read wins: an answer that arrives after a newer one started is dropped.
    if (generation !== this.reading) return;
    if (!result.ok) {
      this.model = null;
      void this.panel.webview.postMessage({ type: 'page', error: result.text });
      return;
    }
    this.model = result.model;
    this.repository = result.repository;
    this.panel.title = `${this.kind === 'issue' ? 'Issue' : 'PR'} #${this.number}`;
    void this.panel.webview.postMessage({ type: 'page', model: result.model, readAt: new Date().toISOString() });
  }

  async handle(raw: unknown): Promise<{ ok: boolean; reason?: string }> {
    const model = this.model;
    const known = { links: model ? model.links.length : 0, files: model?.pr ? model.pr.files.length : 0, inline: new Set(model?.pr ? model.pr.inline.map((entry) => entry.id) : []) };
    const parsed = parsePageMessage(raw, known);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    const message = parsed.message;
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
      default:
        return { ok: false, reason: 'unknown-command' };
    }
  }
}

const pages = new Map<string, GitHubPage>();
const keyOf = (kind: Kind, number: number): string => `${kind}:${number}`;

/** Opens the page of one Issue or pull request, or brings its open tab to the front and reads it again. */
export async function openGitHubPage(source: PageSource, value: unknown): Promise<{ ok: boolean; code?: string }> {
  const input = value && typeof value === 'object' ? (value as { kind?: unknown; number?: unknown }) : {};
  const kind = input.kind === 'issue' || input.kind === 'pullRequest' ? input.kind : null;
  const number = typeof input.number === 'number' && Number.isSafeInteger(input.number) && input.number > 0 ? input.number : null;
  if (!kind || number === null) return { ok: false, code: 'invalid-report' };
  const key = keyOf(kind, number);
  const open = pages.get(key);
  if (open) {
    open.panel.reveal(vscode.ViewColumn.Active);
    await open.load();
    return { ok: true };
  }
  const panel = vscode.window.createWebviewPanel(GITHUB_PAGE_VIEW_TYPE, `${kind === 'issue' ? 'Issue' : 'PR'} #${number}`, vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: false, enableFindWidget: true });
  const page = new GitHubPage(panel, kind, number, source, () => pages.delete(key));
  pages.set(key, page);
  // The page asks for its data with "ready" once its script runs; reading now as well shows it sooner.
  await page.load();
  return { ok: true };
}

/** For the extension's own tests: what the open page of an item shows, and the page's message handler. */
export function githubPageForTests(kind: Kind, number: number): { model: PageModel | null; send(raw: unknown): Promise<{ ok: boolean; reason?: string }> } | null {
  if (!isExtensionTestMode()) throw new Error('This is only exposed in Extension Host tests.');
  const page = pages.get(keyOf(kind, number));
  return page ? { model: page.shown, send: (raw) => page.handle(raw) } : null;
}
