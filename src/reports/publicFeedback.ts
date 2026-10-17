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
const COLLECTION = 'policies';
const MAX_PRIVATE_REFS = 5000;
const PUBLIC_KEYS = new Set(['kind', 'targetKind', 'provider', 'role', 'state', 'status', 'scope', 'type', 'mode', 'unknownQuota', 'repository', 'headSha', 'version', 'requestedModel', 'createdAt', 'updatedAt', 'configuredAt', 'expiresAt', 'revokedAt', 'savedAt']);
const PUBLIC_VALUES = new Set(['unassigned', 'allow', 'deny', 'ask', 'unknown', 'claude', 'codex', 'agy', 'issue', 'pullRequest', 'worker', 'researcher', 'pm']);
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const recordId = (repository: string, kind: string, number: number): string => `public-feedback-${hash(repository.toLowerCase()).slice(0, 20)}-${kind}-${number}`;
const plainText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && Array.from(value).length <= 4000 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);

type Kind = 'issue' | 'pullRequest';
export type PublicTarget = { repository: string; kind: Kind; number: number; version: string };
type Store = { get(collection: string, id: string): any; put(collection: string, id: string, value: unknown): any; list(collection: string): any };
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
  const auth = await hooks.session(true); if (!auth) return { ok: false, code: 'github-sign-in-required' };
  const user = await hooks.user(auth); if (!user) return { ok: false, code: 'github-identity-unverified' };
  if (!await hooks.confirm(`Allow the signed-in GitHub user ${user.login} to publish report feedback as this machine's PM?`, 'Configure PM publisher')) return { ok: false, code: 'cancelled' };
  const saved = store.put(COLLECTION, POLICY_ID, { kind: 'public-feedback-publisher-v1', actorId: String(user.id), login: user.login, configuredAt: new Date().toISOString() });
  return saved?.ok ? { ok: true } : { ok: false, code: 'private-storage-unavailable' };
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
      if (collection === 'policies' && (item.id === POLICY_ID || item.id.startsWith('public-feedback-') || item.id.startsWith('broker-req-'))) continue;
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
type Hooks = {
  session(create: boolean): Promise<vscode.AuthenticationSession | null>;
  user(auth: vscode.AuthenticationSession): Promise<GitHubUser | null>;
  version(target: PublicTarget): Promise<string | null>;
  comment(auth: vscode.AuthenticationSession, repository: { owner: string; name: string }, number: number, body: string): Promise<{ ok: boolean; number?: number }>;
  confirm(message: string, action: string): Promise<boolean>;
  prompt(initialValue: string): Promise<string | undefined>;
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
const realHooks: Hooks = {
  session: realSession, user: userFor, version: currentVersion, comment: realComment,
  confirm: async (message, action) => (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action,
  prompt: async (value) => await vscode.window.showInputBox({ prompt: 'Public GitHub comment (starts blank; private feedback is never copied here)', value, ignoreFocusOut: true }),
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
  const initialDraft = old?.status === 'draft' && old.version === target.version && typeof old.body === 'string' ? old.body : '';
  const body = input?.interactive === false ? input.body : await hooks.prompt(initialDraft);
  if (body === undefined) return { ok: false, code: 'cancelled' };
  if (!plainText(body)) return { ok: false, code: 'invalid-public-feedback' };
  const requestId = old?.status === 'draft' && old.version === target.version && old.body === body && typeof old.requestId === 'string' ? old.requestId : `feedback_${randomBytes(12).toString('hex')}`;
  const draftSaved = store.put(COLLECTION, recordId(target.repository, target.kind, target.number), { kind: 'public-feedback-request-v1', repository: target.repository, targetKind: target.kind, number: target.number, version: target.version, status: 'draft', requestId, body, updatedAt: new Date().toISOString() });
  if (!draftSaved?.ok && draftSaved?.reason !== 'secret-detected') return { ok: false, code: 'private-storage-unavailable' };
  if (input?.interactive !== false) {
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
