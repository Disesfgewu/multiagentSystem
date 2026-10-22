import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { overviewTreeForTests, setJoinDepsForTests, setGitEvidenceReaderForTests, OVERVIEW_VIEW, OVERVIEW_REFRESH, OVERVIEW_OPEN_PULL_REQUEST, OVERVIEW_OPEN_REPORT, OVERVIEW_SHOW_DIFF } from '../../../src/overview/overviewView';
import { setReportDepsForTests } from '../../../src/reports/reportsView';

interface Started { ok: boolean; session?: { id: string } }

// The overview in a real Extension Host with real native terminals. `launch: false` opens only the
// shell and types nothing, so no CLI starts on the machine running the test.
export async function runOverviewChecks(workspace: string): Promise<string> {
  const registered = await vscode.commands.getCommands(true);
  assert.ok(registered.includes(OVERVIEW_REFRESH), 'the overview refresh command is registered');
  assert.ok(registered.includes(OVERVIEW_OPEN_REPORT), 'the overview open report command is registered');
  assert.ok(registered.includes(OVERVIEW_SHOW_DIFF), 'the overview show diff command is registered');
  const manifest = vscode.extensions.all.find((candidate) => candidate.packageJSON?.name === 'multiagentsystem')?.packageJSON;
  assert.ok(manifest, 'the manifest is readable');
  const container = manifest.contributes.viewsContainers.activitybar.find((entry: { id: string }) => entry.id === 'multiagentSystem');
  const ids = manifest.contributes.views.multiagentSystem.map((view: { id: string }) => view.id);
  assert.deepEqual(ids, [OVERVIEW_VIEW, 'multiagentSystem.issuesReportView', 'multiagentSystem.prsReportView', 'multiagentSystem.githubView', 'multiagentSystem.accountsView', 'multiagentSystem.rolesView', 'multiagentSystem.broadcastsView', 'multiagentSystem.memoryView', 'multiagentSystem.toolsSetupView']);
  assert.equal(manifest.contributes.views.explorer, undefined, 'nothing is left in the Explorer');

  const tree = overviewTreeForTests();
  const before = (await tree.getChildren()) ?? [];
  assert.ok(before.length > 0, 'the overview is never blank: it shows the guide or a state');
  assert.equal(before.some((row) => String(row.label).startsWith('Session')), false);

  const started = await vscode.commands.executeCommand<Started>('multiagentSystem.sessions.start', { interactive: false, provider: 'claude', name: 'Overview Session', cwd: workspace, launch: false });
  assert.equal(started?.ok, true);
  try {
    const rows = (await tree.getChildren()) ?? [];
    const agent = rows.find((row) => row.label === 'Overview Session');
    assert.ok(agent, 'a started session is one row in the overview');
    const text = String(agent?.description ?? '');
    assert.match(text, /terminal open, CLI not started/, 'a shell alone is not described as an agent working');
    assert.match(text, /unknown/, 'role and account have no source yet and say so');
    assert.doesNotMatch(text, /working|running|%|progress/i);
    assert.equal(agent?.contextValue, 'multiagentOverviewAgentLive');
    assert.equal((agent?.command as { command?: string } | undefined)?.command, 'multiagentSystem.sessions.focus');
    const tooltip = String(agent?.tooltip ?? '');
    assert.match(tooltip, /Pull request: unknown/);
    assert.match(tooltip, /CI: unknown/);
    assert.ok(rows.some((row) => row.label === 'Agents'), 'the agents section is labelled');

    // the guide steps follow the real state: this session has no account assigned, so it is a record of
    // a terminal, not a running agent with an account, and the "start an agent" step is NOT ticked
    const step = rows.find((row) => row.label === 'Start an agent with an account');
    assert.ok(step, 'the guide is still shown');
    assert.notEqual(step?.description, 'done', 'a session without an account does not complete the step');

    // GitHub: a fake reader (no network) returns an open pull request on this session's branch.
    const sha = 'c'.repeat(40);
    const pullRequest = (over: Record<string, unknown> = {}) => ({ number: 5, state: 'open', draft: false, title: 'Host PR', headRef: 'feat/host', headSha: sha, headRepository: 'host/repo', ...over });
    const fakeDeps = (list: { kind: string; data?: unknown[] }) => ({
      now: () => new Date('2026-10-16T00:00:00.000Z'),
      worktreeInfo: async () => ({ repository: 'host/repo', branch: 'feat/host' }),
      readerFor: () => ({
        listPullRequests: async () => list,
        getPullRequestSnapshot: async () => ({ status: 'complete', checksSummary: { state: 'passing', requiredState: 'passing', headSha: sha } })
      })
    });
    const rowNow = async () => ((await overviewTreeForTests().getChildren()) ?? []).find((entry) => entry.label === 'Overview Session');
    try {
      // The working folder of this host run is not the subject of the PR checks below: a clean, known state keeps them exact.
      setGitEvidenceReaderForTests(async () => ({ state: 'known', source: 'local git', changed: 0, untracked: 0, dirty: false, head: 'abcdef123456', branch: 'feat/host', upstream: { ahead: 0, behind: 0 } }));
      setJoinDepsForTests(fakeDeps({ kind: 'ok', data: [pullRequest()] }) as never);
      const withPr = await rowNow();
      assert.match(String(withPr?.description ?? ''), /· PR #5 · CI passing$/);
      assert.equal(withPr?.contextValue, 'multiagentOverviewAgentLivePr');
      assert.match(String(withPr?.tooltip ?? ''), /Branch: feat\/host/);
      assert.match(String(withPr?.tooltip ?? ''), /Pull request: #5/);
      assert.match(String(withPr?.tooltip ?? ''), /Issue: unknown/);

      setJoinDepsForTests(fakeDeps({ kind: 'ok', data: [pullRequest({ referencedIssues: [{ number: 13 }] })] }) as never);
      const withIssue = await rowNow();
      assert.match(String(withIssue?.tooltip ?? ''), /Issue: #13/);

      const fakeReportReader = {
        listIssues: async () => ({ kind: 'ok', data: [] }),
        getIssue: async () => ({ kind: 'ok', data: undefined }),
        getIssueComments: async () => ({ kind: 'ok', data: [] }),
        listPullRequests: async () => ({ kind: 'ok', data: [] }),
        getPullRequest: async () => ({ kind: 'ok', data: { number: 5, title: 'Host PR', state: 'open', draft: false, headRef: 'feat/host', headSha: sha, headRepository: 'host/repo', body: 'Refs #13', referencedIssues: [{ number: 13 }] } }),
        getPullRequestFiles: async () => ({ kind: 'ok', data: [{ filename: 'src/overview.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' }] }),
        getPullRequestSnapshot: async () => ({ status: 'complete', headSha: sha, checksSummary: { state: 'passing', requiredState: 'passing', headSha: sha } }),
        getReviews: async () => ({ kind: 'ok', data: [] }),
        getReviewComments: async () => ({ kind: 'ok', data: [] })
      };
      setReportDepsForTests({ repository: async () => 'host/repo', readerFor: () => fakeReportReader });

      const openReportResult = await vscode.commands.executeCommand<{ ok: boolean; code?: string }>(OVERVIEW_OPEN_REPORT, started.session?.id);
      assert.equal(openReportResult?.ok, true, 'openReport opens the in-editor pull request report');
      assert.equal(vscode.window.activeTextEditor?.document.uri.scheme, 'multiagent-report');
      assert.match(vscode.window.activeTextEditor?.document.uri.path ?? '', /pull-request-5/);

      const showDiffResult = await vscode.commands.executeCommand<{ ok: boolean; code?: string }>(OVERVIEW_SHOW_DIFF, started.session?.id);
      assert.equal(showDiffResult?.ok, true, 'showDiff reveals the diff section of the pull request report');
      assert.equal(vscode.window.activeTextEditor?.document.uri.scheme, 'multiagent-report');

      setJoinDepsForTests(fakeDeps({ kind: 'ok', data: [pullRequest({ headRepository: 'someone-else/fork' })] }) as never);
      const fork = await rowNow();
      assert.doesNotMatch(String(fork?.description ?? ''), /PR #/, 'a fork\'s same-named branch is not this session\'s pull request');
      assert.equal(fork?.contextValue, 'multiagentOverviewAgentLive');

      setJoinDepsForTests(fakeDeps({ kind: 'partial', data: [pullRequest()] }) as never);
      const partial = await rowNow();
      assert.doesNotMatch(String(partial?.description ?? ''), /PR #/, 'an incomplete read shows no pull request');
      assert.match(String(partial?.tooltip ?? ''), /Pull request: unknown/);

      // Local Git evidence is shown as facts on the row, and an unreadable folder is unknown, never clean.
      setGitEvidenceReaderForTests(async () => ({ state: 'known', source: 'local git', changed: 2, untracked: 1, dirty: true, head: 'abcdef123456', branch: 'feat/host', upstream: { ahead: 1, behind: 0 } }));
      const dirty = await rowNow();
      assert.match(String(dirty?.description ?? ''), /uncommitted changes$/);
      assert.match(String(dirty?.tooltip ?? ''), /Git \(local, read just now\): 2 changed, 1 untracked; 1 ahead, 0 behind its upstream; at abcdef123456/);
      setGitEvidenceReaderForTests(async () => { throw new Error('git is not available'); });
      const unreadable = await rowNow();
      assert.doesNotMatch(String(unreadable?.description ?? ''), /uncommitted/);
      assert.match(String(unreadable?.tooltip ?? ''), /Git: unknown \(Git could not read the working folder\)/);
    } finally {
      setGitEvidenceReaderForTests(undefined);
      setJoinDepsForTests(undefined);
      setReportDepsForTests(undefined);
    }
    const noUrl = await vscode.commands.executeCommand<{ ok: boolean; code?: string }>(OVERVIEW_OPEN_PULL_REQUEST, 'no-such-session');
    assert.deepEqual([noUrl.ok, noUrl.code], [false, 'no-pull-request']);
    const noReport = await vscode.commands.executeCommand<{ ok: boolean; code?: string }>(OVERVIEW_OPEN_REPORT, 'no-such-session');
    assert.deepEqual([noReport?.ok, noReport?.code], [false, 'no-pull-request']);
    const noDiff = await vscode.commands.executeCommand<{ ok: boolean; code?: string }>(OVERVIEW_SHOW_DIFF, 'no-such-session');
    assert.deepEqual([noDiff?.ok, noDiff?.code], [false, 'no-pull-request']);
  } finally {
    setJoinDepsForTests(undefined);
    for (const terminal of vscode.window.terminals.filter((candidate) => candidate.name === 'Multiagent: Overview Session')) terminal.dispose();
  }
  await vscode.commands.executeCommand(OVERVIEW_REFRESH);
  return 'host smoke: Multiagent activity bar container, overview rows (unknown shown, shell not "working"), guide steps from real state verified';
}
