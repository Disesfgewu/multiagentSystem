import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { commandCenterForTests } from '../../../src/commandCenter/commandCenter';
import { setReportDepsForTests } from '../../../src/reports/reportsView';
import { githubPageForTests } from '../../../src/reports/githubPage';

const WORKBENCH_COMMAND = 'multiagentSystem.workbench.open';

/**
 * #397 in a real Extension Host: the Work tab's board is read through the report module's reader (a synthetic GitHub here) and built
 * by the board module; a PM verdict counts only from the repository owner's account with a PM signature; an item the board shows
 * opens its page, and one it does not show is refused.
 */
export async function runWorkBoardChecks(): Promise<void> {
  const HEAD = 'c'.repeat(40);
  const ok = (data: unknown) => ({ kind: 'ok', data });
  const issues = [
    { number: 41, title: 'Backlog one', state: 'open', labels: [], isPullRequest: false, createdAt: '2026-10-20T00:00:00Z' },
    { number: 42, title: 'Needs changes one', state: 'open', labels: ['ready'], isPullRequest: false, createdAt: '2026-10-20T00:00:00Z' },
    { number: 43, title: 'Forged one', state: 'open', labels: ['ready'], isPullRequest: false, createdAt: '2026-10-20T00:00:00Z' }
  ];
  const pr = (number: number, issue: number) => ({ number, title: `PR ${number}`, state: 'open', merged: false, draft: false, headSha: HEAD, referencedIssues: [{ number: issue }], createdAt: '2026-10-21T00:00:00Z', updatedAt: '2026-10-22T00:00:00Z' });
  const comments: Record<number, unknown[]> = {
    420: [{ id: 1, author: 'host', createdAt: '2026-10-23T00:00:00Z', body: '— PM-01\n結論：Needs changes｜head `ccccccc`' }],
    430: [{ id: 2, author: 'someone-else', createdAt: '2026-10-23T00:00:00Z', body: '— PM-01\n結論：Needs changes｜head `ccccccc`' }]
  };
  let reads = 0;
  const reader: any = {
    listIssues: async ({ state }: { state: string }) => { reads += 1; return ok(state === 'open' ? issues : []); },
    listPullRequests: async ({ state }: { state: string }) => ok(state === 'open' ? [pr(420, 42), pr(430, 43)] : []),
    getIssue: async (number: number) => ok(issues.find((entry) => entry.number === number)),
    getIssueComments: async (number: number) => ok(comments[number] ?? []),
    getReviews: async () => ok([]),
    getReviewComments: async () => ok([]),
    getPullRequest: async (number: number) => ok(pr(number, number / 10)),
    getPullRequestFiles: async () => ok([]),
    getPullRequestSnapshot: async (number: number) => ({ status: 'complete', consistent: true, headSha: HEAD, checksSummary: { headSha: HEAD, state: 'passing' }, pullRequest: ok(pr(number, number / 10)) })
  };
  setReportDepsForTests({ repository: async () => 'host/repo', readerFor: () => reader });
  try {
    await vscode.commands.executeCommand(WORKBENCH_COMMAND, { tab: 'work' });
    const center = commandCenterForTests();
    // Nothing was shown yet: nothing can be opened from it.
    assert.deepEqual(await center.handle({ type: 'openWorkItem', kind: 'issue', number: 41 }), { ok: false, reason: 'unknown-item' });
    assert.deepEqual(await center.handle({ type: 'loadBoard' }), { ok: true, command: 'loadBoard' });
    assert.ok(reads > 0, 'the board was read through the report reader');
    const board = center.board() as { state: string; columns: Array<{ id: string; cards: Array<{ number: number; pr: { verdict: string } | null }> }> };
    assert.equal(board.state, 'ok');
    const where = Object.fromEntries(board.columns.flatMap((column) => column.cards.map((card) => [card.number, column.id])));
    assert.deepEqual(where, { 41: 'backlog', 42: 'changes', 43: 'review' }, JSON.stringify(where));
    assert.equal(board.columns.find((column) => column.id === 'review')?.cards[0].pr?.verdict, 'none yet', 'a verdict from another account is not one');
    // An item on the board opens its page; one that is not on it is refused, whatever the page sends.
    assert.deepEqual(await center.handle({ type: 'openWorkItem', kind: 'issue', number: 42 }), { ok: true, command: 'openWorkItem' });
    const deadline = Date.now() + 10000;
    while (!githubPageForTests('issue', 42) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    const page = githubPageForTests('issue', 42);
    assert.ok(page, 'the Issue page opened');
    page.stop();
    assert.deepEqual(await center.handle({ type: 'openWorkItem', kind: 'issue', number: 99 }), { ok: false, reason: 'unknown-item' });
    assert.deepEqual(await center.handle({ type: 'openWorkItem', kind: 'pullRequest', number: 42 }), { ok: false, reason: 'unknown-item' });
  } finally {
    githubPageForTests('issue', 42)?.stop();
    setReportDepsForTests(undefined);
  }
  console.log('host smoke: the Work tab\'s board is read through the report reader, places each Issue by GitHub and the trusted PM verdict only, and opens only an item it shows');
}
