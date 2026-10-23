import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { SessionCommands } from '../sessions/sessionCommands';
import { isExtensionTestMode } from '../shared/testMode';
import { confirmAndType, openStore } from '../dispatch/commands';
import { currentReportDeps, REPORT_SCHEME } from '../reports/reportsView';
import { sendPublicFeedback } from '../reports/publicFeedback';
import { privateStorage } from '../storage/storageCommands';

const { buildNotifyPrompt, renderConversation, newComments, nextPoll, POLL_MS } = require('./conversation') as {
  buildNotifyPrompt(input: unknown): { ok: true; prompt: string } | { ok: false; reason: string };
  renderConversation(input: unknown): string;
  newComments(seen: Set<number> | null, comments: unknown, ownerPosts: unknown): { ok: boolean; fresh: Array<{ id: number; author: { who: string; text: string } }>; seen: Set<number> | null };
  nextPoll(input: unknown): { delayMs: number; note: string };
  POLL_MS: number;
};
const { OwnerPostStore } = require('../reports/ownerPosts') as { OwnerPostStore: new (store: unknown) => { read(repository: string): { ok: true; comments: Map<number, string | null>; reviews: Map<number, string | null> } | { ok: false; reason: string } } };

/**
 * "Talk to PM via GitHub" (issue #343): a conversation on one Issue or pull request, read from GitHub and shown as a read-only document;
 * "Send Message" posts the owner's comment the way the report page does (privacy check, confirmation, the owner record of #342), reads
 * it back from GitHub, and only then offers to type ONE line into the PM agent's terminal (`confirmAndType`, with its own
 * confirmation). The line is built from numbers alone. While the document is open and visible the comments are read again every
 * 30 to 60 seconds, with a notification for each new one; GitHub text never types anything anywhere.
 */

export const TALK_SCHEME = 'multiagent-talk';
export const TALK_COMMANDS = { open: 'multiagentSystem.talk.open', send: 'multiagentSystem.talk.send', refresh: 'multiagentSystem.talk.refresh' } as const;

type Kind = 'issue' | 'pullRequest';
type Target = { kind: Kind; number: number };
type Comments = { kind: string; data?: unknown; resetAt?: string; retryAfterMs?: number };
interface Conversation {
  target: Target;
  repository: string | null;
  title: string | null;
  comments: Comments | null;
  status: string;
  seen: Set<number> | null;
  timer: NodeJS.Timeout | undefined;
  delayMs: number;
  reading: boolean;
  /** The reading in progress: a second request waits for it instead of starting another. */
  pending: Promise<void> | undefined;
  owner: { comments: Map<number, string | null>; reviews: Map<number, string | null> } | null;
}

/** What the commands use from the outside world; tests replace parts of it. */
export interface TalkDeps {
  trusted(): boolean;
  send: typeof sendPublicFeedback;
  ownerPosts(repository: string): Promise<{ comments: Map<number, string | null>; reviews: Map<number, string | null> } | null>;
  setTimer(run: () => void, ms: number): NodeJS.Timeout;
  clearTimer(timer: NodeJS.Timeout): void;
  notify(message: string): void;
}
const realDeps: TalkDeps = {
  trusted: () => vscode.workspace.isTrusted,
  send: sendPublicFeedback,
  async ownerPosts(repository) {
    try {
      const opened = await privateStorage()?.use();
      if (!opened?.ok) return null;
      const read = new OwnerPostStore(opened.store).read(repository);
      return read.ok ? { comments: read.comments, reviews: read.reviews } : null;
    } catch { return null; }
  },
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (timer) => clearTimeout(timer),
  notify: (message) => { void vscode.window.showInformationMessage(message); }
};
let deps: TalkDeps = realDeps;

export function talkUri(target: Target): vscode.Uri {
  return vscode.Uri.from({ scheme: TALK_SCHEME, path: `/${target.kind === 'issue' ? 'issue' : 'pull-request'}-${target.number}.txt`, query: `kind=${target.kind}&n=${target.number}` });
}
function targetOf(uri: vscode.Uri): Target | null {
  const params = new URLSearchParams(uri.query);
  const kind = params.get('kind');
  const number = Number(params.get('n'));
  return (kind === 'issue' || kind === 'pullRequest') && Number.isSafeInteger(number) && number > 0 ? { kind, number } : null;
}
const where = (target: Target): string => `${target.kind === 'issue' ? 'Issue' : 'PR'} #${target.number}`;

class TalkContent implements vscode.TextDocumentContentProvider {
  readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  readonly conversations = new Map<string, Conversation>();

  provideTextDocumentContent(uri: vscode.Uri): string {
    const target = targetOf(uri);
    if (!target) return 'This conversation link is not valid.\n';
    const state = this.conversation(uri, target);
    if (state.comments === null && !state.reading) void this.read(uri);
    // Authors follow #342's rules, with the owner record of the last reading (null: it could not be read).
    return `${renderConversation({ repository: state.repository, kind: target.kind, number: target.number, title: state.title, comments: state.comments, ownerPosts: state.owner, status: state.status })}\n`;
  }

  conversation(uri: vscode.Uri, target: Target): Conversation {
    const key = uri.toString();
    let state = this.conversations.get(key);
    if (!state) {
      state = { target, repository: null, title: null, comments: null, status: 'reading…', seen: null, timer: undefined, delayMs: POLL_MS, reading: false, pending: undefined, owner: null };
      this.conversations.set(key, state);
    }
    return state;
  }

  /** Reads the conversation once, updates the screen, reports new comments, and plans the next reading while the document stays visible. */
  read(uri: vscode.Uri, options: { force?: boolean } = {}): Promise<void> {
    const target = targetOf(uri);
    if (!target) return Promise.resolve();
    const state = this.conversation(uri, target);
    if (state.pending) return state.pending;
    state.reading = true;
    state.pending = this.readOnce(uri, target, state, options).finally(() => { state.pending = undefined; });
    return state.pending;
  }

  private async readOnce(uri: vscode.Uri, target: Target, state: Conversation, options: { force?: boolean }): Promise<void> {
    if (state.timer) { deps.clearTimer(state.timer); state.timer = undefined; }
    try {
      const report = currentReportDeps();
      const repository = await report.repository();
      const reader = repository ? report.readerFor(repository) : null;
      if (!repository || !reader) {
        state.status = 'no GitHub project is open, so nothing can be read';
        state.comments = { kind: 'invalid' };
      } else {
        if (state.repository !== repository) { state.repository = repository; state.seen = null; }
        const [subject, comments] = await Promise.all([target.kind === 'issue' ? reader.getIssue(target.number) : reader.getPullRequest(target.number), reader.getIssueComments(target.number, { forceRefresh: options.force === true })]);
        if (subject.kind === 'ok' && subject.data && typeof subject.data.title === 'string') state.title = subject.data.title;
        const owner = await deps.ownerPosts(repository);
        state.owner = owner;
        state.comments = comments as Comments;
        const found = newComments(state.seen, comments, owner);
        if (found.ok) {
          state.seen = found.seen;
          // Your own new comments are not announced back to you.
          for (const entry of found.fresh) if (entry.author.who !== 'owner') deps.notify(`New comment on ${where(target)} by ${entry.author.text}.`);
        }
        const planned = nextPoll({ previousMs: state.delayMs, result: comments });
        state.delayMs = planned.delayMs;
        state.status = `${planned.note} · last read ${new Date().toISOString()}`;
      }
    } catch {
      state.status = 'could not read the conversation';
    } finally {
      state.reading = false;
    }
    this.changed.fire(uri);
    this.schedule(uri, state);
  }

  /** The next reading, only while the document is open; a hidden one waits and checks again later. */
  schedule(uri: vscode.Uri, state: Conversation): void {
    if (!this.isOpen(uri)) { this.stop(uri); return; }
    state.timer = deps.setTimer(() => {
      state.timer = undefined;
      if (!this.isOpen(uri)) { this.stop(uri); return; }
      if (this.isVisible(uri)) void this.read(uri); else this.schedule(uri, state);
    }, state.delayMs);
  }

  isOpen(uri: vscode.Uri): boolean { return vscode.workspace.textDocuments.some((document) => document.uri.toString() === uri.toString()); }
  isVisible(uri: vscode.Uri): boolean { return vscode.window.visibleTextEditors.some((editor) => editor.document.uri.toString() === uri.toString()); }

  /** Closing the screen stops the readings and forgets the conversation. */
  stop(uri: vscode.Uri): void {
    const state = this.conversations.get(uri.toString());
    if (state?.timer) deps.clearTimer(state.timer);
    this.conversations.delete(uri.toString());
  }
}

const content = new TalkContent();
/** Which Issue or PR to talk on: the report that is open, or one picked from the open Issues and PRs. */
async function chooseTarget(): Promise<Target | undefined> {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active && (active.scheme === REPORT_SCHEME || active.scheme === TALK_SCHEME)) {
    const target = targetOf(active);
    if (target) return target;
  }
  const report = currentReportDeps();
  const repository = await report.repository();
  const reader = repository ? report.readerFor(repository) : null;
  if (!reader) { void vscode.window.showErrorMessage('No GitHub project is open, so there is nothing to talk on.'); return undefined; }
  const [issues, pulls] = await Promise.all([reader.listIssues({ state: 'open' }), reader.listPullRequests({ state: 'open' })]);
  const items: Array<vscode.QuickPickItem & { target: Target }> = [];
  for (const item of (issues.kind === 'ok' && Array.isArray(issues.data) ? issues.data : []).filter((entry: any) => !entry.isPullRequest).slice(0, 100)) {
    if (Number.isSafeInteger(item.number)) items.push({ label: `Issue #${item.number}`, description: String(item.title ?? '').slice(0, 120), target: { kind: 'issue', number: item.number } });
  }
  for (const item of (pulls.kind === 'ok' && Array.isArray(pulls.data) ? pulls.data : []).slice(0, 100)) {
    if (Number.isSafeInteger(item.number)) items.push({ label: `PR #${item.number}`, description: String(item.title ?? '').slice(0, 120), target: { kind: 'pullRequest', number: item.number } });
  }
  if (items.length === 0) { void vscode.window.showInformationMessage('No open Issue or pull request could be read to talk on.'); return undefined; }
  return (await vscode.window.showQuickPick(items, { placeHolder: 'Talk to the PM on which Issue or pull request?', matchOnDescription: true }))?.target;
}

async function openConversation(): Promise<void> {
  if (!deps.trusted()) { void vscode.window.showWarningMessage('Trust this workspace before talking to the PM through GitHub.'); return; }
  const target = await chooseTarget();
  if (!target) return;
  const document = await vscode.workspace.openTextDocument(talkUri(target));
  await vscode.window.showTextDocument(document, { preview: false });
}

/** What the comment's version is now (the report's evidence version): the same check the report page's publishing makes. */
async function currentVersion(repository: string, target: Target): Promise<string | null> {
  const reader = currentReportDeps().readerFor(repository);
  if (!reader) return null;
  if (target.kind === 'issue') {
    const issue = await reader.getIssue(target.number);
    return issue.kind === 'ok' && issue.data ? createHash('sha256').update(`${issue.data.title}\0${issue.data.body ?? ''}`).digest('hex') : null;
  }
  const pull = await reader.getPullRequest(target.number, { forceRefresh: true });
  return pull.kind === 'ok' && pull.data && typeof pull.data.headSha === 'string' ? pull.data.headSha : null;
}

/**
 * Send Message. The order is what makes it safe: post (privacy check and confirmation inside), read the comment back from GitHub,
 * and only when it is there with exactly the text that was sent, offer to tell the PM agent. A comment that was not posted, or cannot
 * be found, tells nobody anything.
 */
async function sendMessage(sessions: SessionCommands, uri: vscode.Uri | undefined): Promise<{ ok: boolean; code?: string }> {
  if (!deps.trusted()) { void vscode.window.showWarningMessage('Trust this workspace before talking to the PM through GitHub.'); return { ok: false, code: 'untrusted' }; }
  const target = uri && uri.scheme === TALK_SCHEME ? targetOf(uri) : null;
  if (!uri || !target) { void vscode.window.showInformationMessage('Open a conversation first (Talk to PM via GitHub).'); return { ok: false, code: 'no-conversation' }; }
  const report = currentReportDeps();
  const repository = await report.repository();
  if (!repository) { void vscode.window.showErrorMessage('No GitHub project is open.'); return { ok: false, code: 'no-repository' }; }
  const version = await currentVersion(repository, target);
  if (!version) { void vscode.window.showErrorMessage(`${where(target)} could not be read, so nothing was sent.`); return { ok: false, code: 'target-unreadable' }; }
  const sent = await deps.send({ repository, kind: target.kind, number: target.number, version }, { interactive: true, conversation: true });
  if (!sent.ok) {
    if (sent.code !== 'cancelled') void vscode.window.showErrorMessage(`The message was not sent (${sent.code ?? 'unknown'}). The PM was not told.`);
    return { ok: false, code: sent.code };
  }
  if (sent.commentId === undefined || typeof sent.body !== 'string') {
    void vscode.window.showInformationMessage('This exact message was already sent before; the PM was not told again.');
    return { ok: true, code: 'already-sent' };
  }
  // Read back from GitHub, past any cache: the PM is told only about a comment that is really there, with exactly the sent text.
  const reader = report.readerFor(repository);
  const back = reader ? await reader.getIssueComments(target.number, { forceRefresh: true }) : null;
  const items = back && (back.kind === 'ok' || back.kind === 'empty') && Array.isArray(back.data) ? back.data : null;
  const there = items !== null && items.some((item: any) => item && item.id === sent.commentId && item.body === sent.body);
  void content.read(uri, { force: true });
  if (!there) {
    void vscode.window.showErrorMessage(`Your comment was posted but could not be read back from GitHub${back ? ` (${back.kind})` : ''}, so the PM agent was not told. Read the conversation again and tell the PM by hand if needed.`);
    return { ok: false, code: 'not-read-back' };
  }
  const notify = buildNotifyPrompt({ kind: target.kind, number: target.number, commentId: sent.commentId });
  if (!notify.ok) return { ok: false, code: notify.reason };
  const opened = await openStore();
  if (!opened) return { ok: false, code: 'storage-unavailable' };
  const roleOf = (session: { roleGroupId?: string }): string | undefined => {
    if (!session.roleGroupId || session.roleGroupId === 'unassigned') return undefined;
    try { const loaded = opened.get('roleGroups', session.roleGroupId); return loaded?.ok && loaded.found ? loaded.value?.group?.role : undefined; } catch { return undefined; }
  };
  const results = await confirmAndType({
    sessions, roleOf, task: { prompt: notify.prompt, kind: 'talk', issueNumber: null }, target: { scope: 'role', role: 'pm' },
    title: `Your comment is on ${where(target)}. Tell the PM agent to read it and reply there?`
  });
  return { ok: true, code: results && results.some((entry) => entry.outcome === 'sent') ? 'pm-told' : 'pm-not-told' };
}

/** Replaces parts of the outside world: only in the extension's own host tests. */
export function setTalkDepsForTests(next: Partial<TalkDeps> | undefined): void {
  if (!isExtensionTestMode()) throw new Error('This is only exposed in Extension Host tests.');
  deps = next ? { ...realDeps, ...next } : realDeps;
}
/** Send Message for a given conversation document: only in the extension's own host tests. */
export function sendForTests(sessions: SessionCommands, uri: vscode.Uri): Promise<{ ok: boolean; code?: string }> {
  if (!isExtensionTestMode()) throw new Error('This is only exposed in Extension Host tests.');
  return sendMessage(sessions, uri);
}
/** Reads a conversation now: only in the extension's own host tests. */
export function readForTests(uri: vscode.Uri): Promise<void> {
  if (!isExtensionTestMode()) throw new Error('This is only exposed in Extension Host tests.');
  return content.read(uri);
}

export function registerTalkCommands(context: vscode.ExtensionContext, sessions: SessionCommands): void {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(TALK_SCHEME, content),
    // No argument is read by any of these: which conversation, the text and every confirmation come from this window.
    vscode.commands.registerCommand(TALK_COMMANDS.open, () => openConversation()),
    vscode.commands.registerCommand(TALK_COMMANDS.send, () => sendMessage(sessions, vscode.window.activeTextEditor?.document.uri)),
    vscode.commands.registerCommand(TALK_COMMANDS.refresh, () => { const uri = vscode.window.activeTextEditor?.document.uri; if (uri?.scheme === TALK_SCHEME) void content.read(uri, { force: true }); }),
    vscode.workspace.onDidCloseTextDocument((document) => { if (document.uri.scheme === TALK_SCHEME) content.stop(document.uri); }),
    { dispose: () => { for (const key of [...content.conversations.keys()]) content.stop(vscode.Uri.parse(key)); } }
  );
}
