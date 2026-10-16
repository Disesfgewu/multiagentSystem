import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { REPORT_COMMANDS, REPORT_SCHEME, reportText, reportTreeForTests, reportUri, setReportDepsForTests, ReportReader } from '../../../src/reports/reportsView';

const HEAD = 'd'.repeat(40);

function fakeReader(over: Partial<ReportReader> = {}): ReportReader {
  const issues = [{ number: 12, title: 'Read reports in the editor', state: 'open', labels: ['mvp'], assignees: [], body: 'The user reads a report without a number.', author: 'pm-user' }, { number: 13, title: 'Second issue', state: 'open', labels: [], assignees: [], body: 'Another.', author: 'pm-user' }];
  const prs = [{ number: 7, title: 'Add reports', state: 'open', draft: false, headRef: 'feat/reports', headRepository: 'external/reports', headSha: HEAD, baseRef: 'main', author: 'external-worker', body: 'Refs #12', referencedIssues: [{ number: 12 }] }, { number: 8, title: 'Second PR', state: 'open', draft: true, headRef: 'feat/two', headRepository: 'host/repo', headSha: HEAD, baseRef: 'main', author: 'worker', body: 'x', referencedIssues: [] }];
  return {
    listIssues: async () => ({ kind: 'ok', data: issues }),
    getIssue: async (n) => ({ kind: 'ok', data: issues.find((entry) => entry.number === n) }),
    getIssueComments: async () => ({ kind: 'ok', data: [{ author: 'pm-user', createdAt: '2026-10-16T00:00:00Z', body: '結論：Pass｜head `dddddddddddd`' }] }),
    listPullRequests: async () => ({ kind: 'ok', data: prs }),
    getPullRequest: async (n) => ({ kind: 'ok', data: prs.find((entry) => entry.number === n) }),
    getPullRequestFiles: async () => ({ kind: 'ok', data: [{ filename: 'src/report.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' }] }),
    getPullRequestSnapshot: async () => ({ status: 'complete', consistent: true, headSha: HEAD, approval: { status: 'not_approved', reason: 'no_approval' }, checksSummary: { state: 'passing', requiredState: 'passing', headSha: HEAD, failing: [] }, unresolvedThreads: 0 }),
    getReviews: async () => ({ kind: 'ok', data: [] }),
    ...over
  };
}

const labels = async (kind: 'issue' | 'pullRequest'): Promise<string[]> => ((await reportTreeForTests(kind).getChildren()) ?? []).map((item) => String(item.label));

// The report lists and the in-editor reports with a fake reader (no network). Reading is all they do.
export async function runReportChecks(): Promise<string> {
  const registered = await vscode.commands.getCommands(true);
  for (const id of Object.values(REPORT_COMMANDS)) assert.ok(registered.includes(id), `${id} is registered`);
  const manifest = vscode.extensions.all.find((candidate) => candidate.packageJSON?.name === 'multiagentsystem')?.packageJSON;
  const ids = manifest.contributes.views.multiagentSystem.map((view: { id: string }) => view.id);
  assert.ok(ids.includes('multiagentSystem.issuesReportView') && ids.includes('multiagentSystem.prsReportView'), 'both report lists are in the Multiagent container');

  try {
    setReportDepsForTests({ repository: async () => 'host/repo', readerFor: () => fakeReader() });
    assert.deepEqual(await labels('issue'), ['#12 Read reports in the editor', '#13 Second issue']);
    assert.deepEqual(await labels('pullRequest'), ['#7 Add reports', '#8 Second PR']);
    const first = ((await reportTreeForTests('issue').getChildren()) ?? [])[0];
    assert.equal((first.command as { command?: string }).command, REPORT_COMMANDS.open, 'a list entry opens its report');

    // a report opens in the editor with no number typed and no browser
    const opened = await vscode.commands.executeCommand<{ ok: boolean }>(REPORT_COMMANDS.open, { kind: 'issue', number: 12 });
    assert.equal(opened.ok, true);
    const issueText = vscode.window.activeTextEditor?.document.getText() ?? '';
    assert.equal(vscode.window.activeTextEditor?.document.uri.scheme, REPORT_SCHEME);
    for (const part of ['Issue #12: Read reports in the editor', 'REQUIREMENT AND SCOPE', 'The user reads a report without a number.', 'RELATED PULL REQUESTS', '- #7 Add reports', 'None can be made here yet', 'NOT VERIFIED']) assert.ok(issueText.includes(part), part);

    // reading through the list: next and previous wrap around; each is a different report
    const next = await vscode.commands.executeCommand<{ ok: boolean; number?: number }>(REPORT_COMMANDS.next);
    assert.deepEqual([next.ok, next.number], [true, 13]);
    assert.match(vscode.window.activeTextEditor?.document.getText() ?? '', /Issue #13: Second issue/);
    const wrapped = await vscode.commands.executeCommand<{ number?: number }>(REPORT_COMMANDS.next);
    assert.equal(wrapped.number, 12);
    const back = await vscode.commands.executeCommand<{ number?: number }>(REPORT_COMMANDS.previous);
    assert.equal(back.number, 13);

    // a pull request report ties the verdict and CI to the latest head
    await vscode.commands.executeCommand(REPORT_COMMANDS.open, { kind: 'pullRequest', number: 7 });
    const prText = vscode.window.activeTextEditor?.document.getText() ?? '';
    for (const part of ['Pull request #7: Add reports', `Latest head: ${HEAD}`, 'Source: fork / external contributor', 'Head repository: external/reports', 'Author: external-worker', 'Refers to: Issue #12', 'CI for this head: passing', 'src/report.ts', '+new', 'verdict "Pass" applies to the current head', 'it cannot approve, request changes or merge']) assert.ok(prText.includes(part), part);

    // A push during the files request makes the patch's version unknowable; never label B's
    // changed files as the diff for head A.
    let headReads = 0;
    setReportDepsForTests({ repository: async () => 'host/repo', readerFor: () => fakeReader({
      getPullRequest: async () => ({ kind: 'ok', data: { number: 7, title: 'Changed while reading', state: 'open', headSha: ++headReads === 1 ? HEAD : 'e'.repeat(40), headRepository: 'external/reports' } }),
      getPullRequestFiles: async () => ({ kind: 'ok', data: [{ filename: 'new-head.ts', status: 'modified', patch: '+new-head-only' }] })
    }) });
    const movedHead = await reportText('pullRequest', 7);
    assert.equal(headReads, 2);
    assert.match(movedHead, /Diff for this head: unknown/);
    assert.equal(movedHead.includes('new-head.ts'), false);
    assert.equal(movedHead.includes('+new-head-only'), false);
    setReportDepsForTests({ repository: async () => 'host/repo', readerFor: () => fakeReader() });

    // a report cannot be written to a file
    await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(reportUri('pullRequest', 7), Buffer.from('x'))));

    // back to the agents
    const home = await vscode.commands.executeCommand<{ ok: boolean }>(REPORT_COMMANDS.back);
    assert.equal(home.ok, true);
    assert.notEqual(vscode.window.activeTextEditor?.document.uri.scheme, REPORT_SCHEME, 'the report was closed');
    assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.next), { ok: false, code: 'no-report-open' });

    // nothing invalid opens
    for (const bad of [undefined, null, {}, { kind: 'issue' }, { kind: 'issue', number: 0 }, { kind: 'issue', number: '12' }, { kind: 'other', number: 1 }, { kind: 'issue', number: 1.5 }]) {
      const result = await vscode.commands.executeCommand<{ ok: boolean; code?: string }>(REPORT_COMMANDS.open, bad);
      assert.deepEqual([result.ok, result.code], [false, 'invalid-report'], JSON.stringify(bad));
    }

    // an incomplete or failed list is never shown as the whole list
    for (const kind of ['partial', 'truncated', 'denied', 'offline', 'rate_limited', 'invalid']) {
      setReportDepsForTests({ repository: async () => 'host/repo', readerFor: () => fakeReader({ listIssues: async () => ({ kind, data: [{ number: 99, title: 'Must not appear' }] }) }) });
      const shown = await labels('issue');
      assert.equal(shown.length, 1, kind);
      assert.equal(shown.some((label) => label.includes('99')), false, kind);
    }
    setReportDepsForTests({ repository: async () => 'host/repo', readerFor: () => fakeReader({ listIssues: async () => { throw new Error('network down'); } }) });
    assert.match((await labels('issue'))[0], /could not be read/);
    setReportDepsForTests({ repository: async () => 'host/repo', readerFor: () => fakeReader({ listIssues: async () => ({ kind: 'empty', data: [] }) }) });
    assert.deepEqual(await labels('issue'), ['No open issues.']);
    for (const answer of [{ kind: 'ok' }, { kind: 'ok', data: [null] }, { kind: 'ok', data: [{ number: 0, title: 'bad' }] }, { kind: 'empty', data: [{ number: 99, title: 'bad' }] }]) {
      setReportDepsForTests({ repository: async () => 'host/repo', readerFor: () => fakeReader({ listIssues: async () => answer }) });
      assert.match((await labels('issue'))[0], /could not be read \(invalid\)/);
      assert.equal((await labels('issue')).some((label) => label.includes('No open issues.')), false);
    }
    setReportDepsForTests({ repository: async () => null, readerFor: () => null });
    assert.match((await labels('issue'))[0], /Open a project folder that has a GitHub origin/);

    // An already opened virtual document must be read again on Refresh, including failures.
    setReportDepsForTests({ repository: async () => 'host/repo', readerFor: () => fakeReader() });
    const report = await vscode.workspace.openTextDocument(reportUri('issue', 12));
    assert.match(report.getText(), /Issue #12: Read reports in the editor/);
    setReportDepsForTests({ repository: async () => 'host/repo', readerFor: () => fakeReader({ getIssue: async () => ({ kind: 'not_found' }) }) });
    const refreshed = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => { listener.dispose(); reject(new Error('Report refresh did not update the open document.')); }, 5000);
      const listener = vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.toString() !== report.uri.toString()) return;
        const updated = event.document.getText();
        if (!updated.includes('not_found')) return;
        clearTimeout(timeout);
        listener.dispose();
        resolve(updated);
      });
    });
    await vscode.commands.executeCommand(REPORT_COMMANDS.refresh);
    const missing = await refreshed;
    assert.match(missing, /Issue #12 could not be read \(not_found\)/);
  } finally {
    setReportDepsForTests(undefined);
  }
  return 'host smoke: Issues Report and PRs Report lists, in-editor reports (requirement, related PRs, verdict tied to the head, CI), next/previous/back, incomplete reads shown as unknown, reports cannot be saved to a file';
}
