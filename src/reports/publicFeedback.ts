import * as vscode from 'vscode';
import { createHash, randomBytes } from 'node:crypto';
import { privateStorage } from '../storage/storageCommands';
import { githubReaderFor, GITHUB_AUTH_PROVIDER, GITHUB_SCOPES } from '../github/githubCommands';
import { WorktreeService } from '../projects/worktrees';
import { COLLECTIONS } from '../storage/extensionStorage';
const { OwnerPostStore } = require('./ownerPosts') as { OwnerPostStore: new (store: unknown) => { record(input: { repository: string; kind: 'comment' | 'review'; id: number; number: number; body: string }): { ok: boolean } } };
const { classifyWrite } = require('./writeOutcome') as { classifyWrite(response: { ok: boolean; status: number }, verified: boolean): 'done' | 'refused' | 'unknown' };
const { Broker } = require('../broker/broker') as { Broker: new (deps: Record<string, unknown>) => { request(value: Record<string, unknown>): Promise<{ ok: boolean; reason?: string; found?: Found }> } };
// What the privacy scan found when it stopped a post (#389): kinds and ids only, never the text; the message says which kind.
export type Found = Array<{ category: string; id?: string }>;
const foundOf = (result: { reason?: string; found?: Found }): { found?: Found } => (result.reason === 'content-blocked' && Array.isArray(result.found) ? { found: result.found } : {});

const REPOSITORY = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/;
const SHA = /^[a-f0-9]{40}$/i;
const POLICY_ID = 'public-feedback-publisher';
const MERGE_POLICY_ID = 'merge-authority-policy';
const COLLECTION = 'policies';
// The private values the scan looks for, collected from the private store (#389: free-form fields only, as whole words).
const { collectPrivateReferences } = require('../publish/private-references') as { collectPrivateReferences(store: unknown, collections: readonly string[], options: { skip(collection: string, id: string): boolean; hash(text: string): string }): { knownValues: Array<{ id: string; value: string }>; rules: Array<{ id: string; text: string }> } | null };
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const recordId = (repository: string, kind: string, number: number): string => `public-feedback-${hash(repository.toLowerCase()).slice(0, 20)}-${kind}-${number}`;
const reviewRecordId = (repository: string, number: number): string => `pr-review-${hash(repository.toLowerCase()).slice(0, 20)}-${number}`;
const branchRecordId = (repository: string, number: number): string => `pr-branch-delete-${hash(repository.toLowerCase()).slice(0, 20)}-${number}`;
const closeRecordId = (repository: string, number: number): string => `issue-close-${hash(repository.toLowerCase()).slice(0, 20)}-${number}`;
const mergeRecordId = (repository: string, number: number): string => `pr-merge-${hash(repository.toLowerCase()).slice(0, 20)}-${number}`;
const plainText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && Array.from(value).length <= 4000 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);

const { publisherFor, mergeModeFor } = require('./publisherPolicy') as {
  publisherFor(found: any, repository?: string): { actorId: string; login: string } | 'unreadable' | null;
  mergeModeFor(found: any, repository?: string): 'human' | 'pm' | 'unreadable';
};

type Kind = 'issue' | 'pullRequest';
export type ReviewDecision = 'approve' | 'request_changes' | 'comment';
export type MergeAuthorityMode = 'human' | 'pm';
export type CloseReason = 'completed' | 'not_planned';
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

function mergeAuthorityOf(store: Store, repository?: string): MergeAuthorityMode | 'unreadable' {
  return mergeModeFor(store.get(COLLECTION, MERGE_POLICY_ID), repository);
}

export async function readMergeAuthority(repository?: string): Promise<MergeAuthorityMode | 'unreadable'> {
  try {
    const opened = await privateStorage()?.use(); const store = useStore(opened);
    return store ? mergeAuthorityOf(store, repository) : 'unreadable';
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

function publisher(store: Store, repository: string): { actorId: string; login: string } | 'unreadable' | null {
  return publisherFor(store.get(COLLECTION, POLICY_ID), repository);
}
function previous(store: Store, target: PublicTarget, id = recordId(target.repository, target.kind, target.number)): any {
  const found = store.get(COLLECTION, id);
  if (!found?.ok) return 'unreadable';
  if (!found.found) return null;
  return found.value?.kind === 'public-feedback-request-v1' ? found.value : 'unreadable';
}
function save(store: Store, target: PublicTarget, value: Record<string, unknown>, id = recordId(target.repository, target.kind, target.number)): boolean {
  return store.put(COLLECTION, id, { kind: 'public-feedback-request-v1', repository: target.repository, targetKind: target.kind, number: target.number, version: target.version, ...value })?.ok === true;
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
  // What this extension publishes itself (the publisher, the merge authority and the records of its own posts) is not looked for.
  const own = (collection: string, id: string): boolean => collection === 'policies' && (id === POLICY_ID || id === MERGE_POLICY_ID || id.startsWith('public-feedback-') || id.startsWith('pr-review-') || id.startsWith('pr-merge-') || id.startsWith('broker-req-'));
  try { return collectPrivateReferences(store, COLLECTIONS, { skip: own, hash }); } catch { return null; }
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
  repositoryInfo(target: PublicTarget): Promise<any>;
  branchRequirements(target: PublicTarget, branch: string): Promise<any>;
  branchHead(auth: vscode.AuthenticationSession, repository: { owner: string; name: string }, branch: string): Promise<any>;
  deleteBranch(auth: vscode.AuthenticationSession, repository: { owner: string; name: string }, branch: string, expectedHeadSha: string): Promise<{ ok: boolean; reason?: string }>;
  issue(target: PublicTarget): Promise<any>;
  closeIssue(auth: vscode.AuthenticationSession, repository: { owner: string; name: string }, number: number, reason: CloseReason): Promise<{ ok: boolean; number?: number }>;
  pickCloseReason(): Promise<CloseReason | undefined>;
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
  const verified = response.ok && Number.isSafeInteger(data?.id) && data.id > 0 && data.body === body && exact.test(url);
  const outcome = classifyWrite(response, verified);
  // A throw is how the broker learns the outcome is unknown: it keeps the guard against sending again.
  if (outcome === 'unknown') throw new Error('write-outcome-unknown');
  return verified ? { ok: true, number: data.id } : { ok: false };
}
async function realReview(auth: vscode.AuthenticationSession, repository: { owner: string; name: string }, number: number, decision: ReviewDecision, body: string, expectedHeadSha: string): Promise<{ ok: boolean; number?: number }> {
  const endpoint = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls/${number}/reviews`;
  const event = decision === 'approve' ? 'APPROVE' : decision === 'request_changes' ? 'REQUEST_CHANGES' : 'COMMENT';
  const response = await api(auth.accessToken, endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commit_id: expectedHeadSha, event, body }) });
  const data = response.ok ? await response.json() as any : null;
  const verified = response.ok && Number.isSafeInteger(data?.id) && data.id > 0 && typeof data?.commit_id === 'string' && data.commit_id.toLowerCase() === expectedHeadSha.toLowerCase() && data?.body === body;
  if (classifyWrite(response, verified) === 'unknown') throw new Error('write-outcome-unknown');
  return verified ? { ok: true, number: data.id } : { ok: false };
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
async function realRepositoryInfo(target: PublicTarget): Promise<any> {
  const reader: any = githubReaderFor(target.repository); if (!reader) return { kind: 'unavailable' };
  try { return await reader.getRepository({ forceRefresh: true }); } catch { return { kind: 'unavailable' }; }
}
async function realBranchRequirements(target: PublicTarget, branch: string): Promise<any> {
  const reader: any = githubReaderFor(target.repository); if (!reader) return { kind: 'unavailable' };
  try { return await reader.getBranchRequirements(branch, { forceRefresh: true }); } catch { return { kind: 'unavailable' }; }
}
async function realBranchHead(auth: vscode.AuthenticationSession, repository: { owner: string; name: string }, branch: string): Promise<any> {
  const refPath = branch.split('/').map(encodeURIComponent).join('/');
  try {
    const response = await api(auth.accessToken, `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/ref/heads/${refPath}`);
    const data = response.ok ? await response.json() as any : null;
    return typeof data?.object?.sha === 'string' && SHA.test(data.object.sha) ? { kind: 'ok', data: { sha: data.object.sha.toLowerCase() } } : { kind: response.status === 404 ? 'not_found' : 'unavailable' };
  } catch { return { kind: 'unavailable' }; }
}
async function realDeleteBranch(auth: vscode.AuthenticationSession, repository: { owner: string; name: string }, branch: string, expectedHeadSha: string): Promise<{ ok: boolean; reason?: string }> {
  const refPath = branch.split('/').map(encodeURIComponent).join('/');
  const base = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/refs/heads/${refPath}`;
  // The branch must still point at the reviewed head right before it goes. A short gap remains between this read and the delete.
  const current = await api(auth.accessToken, base.replace('/git/refs/', '/git/ref/'));
  if (current.status === 404) return { ok: false, reason: 'branch-not-found' };
  const ref = current.ok ? await current.json() as any : null;
  if (typeof ref?.object?.sha !== 'string') return { ok: false, reason: 'branch-unverified' };
  if (ref.object.sha.toLowerCase() !== expectedHeadSha.toLowerCase()) return { ok: false, reason: 'head-changed' };
  const response = await api(auth.accessToken, base, { method: 'DELETE' });
  const outcome = classifyWrite(response, response.status === 204);
  if (outcome === 'unknown') throw new Error('write-outcome-unknown');
  return response.status === 204 ? { ok: true } : { ok: false, reason: response.status === 403 ? 'denied' : response.status === 422 ? 'validation-failed' : 'refused' };
}
async function realIssue(target: PublicTarget): Promise<any> {
  const reader: any = githubReaderFor(target.repository); if (!reader) return { kind: 'unavailable' };
  try { return await reader.getIssue(target.number, { forceRefresh: true }); } catch { return { kind: 'unavailable' }; }
}
async function realCloseIssue(auth: vscode.AuthenticationSession, repository: { owner: string; name: string }, number: number, reason: CloseReason): Promise<{ ok: boolean; number?: number }> {
  const endpoint = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/issues/${number}`;
  const response = await api(auth.accessToken, endpoint, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: 'closed', state_reason: reason }) });
  const data = response.ok ? await response.json() as any : null;
  const verified = response.ok && data?.number === number && data?.state === 'closed' && data?.state_reason === reason;
  if (classifyWrite(response, verified) === 'unknown') throw new Error('write-outcome-unknown');
  return verified ? { ok: true, number } : { ok: false };
}
const realHooks: Hooks = {
  session: realSession, user: userFor, version: currentVersion, snapshot: realSnapshot, publication: realPublication, authorId: realAuthorId,
  comment: realComment, review: realReview, merge: realMerge, issue: realIssue, closeIssue: realCloseIssue, repositoryInfo: realRepositoryInfo, branchRequirements: realBranchRequirements, branchHead: realBranchHead, deleteBranch: realDeleteBranch,
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
  pickCloseReason: async () => {
    const picked = await vscode.window.showQuickPick([
      { label: 'Completed', description: 'The work is done', value: 'completed' as const },
      { label: 'Not planned', description: 'Closed without doing the work', value: 'not_planned' as const }
    ], { placeHolder: 'Why is this Issue being closed?' });
    return picked?.value;
  },
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
/**
 * The end-to-end run only (#353): publishing goes to its synthetic GitHub. The condition is checked here again (development mode and
 * the run's environment variable naming the file), so an installed extension can never reach this.
 */
export function useE2eGitHubForPublishing(mode: number, env: NodeJS.ProcessEnv, fixture: unknown): boolean {
  const { e2eGitHubFixture, fixtureWriteHooks } = require('./e2eGitHub') as { e2eGitHubFixture(mode: number, env: NodeJS.ProcessEnv): unknown; fixtureWriteHooks(fixture: unknown): Partial<Hooks> };
  if (!e2eGitHubFixture(mode, env)) return false;
  hooks = { ...realHooks, ...fixtureWriteHooks(fixture) };
  return true;
}
export function installPublicFeedbackTestOverrides(next: Partial<Hooks>): void {
  if (!testMode) throw new Error('Public feedback overrides are available only in Extension Host tests.');
  hooks = { ...realHooks, ...next };
}

/**
 * What the owner publishes here is recorded by GitHub's id for it (issue #342): the report shows a post as the owner's only when
 * its id is in this record, since the GitHub account is shared with the agents. A record that cannot be written does not undo the
 * post (it is already on GitHub); the post is then shown as unsigned, never as the owner's, and the caller is told.
 */
function recordOwnerPost(store: Store, repository: string, kind: 'comment' | 'review', id: number | undefined, number: number, body: string): boolean {
  try { return id !== undefined && new OwnerPostStore(store).record({ repository, kind, id, number, body }).ok === true; } catch { return false; }
}

/**
 * `conversation`: a message of a conversation with the PM (#343). It is kept in its own record per Issue or PR, and a finished message
 * does not stop the next one (the report page's feedback stays one per version). A message whose outcome is unknown, or that is
 * still being sent, still blocks the next until it is resolved, so a retry can never post the same text twice by itself.
 */
export async function sendPublicFeedback(target: PublicTarget, input?: { body?: unknown; typed?: string; interactive?: boolean; conversation?: boolean }): Promise<{ ok: boolean; code?: string; ownerRecorded?: boolean; commentId?: number; body?: string; found?: Found }> {
  let ownerRecorded = false;
  // GitHub's id for the comment this call posted (not set when it was already sent before): talking to the PM (#343) reads it back.
  let commentId: number | undefined;
  if (!REPOSITORY.test(target.repository) || !Number.isSafeInteger(target.number) || target.number < 1 || !/^[a-f0-9]{40,64}$/i.test(target.version)) return { ok: false, code: 'report-evidence-unavailable' };
  const opened = await privateStorage()?.use(); const store = useStore(opened);
  if (!store) return { ok: false, code: 'private-storage-unavailable' };
  const configured = publisher(store, target.repository);
  if (configured === 'unreadable') return { ok: false, code: 'private-storage-unavailable' };
  if (!configured) return { ok: false, code: 'publisher-not-configured' };
  const conversation = input?.conversation === true;
  const requestRecord = conversation ? `${recordId(target.repository, target.kind, target.number)}-talk` : recordId(target.repository, target.kind, target.number);
  const old = previous(store, target, requestRecord);
  if (old === 'unreadable') return { ok: false, code: 'private-storage-unavailable' };
  if (old?.status === 'unknown' || old?.status === 'sending') return { ok: false, code: 'outcome-unknown' };
  if (!conversation && old?.status === 'done' && old.version === target.version) return { ok: true, code: 'already-sent' };
  const allowBypass = testMode && input?.interactive === false;
  const initialDraft = old?.status === 'draft' && old.version === target.version && typeof old.body === 'string' ? old.body : '';
  // `typed`: what the person wrote in the Issue or pull request page (#353) instead of the input box. It is still shown whole in the
  // confirmation below and goes through the same checks; only the extension's own tests may skip the confirmation.
  const body = allowBypass ? input?.body : typeof input?.typed === 'string' ? input.typed : await hooks.prompt(initialDraft);
  if (body === undefined) return { ok: false, code: 'cancelled' };
  if (!plainText(body)) return { ok: false, code: 'invalid-public-feedback' };
  const requestId = old?.status === 'draft' && old.version === target.version && old.body === body && typeof old.requestId === 'string' ? old.requestId : `feedback_${randomBytes(12).toString('hex')}`;
  const draftSaved = store.put(COLLECTION, requestRecord, { kind: 'public-feedback-request-v1', repository: target.repository, targetKind: target.kind, number: target.number, version: target.version, status: 'draft', requestId, body, updatedAt: new Date().toISOString() });
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
    if (!save(store, target, { status, requestId, body, updatedAt: new Date().toISOString(), audit: { stage: entry.stage, outcome: entry.outcome ?? null } }, requestRecord)) throw new Error('audit-unavailable');
  } };
  const broker = new Broker({
    identity: { current: () => ({ actorId: String(actor.id), role: 'pm' }), actorIdForLogin: () => null },
    reader: {}, transport: { comment: async ({ number, body: sent }: any) => { const posted = await hooks.comment(auth, repository, number, sent); if (posted.ok) { ownerRecorded = recordOwnerPost(store, target.repository, 'comment', posted.number, number, sent); commentId = posted.number; } return posted; } }, audit,
    config: { pmActorId: configured.actorId, pmLogin: configured.login }, project: { repository }, store, scanOptions: refs, privateReferencesChecked: true
  });
  const result = await broker.request({ operation: 'comment', requestId, target: target.kind === 'issue' ? 'issue' : 'pr', number: target.number, body });
  return result.ok ? { ok: true, ownerRecorded, ...(commentId !== undefined ? { commentId, body: body as string } : {}) } : { ok: false, code: result.reason ?? 'write-refused', ...foundOf(result) };
}

export async function reviewPullRequestReport(target: PublicTarget, input?: { decision?: unknown; body?: unknown; interactive?: boolean; chosen?: { decision: ReviewDecision; typed?: string } }): Promise<{ ok: boolean; code?: string; ownerRecorded?: boolean; found?: Found }> {
  let ownerRecorded = false;
  if (target.kind !== 'pullRequest' || !REPOSITORY.test(target.repository) || !Number.isSafeInteger(target.number) || target.number < 1 || !SHA.test(target.version)) return { ok: false, code: 'report-evidence-unavailable' };
  const opened = await privateStorage()?.use(); const store = useStore(opened);
  if (!store) return { ok: false, code: 'private-storage-unavailable' };
  const configured = publisher(store, target.repository);
  if (configured === 'unreadable') return { ok: false, code: 'private-storage-unavailable' };
  if (!configured) return { ok: false, code: 'publisher-not-configured' };
  const id = reviewRecordId(target.repository, target.number);
  const old = previousBy(store, id, 'pr-review-request-v1');
  if (old === 'unreadable') return { ok: false, code: 'private-storage-unavailable' };
  if (old?.status === 'unknown' || old?.status === 'sending') return { ok: false, code: 'outcome-unknown' };
  const allowBypass = testMode && input?.interactive === false;
  // `chosen`: the button pressed on the Issue or pull request page (#383) and what was typed there as the review. The review is still
  // shown whole in the confirmation below; with nothing typed, the input box asks for it as from the text report.
  const pickedDecision = allowBypass ? input?.decision : input?.chosen !== undefined ? input.chosen.decision : await hooks.pickReviewDecision();
  if (pickedDecision === undefined) return { ok: false, code: 'cancelled' };
  if (pickedDecision !== 'approve' && pickedDecision !== 'request_changes' && pickedDecision !== 'comment') return { ok: false, code: 'invalid-review-decision' };
  if (old?.status === 'done' && old.version === target.version && old.decision === pickedDecision) return { ok: true, code: 'already-reviewed' };
  const initialDraft = old?.status === 'draft' && old.version === target.version && typeof old.body === 'string' ? old.body : '';
  const typed = input?.chosen?.typed;
  const body = allowBypass ? input?.body : typeof typed === 'string' && typed.trim() !== '' ? typed : await hooks.promptReview(initialDraft, pickedDecision);
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
    transport: { reviewPullRequest: async ({ number, decision, body: sent, expectedHeadSha }: any) => { const posted = await hooks.review(auth, repository, number, decision, sent, expectedHeadSha); if (posted.ok) ownerRecorded = recordOwnerPost(store, target.repository, 'review', posted.number, number, sent); return posted; } },
    audit,
    config: { pmActorId: configured.actorId, pmLogin: configured.login }, project: { repository }, store, scanOptions: refs, privateReferencesChecked: true
  });
  const result = await broker.request({ operation: 'reviewPr', requestId, number: target.number, decision: pickedDecision, body, expectedHeadSha: target.version.toLowerCase() });
  return result.ok ? { ok: true, ownerRecorded } : { ok: false, code: result.reason ?? 'write-refused', ...foundOf(result) };
}

export async function mergePullRequestReport(target: PublicTarget, input?: { interactive?: boolean }): Promise<{ ok: boolean; code?: string }> {
  if (target.kind !== 'pullRequest' || !REPOSITORY.test(target.repository) || !Number.isSafeInteger(target.number) || target.number < 1 || !SHA.test(target.version)) return { ok: false, code: 'report-evidence-unavailable' };
  const opened = await privateStorage()?.use(); const store = useStore(opened);
  if (!store) return { ok: false, code: 'private-storage-unavailable' };
  const configured = publisher(store, target.repository);
  if (configured === 'unreadable') return { ok: false, code: 'private-storage-unavailable' };
  if (!configured) return { ok: false, code: 'publisher-not-configured' };
  const authority = mergeAuthorityOf(store, target.repository);
  if (authority === 'unreadable') return { ok: false, code: 'private-storage-unavailable' };
  const id = mergeRecordId(target.repository, target.number);
  const old = previousBy(store, id, 'pr-merge-request-v1');
  if (old === 'unreadable') return { ok: false, code: 'private-storage-unavailable' };
  if (old?.status === 'unknown' || old?.status === 'sending') return { ok: false, code: 'outcome-unknown' };
  if (old?.status === 'done' && old.version === target.version) return { ok: true, code: 'already-merged' };
  const allowBypass = testMode && input?.interactive === false;
  if (authority === 'pm' && !allowBypass) {
    if (!await hooks.confirm(`Merge ${target.repository} PR #${target.number} (head ${target.version}) after verifying current-head PM approval, passing CI, resolved threads, supported branch rules, and publication scan? The merge commit title and body come from the pull request, with attribution trailer lines (Co-authored-by, Signed-off-by and similar) removed.`, 'Merge pull request')) return { ok: false, code: 'cancelled' };
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

export async function deleteMergedBranchReport(target: PublicTarget, input?: { interactive?: boolean }): Promise<{ ok: boolean; code?: string }> {
  if (target.kind !== 'pullRequest' || !REPOSITORY.test(target.repository) || !Number.isSafeInteger(target.number) || target.number < 1 || !SHA.test(target.version)) return { ok: false, code: 'report-evidence-unavailable' };
  const opened = await privateStorage()?.use(); const store = useStore(opened);
  if (!store) return { ok: false, code: 'private-storage-unavailable' };
  const configured = publisher(store, target.repository);
  if (configured === 'unreadable') return { ok: false, code: 'private-storage-unavailable' };
  if (!configured) return { ok: false, code: 'publisher-not-configured' };
  const id = branchRecordId(target.repository, target.number);
  const old = previousBy(store, id, 'pr-branch-delete-request-v1');
  if (old === 'unreadable') return { ok: false, code: 'private-storage-unavailable' };
  if (old?.status === 'unknown' || old?.status === 'sending') return { ok: false, code: 'outcome-unknown' };
  if (old?.status === 'done' && old.version === target.version) return { ok: true, code: 'already-deleted' };
  const allowBypass = testMode && input?.interactive === false;
  if ((await hooks.repository())?.toLowerCase() !== target.repository.toLowerCase()) return { ok: false, code: 'report-context-changed' };
  const auth = await hooks.session(false); if (!auth) return { ok: false, code: 'github-sign-in-required' };
  const actor = await hooks.user(auth); if (!actor || String(actor.id) !== configured.actorId || actor.login.toLowerCase() !== configured.login.toLowerCase()) return { ok: false, code: 'publisher-identity-changed' };
  const snapshot = await hooks.snapshot(target);
  const branch = snapshot?.pullRequest?.data?.headRef;
  if (!allowBypass) {
    // The person sees which branch goes, read now, before anything is deleted.
    const name = typeof branch === 'string' ? branch : 'the head branch';
    if (!await hooks.confirm(`Delete the branch “${name}” of ${target.repository} PR #${target.number} (head ${target.version})? Only a merged pull request's unprotected, non-default branch in this repository is deleted; the commits stay in the merged history.`, 'Delete branch')) return { ok: false, code: 'cancelled' };
  }
  const refs = privateReferences(store); if (!refs) return { ok: false, code: 'private-reference-unreadable' };
  const match = REPOSITORY.exec(target.repository)!; const repository = { owner: match[1], name: match[2] };
  const requestId = `branch_${randomBytes(12).toString('hex')}`;
  const audit = { record(entry: any) {
    const status = entry.stage === 'result' ? (entry.outcome === 'done' ? 'done' : entry.outcome === 'unknown' ? 'unknown' : 'draft') : 'sending';
    if (!saveBy(store, id, 'pr-branch-delete-request-v1', target, { status, requestId, updatedAt: new Date().toISOString(), audit: { stage: entry.stage, outcome: entry.outcome ?? null } })) throw new Error('audit-unavailable');
  } };
  const broker = new Broker({
    identity: { current: () => ({ actorId: String(actor.id), role: 'pm' }), actorIdForLogin: () => null },
    reader: {
      getPullRequestSnapshot: async (number: number) => await hooks.snapshot({ ...target, number }),
      getRepository: async () => await hooks.repositoryInfo(target),
      getBranchRequirements: async (name: string) => await hooks.branchRequirements(target, name),
      getBranchHead: async (name: string) => await hooks.branchHead(auth, repository, name)
    },
    transport: { deleteBranch: ({ branch: name, expectedHeadSha }: any) => hooks.deleteBranch(auth, repository, name, expectedHeadSha) },
    audit,
    config: { pmActorId: configured.actorId, pmLogin: configured.login }, project: { repository }, store, scanOptions: refs, privateReferencesChecked: true
  });
  const result = await broker.request({ operation: 'deleteBranch', requestId, number: target.number, expectedHeadSha: target.version.toLowerCase() });
  return result.ok ? { ok: true } : { ok: false, code: result.reason ?? 'write-refused' };
}

export async function closeIssueReport(target: PublicTarget, input?: { reason?: unknown; interactive?: boolean; chosen?: CloseReason }): Promise<{ ok: boolean; code?: string }> {
  if (target.kind !== 'issue' || !REPOSITORY.test(target.repository) || !Number.isSafeInteger(target.number) || target.number < 1 || !/^[a-f0-9]{40,64}$/i.test(target.version)) return { ok: false, code: 'report-evidence-unavailable' };
  const opened = await privateStorage()?.use(); const store = useStore(opened);
  if (!store) return { ok: false, code: 'private-storage-unavailable' };
  const configured = publisher(store, target.repository);
  if (configured === 'unreadable') return { ok: false, code: 'private-storage-unavailable' };
  if (!configured) return { ok: false, code: 'publisher-not-configured' };
  const id = closeRecordId(target.repository, target.number);
  const old = previousBy(store, id, 'issue-close-request-v1');
  if (old === 'unreadable') return { ok: false, code: 'private-storage-unavailable' };
  if (old?.status === 'unknown' || old?.status === 'sending') return { ok: false, code: 'outcome-unknown' };
  // The confirmation and the reason come from the person. Only the Extension Host tests may supply them.
  const allowBypass = testMode && input?.interactive === false;
  // `chosen`: the button pressed on the Issue page (#383); the confirmation below still asks.
  const picked = allowBypass ? input?.reason : input?.chosen !== undefined ? input.chosen : await hooks.pickCloseReason();
  if (picked === undefined) return { ok: false, code: 'cancelled' };
  if (picked !== 'completed' && picked !== 'not_planned') return { ok: false, code: 'invalid-close-reason' };
  if (old?.status === 'done' && old.version === target.version && old.reason === picked) return { ok: true, code: 'already-closed' };
  if (!allowBypass) {
    if (!await hooks.confirm(`Close ${target.repository} Issue #${target.number} as ${picked === 'completed' ? 'completed' : 'not planned'}? Closing is visible to everyone and does not remove the Issue.`, 'Close Issue')) return { ok: false, code: 'cancelled' };
  }
  if ((await hooks.repository())?.toLowerCase() !== target.repository.toLowerCase()) return { ok: false, code: 'report-context-changed' };
  const auth = await hooks.session(false); if (!auth) return { ok: false, code: 'github-sign-in-required' };
  const actor = await hooks.user(auth); if (!actor || String(actor.id) !== configured.actorId || actor.login.toLowerCase() !== configured.login.toLowerCase()) return { ok: false, code: 'publisher-identity-changed' };
  // The report the person read must still be the Issue as it is now.
  const current = await hooks.version(target); if (!current || current.toLowerCase() !== target.version.toLowerCase()) return { ok: false, code: 'report-context-changed' };
  const refs = privateReferences(store); if (!refs) return { ok: false, code: 'private-reference-unreadable' };
  const match = REPOSITORY.exec(target.repository)!; const repository = { owner: match[1], name: match[2] };
  const requestId = old?.status === 'draft' && old.version === target.version && old.reason === picked && typeof old.requestId === 'string' ? old.requestId : `close_${randomBytes(12).toString('hex')}`;
  const audit = { record(entry: any) {
    const status = entry.stage === 'result' ? (entry.outcome === 'done' ? 'done' : entry.outcome === 'unknown' ? 'unknown' : 'draft') : 'sending';
    if (!saveBy(store, id, 'issue-close-request-v1', target, { reason: picked, status, requestId, updatedAt: new Date().toISOString(), audit: { stage: entry.stage, outcome: entry.outcome ?? null } })) throw new Error('audit-unavailable');
  } };
  const broker = new Broker({
    identity: { current: () => ({ actorId: String(actor.id), role: 'pm' }), actorIdForLogin: () => null },
    reader: { getIssue: async (number: number) => await hooks.issue({ ...target, number }) },
    transport: { closeIssue: ({ number, reason }: any) => hooks.closeIssue(auth, repository, number, reason) },
    audit,
    config: { pmActorId: configured.actorId, pmLogin: configured.login }, project: { repository }, store, scanOptions: refs, privateReferencesChecked: true
  });
  const result = await broker.request({ operation: 'closeIssue', requestId, number: target.number, reason: picked });
  return result.ok ? { ok: true } : { ok: false, code: result.reason ?? 'write-refused' };
}

const { assessMerge } = require('../delivery/merge') as { assessMerge(snapshot: unknown, input: Record<string, unknown>): { ok: boolean; reason?: string } };
const { evaluatePublishRequest } = require('../publish-policy') as { evaluatePublishRequest(request: Record<string, unknown>, config: Record<string, unknown>): { allowed: boolean; reason: string } };
export type PageWriteFacts = {
  publisher: 'configured' | 'none' | 'unreadable';
  pending: Record<'review' | 'merge' | 'branch' | 'close', 'clear' | 'unknown' | 'unreadable'>;
  state: string;
  authority?: MergeAuthorityMode | 'unreadable';
  review?: { ok: boolean; reason?: string } | null;
  merge?: { ok: boolean; reason?: string } | null;
};
// The GitHub id of a pull request's author, once found: the page is read again every 45 seconds and the author does not change.
const authorIds = new Map<string, string>();

/**
 * What the Issue and pull request page (#383) needs to know to turn its decision buttons on or off: the same records and checks the
 * four functions above use (publisher, merge authority, the record of earlier attempts, the publication policy for a review and the
 * merge assessment of the snapshot the page was read from). Nothing is written and nothing is asked. What cannot be read stays
 * "unreadable" (or null), and the page then shows the button off with "unknown".
 */
export async function pageWriteFacts(input: { repository: string; kind: Kind; number: number; state: string; snapshot?: unknown }): Promise<PageWriteFacts | null> {
  if (!REPOSITORY.test(input.repository) || !Number.isSafeInteger(input.number) || input.number < 1) return null;
  let store: Store | null = null;
  try { store = useStore(await privateStorage()?.use()); } catch { store = null; }
  if (!store) return null;
  const configured = publisher(store, input.repository);
  const pendingOf = (id: string, kind: string): 'clear' | 'unknown' | 'unreadable' => {
    const old = previousBy(store!, id, kind);
    return old === 'unreadable' ? 'unreadable' : old?.status === 'unknown' || old?.status === 'sending' ? 'unknown' : 'clear';
  };
  const pending = {
    review: pendingOf(reviewRecordId(input.repository, input.number), 'pr-review-request-v1'),
    merge: pendingOf(mergeRecordId(input.repository, input.number), 'pr-merge-request-v1'),
    branch: pendingOf(branchRecordId(input.repository, input.number), 'pr-branch-delete-request-v1'),
    close: pendingOf(closeRecordId(input.repository, input.number), 'issue-close-request-v1')
  };
  const facts: PageWriteFacts = { publisher: configured === 'unreadable' ? 'unreadable' : configured ? 'configured' : 'none', pending, state: input.state };
  if (input.kind !== 'pullRequest' || !configured || configured === 'unreadable') return facts;
  facts.authority = mergeAuthorityOf(store, input.repository);
  const snapshot = input.snapshot as any;
  const author = snapshot?.pullRequest?.data?.author;
  const headSha = typeof snapshot?.headSha === 'string' ? snapshot.headSha : null;
  if (typeof author !== 'string' || !headSha) { facts.review = null; facts.merge = null; return facts; }
  // Who opened the pull request, as a GitHub id (the policy compares ids, never logins); found without asking to sign in.
  const key = `${configured.actorId}:${author.toLowerCase()}`;
  let authorId = author.toLowerCase() === configured.login.toLowerCase() ? configured.actorId : authorIds.get(key) ?? null;
  if (!authorId) {
    const auth = await hooks.session(false);
    if (!auth) { facts.review = { ok: false, reason: 'github-sign-in-required' }; facts.merge = facts.review; return facts; }
    authorId = await hooks.authorId(auth, author, configured);
    if (authorId) authorIds.set(key, authorId);
  }
  if (!authorId) { facts.review = null; facts.merge = null; return facts; }
  const review = evaluatePublishRequest({ operation: 'reviewPr', role: 'pm', actorId: configured.actorId, pullRequest: { authorId, headSha, state: snapshot?.pullRequest?.data?.state } }, { pmActorId: configured.actorId });
  facts.review = review.allowed ? { ok: true } : { ok: false, reason: review.reason };
  facts.merge = facts.authority === 'unreadable' ? null : assessMerge(snapshot, { role: 'pm', actorId: configured.actorId, authorId, pmLogin: configured.login, policyConfig: { pmActorId: configured.actorId, pmLogin: configured.login, mergeAuthority: facts.authority }, expectedNumber: input.number });
  return facts;
}
