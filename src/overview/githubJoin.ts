import * as fs from 'node:fs';
import { WorktreeService } from '../projects/worktrees';

// Finds, for each session, the branch its worktree is on and the open pull request and checks that
// belong to it. Everything that touches Git, the network or the editor is injected, so the join can
// be tested with real folders and a fake reader. A read that is not complete is passed on as such:
// the overview model turns it into "unknown", never into "no pull request".

export interface JoinSession { id: string; worktree: string }

export interface WorktreeInfo { repository: string | null; branch: string | null }

export interface PullRequestListEntry { number: number; state: string; headRef?: string | null; headSha?: string; [key: string]: unknown }

export interface JoinReader {
  listPullRequests(filter: { state: 'open' }): Promise<{ kind: string; data?: PullRequestListEntry[] }>;
  getPullRequestSnapshot(number: number): Promise<{ status: string; checksSummary?: { state?: string; requiredState?: string; headSha?: string } | null }>;
}

export interface JoinDeps {
  worktreeInfo(worktree: string): Promise<WorktreeInfo | null>;
  readerFor(repository: string): JoinReader | null;
  now(): Date;
}

export interface GitHubInput {
  kind: string;
  fetchedAt: string;
  pullRequests?: Array<{ pullRequest: PullRequestListEntry; checks?: { state: string; requiredState: string; headSha: string } }>;
}

export interface JoinGroup { repository: string; sessionIds: string[]; github: GitHubInput }
export interface JoinResult { branches: Record<string, string>; groups: JoinGroup[] }

// Checks are read one pull request at a time, so only pull requests that match a session's branch are
// read, and no more than this many per refresh.
export const MAX_CHECK_READS = 20;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

export async function collectGitHub(sessions: JoinSession[], deps: JoinDeps): Promise<JoinResult> {
  const branches: Record<string, string> = Object.create(null);
  const byRepository = new Map<string, JoinSession[]>();
  for (const session of sessions) {
    let info: WorktreeInfo | null = null;
    try {
      info = await deps.worktreeInfo(session.worktree);
    } catch {
      info = null;
    }
    if (!info) continue;
    if (typeof info.branch === 'string' && info.branch !== '') branches[session.id] = info.branch;
    if (typeof info.repository === 'string' && REPOSITORY.test(info.repository)) {
      const key = info.repository;
      byRepository.set(key, [...(byRepository.get(key) ?? []), session]);
    }
  }

  const groups: JoinGroup[] = [];
  let checkReads = 0;
  for (const [repository, members] of byRepository) {
    const fetchedAt = deps.now().toISOString();
    const reader = deps.readerFor(repository);
    if (!reader) { groups.push({ repository, sessionIds: members.map((member) => member.id), github: { kind: 'denied', fetchedAt } }); continue; }
    let listed: { kind: string; data?: PullRequestListEntry[] };
    try {
      listed = await reader.listPullRequests({ state: 'open' });
    } catch {
      listed = { kind: 'invalid' };
    }
    const complete = listed.kind === 'ok' || listed.kind === 'empty';
    if (!complete) { groups.push({ repository, sessionIds: members.map((member) => member.id), github: { kind: listed.kind, fetchedAt } }); continue; }
    const list = Array.isArray(listed.data) ? listed.data : [];
    const wanted = new Set(members.map((member) => branches[member.id]).filter((branch): branch is string => typeof branch === 'string'));
    const pullRequests: NonNullable<GitHubInput['pullRequests']> = [];
    for (const pullRequest of list) {
      const entry: NonNullable<GitHubInput['pullRequests']>[number] = { pullRequest };
      if (typeof pullRequest.headRef === 'string' && wanted.has(pullRequest.headRef) && checkReads < MAX_CHECK_READS && Number.isSafeInteger(pullRequest.number)) {
        checkReads += 1;
        try {
          const snapshot = await reader.getPullRequestSnapshot(pullRequest.number);
          const summary = snapshot.status === 'complete' ? snapshot.checksSummary : null;
          if (summary && typeof summary.state === 'string' && typeof summary.requiredState === 'string' && typeof summary.headSha === 'string') {
            entry.checks = { state: summary.state, requiredState: summary.requiredState, headSha: summary.headSha };
          }
        } catch {
          // checks stay unread; the model shows CI as unknown
        }
      }
      pullRequests.push(entry);
    }
    groups.push({ repository, sessionIds: members.map((member) => member.id), github: { kind: listed.kind, fetchedAt, pullRequests } });
  }
  return { branches, groups };
}

/**
 * The branch a session's worktree is on and the GitHub repository of its origin, from real Git. The
 * worktree is matched by its resolved path, never by name; a worktree that cannot be matched, or one on
 * a detached head, has no branch (unknown).
 */
export async function worktreeInfoFor(worktree: string): Promise<WorktreeInfo> {
  const service = await WorktreeService.open(worktree);
  const wanted = fs.realpathSync.native(worktree);
  const entries: Array<{ path: string; branch: string | null }> = await service.list();
  const entry = entries.find((candidate) => {
    try { return fs.realpathSync.native(candidate.path) === wanted; } catch { return false; }
  });
  // The service names the repository as github.com/owner/name; the readers and the model use owner/name.
  const repository = typeof service.githubRepository === 'string' ? service.githubRepository.replace(/^github\.com\//i, '') : null;
  return { repository, branch: entry?.branch ?? null };
}
