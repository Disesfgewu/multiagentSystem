import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { commandCenterForTests } from '../../../src/commandCenter/commandCenter';
import { setReportDepsForTests } from '../../../src/reports/reportsView';
import { githubPageForTests } from '../../../src/reports/githubPage';
import { countTasksSent } from '../../../src/dispatch/commands';

type Guide = { steps: Array<{ id: string; done: boolean | 'unknown' }>; done: number; next: string | null; complete: boolean; hidden: boolean };

/**
 * #357's first steps in a real Extension Host: the Workbench's state carries the five steps read from the real stores (accounts, role
 * groups, sessions, the task log); opening a pull request page marks the last step done in this workspace; hiding them from the
 * Agents tab and showing them again is kept by the extension. Nothing the page sends can tick a step.
 */
export async function runGettingStartedChecks(): Promise<void> {
  const HEAD = 'd'.repeat(40);
  const ok = (data: unknown) => ({ kind: 'ok', data });
  const pr = { number: 510, title: 'PR 510', state: 'open', merged: false, draft: false, headSha: HEAD, referencedIssues: [{ number: 51 }], createdAt: '2026-10-21T00:00:00Z', updatedAt: '2026-10-22T00:00:00Z' };
  const reader: any = {
    listIssues: async ({ state }: { state: string }) => ok(state === 'open' ? [{ number: 51, title: 'Guide one', state: 'open', labels: ['ready'], isPullRequest: false, createdAt: '2026-10-20T00:00:00Z' }] : []),
    listPullRequests: async ({ state }: { state: string }) => ok(state === 'open' ? [pr] : []),
    getIssue: async () => ok({ number: 51, title: 'Guide one', state: 'open', labels: [], isPullRequest: false, createdAt: '2026-10-20T00:00:00Z' }),
    getIssueComments: async () => ok([]),
    getReviews: async () => ok([]),
    getReviewComments: async () => ok([]),
    getPullRequest: async () => ok(pr),
    getPullRequestFiles: async () => ok([]),
    getPullRequestSnapshot: async () => ({ status: 'complete', consistent: true, headSha: HEAD, checksSummary: { headSha: HEAD, state: 'passing' }, pullRequest: ok(pr) })
  };
  setReportDepsForTests({ repository: async () => 'host/repo', readerFor: () => reader });
  try {
    await vscode.commands.executeCommand('multiagentSystem.workbench.open', { tab: 'agents' });
    const center = commandCenterForTests();
    await center.refresh();
    const guide = (): Guide => (center.state() as { guide: Guide }).guide;
    assert.deepEqual(guide().steps.map((step) => step.id), ['account', 'role', 'agent', 'task', 'review']);
    // The earlier suites made accounts, role groups and sessions: read from the stores, these are done. The task log is read as it
    // is now (the suites remove what they sent), and the last step starts again from not done.
    assert.deepEqual(guide().steps.slice(0, 3).map((step) => step.done), [true, true, true], JSON.stringify(guide()));
    const tasks = await countTasksSent();
    assert.equal(typeof tasks, 'number');
    assert.equal(guide().steps[3].done, (tasks ?? 0) > 0);
    await center.forgetReviewed();
    await center.refresh();
    assert.equal(guide().steps[4].done, false);
    assert.equal(guide().complete, false);

    // A page message cannot tick a step: only opening a pull request page does.
    assert.equal((await center.handle({ type: 'guideShow', step: 'review', done: true })).ok, false);
    assert.equal(guide().steps[4].done, false, 'still not done');
    const opened = await vscode.commands.executeCommand<{ ok: boolean }>('multiagentSystem.reports.openPage', { kind: 'pullRequest', number: 510 });
    assert.equal(opened?.ok, true, JSON.stringify(opened));
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await center.refresh();
      if (guide().steps[4].done === true) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(guide().steps[4].done, true, 'a pull request page was opened in this workspace');
    assert.equal(guide().done, (tasks ?? 0) > 0 ? 5 : 4);

    // Hidden from the Agents tab, then shown again from Setup: the extension keeps it.
    assert.deepEqual(await center.handle({ type: 'guideHide' }), { ok: true, command: 'guideHide' });
    assert.equal(guide().hidden, true);
    assert.deepEqual(await center.handle({ type: 'guideShow' }), { ok: true, command: 'guideShow' });
    assert.equal(guide().hidden, false);
  } finally {
    githubPageForTests('pullRequest', 510)?.stop();
    setReportDepsForTests(undefined);
  }
  console.log('host smoke: the Workbench\'s five first steps are read from the real stores, opening a pull request page marks the last one done, and hiding or showing them is kept; a page message cannot tick one');
}
