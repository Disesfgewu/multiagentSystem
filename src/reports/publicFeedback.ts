import * as vscode from 'vscode';
import { createHash, randomBytes } from 'node:crypto';
import { privateStorage } from '../storage/storageCommands';
import { githubReaderFor, GITHUB_AUTH_PROVIDER, GITHUB_SCOPES } from '../github/githubCommands';
import { WorktreeService } from '../projects/worktrees';
import { COLLECTIONS } from '../storage/extensionStorage';
const { Broker } = require('../broker/broker') as { Broker: new (deps: Record<string, unknown>) => { request(value: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }> } };

const REPOSITORY = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/;
const SHA = /^[a-f0-9]{40}$/i;
const POLICY_ID = 'public-feedback-publisher';
const MERGE_POLICY_ID = 'merge-authority-policy';
const COLLECTION = 'policies';
const MAX_PRIVATE_REFS = 5000;
const PUBLIC_KEYS = new Set(['kind', 'targetKind', 'provider', 'role', 'state', 'status', 'scope', 'type', 'mode', 'decision', 'unknownQuota', 'repository', 'headSha', 'version', 'requestedModel', 'createdAt', 'updatedAt', 'configuredAt', 'expiresAt', 'revokedAt', 'savedAt']);
const PUBLIC_VALUES = new Set(['unassigned', 'allow', 'deny', 'ask', 'unknown', 'claude', 'codex', 'agy', 'issue', 'pullRequest', 'worker', 'researcher', 'pm', 'human', 'approve', 'request_changes', 'comment', 'merged']);
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const recordId = (repository: string, kind: string, number: number): string => `public-feedback-${hash(repository.toLowerCase()).slice(0, 20)}-${kind}-${number}`;
const reviewRecordId = (repository: string, number: number): string => `pr-review-${hash(repository.toLowerCase()).slice(0, 20)}-${number}`;
const mergeRecordId = (repository: string, number: number): string => `pr-merge-${hash(repository.toLowerCase()).slice(0, 20)}-${number}`;
const plainText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && Array.from(value).length <= 4000 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);

type Kind = 'issue' | 'pullRequest';
export type ReviewDecision = 'approve' | 'request_changes' | 'comment';
export type MergeAuthorityMode = 'human' | 'pm';
export type PublicTarget = { repository: string; kind: Kind; number: number; version: string };
type Store = { get(collection: string, id: string): any; put(collection: string, id: string, value: unknown): any; delete?(collection: string, id: string): any; list(collection: string): any };
type GitHubUser = { id: number; login: string };

async function realSession(create: boolean): Promise<vscode.AuthenticationSession | null> {
  try { return await vscode.authentication.getSession(GITHUB_AUTH_PROVIDER, [...GITHUB_SCOPES], create ? { createIfNone: true } : { silent: true }) ?? null; } catch { return null; }
}
async function api(token: string, url: string, init: RequestInit = {}): Promise<Response> {
  if (!url.startsWith('https://api.github.com/')) throw new Error('host-refused');
  return fetch(url, { ...init, redirect: 'error', headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'multiagent-system-vscode', 'X-GitHub-Api-Version': '2022-11-28', ...(init.headers ?? {}) } });
}
async function userFor(auth: vscode.AuthenticationSession): Promise<GitHubUser | null> {
  try {
    const response = await api(auth.accessToken, 'https://api.github.com/user');
    const value = response.ok ? await response.json() as any : null;
    return value && Number.isSafeInteger(value.id) && value.id > 0 && typeof value.login === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(value.login) ? { id: value.id, login: value.login } : null;
  } catch { return null; }
}
function useStore(opened: any): Store | null { return opened?.ok && opened.store ? opened.store as Store : null; }

export async function configurePublicFeedback(): Promise<{ ok: boolean; code?: string }> {
  const opened = await privateStorage()?.use(); const store = useStore(opened);
  if (!store) return { ok: false, code: 'private-storage-unavailable' };
  const repo = await hooks.repository();
  if (!repo || !REPOSITORY.test(repo)) return { ok: false, code: 'no-workspace-repository' };
  const auth = await hooks.session(true); if (!auth) return { ok: false, code: 'github-sign-in-required' };
  const user = await hooks.user(auth); if (!user) return { ok: false, code: 'github-identity-unverified' };
  if (!await hooks.confirm(`Allow the signed-in GitHub user ${user.login} to publish report feedback as this machine's PM for ${repo}?`, 'Configure PM publisher')) return { ok: false, code: 'cancelled' };
  const saved = store.put(COLLECTION, POLICY_ID, { kind: 'public-feedback-publisher-v1', repository: repo, actorId: String(user.id), login: user.login, configuredAt: new Date().toISOString() });
  return saved?.ok ? { ok: true } : { ok: false, code: 'private-storage-unavailable' };
}

function mergeAuthorityOf(store: Store): MergeAuthorityMode | 'unreadable' {
  const found = store.get(COLLECTION, MERGE_POLICY_ID);
  if (!found?.ok) return 'unreadable';
  if (!found.found) return 'human';
  const value = found.value;
  return value?.kind === 'merge-authority-policy-v1' && (value.mode === 'human' || value.mode === 'pm') ? value.mode : 'unreadable';
}

export async function readMergeAuthority(): Promise<MergeAuthorityMode | 'unreadable'> {
  try {
    const opened = await privateStorage()?.use(); const store = useStore(opened);
    return store ? mergeAuthorityOf(store) : 'unreadable';
  } catch { return 'unreadable'; }
}

export async function configureMergeAuthority(input?: { mode?: unknown; interactive?: boolean }): Promise<{ ok: boolean; mode?: MergeAuthorityMode; code?: string }> {
  const opened = await privateStorage()?.use(); const store = useStore(opened);
  if (!store) return { ok: false, code: 'private-storage-unavailable' };
  const repo = await hooks.repository();
  if (!repo || !REPOSITORY.test(repo)) return { ok: false, code: 'no-workspace-repository' };
  const current = mergeAuthorityOf(store);
  const allowBypass = testMode && input?.interactive === false;
  const picked = allowBypass ? input?.mode : (input?.mode !== undefined && allowBypass ? input.mode : await hooks.pickMergeAuthority(current === 'pm' ? 'pm' : 'human'));
  if (picked === undefined) return { ok: false, code: 'cancelled' };
  if (picked !== 'human' && picked !== 'pm') return { ok: false, code: 'invalid-merge-authority' };
  if (!allowBypass) {
    const message = picked === 'pm'
      ? `Allow the configured PM publisher to merge pull requests from reports in ${repo} when current-head PM approval, passing CI, resolved threads, branch rules, and publication scans all pass?`
      : `Require a human to merge pull requests in ${repo} (default) and refuse PM merge requests from reports?`;
    if (!await hooks.confirm(message, 'Save merge authority')) return { ok: false, code: 'cancelled' };
  }
  const saved = store.put(COLLECTION, MERGE_POLICY_ID, { kind: 'merge-authority-policy-v1', repository: repo, mode: picked, updatedAt: new Date().toISOString() });
  return saved?.ok ? { ok: true, mode: picked } : { ok: false, code: 'private-storage-unavailable' };
}

function publisher(store: Store): { actorId: string; login: string } | 'unreadable' | null {
  const found = store.get(COLLECTION, POLICY_ID);
  if (!found?.ok) return 'unreadable';
  if (!found.found) return null;
  const value = found.value;
  return value?.kind === 'public-feedback-publisher-v1' && typeof value.actorId === 'string' && /^\d+$/.test(value.actorId) && typeof value.login === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(value.login) ? value : 'unreadable';
}
function previous(store: Store, target: PublicTarget): any {
  const found = store.get(COLLECTION, recordId(target.repository, target.kind, target.number));
  if (!found?.ok) return 'unreadable';
  if (!found.found) return null;
  return found.value?.kind === 'public-feedback-request-v1' ? found.value : 'unreadable';
}
function save(store: Store, target: PublicTarget, value: Record<string, unknown>): boolean {
  return store.put(COLLECTION, recordId(target.repository, target.kind, target.number), { kind: 'public-feedback-request-v1', repository: target.repository, targetKind: target.kind, number: target.number, version: target.version, ...value })?.ok === true;
}
function previousBy(store: Store, id: string, expectedKind: string): any {
  const found = store.get(COLLECTION, id);
  if (!found?.ok) return 'unreadable';
  if (!found.found) return null;
  return found.value?.kind === expectedKind ? found.value : 'unreadable';
}
function saveBy(store: Store, id: string, expectedKind: string, target: PublicTarget, value: Record<string, unknown>): boolean {
  return store.put(COLLECTION, id, { kind: expectedKind, repository: target.repository, number: target.number, version: target.version, ...value })?.ok === true;
}
function privateReferences(store: Store): { knownValues: Array<{ id: string; value: string }>; rules: Array<{ id: string; text: string }> } | null {
  const knownValues: Array<{ id: string; value: string }> = [];
  const rules: Array<{ id: string; text: string }> = [];
  let unreadable = false;
  const visit = (value: unknown, id: string, keyName?: string): void => {
    if (unreadable) return;
    if (typeof value === 'string') {
      if (PUBLIC_VALUES.has(value)) return;
      if (knownValues.length >= MAX_PRIVATE_REFS) { unreadable = true; return; }
      knownValues.push({ id, value });
      if (keyName === 'note' || keyName === 'text') rules.push({ id, text: value });
      return;
    }
    if (Array.isArray(value)) { value.forEach((entry, index) => visit(entry, `${id}-${index}`, keyName)); return; }
    if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        if (PUBLIC_KEYS.has(key)) continue;
        visit(entry, `${id}-${key}`, key);
      }
    }
  };
  for (const collection of COLLECTIONS) {
    const listed = store.list(collection);
    if (!listed?.ok || !Array.isArray(listed.items)) return null;
    for (const item of listed.items) {
      if (!item || typeof item.id !== 'string' || !item.value || typeof item.value !== 'object' || Array.isArray(item.value)) return null;
      if (collection === 'policies' && (item.id === POLICY_ID || item.id === MERGE_POLICY_ID || item.id.startsWith('public-feedback-') || item.id.startsWith('pr-review-') || item.id.startsWith('pr-merge-') || item.id.startsWith('broker-req-'))) continue;
      if (collection === 'reportFeedback' && (typeof (item.value as any).note !== 'string' || (item.value as any).note.trim() === '')) return null;
      if (collection === 'broadcasts' && (typeof (item.value as any).text !== 'string' || (item.value as any).text.trim() === '')) return null;
      visit(item.value, `${collection}-${hash(item.id).slice(0, 12)}`);
      if (unreadable) return null;
    }
  }
  return { knownValues, rules };
}
async function currentVersion(target: PublicTarget): Promise<string | null> {
  const reader: any = githubReaderFor(target.repository); if (!reader) return null;
  try {
    if (target.kind === 'pullRequest') {
      const read = await reader.getPullRequest(target.number, { forceRefresh: true });
      return read?.kind === 'ok' && SHA.test(read.data?.headSha) ? read.data.headSha.toLowerCase() : null;
    }
    const read = await reader.getIssue(target.number, { forceRefresh: true });
    return read?.kind === 'ok' && read.data?.number === target.number && typeof read.data.title === 'string' && typeof read.data.body !== 'undefined'
      ? hash(`${read.data.title}\0${read.data.body ?? ''}`) : null;
  } catch { return null; }
}
async function realSnapshot(target: PublicTarget): Promise<any> {
  const reader: any = githubReaderFor(target.repository); if (!reader) return null;
  try { return await reader.getPullRequestSnapshot(target.number, { forceRefresh: true }); } catch { return null; }
}
async function realPublication(target: PublicTarget, headSha: string): Promise<any> {
  const reader: any = githubReaderFor(target.repository); if (!reader) return { kind: 'unavailable' };
  try {
    if (typeof reader.getPullRequestPublication === 'function') return await reader.getPullRequestPublication(target.number, headSha, { forceRefresh: true });
    const before = await reader.getPullRequest(target.number, { forceRefresh: true });
    const files = await reader.getPullRequestFiles(target.number, { forceRefresh: true });
    const after = await reader.getPullRequest(target.number, { forceRefresh: true });
    if (
      before?.kind !== 'ok' || after?.kind !== 'ok' || files?.kind !== 'ok' || !Array.isArray(files.data) ||
      typeof before.data?.headSha !== 'string' || typeof after.data?.headSha !== 'string' ||
      before.data.headSha.toLowerCase() !== headSha.toLowerCase() ||
      after.data.headSha.toLowerCase() !== headSha.toLowerCase() ||
      files.data.length === 0 ||
      files.data.some((file: any) => !file || typeof file.filename !== 'string' || typeof file.patch !== 'string')
    ) {
      return { kind: 'partial' };
    }
    const diff = files.data.map((file: any) => `diff --git a/${file.filename} b/${file.filename}\n${file.patch}`).join('\n');
    return { kind: 'ok', data: { complete: true, number: target.number, headSha, diff } };
  } catch { return { kind: 'unavailable' }; }
}
async function realAuthorId(auth: vscode.AuthenticationSession, login: string, configured: { actorId: string; login: string }): Promise<string | null> {
  if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) return null;
  if (login.toLowerCase() === configured.login.toLowerCase()) return configured.actorId;
  try {
    const response = await api(auth.accessToken, `https://api.github.com/users/${encodeURIComponent(login)}`);
    const value = response.ok ? await response.json() as any : null;
    return value && Number.isSafeInteger(value.id) && value.id > 0 && typeof value.login === 'string' && value.login.toLowerCase() === login.toLowerCase() ? String(value.id) : null;
  } catch { return null; }
}
type Hooks = {
  session(create: boolean): Promise<vscode.AuthenticationSession | null>;
  user(auth: vscode.AuthenticationSession): Promise<GitHubUser | null>;
  version(target: PublicTarget): Promise<string | null>;
  snapshot(target: PublicTarget): Promise<any>;
  publication(target: PublicTarget, headSha: string): Promise<any>;
  authorId(auth: vscode.AuthenticationSession, login: string, configured: { actorId: string; login: string }): Promise<string | null>;
  comment(auth: vscode.AuthenticationSession, repository: { owner: string; name: string }, number: number, body: string): Promise<{ ok: boolean; number?: number }>;
  review(auth: vscode.AuthenticationSession, repository: { owner: string; name: string }, number: number, decision: ReviewDecision, body: string, expectedHeadSha: string): Promise<{ ok: boolean; number?: number }>;
  merge(auth: vscode.AuthenticationSession, repository: { owner: string; name: string }, number: number, expectedHeadSha: string, commitTitle: string, commitMessage: string): Promise<{ ok: boolean; reason?: string; sha?: string }>;
  confirm(message: string, action: string): Promise<boolean>;
  prompt(initialValue: string): Promise<string | undefined>;
  pickReviewDecision(): Promise<ReviewDecision | undefined>;
  promptReview(initialValue: string, decision: ReviewDecision): Promise<string | undefined>;
  pickMergeAuthority(current: MergeAuthorityMode): Promise<MergeAuthorityMode | undefined>;
  repository(): Promise<string | null>;
};
async function realComment(auth: vscode.AuthenticationSession, repository: { owner: string; name: string }, number: number, body: string): Promise<{ ok: boolean; number?: number }> {
  const endpoint = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/issues/${number}/comments`;
  const response = await api(auth.accessToken, endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) });
  const data = response.ok ? await response.json() as any : null;
  const url = typeof data?.html_url === 'string' ? data.html_url : '';
  const exact = new RegExp(`^https://github\\.com/${repository.owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/${repository.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(?:issues|pull)/${number}#issuecomment-\\d+$`, 'i');
  return response.ok && Number.isSafeInteger(data?.id) && data.id > 0 && data.body === body && exact.test(url) ? { ok: true, number: data.id } : { ok: false };
}
async function realReview(auth: vscode.AuthenticationSession, repository: { owner: string; name: string }, number: number, decision: ReviewDecision, body: string, expectedHeadSha: string): Promise<{ ok: boolean; number?: number }> {
  const endpoint = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls/${number}/reviews`;
  const event = decision === 'approve' ? 'APPROVE' : decision === 'request_changes' ? 'REQUEST_CHANGES' : 'COMMENT';
  const response = await api(auth.accessToken, endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commit_id: expectedHeadSha, event, body }) });
  const data = response.ok ? await response.json() as any : null;
  return response.ok && Number.isSafeInteger(data?.id) && data.id > 0 && typeof data?.commit_id === 'string' && data.commit_id.toLowerCase() === expectedHeadSha.toLowerCase() && data?.body === body ? { ok: true, number: data.id } : { ok: false };
}
async function realMerge(auth: vscode.AuthenticationSession, repository: { owner: string; name: string }, number: number, expectedHeadSha: string, commitTitle: string, commitMessage: string): Promise<{ ok: boolean; reason?: string; sha?: string }> {
  const endpoint = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls/${number}/merge`;
  const response = await api(auth.accessToken, endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sha: expectedHeadSha, commit_title: commitTitle, commit_message: commitMessage }) });
  if (response.ok) {
    const data = await response.json() as any;
    return data?.merged === true && typeof data?.sha === 'string' && SHA.test(data.sha) ? { ok: true, sha: data.sha } : { ok: false, reason: 'unknown' };
  }
  const reason = response.status === 409 ? 'head-changed' : response.status === 405 ? 'not-mergeable' : response.status === 403 ? 'denied' : response.status === 404 ? 'not-found' : response.status === 422 ? 'validation-failed' : response.status === 429 ? 'rate-limited' : 'unknown';
  return { ok: false, reason };
}
const realHooks: Hooks = {
  session: realSession, user: userFor, version: currentVersion, snapshot: realSnapshot, publication: realPublication, authorId: realAuthorId,
  comment: realComment, review: realReview, merge: realMerge,
  confirm: async (message, action) => (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action,
  prompt: async (value) => await vscode.window.showInputBox({ prompt: 'Public GitHub comment (starts blank; private feedback is never copied here)', value, ignoreFocusOut: true }),
  pickReviewDecision: async () => {
    const picked = await vscode.window.showQuickPick([
      { label: 'Approve', description: 'Formal GitHub approval bound to the open report head', value: 'approve' as const },
      { label: 'Request changes', description: 'Formal GitHub changes-requested review bound to the open report head', value: 'request_changes' as const },
      { label: 'Comment', description: 'Formal GitHub review comment bound to the open report head', value: 'comment' as const }
    ], { placeHolder: 'Select formal pull request review decision' });
    return picked?.value;
  },
  promptReview: async (value, decision) => await vscode.window.showInputBox({ prompt: `Public GitHub review body (${decision}; starts blank and never copies private feedback)`, value, ignoreFocusOut: true }),
  pickMergeAuthority: async (current) => {
    const picked = await vscode.window.showQuickPick([
      { label: 'Human only (default)', description: `${current === 'human' ? 'Current · ' : ''}PM merge requests from reports are refused`, value: 'human' as const },
      { label: 'PM allowed', description: `${current === 'pm' ? 'Current · ' : ''}Guarded PM merge allowed when approval, CI, threads, branch rules, and scan pass`, value: 'pm' as const }
    ], { placeHolder: 'Select pull request merge authority policy' });
    return picked?.value;
  },
  repository: async () => {
    const folder = vscode.workspace.workspaceFolders?.[0]; if (!folder || !vscode.workspace.isTrusted) return null;
    try { const project = await WorktreeService.open(folder.uri.fsPath); return typeof project.githubRepository === 'string' ? project.githubRepository.replace(/^github\.com\//i, '') : null; } catch { return null; }
  }
};
let hooks = realHooks;
let testMode = false;
export function setPublicFeedbackTestMode(enabled: boolean): void { testMode = enabled; if (!enabled) hooks = realHooks; }
export function installPublicFeedbackTestOverrides(next: Partial<Hooks>): void {
  if (!testMode) throw new Error('Public feedback overrides are available only in Extension Host tests.');
  hooks = { ...realHooks, ...next };
}

export async function sendPublicFeedback(target: PublicTarget, input?: { body?: unknown; interactive?: boolean }): Promise<{ ok: boolean; code?: string }> {
  if (!REPOSITORY.test(target.repository) || !Number.isSafeInteger(target.number) || target.number < 1 || !/^[a-f0-9]{40,64}$/i.test(target.version)) return { ok: false, code: 'report-evidence-unavailable' };
  const opened = await privateStorage()?.use(); const store = useStore(opened);
  if (!store) return { ok: false, code: 'private-storage-unavailable' };
  const configured = publisher(store);
  if (configured === 'unreadable') return { ok: false, code: 'private-storage-unavailable' };
  if (!configured) return { ok: false, code: 'publisher-not-configured' };
  const old = previous(store, target);
  if (old === 'unreadable') return { ok: false, code: 'private-storage-unavailable' };
  if (old?.status === 'unknown' || old?.status === 'sending') return { ok: false, code: 'outcome-unknown' };
  if (old?.status === 'done' && old.version === target.version) return { ok: true, code: 'already-sent' };
  const allowBypass = testMode && input?.interactive === false;
  const initialDraft = old?.status === 'draft' && old.version === target.version && typeof old.body === 'string' ? old.body : '';
  const body = allowBypass ? input?.body : await hooks.prompt(initialDraft);
  if (body === undefined) return { ok: false, code: 'cancelled' };
  if (!plainText(body)) return { ok: false, code: 'invalid-public-feedback' };
  const requestId = old?.status === 'draft' && old.version === target.version && old.body === body && typeof old.requestId === 'string' ? old.requestId : `feedback_${randomBytes(12).toString('hex')}`;
  const draftSaved = store.put(COLLECTION, recordId(target.repository, target.kind, target.number), { kind: 'public-feedback-request-v1', repository: target.repository, targetKind: target.kind, number: target.number, version: target.version, status: 'draft', requestId, body, updatedAt: new Date().toISOString() });
  if (!draftSaved?.ok && draftSaved?.reason !== 'secret-detected') return { ok: false, code: 'private-storage-unavailable' };
  if (!allowBypass) {
    const versionInfo = target.kind === 'pullRequest' ? ` (head ${target.version})` : ` (version ${target.version.slice(0, 12)})`;
    if (!await hooks.confirm(`Publish this exact comment to ${target.repository} ${target.kind === 'issue' ? 'Issue' : 'PR'} #${target.number}${versionInfo}?\n\n${body}`, 'Publish public feedback')) return { ok: false, code: 'cancelled' };
  }
  if ((await hooks.repository())?.toLowerCase() !== target.repository.toLowerCase()) return { ok: false, code: 'report-context-changed' };
  const auth = await hooks.session(false); if (!auth) return { ok: false, code: 'github-sign-in-required' };
  const actor = await hooks.user(auth); if (!actor || String(actor.id) !== configured.actorId || actor.login.toLowerCase() !== configured.login.toLowerCase()) return { ok: false, code: 'publisher-identity-changed' };
  const current = await hooks.version(target); if (!current || current.toLowerCase() !== target.version.toLowerCase()) return { ok: false, code: 'report-context-changed' };
  const refs = privateReferences(store); if (!refs) return { ok: false, code: 'private-reference-unreadable' };
  const match = REPOSITORY.exec(target.repository)!; const repository = { owner: match[1], name: match[2] };
  const audit = { record(entry: any) {
    const status = entry.stage === 'result' ? (entry.outcome === 'done' ? 'done' : entry.outcome === 'unknown' ? 'unknown' : 'draft') : 'sending';
    if (!save(store, target, { status, requestId, body, updatedAt: new Date().toISOString(), audit: { stage: entry.stage, outcome: entry.outcome ?? null } })) throw new Error('audit-unavailable');
  } };
  const broker = new Broker({
    identity: { current: () => ({ actorId: String(actor.id), role: 'pm' }), actorIdForLogin: () => null },
    reader: {}, transport: { comment: ({ number, body: sent }: any) => hooks.comment(auth, repository, number, sent) }, audit,
    config: { pmActorId: configured.actorId, pmLogin: configured.login }, project: { repository }, store, scanOptions: refs, privateReferencesChecked: true
  });
  const result = await broker.request({ operation: 'comment', requestId, target: target.kind === 'issue' ? 'issue' : 'pr', number: target.number, body });
  return result.ok ? { ok: true } : { ok: false, code: result.reason ?? 'write-refused' };
}

export async function reviewPullRequestReport(target: PublicTarget, input?: { decision?: unknown; body?: unknown; interactive?: boolean }): Promise<{ ok: boolean; code?: string }> {
  if (target.kind !== 'pullRequest' || !REPOSITORY.test(target.repository) || !Number.isSafeInteger(target.number) || target.number < 1 || !SHA.test(target.version)) return { ok: false, code: 'report-evidence-unavailable' };
  const opened = await privateStorage()?.use(); const store = useStore(opened);
  if (!store) return { ok: false, code: 'private-storage-unavailable' };
  const configured = publisher(store);
  if (configured === 'unreadable') return { ok: false, code: 'private-storage-unavailable' };
  if (!configured) return { ok: false, code: 'publisher-not-configured' };
  const id = reviewRecordId(target.repository, target.number);
  const old = previousBy(store, id, 'pr-review-request-v1');
  if (old === 'unreadable') return { ok: false, code: 'private-storage-unavailable' };
  if (old?.status === 'unknown' || old?.status === 'sending') return { ok: false, code: 'outcome-unknown' };
  const allowBypass = testMode && input?.interactive === false;
  const pickedDecision = allowBypass ? input?.decision : (input?.decision !== undefined && allowBypass ? input.decision : await hooks.pickReviewDecision());
  if (pickedDecision === undefined) return { ok: false, code: 'cancelled' };
  if (pickedDecision !== 'approve' && pickedDecision !== 'request_changes' && pickedDecision !== 'comment') return { ok: false, code: 'invalid-review-decision' };
  if (old?.status === 'done' && old.version === target.version && old.decision === pickedDecision) return { ok: true, code: 'already-reviewed' };
  const initialDraft = old?.status === 'draft' && old.version === target.version && typeof old.body === 'string' ? old.body : '';
  const body = allowBypass ? input?.body : (input?.body !== undefined && allowBypass ? input.body : await hooks.promptReview(initialDraft, pickedDecision));
  if (body === undefined) return { ok: false, code: 'cancelled' };
  if (!plainText(body)) return { ok: false, code: 'invalid-review-body' };
  const requestId = old?.status === 'draft' && old.version === target.version && old.decision === pickedDecision && old.body === body && typeof old.requestId === 'string' ? old.requestId : `review_${randomBytes(12).toString('hex')}`;
  const draftSaved = store.put(COLLECTION, id, { kind: 'pr-review-request-v1', repository: target.repository, number: target.number, version: target.version, decision: pickedDecision, status: 'draft', requestId, body, updatedAt: new Date().toISOString() });
  if (!draftSaved?.ok && draftSaved?.reason !== 'secret-detected') return { ok: false, code: 'private-storage-unavailable' };
  if (!allowBypass) {
    if (!await hooks.confirm(`Submit formal GitHub review (${pickedDecision}) to ${target.repository} PR #${target.number} (head ${target.version})?\n\n${body}`, 'Submit formal review')) return { ok: false, code: 'cancelled' };
  }
  if ((await hooks.repository())?.toLowerCase() !== target.repository.toLowerCase()) return { ok: false, code: 'report-context-changed' };
  const auth = await hooks.session(false); if (!auth) return { ok: false, code: 'github-sign-in-required' };
  const actor = await hooks.user(auth); if (!actor || String(actor.id) !== configured.actorId || actor.login.toLowerCase() !== configured.login.toLowerCase()) return { ok: false, code: 'publisher-identity-changed' };
  const current = await hooks.version(target); if (!current || current.toLowerCase() !== target.version.toLowerCase()) return { ok: false, code: 'report-context-changed' };
  const refs = privateReferences(store); if (!refs) return { ok: false, code: 'private-reference-unreadable' };
  const match = REPOSITORY.exec(target.repository)!; const repository = { owner: match[1], name: match[2] };
  const loginIds = new Map<string, string>([[configured.login.toLowerCase(), configured.actorId]]);
  const reader = {
    getPullRequestSnapshot: async (number: number) => {
      const snap = await hooks.snapshot({ ...target, number });
      const author = snap?.pullRequest?.data?.author;
      if (typeof author === 'string' && !loginIds.has(author.toLowerCase())) {
        const resolved = await hooks.authorId(auth, author, configured);
        if (resolved) loginIds.set(author.toLowerCase(), resolved);
      }
      return snap;
    }
  };
  const audit = { record(entry: any) {
    const status = entry.stage === 'result' ? (entry.outcome === 'done' ? 'done' : entry.outcome === 'unknown' ? 'unknown' : 'draft') : 'sending';
    if (!saveBy(store, id, 'pr-review-request-v1', target, { decision: pickedDecision, status, requestId, body, updatedAt: new Date().toISOString(), audit: { stage: entry.stage, outcome: entry.outcome ?? null } })) throw new Error('audit-unavailable');
  } };
  const broker = new Broker({
    identity: { current: () => ({ actorId: String(actor.id), role: 'pm' }), actorIdForLogin: (login: string) => typeof login === 'string' ? (loginIds.get(login.toLowerCase()) ?? null) : null },
    reader,
    transport: { reviewPullRequest: ({ number, decision, body: sent, expectedHeadSha }: any) => hooks.review(auth, repository, number, decision, sent, expectedHeadSha) },
    audit,
    config: { pmActorId: configured.actorId, pmLogin: configured.login }, project: { repository }, store, scanOptions: refs, privateReferencesChecked: true
  });
  const result = await broker.request({ operation: 'reviewPr', requestId, number: target.number, decision: pickedDecision, body, expectedHeadSha: target.version.toLowerCase() });
  return result.ok ? { ok: true } : { ok: false, code: result.reason ?? 'write-refused' };
}

export async function mergePullRequestReport(target: PublicTarget, input?: { interactive?: boolean }): Promise<{ ok: boolean; code?: string }> {
  if (target.kind !== 'pullRequest' || !REPOSITORY.test(target.repository) || !Number.isSafeInteger(target.number) || target.number < 1 || !SHA.test(target.version)) return { ok: false, code: 'report-evidence-unavailable' };
  const opened = await privateStorage()?.use(); const store = useStore(opened);
  if (!store) return { ok: false, code: 'private-storage-unavailable' };
  const configured = publisher(store);
  if (configured === 'unreadable') return { ok: false, code: 'private-storage-unavailable' };
  if (!configured) return { ok: false, code: 'publisher-not-configured' };
  const authority = mergeAuthorityOf(store);
  if (authority === 'unreadable') return { ok: false, code: 'private-storage-unavailable' };
  const id = mergeRecordId(target.repository, target.number);
  const old = previousBy(store, id, 'pr-merge-request-v1');
  if (old === 'unreadable') return { ok: false, code: 'private-storage-unavailable' };
  if (old?.status === 'unknown' || old?.status === 'sending') return { ok: false, code: 'outcome-unknown' };
  if (old?.status === 'done' && old.version === target.version) return { ok: true, code: 'already-merged' };
  const allowBypass = testMode && input?.interactive === false;
  if (authority === 'pm' && !allowBypass) {
    if (!await hooks.confirm(`Merge ${target.repository} PR #${target.number} (head ${target.version}) after verifying current-head PM approval, passing CI, resolved threads, supported branch rules, and publication scan?`, 'Merge pull request')) return { ok: false, code: 'cancelled' };
  }
  if ((await hooks.repository())?.toLowerCase() !== target.repository.toLowerCase()) return { ok: false, code: 'report-context-changed' };
  const auth = await hooks.session(false); if (!auth) return { ok: false, code: 'github-sign-in-required' };
  const actor = await hooks.user(auth); if (!actor || String(actor.id) !== configured.actorId || actor.login.toLowerCase() !== configured.login.toLowerCase()) return { ok: false, code: 'publisher-identity-changed' };
  const current = await hooks.version(target); if (!current || current.toLowerCase() !== target.version.toLowerCase()) return { ok: false, code: 'report-context-changed' };
  const refs = privateReferences(store); if (!refs) return { ok: false, code: 'private-reference-unreadable' };
  const match = REPOSITORY.exec(target.repository)!; const repository = { owner: match[1], name: match[2] };
  const requestId = `merge_${randomBytes(12).toString('hex')}`;
  const loginIds = new Map<string, string>([[configured.login.toLowerCase(), configured.actorId]]);
  const reader = {
    getPullRequestSnapshot: async (number: number) => {
      const snap = await hooks.snapshot({ ...target, number });
      const author = snap?.pullRequest?.data?.author;
      if (typeof author === 'string' && !loginIds.has(author.toLowerCase())) {
        const resolved = await hooks.authorId(auth, author, configured);
        if (resolved) loginIds.set(author.toLowerCase(), resolved);
      }
      return snap;
    },
    getPullRequestPublication: async (number: number, headSha: string) => await hooks.publication({ ...target, number }, headSha)
  };
  const audit = { record(entry: any) {
    const status = entry.stage === 'result' ? (entry.outcome === 'done' ? 'done' : entry.outcome === 'unknown' ? 'unknown' : 'draft') : 'sending';
    if (!saveBy(store, id, 'pr-merge-request-v1', target, { status, requestId, updatedAt: new Date().toISOString(), audit: { stage: entry.stage, outcome: entry.outcome ?? null, reason: entry.reason ?? null } })) throw new Error('audit-unavailable');
  } };
  const broker = new Broker({
    identity: { current: () => ({ actorId: String(actor.id), role: 'pm' }), actorIdForLogin: (login: string) => typeof login === 'string' ? (loginIds.get(login.toLowerCase()) ?? null) : null },
    reader,
    transport: { mergePullRequest: ({ number, expectedHeadSha, commitTitle, commitMessage }: any) => hooks.merge(auth, repository, number, expectedHeadSha, commitTitle, commitMessage) },
    audit,
    config: { pmActorId: configured.actorId, pmLogin: configured.login, mergeAuthority: authority }, project: { repository }, store, scanOptions: refs, privateReferencesChecked: true
  });
  const result = await broker.request({ operation: 'mergePr', requestId, number: target.number });
  return result.ok ? { ok: true } : { ok: false, code: result.reason ?? 'write-refused' };
}
