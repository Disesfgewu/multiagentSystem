// Command logic for reading GitHub from the extension. It deliberately does not import
// `vscode`: the editor prompts are injected through `GitHubUi`, and the read-only adapter in
// packages/github-read-adapter is injected through `adapter`. Everything shown here is local
// UI only; nothing is logged, stored or published, and nothing here can write to GitHub.
//
// The rule that shapes every branch below: a failed or partial read is never shown as an
// empty list, and a state that was not read is shown as unknown, never guessed.

export interface RepositoryRef {
  readonly owner: string;
  readonly name: string;
}

export type ReadKind =
  | 'ok' | 'empty' | 'partial' | 'truncated'
  | 'not_found' | 'denied' | 'rate_limited' | 'transient' | 'offline' | 'cancelled' | 'invalid';

export interface ReadResult<T> {
  kind: ReadKind;
  data?: T;
  partialData?: T;
  lastKnown?: { data: T; fetchedAt: string };
  reason?: string;
  possiblyHidden?: boolean;
  resetAt?: string;
  retryAfterMs?: number;
  pagesFetched?: number;
  pageLimit?: number;
}

export interface IssueSummary {
  number: number;
  title: string;
  state: string;
  author: string | null;
  labels: string[];
  assignees: string[];
}

export interface PullRequestSummary {
  number: number;
  title: string;
  state: string;
  merged: boolean;
  draft: boolean;
  author: string | null;
  headSha: string;
  baseRef: string;
}

export interface PullRequestSnapshot {
  status: 'complete' | 'partial' | 'unavailable' | 'cancelled';
  consistent: boolean;
  headSha: string | null;
  readAt: string;
  pullRequest: ReadResult<PullRequestSummary>;
  approval?: { status: string; reason?: string };
  checksSummary?: { state: string; requiredState: string; reason?: string };
  unresolvedThreads?: number | null;
}

export interface ReadOptions {
  signal?: AbortSignal;
}

export interface GitHubReader {
  readonly repository: RepositoryRef;
  readonly links: {
    issue(number: number): string;
    pullRequest(number: number): string;
    pullRequestChecks(number: number): string;
    pullRequestFiles(number: number): string;
  };
  listIssues(filter: { state: 'open' }, options?: ReadOptions): Promise<ReadResult<IssueSummary[]>>;
  listPullRequests(filter: { state: 'open' }, options?: ReadOptions): Promise<ReadResult<PullRequestSummary[]>>;
  getPullRequestSnapshot(number: number, options?: ReadOptions): Promise<PullRequestSnapshot>;
}

export interface GitHubAdapter {
  useRepository(repo: RepositoryRef): GitHubReader;
}

// ---- UI and dependencies ----------------------------------------------------

export type Category = 'issues' | 'pullRequests';
export type PullRequestPage = 'pullRequest' | 'checks' | 'files' | 'status';
export type SignInOutcome = 'signed-in' | 'cancelled' | 'unavailable';

export interface PickItem<T> {
  label: string;
  description?: string;
  detail?: string;
  value: T;
}

export interface GitHubUi {
  isTrusted(): boolean;
  workspaceFolders(): string[];
  pickProjectFolder(folders: string[]): Promise<string | undefined>;
  askRepository(validate: (value: string) => string | undefined): Promise<string | undefined>;
  askNumber(prompt: string, validate: (value: string) => string | undefined): Promise<string | undefined>;
  pickCategory(items: PickItem<Category>[]): Promise<PickItem<Category> | undefined>;
  pickItem<T>(items: PickItem<T>[], placeholder: string): Promise<PickItem<T> | undefined>;
  /** Runs `task` with a cancellable progress notice; cancelling aborts the signal. */
  withProgress<T>(title: string, task: (signal: AbortSignal) => Promise<T>): Promise<T>;
  showSummary(title: string, lines: string[]): void;
  openExternal(url: string): Promise<boolean>;
  signIn(): Promise<SignInOutcome>;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface GitHubDeps {
  ui: GitHubUi;
  /** Created on first use, so activating the extension does no work. */
  adapter(): GitHubAdapter;
  /** `github.com/owner/name` for the folder's `origin`, or null when it is not a GitHub remote. */
  resolveOriginRepository(folder: string): Promise<string | null>;
}

/**
 * Options double as the programmatic form of each command. With `interactive: false` no prompt
 * is ever shown and a page is opened only when `open: true`, which is what the Extension Host
 * smoke test uses. Nothing in here can select the transport or the credential.
 */
export interface GitHubCommandOptions {
  interactive?: boolean;
  repository?: string;
  kind?: Category;
  number?: number;
  open?: boolean;
}

export interface Failure { ok: false; code: string; message: string }
export interface Cancelled { ok: false; code: 'cancelled'; message: string }

export interface BrowseItem {
  number: number;
  title: string;
  state: string;
  url: string;
  detail: string;
}

export type ListStatus = 'ok' | 'empty' | 'partial' | 'truncated' | 'stale';

export type BrowseResult =
  | { ok: true; repository: string; kind: Category; status: ListStatus; note: string | null; items: BrowseItem[]; opened: string | null }
  | Failure
  | Cancelled;
export type OpenResult = { ok: true; url: string; opened: boolean } | Failure | Cancelled;
export type StatusResult = { ok: true; repository: string; number: number; lines: string[] } | Failure | Cancelled;
export type SignInResult = { ok: true } | Failure | Cancelled;

// ---- text safety ------------------------------------------------------------

// Titles, labels and logins come from GitHub and are untrusted. They are shown as plain
// text on one line, with control and direction-changing characters replaced, so a crafted
// title cannot reorder or hide what is shown around it.
function isUnsafeCodePoint(code: number): boolean {
  return code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2064) || (code >= 0x2066 && code <= 0x2069) ||
    code === 0x061c || code === 0xfeff;
}

export function displayText(value: unknown, max = 100): string {
  if (typeof value !== 'string') return '';
  let out = '';
  for (const char of value) out += isUnsafeCodePoint(char.codePointAt(0) ?? 0) ? ' ' : char;
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > max ? `${out.slice(0, max - 3)}...` : out;
}

const shortSha = (sha: unknown): string => (typeof sha === 'string' && /^[0-9a-f]{7,64}$/.test(sha) ? sha.slice(0, 7) : 'unknown');

// ---- repository and number input --------------------------------------------

const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** `owner/name`, `github.com/owner/name` or an https GitHub URL. Returns null for anything else. */
export function parseRepository(text: unknown): RepositoryRef | null {
  if (typeof text !== 'string') return null;
  const cleaned = text.trim().replace(/^(?:https:\/\/)?(?:www\.)?github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  const parts = cleaned.split('/');
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  for (const part of parts) if (!NAME.test(part) || part === '.' || part === '..') return null;
  return { owner, name };
}

export function validateRepositoryInput(value: string): string | undefined {
  return parseRepository(value) ? undefined : 'Enter the repository as owner/name.';
}

export function parseNumber(value: unknown): number | null {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim().replace(/^#/, '') : '';
  if (!/^[0-9]{1,9}$/.test(text)) return null;
  const number = Number(text);
  return number >= 1 ? number : null;
}

export function validateNumberInput(value: string): string | undefined {
  return parseNumber(value) === null ? 'Enter a positive number, for example 12.' : undefined;
}

/** Only https pages on github.com are ever handed to the browser. */
export function isGitHubWebUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  // Node's WHATWG URL parser treats a backslash as a slash, while VS Code's URI parser can
  // interpret the same text differently. Percent escapes have the same cross-parser risk. The
  // extension only opens links built from GitHub identifiers, so neither form is needed here.
  if (value.includes('\\') || value.includes('%')) return false;
  try {
    const url = new URL(value);
    return url.href === value && url.protocol === 'https:' && url.hostname === 'github.com' && url.port === '' && !url.username && !url.password;
  } catch {
    return false;
  }
}

// ---- results and messages ---------------------------------------------------

const failure = (code: string, message: string): Failure => ({ ok: false, code, message });
const cancelled = (): Cancelled => ({ ok: false, code: 'cancelled', message: 'Cancelled.' });

const DENIED_REASONS: Record<string, string> = {
  bad_credentials: 'the sign-in was rejected',
  sso_required: 'the organization requires single sign-on for this account',
  credential_unavailable: 'the GitHub sign-in could not be read from the editor',
  forbidden: 'the account lacks permission'
};

/** Maps a failed read to a code and a message. Remote text is never repeated. */
export function describeReadFailure(result: ReadResult<unknown>, what: string): { code: string; message: string } {
  switch (result.kind) {
    case 'not_found':
      return {
        code: 'not-found',
        message: `${what} was not found, or this account cannot see it. GitHub answers both cases the same way.`
      };
    case 'denied': {
      const reason = (result.reason && DENIED_REASONS[result.reason]) || 'access was refused';
      return { code: 'denied', message: `GitHub refused access to ${what}: ${reason}. Use "Multiagent: Sign In to GitHub" or check the account's permissions.` };
    }
    case 'rate_limited': {
      const when = result.resetAt ? ` Try again after ${result.resetAt}.` : '';
      return { code: 'rate-limited', message: `GitHub is rate limiting requests for ${what}.${when} Signing in raises the limit.` };
    }
    case 'transient':
      return { code: 'transient', message: `GitHub did not answer reliably for ${what}. Nothing was changed; try again later.` };
    case 'offline':
      return { code: 'offline', message: `Cannot reach GitHub to read ${what}. Check the connection and try again.` };
    case 'invalid':
      return { code: 'invalid-response', message: `GitHub's answer for ${what} could not be understood, so nothing is shown.` };
    case 'cancelled':
      return { code: 'cancelled', message: 'Cancelled.' };
    default:
      return { code: 'unavailable', message: `${what} could not be read.` };
  }
}

interface ListView<T> {
  items: T[];
  status: ListStatus;
  note: string | null;
}

/** Turns a list read into what may be shown, or null when it must be shown as a failure. */
function viewList<T>(result: ReadResult<T[]>, noun: string): ListView<T> | null {
  switch (result.kind) {
    case 'ok':
      return { items: result.data ?? [], status: 'ok', note: null };
    case 'empty':
      return { items: [], status: 'empty', note: `GitHub confirmed there are no open ${noun}.` };
    case 'truncated':
      return {
        items: result.partialData ?? [],
        status: 'truncated',
        note: `Only the first ${result.pagesFetched ?? 'few'} pages of ${noun} were read, so this list is incomplete.`
      };
    case 'partial':
      return {
        items: result.data ?? result.partialData ?? [],
        status: 'partial',
        note: `Some ${noun} could not be read, so this list is incomplete.`
      };
    case 'offline':
    case 'transient':
    case 'rate_limited':
      // Old data may be shown to orient the user, never as current: it is labelled stale
      // and carries the time it was read. Access failures never show old data.
      if (result.lastKnown) {
        return {
          items: result.lastKnown.data,
          status: 'stale',
          note: `Could not refresh (${result.kind.replace('_', ' ')}). Showing ${noun} last read at ${result.lastKnown.fetchedAt}; they may be out of date.`
        };
      }
      return null;
    default:
      return null;
  }
}

// ---- snapshot text ----------------------------------------------------------

const APPROVAL_REASONS: Record<string, string> = {
  approved_on_current_head: 'approved on the current head',
  insufficient_approvals: 'not enough approvals on the current head',
  approval_stale: 'the only approval is for an older head, so it no longer counts',
  self_approval_only: "only the author's own approval, which does not count",
  no_approval: 'no approval yet',
  changes_requested: 'changes were requested'
};

/** What a snapshot says, with anything that was not read shown as unknown. */
export function describeSnapshot(snapshot: PullRequestSnapshot): string[] {
  if (snapshot.status === 'unavailable' || snapshot.headSha === null) {
    const { message } = describeReadFailure(snapshot.pullRequest, 'the pull request');
    return [message, 'Review and CI status: unknown.'];
  }
  const lines = [`Head commit: ${shortSha(snapshot.headSha)} (read at ${snapshot.readAt}).`];
  lines.push(snapshot.consistent
    ? 'The head did not change while this was read.'
    : 'The head changed, or could not be confirmed, while this was read. Results for an older head are shown as unknown.');

  const approval = snapshot.approval;
  if (!approval || approval.status === 'unknown') {
    lines.push(`Review: unknown (${displayText(approval?.reason ?? 'not read', 60)}).`);
  } else if (approval.status === 'approved') {
    lines.push('Review: approved on the current head.');
  } else if (approval.status === 'changes_requested') {
    lines.push('Review: changes requested.');
  } else {
    lines.push(`Review: not approved (${APPROVAL_REASONS[approval.reason ?? ''] ?? 'no valid approval'}).`);
  }

  const checks = snapshot.checksSummary;
  if (!checks || checks.state === 'unknown') {
    lines.push(`CI checks: unknown (${displayText(checks?.reason ?? 'not read', 60)}).`);
  } else {
    lines.push(`CI checks: ${checks.state}; required checks: ${checks.requiredState}.`);
  }
  lines.push(`Unresolved review threads: ${typeof snapshot.unresolvedThreads === 'number' ? snapshot.unresolvedThreads : 'unknown'}.`);
  lines.push('This is evidence read from GitHub, not a decision to merge. Merging stays with a person.');
  return lines;
}

// ---- controller -------------------------------------------------------------

export class GitHubController {
  constructor(private readonly deps: GitHubDeps) {}

  /** Lists open issues or pull requests, and opens the page that is picked. */
  async browse(options: GitHubCommandOptions = {}): Promise<BrowseResult> {
    const interactive = options.interactive !== false;
    const chosen = await this.chooseRepository(options, interactive);
    if (!chosen.ok) return chosen;
    const { repository } = chosen;

    let kind = options.kind;
    if (kind !== undefined && kind !== 'issues' && kind !== 'pullRequests') {
      return failure('kind-invalid', 'Choose issues or pull requests.');
    }
    if (kind === undefined) {
      if (!interactive) return failure('kind-required', 'Say whether to list issues or pull requests.');
      const picked = await this.deps.ui.pickCategory([
        { label: 'Issues', value: 'issues' },
        { label: 'Pull requests', value: 'pullRequests' }
      ]);
      if (!picked) return cancelled();
      kind = picked.value;
    }

    const reader = this.deps.adapter().useRepository(repository);
    const label = `${repository.owner}/${repository.name}`;
    const noun = kind === 'issues' ? 'issues' : 'pull requests';
    const title = `Reading open ${noun} of ${label}`;

    const outcome = kind === 'issues'
      ? await this.read(interactive, title, (signal) => reader.listIssues({ state: 'open' }, { signal }))
      : await this.read(interactive, title, (signal) => reader.listPullRequests({ state: 'open' }, { signal }));
    if (outcome.kind === 'cancelled') return cancelled();

    const view = viewList<IssueSummary | PullRequestSummary>(outcome, noun);
    if (!view) {
      const described = describeReadFailure(outcome, `the open ${noun} of ${label}`);
      if (interactive) this.deps.ui.error(described.message);
      return failure(described.code, described.message);
    }

    const items = view.items.map((item) => this.toBrowseItem(kind as Category, reader, item));
    const result: BrowseResult = { ok: true, repository: label, kind, status: view.status, note: view.note, items, opened: null };
    if (!interactive) return result;

    if (items.length === 0) {
      this.deps.ui.info(view.note ?? `No open ${noun} to show.`);
      return result;
    }
    if (view.note) this.deps.ui.warn(view.note);

    const picked = await this.deps.ui.pickItem(
      items.map((item) => ({ label: `#${item.number} ${item.title}`, description: item.state, detail: item.detail, value: item })),
      view.status === 'ok' ? `Open ${noun} of ${label}` : `Open ${noun} of ${label} (${view.status})`
    );
    if (!picked) return result;

    if (kind === 'issues') {
      const opened = await this.openUrl(reader.links.issue(picked.value.number), true);
      if (!opened.ok) return opened;
      return { ...result, opened: opened.url };
    }
    const page = await this.pickPullRequestPage();
    if (!page) return result;
    if (page === 'status') {
      const status = await this.pullRequestStatus({ interactive: true, repository: label, number: picked.value.number });
      if (!status.ok && status.code !== 'cancelled') return status;
      return result;
    }
    const opened = await this.openUrl(this.pageUrl(reader, page, picked.value.number), true);
    return opened.ok ? { ...result, opened: opened.url } : opened;
  }

  /** Opens an issue, a pull request or its checks page. No read is needed: the address is built locally. */
  async openPage(kind: 'issue' | 'pullRequest' | 'checks', options: GitHubCommandOptions = {}): Promise<OpenResult> {
    const interactive = options.interactive !== false;
    const chosen = await this.chooseRepository(options, interactive);
    if (!chosen.ok) return chosen;

    const number = await this.chooseNumber(kind === 'issue' ? 'Issue number' : 'Pull request number', options, interactive);
    if (typeof number !== 'number') return number;

    const reader = this.deps.adapter().useRepository(chosen.repository);
    const url = kind === 'issue' ? reader.links.issue(number)
      : kind === 'checks' ? reader.links.pullRequestChecks(number)
        : reader.links.pullRequest(number);
    return this.openUrl(url, interactive || options.open === true);
  }

  /** Reads the review and CI evidence of one pull request; whatever was not read is shown as unknown. */
  async pullRequestStatus(options: GitHubCommandOptions = {}): Promise<StatusResult> {
    const interactive = options.interactive !== false;
    const chosen = await this.chooseRepository(options, interactive);
    if (!chosen.ok) return chosen;
    const number = await this.chooseNumber('Pull request number', options, interactive);
    if (typeof number !== 'number') return number;

    const reader = this.deps.adapter().useRepository(chosen.repository);
    const label = `${chosen.repository.owner}/${chosen.repository.name}`;
    const snapshot = await this.read(interactive, `Reading review and CI status of ${label}#${number}`,
      (signal) => reader.getPullRequestSnapshot(number, { signal }));
    if (snapshot.status === 'cancelled') return cancelled();

    const lines = describeSnapshot(snapshot);
    if (interactive) this.deps.ui.showSummary(`${label}#${number}`, lines);
    return { ok: true, repository: label, number, lines };
  }

  /** Signing in is always an explicit action; reading works without it for public repositories. */
  async signIn(): Promise<SignInResult> {
    const outcome = await this.deps.ui.signIn();
    if (outcome === 'signed-in') {
      this.deps.ui.info('Signed in to GitHub in this editor. Reads use that account and stay read-only.');
      return { ok: true };
    }
    if (outcome === 'cancelled') return cancelled();
    const message = 'GitHub sign-in is not available in this editor.';
    this.deps.ui.error(message);
    return failure('sign-in-unavailable', message);
  }

  // ---- helpers ---------------------------------------------------------------

  private toBrowseItem(kind: Category, reader: GitHubReader, item: IssueSummary | PullRequestSummary): BrowseItem {
    const title = displayText(item.title, 100) || '(no title)';
    const author = displayText(item.author ?? 'unknown', 40);
    if (kind === 'issues') {
      const issue = item as IssueSummary;
      const labels = issue.labels.map((name) => displayText(name, 30)).filter(Boolean).join(', ');
      return {
        number: issue.number, title, state: displayText(issue.state, 20), url: reader.links.issue(issue.number),
        detail: `by ${author}${labels ? ` | labels: ${labels}` : ''}`
      };
    }
    const pull = item as PullRequestSummary;
    // The list does not carry review or CI state, so it is shown as not loaded rather than guessed.
    return {
      number: pull.number, title, state: pull.merged ? 'merged' : pull.draft ? 'draft' : displayText(pull.state, 20),
      url: reader.links.pullRequest(pull.number),
      detail: `by ${author} | head ${shortSha(pull.headSha)} -> ${displayText(pull.baseRef, 40)} | review and CI: not loaded`
    };
  }

  private pageUrl(reader: GitHubReader, page: PullRequestPage, number: number): string {
    if (page === 'checks') return reader.links.pullRequestChecks(number);
    if (page === 'files') return reader.links.pullRequestFiles(number);
    return reader.links.pullRequest(number);
  }

  private async pickPullRequestPage(): Promise<PullRequestPage | undefined> {
    const picked = await this.deps.ui.pickItem<PullRequestPage>([
      { label: 'Open pull request', value: 'pullRequest' },
      { label: 'Open checks', value: 'checks' },
      { label: 'Open changed files', value: 'files' },
      { label: 'Read review and CI status here', description: 'reads reviews and checks; unread parts show as unknown', value: 'status' }
    ], 'What do you want to do with this pull request?');
    return picked?.value;
  }

  /** Runs a read with progress and cancel in interactive use, and plainly otherwise. */
  private async read<T>(interactive: boolean, title: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (interactive) return this.deps.ui.withProgress(title, task);
    return task(new AbortController().signal);
  }

  private async openUrl(url: string, open: boolean): Promise<{ ok: true; url: string; opened: boolean } | Failure> {
    if (!isGitHubWebUrl(url)) return failure('unsafe-url', 'Only https pages on github.com are opened.');
    if (!open) return { ok: true, url, opened: false };
    const opened = await this.deps.ui.openExternal(url);
    return opened ? { ok: true, url, opened: true } : failure('open-failed', 'The browser could not be opened.');
  }

  private async chooseNumber(prompt: string, options: GitHubCommandOptions, interactive: boolean): Promise<number | Failure | Cancelled> {
    if (options.number !== undefined) {
      // A programmatic number must really be a number; text is only accepted from the prompt.
      const number = typeof options.number === 'number' ? parseNumber(options.number) : null;
      return number === null ? failure('number-invalid', 'The number must be a positive integer.') : number;
    }
    if (!interactive) return failure('number-required', 'A number is required.');
    const typed = await this.deps.ui.askNumber(prompt, validateNumberInput);
    if (typed === undefined) return cancelled();
    const number = parseNumber(typed);
    return number === null ? failure('number-invalid', 'The number must be a positive integer.') : number;
  }

  /**
   * The repository comes from the option, else from the workspace folder's GitHub `origin`
   * (read only in a trusted workspace), else from what the user types.
   */
  private async chooseRepository(
    options: GitHubCommandOptions,
    interactive: boolean
  ): Promise<{ ok: true; repository: RepositoryRef } | Failure | Cancelled> {
    if (options.repository !== undefined) {
      const repository = parseRepository(options.repository);
      return repository ? { ok: true, repository } : failure('repository-invalid', 'The repository must be written as owner/name.');
    }
    if (!interactive) return failure('repository-required', 'A repository (owner/name) is required.');

    const folders = this.deps.ui.isTrusted() ? this.deps.ui.workspaceFolders() : [];
    if (folders.length > 0) {
      const folder = folders.length === 1 ? folders[0] : await this.deps.ui.pickProjectFolder(folders);
      if (folder === undefined) return cancelled();
      let origin: string | null = null;
      try {
        origin = await this.deps.resolveOriginRepository(folder);
      } catch {
        origin = null;
      }
      const fromOrigin = origin === null ? null : parseRepository(origin);
      if (fromOrigin) return { ok: true, repository: fromOrigin };
    }

    const typed = await this.deps.ui.askRepository(validateRepositoryInput);
    if (typed === undefined) return cancelled();
    const repository = parseRepository(typed);
    return repository ? { ok: true, repository } : failure('repository-invalid', 'The repository must be written as owner/name.');
  }
}
