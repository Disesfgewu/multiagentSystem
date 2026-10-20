import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { REPORT_COMMANDS, REPORT_SCHEME, reportBadgeForTests, reportText, reportTreeForTests, reportUri, setReportDepsForTests, ReportReader } from '../../../src/reports/reportsView';
import { installPublicFeedbackTestOverrides, setPublicFeedbackTestMode } from '../../../src/reports/publicFeedback';
import { privateStorage } from '../../../src/storage/storageCommands';

const HEAD = 'd'.repeat(40);

function fakeReader(over: Partial<ReportReader> = {}): ReportReader {
  const issues = [{ number: 12, title: 'Read reports in the editor', state: 'open', labels: ['mvp'], assignees: [], body: 'The user reads a report without a number.', author: 'pm-user' }, { number: 13, title: 'Second issue', state: 'open', labels: [], assignees: [], body: 'Another.', author: 'pm-user' }];
  const prs = [{ number: 7, title: 'Add reports', state: 'open', draft: false, headRef: 'feat/reports', headRepository: 'external/reports', headSha: HEAD, baseRef: 'main', author: 'external-worker', body: 'Refs #12', referencedIssues: [{ number: 12 }] }, { number: 8, title: 'Second PR', state: 'open', draft: true, headRef: 'feat/two', headRepository: 'host/repo', headSha: HEAD, baseRef: 'main', author: 'worker', body: 'x', referencedIssues: [] }];
  return {
    listIssues: async (filter) => filter.state === 'closed' ? { kind: 'empty' } : ({ kind: 'ok', data: issues }),
    getIssue: async (n) => ({ kind: 'ok', data: issues.find((entry) => entry.number === n) }),
    getIssueComments: async () => ({ kind: 'ok', data: [{ author: 'host', createdAt: '2026-10-16T00:00:00Z', body: '結論：Pass｜head `dddddddddddd`' }] }),
    listPullRequests: async (filter) => filter.state === 'closed' ? { kind: 'empty' } : ({ kind: 'ok', data: prs }),
    getPullRequest: async (n) => ({ kind: 'ok', data: prs.find((entry) => entry.number === n) }),
    getPullRequestFiles: async () => ({ kind: 'ok', data: [{ filename: 'src/report.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' }] }),
    getPullRequestSnapshot: async () => ({ status: 'complete', consistent: true, headSha: HEAD, approval: { status: 'not_approved', reason: 'no_approval' }, checksSummary: { state: 'passing', requiredState: 'passing', headSha: HEAD, failing: [] }, checks: { kind: 'ok', data: { headSha: HEAD, checkRuns: [{ name: 'unit tests', state: 'passing', completedAt: '2026-10-16T01:00:00Z' }, { name: 'host smoke', state: 'failing', completedAt: '2026-10-16T01:05:00Z' }], statuses: [] } }, unresolvedThreads: 0 }),
    getReviews: async () => ({ kind: 'ok', data: [] }),
    getReviewComments: async () => ({ kind: 'ok', data: [] }),
    ...over
  };
}

const labels = async (kind: 'issue' | 'pullRequest'): Promise<string[]> => {
  const tree = reportTreeForTests(kind);
  const roots = (await tree.getChildren()) ?? [];
  const nested = (await Promise.all(roots.map((item) => tree.getChildren(item)))).flat().filter((item): item is vscode.TreeItem => Boolean(item));
  return (nested.length ? nested : roots).map((item) => String(item.label));
};

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
    const issueSections = (await reportTreeForTests('issue').getChildren()) ?? [];
    assert.deepEqual(issueSections.map((item) => String(item.label)), ['待我決策／待補證據 (2)', '要求修改 (0)', '已通過 (0)', '已處理 (0)']);
    assert.equal(reportBadgeForTests('issue'), 2, 'the activity-bar badge counts items that still need a decision');
    setReportDepsForTests({ repository: async () => 'host/repo', readerFor: () => fakeReader({
      listPullRequests: async (filter) => filter.state === 'closed'
        ? { kind: 'ok', data: [{ number: 9, title: 'Closed PR', state: 'closed', headSha: HEAD }] }
        : { kind: 'ok', data: [{ number: 7, title: 'Approved PR', state: 'open', headSha: HEAD }, { number: 8, title: 'Changes PR', state: 'open', headSha: HEAD }] },
      getPullRequestSnapshot: async (number) => ({ status: 'complete', consistent: true, headSha: HEAD,
        approval: { status: number === 7 ? 'approved' : 'changes_requested', headSha: HEAD },
        checksSummary: { state: 'passing', requiredState: 'passing', headSha: HEAD } })
    }) });
    const decided = (await reportTreeForTests('pullRequest').getChildren()) ?? [];
    assert.deepEqual(decided.map((item) => String(item.label)), ['待我決策／待補證據 (0)', '要求修改 (1)', '已通過 (1)', '已處理 (1)']);
    assert.equal(reportBadgeForTests('pullRequest'), 1, 'a changes-requested PR still needs a decision; a passed or processed one does not count');
    setReportDepsForTests({ repository: async () => 'host/repo', readerFor: () => fakeReader({
      getPullRequestSnapshot: async () => ({ status: 'complete', consistent: true, headSha: 'e'.repeat(40), approval: { status: 'approved', headSha: 'e'.repeat(40) }, checksSummary: { state: 'passing', requiredState: 'passing', headSha: 'e'.repeat(40) } })
    }) });
    const stale = (await reportTreeForTests('pullRequest').getChildren()) ?? [];
    assert.match(String(stale[0].label), /待我決策／待補證據 \(2\)/, 'old-head pass remains pending');
    setReportDepsForTests({ repository: async () => 'host/repo', readerFor: () => fakeReader() });
    const first = ((await reportTreeForTests('issue').getChildren(issueSections[0])) ?? [])[0];
    assert.equal((first.command as { command?: string }).command, REPORT_COMMANDS.open, 'a list entry opens its report');

    // a report opens in the editor with no number typed and no browser
    const opened = await vscode.commands.executeCommand<{ ok: boolean }>(REPORT_COMMANDS.open, { kind: 'issue', number: 12 });
    assert.equal(opened.ok, true);
    const issueText = vscode.window.activeTextEditor?.document.getText() ?? '';
    assert.equal(vscode.window.activeTextEditor?.document.uri.scheme, REPORT_SCHEME);
    for (const part of ['Issue #12: Read reports in the editor', 'REQUIREMENT AND SCOPE', 'The user reads a report without a number.', 'RELATED PULL REQUESTS', '- #7 Add reports', 'A private note can be saved locally', 'NOT VERIFIED']) assert.ok(issueText.includes(part), part);
    assert.match(issueText, /OPEN DISCUSSION \(click to jump\)/);
    assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.showDiscussion), { ok: true });
    assert.equal(vscode.window.activeTextEditor?.document.lineAt(vscode.window.activeTextEditor.selection.active.line).text, 'DISCUSSION AND PM COMMENTS');
    assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.showDiff), { ok: false, code: 'no-pr-report-open' });

    // reading through the list: next and previous wrap around; each is a different report
    const next = await vscode.commands.executeCommand<{ ok: boolean; number?: number }>(REPORT_COMMANDS.next);
    assert.deepEqual([next.ok, next.number], [true, 13]);
    assert.match(vscode.window.activeTextEditor?.document.getText() ?? '', /Issue #13: Second issue/);
    const wrapped = await vscode.commands.executeCommand<{ number?: number }>(REPORT_COMMANDS.next);
    assert.equal(wrapped.number, 12);
    const back = await vscode.commands.executeCommand<{ number?: number }>(REPORT_COMMANDS.previous);
    assert.equal(back.number, 13);
    const returnToList = await vscode.commands.executeCommand<{ ok: boolean }>(REPORT_COMMANDS.backToList);
    assert.equal(returnToList.ok, true);
    assert.deepEqual(await labels('issue'), ['#12 Read reports in the editor', '#13 Second issue'], 'returning keeps the list position and contents');

    // a pull request report ties the verdict and CI to the latest head
    await vscode.commands.executeCommand(REPORT_COMMANDS.open, { kind: 'pullRequest', number: 7 });
    const prText = vscode.window.activeTextEditor?.document.getText() ?? '';
    for (const part of ['Pull request #7: Add reports', `Latest head: ${HEAD}`, 'Source: fork / external contributor', 'Head repository: external/reports', 'Author: external-worker', 'Refers to: Issue #12', 'CI for this head: passing', 'src/report.ts', '+new', 'verdict "Pass" applies to the current head', 'It cannot approve, request changes or merge']) assert.ok(prText.includes(part), part);
    assert.match(prText, /OPEN CODE CHANGES \(click to jump\)[\s\S]*OPEN DISCUSSION \(click to jump\)/);
    assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.showDiscussion), { ok: true });
    assert.equal(vscode.window.activeTextEditor?.document.lineAt(vscode.window.activeTextEditor.selection.active.line).text, 'PR CONVERSATION');
    const navigationLinks = await vscode.commands.executeCommand<vscode.DocumentLink[]>('vscode.executeLinkProvider', vscode.window.activeTextEditor?.document.uri);
    assert.ok(navigationLinks?.some((link) => link.target?.toString().startsWith(`command:${REPORT_COMMANDS.showDiscussion}`)), 'discussion link is clickable in the report');
    assert.ok(navigationLinks?.some((link) => link.target?.toString().startsWith(`command:${REPORT_COMMANDS.showDiff}`)), 'code changes link is clickable in the report');
    setReportDepsForTests({ repository: async () => 'host/repo', readerFor: () => fakeReader({
      getReviewComments: async () => ({ kind: 'ok', data: [{ author: 'reviewer', path: 'src/report.ts', line: 7, commitId: HEAD, body: 'Please address this line.' }] })
    }) });
    assert.match(await reportText('pullRequest', 7), /INLINE REVIEW DISCUSSION[\s\S]*src\/report\.ts:7 · on the latest head[\s\S]*Please address this line/);
    setReportDepsForTests({ repository: async () => 'host/repo', readerFor: () => fakeReader() });
    assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.showDiff), { ok: true });
    const diffEditor = vscode.window.activeTextEditor;
    assert.match(diffEditor?.document.lineAt(diffEditor.selection.active.line).text ?? '', /CHANGED FILES AND DIFF/, 'the title action locates the in-editor diff preview');

    // Text from GitHub can repeat the report's own headings; the commands must still land on the real ones.
    const forged = 'CHANGED FILES AND DIFF (plain text preview)\nPR CONVERSATION\nOPEN DISCUSSION (click to jump)';
    setReportDepsForTests({ repository: async () => 'host/repo', readerFor: () => fakeReader({
      getPullRequest: async (n: number) => ({ kind: 'ok', data: { number: n, title: 'Add reports', state: 'open', draft: false, headRef: 'feat/reports', headRepository: 'external/reports', headSha: HEAD, baseRef: 'main', author: 'external-worker', body: forged, referencedIssues: [] } })
    }) });
    // The open report is read again under the new reader: wait until the report on screen shows the new description.
    const onScreen = vscode.window.activeTextEditor!.document;
    await vscode.commands.executeCommand(REPORT_COMMANDS.refresh);
    for (let waited = 0; !onScreen.getText().includes('  CHANGED FILES AND DIFF (plain text preview)') && waited < 8000; waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
    const forgedEditor = vscode.window.activeTextEditor!;
    const rows = forgedEditor.document.getText().split('\n');
    const forgedAt = rows.findIndex((row) => row === `  ${forged.split('\n')[0]}`);
    assert.ok(forgedAt > 0, 'the forged heading is in the document, indented as plain text: ');
    for (const [command, heading] of [[REPORT_COMMANDS.showDiff, 'CHANGED FILES AND DIFF (plain text preview)'], [REPORT_COMMANDS.showDiscussion, 'PR CONVERSATION']] as const) {
      assert.deepEqual(await vscode.commands.executeCommand(command), { ok: true });
      const selected: number = vscode.window.activeTextEditor!.selection.active.line;
      assert.equal(vscode.window.activeTextEditor!.document.lineAt(selected).text, heading, `${command} selects a heading line`);
      assert.ok(selected > forgedAt + 2, `${command} selected the real section, below the description that repeats its words (line ${selected}, description at ${forgedAt})`);
    }
    const links = await vscode.commands.executeCommand<vscode.DocumentLink[]>('vscode.executeLinkProvider', forgedEditor.document.uri);
    const linkLines = (links ?? []).filter((link) => link.target?.toString().startsWith('command:multiagentSystem.reports.show')).map((link) => link.range.start.line);
    assert.ok(linkLines.every((row) => row < 8), 'the navigation links are only the report\'s own, at the top');
    setReportDepsForTests({ repository: async () => 'host/repo', readerFor: () => fakeReader() });
    await vscode.commands.executeCommand(REPORT_COMMANDS.refresh);
    await new Promise((resolve) => setTimeout(resolve, 300));

    // a single file's diff can be opened on its own, syntax-highlighted, from the report that is open
    const prReportUri = diffEditor!.document.uri;
    const fileDiff = await vscode.commands.executeCommand<{ ok: boolean }>(REPORT_COMMANDS.openFileDiff, { reportUri: prReportUri.toString(), filename: 'src/report.ts' });
    assert.equal(fileDiff.ok, true);
    const fileDiffEditor = vscode.window.activeTextEditor;
    assert.equal(fileDiffEditor?.document.languageId, 'diff', 'the single-file diff is syntax-highlighted as a diff');
    const fileDiffText = fileDiffEditor?.document.getText() ?? '';
    assert.match(fileDiffText, /src\/report\.ts \(modified\)/);
    assert.match(fileDiffText, /\+new/);
    assert.equal(fileDiffText.includes('CHANGED FILES AND DIFF'), false, 'only the one file is shown, not the whole report');
    // an unknown file name, or a report that is no longer open, explains itself rather than throwing
    const unknownFile = await vscode.commands.executeCommand<{ ok: boolean }>(REPORT_COMMANDS.openFileDiff, { reportUri: prReportUri.toString(), filename: 'no-such-file.ts' });
    assert.equal(unknownFile.ok, true);
    assert.match(vscode.window.activeTextEditor?.document.getText() ?? '', /No changed-file entry named "no-such-file\.ts" was found/);
    const staleReportUri = reportUri('pullRequest', 8);
    const staleFileDiff = await vscode.commands.executeCommand<{ ok: boolean }>(REPORT_COMMANDS.openFileDiff, { reportUri: staleReportUri.toString(), filename: 'src/report.ts' });
    assert.equal(staleFileDiff.ok, true);
    assert.match(vscode.window.activeTextEditor?.document.getText() ?? '', /is no longer open/);
    for (const bad of [undefined, null, {}, { reportUri: prReportUri.toString() }, { filename: 'x' }, { reportUri: 'not-a-report:x', filename: 'x' }]) {
      const result = await vscode.commands.executeCommand<{ ok: boolean; code?: string }>(REPORT_COMMANDS.openFileDiff, bad);
      assert.equal(result.ok, false, JSON.stringify(bad));
    }
    await vscode.commands.executeCommand(REPORT_COMMANDS.open, { kind: 'pullRequest', number: 7 });
    const saved = await vscode.commands.executeCommand<{ ok: boolean }>(REPORT_COMMANDS.feedback, { kind: 'pullRequest', number: 7, note: 'Please add a second test', interactive: false });
    assert.equal(saved.ok, true, 'feedback is written only to the private store');
    const feedbackStatus = await reportText('pullRequest', 7);
    assert.match(feedbackStatus, /LOCAL FEEDBACK\nSaved only on this machine.*Nothing was sent to GitHub\./);
    assert.equal(feedbackStatus.includes('Please add a second test'), false, 'private feedback is never put into the report text');

    const published: Array<{ number: number; body: string }> = [];
    const previews: string[] = [];
    const seenInitialDrafts: string[] = [];
    const auth = { id: 'session', accessToken: 'x', account: { id: '42', label: 'pm-user' }, scopes: ['repo'] };
    assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.publicFeedback, { body: 'Before configuring publisher.', interactive: false }), { ok: false, code: 'publisher-not-configured' });
    installPublicFeedbackTestOverrides({
      session: async () => auth,
      user: async () => ({ id: 42, login: 'pm-user' }),
      version: async (target) => target.version,
      repository: async () => null,
      confirm: async () => true
    });
    assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.configurePublisher), { ok: false, code: 'no-workspace-repository' });
    assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.configureMergeAuthority, { mode: 'pm', interactive: false }), { ok: false, code: 'no-workspace-repository' });

    installPublicFeedbackTestOverrides({
      session: async () => auth,
      user: async () => ({ id: 42, login: 'pm-user' }),
      version: async (target) => target.version,
      repository: async () => 'host/repo',
      prompt: async (initialValue) => { seenInitialDrafts.push(initialValue); return 'Draft kept across cancel.'; },
      confirm: async (message) => { previews.push(message); return true; },
      comment: async (_session, _repository, number, body) => { published.push({ number, body }); return { ok: true, number: 9001 }; }
    });
    assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.configurePublisher), { ok: true });

    // Interactive preview shows target repo, PR number, current head SHA, and exact text; cancelling preserves the draft without copying private local feedback.
    installPublicFeedbackTestOverrides({
      session: async () => auth,
      user: async () => ({ id: 42, login: 'pm-user' }),
      version: async (target) => target.version,
      repository: async () => 'host/repo',
      prompt: async (initialValue) => { seenInitialDrafts.push(initialValue); return 'Draft kept across cancel.'; },
      confirm: async (message) => { previews.push(message); return false; },
      comment: async (_session, _repository, number, body) => { published.push({ number, body }); return { ok: true, number: 9001 }; }
    });
    const cancelledPreview = await vscode.commands.executeCommand<{ ok: boolean; code?: string }>(REPORT_COMMANDS.publicFeedback);
    assert.deepEqual(cancelledPreview, { ok: false, code: 'cancelled' });
    assert.equal(seenInitialDrafts[0], '', 'public draft starts blank and never copies private local feedback');
    assert.match(previews[previews.length - 1] ?? '', new RegExp(`host/repo PR #7 \\(head ${HEAD}\\)\\?\\n\\nDraft kept across cancel\\.`));
    assert.equal(published.length, 0);

    installPublicFeedbackTestOverrides({
      session: async () => auth,
      user: async () => ({ id: 42, login: 'pm-user' }),
      version: async (target) => target.version,
      repository: async () => 'host/repo',
      prompt: async (initialValue) => { seenInitialDrafts.push(initialValue); return undefined; },
      confirm: async () => false,
      comment: async () => ({ ok: false })
    });
    assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.publicFeedback), { ok: false, code: 'cancelled' });
    assert.equal(seenInitialDrafts[1], 'Draft kept across cancel.', 'cancelling preserves the user draft for the next attempt on the same head');

    // Content scan blocks private local feedback notes, credentials, and machine paths; unreadable private references fail closed.
    installPublicFeedbackTestOverrides({
      session: async () => auth,
      user: async () => ({ id: 42, login: 'pm-user' }),
      version: async (target) => target.version,
      repository: async () => 'host/repo',
      confirm: async () => true,
      comment: async (_session, _repository, number, body) => { published.push({ number, body }); return { ok: true, number: 9001 }; }
    });
    for (const blockedBody of [
      'Repeating private note: Please add a second test',
      'Leaking token ghp_1234567890abcdefghijklmnopqrstuvwx12 in public',
      'Leaking local path /Users/pm/private-notes.md in public'
    ]) {
      const blocked = await vscode.commands.executeCommand<{ ok: boolean; code?: string }>(REPORT_COMMANDS.publicFeedback, { body: blockedBody, interactive: false });
      assert.deepEqual(blocked, { ok: false, code: 'content-blocked' }, blockedBody);
    }
    assert.equal(published.length, 0, 'blocked content never reaches the transport');
    const openedStore = await privateStorage()?.use();
    assert.equal(openedStore?.ok, true);
    if (openedStore?.ok) {
      openedStore.store.put('reportFeedback', 'corrupt-feedback', { note: '' });
      try {
        assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.publicFeedback, { body: 'Valid public comment.', interactive: false }), { ok: false, code: 'private-reference-unreadable' });
      } finally {
        openedStore.store.delete('reportFeedback', 'corrupt-feedback');
      }
    }

    // Sign-in, publisher identity, repository, and head changes before send are refused.
    installPublicFeedbackTestOverrides({ session: async () => null, user: async () => ({ id: 42, login: 'pm-user' }), version: async (target) => target.version, repository: async () => 'host/repo', confirm: async () => true, comment: async () => ({ ok: true, number: 1 }) });
    assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.publicFeedback, { body: 'Valid public comment.', interactive: false }), { ok: false, code: 'github-sign-in-required' });
    installPublicFeedbackTestOverrides({ session: async () => auth, user: async () => ({ id: 99, login: 'other-user' }), version: async (target) => target.version, repository: async () => 'host/repo', confirm: async () => true, comment: async () => ({ ok: true, number: 1 }) });
    assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.publicFeedback, { body: 'Valid public comment.', interactive: false }), { ok: false, code: 'publisher-identity-changed' });
    installPublicFeedbackTestOverrides({ session: async () => auth, user: async () => ({ id: 42, login: 'pm-user' }), version: async (target) => target.version, repository: async () => 'other/repo', confirm: async () => true, comment: async () => ({ ok: true, number: 1 }) });
    assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.publicFeedback, { body: 'Valid public comment.', interactive: false }), { ok: false, code: 'report-context-changed' });
    installPublicFeedbackTestOverrides({ session: async () => auth, user: async () => ({ id: 42, login: 'pm-user' }), version: async () => 'e'.repeat(40), repository: async () => 'host/repo', confirm: async () => true, comment: async () => ({ ok: true, number: 1 }) });
    assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.publicFeedback, { body: 'Valid public comment.', interactive: false }), { ok: false, code: 'report-context-changed' });

    installPublicFeedbackTestOverrides({
      session: async () => auth,
      user: async () => ({ id: 42, login: 'pm-user' }),
      version: async (target) => target.version,
      repository: async () => 'host/repo',
      confirm: async () => true,
      comment: async (_session, _repository, number, body) => { published.push({ number, body }); return { ok: true, number: 9001 }; }
    });
    const publicResult = await vscode.commands.executeCommand<{ ok: boolean; code?: string }>(REPORT_COMMANDS.publicFeedback, { body: 'Please add a public regression test.', interactive: false });
    assert.deepEqual(publicResult, { ok: true });
    assert.deepEqual(published, [{ number: 7, body: 'Please add a public regression test.' }], 'only the separate public draft reaches the broker transport');
    assert.equal(JSON.stringify(published).includes('Please add a second test'), false, 'the private local note is never copied into public feedback');
    const replay = await vscode.commands.executeCommand<{ ok: boolean; code?: string }>(REPORT_COMMANDS.publicFeedback, { body: 'changed retry text', interactive: false });
    assert.deepEqual(replay, { ok: true, code: 'already-sent' });
    assert.equal(published.length, 1, 'reopening and retrying a completed request does not post twice');

    // Formal PR review and guarded PR merge from the open report via Broker
    assert.match(await reportText('pullRequest', 7), /MERGE AUTHORITY\nHuman only \(default\): PM merge is refused\./);
    const reviewsSent: Array<{ number: number; decision: string; body: string; expectedHeadSha: string }> = [];
    const mergesSent: Array<{ number: number; expectedHeadSha: string; commitTitle: string; commitMessage: string }> = [];
    const completeSnapshot = (over: Record<string, any> = {}) => ({
      repository: { owner: 'host', name: 'repo' },
      number: 7,
      status: 'complete',
      consistent: true,
      headSha: HEAD,
      pullRequest: {
        kind: 'ok',
        data: {
          number: 7, state: 'open', merged: false, draft: false, author: 'external-worker',
          title: 'Add reports', body: 'Refs #12', headSha: HEAD, mergeable: true, baseRef: 'main',
          ...(over.pr ?? {})
        }
      },
      reviews: { kind: 'ok', data: [] },
      approval: {
        status: 'approved', reason: 'approved_on_current_head', headSha: HEAD,
        currentApprovals: [{ reviewer: 'pm-user', reviewId: 1, commitId: HEAD }],
        staleApprovals: [], changesRequested: [], selfApprovalsIgnored: []
      },
      checks: { kind: 'ok', data: { headSha: HEAD, checkRuns: [{}], statuses: [] } },
      checksSummary: { headSha: HEAD, state: 'passing', requiredState: 'passing', counts: { passing: 1, failing: 0, pending: 0 }, failing: [], pending: [], missingRequired: [] },
      threads: { kind: 'empty', data: { headSha: HEAD, threads: [], unresolvedCount: 0 } },
      unresolvedThreads: 0,
      requirements: {
        kind: 'ok',
        data: {
          complete: true, ruleTypes: ['pull_request', 'required_status_checks'],
          requireCodeOwnerReview: false, requireLastPushApproval: false, strictStatusChecks: false
        }
      },
      ...over
    });

    // Self-review of PM's own PR is refused by publish-policy via Broker
    installPublicFeedbackTestOverrides({
      session: async () => auth,
      user: async () => ({ id: 42, login: 'pm-user' }),
      version: async (target) => target.version,
      repository: async () => 'host/repo',
      snapshot: async () => completeSnapshot({ pr: { author: 'pm-user' } }),
      authorId: async (_auth, login) => (login === 'pm-user' ? '42' : '77'),
      review: async (_session, _repository, number, decision, body, expectedHeadSha) => {
        reviewsSent.push({ number, decision, body, expectedHeadSha });
        return { ok: true, number: 501 };
      }
    });
    assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.reviewPullRequest, { decision: 'approve', body: 'Self-approval attempt.', interactive: false }), { ok: false, code: 'self-review-forbidden' });
    assert.equal(reviewsSent.length, 0);

    // Formal PR review blocks private feedback leakage and succeeds for a distinct author on the open head
    installPublicFeedbackTestOverrides({
      session: async () => auth,
      user: async () => ({ id: 42, login: 'pm-user' }),
      version: async (target) => target.version,
      repository: async () => 'host/repo',
      snapshot: async () => completeSnapshot(),
      authorId: async (_auth, login) => (login === 'pm-user' ? '42' : '77'),
      review: async (_session, _repository, number, decision, body, expectedHeadSha) => {
        reviewsSent.push({ number, decision, body, expectedHeadSha });
        return { ok: true, number: 501 };
      }
    });
    assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.reviewPullRequest, { decision: 'approve', body: 'Leaking private note: Please add a second test', interactive: false }), { ok: false, code: 'content-blocked' });
    assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.reviewPullRequest, { decision: 'approve', body: '結論：Pass｜head `' + HEAD + '` Verified in report.', interactive: false }), { ok: true });
    assert.deepEqual(reviewsSent, [{ number: 7, decision: 'approve', body: '結論：Pass｜head `' + HEAD + '` Verified in report.', expectedHeadSha: HEAD }]);
    assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.reviewPullRequest, { decision: 'approve', body: 'Duplicate review attempt.', interactive: false }), { ok: true, code: 'already-reviewed' });
    assert.equal(reviewsSent.length, 1);

    // Guarded PR merge: refused under default 'human' merge authority, then enforced when 'pm' authority is configured
    installPublicFeedbackTestOverrides({
      session: async () => auth,
      user: async () => ({ id: 42, login: 'pm-user' }),
      version: async (target) => target.version,
      repository: async () => 'host/repo',
      snapshot: async () => completeSnapshot(),
      publication: async (_target, headSha) => ({ kind: 'ok', data: { complete: true, number: 7, headSha, diff: 'diff --git a/src/report.ts b/src/report.ts\n@@ -1 +1 @@\n-old\n+new\n' } }),
      authorId: async (_auth, login) => (login === 'pm-user' ? '42' : '77'),
      merge: async (_session, _repository, number, expectedHeadSha, commitTitle, commitMessage) => {
        mergesSent.push({ number, expectedHeadSha, commitTitle, commitMessage });
        return { ok: true, sha: HEAD };
      }
    });
    assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.mergePullRequest, { interactive: false }), { ok: false, code: 'human-merge-required' });
    assert.equal(mergesSent.length, 0);

    assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.configureMergeAuthority, { mode: 'invalid', interactive: false }), { ok: false, code: 'invalid-merge-authority' });

    // Interactive confirmation is required: cancelling the confirmation dialog cancels the change
    installPublicFeedbackTestOverrides({
      repository: async () => 'host/repo',
      confirm: async () => false,
      pickMergeAuthority: async () => 'pm'
    });
    assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.configureMergeAuthority, { mode: 'pm', interactive: true }), { ok: false, code: 'cancelled' });

    installPublicFeedbackTestOverrides({
      repository: async () => 'host/repo',
      confirm: async () => true,
      pickMergeAuthority: async () => 'pm'
    });
    assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.configureMergeAuthority, { mode: 'pm', interactive: false }), { ok: true, mode: 'pm' });
    assert.match(await reportText('pullRequest', 7), /MERGE AUTHORITY\nPM allowed: guarded merge requires current-head PM approval/);

    // Failing CI or secret in diff blocks merge even under 'pm' authority
    installPublicFeedbackTestOverrides({
      session: async () => auth,
      user: async () => ({ id: 42, login: 'pm-user' }),
      version: async (target) => target.version,
      repository: async () => 'host/repo',
      snapshot: async () => completeSnapshot({ checksSummary: { headSha: HEAD, state: 'failing', requiredState: 'failing', counts: { passing: 0, failing: 1, pending: 0 }, failing: ['host smoke'], pending: [], missingRequired: [] } }),
      publication: async (_target, headSha) => ({ kind: 'ok', data: { complete: true, number: 7, headSha, diff: 'diff --git a/src/report.ts b/src/report.ts\n+new\n' } }),
      authorId: async (_auth, login) => (login === 'pm-user' ? '42' : '77'),
      merge: async () => ({ ok: true, sha: HEAD })
    });
    assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.mergePullRequest, { interactive: false }), { ok: false, code: 'ci-failing' });

    installPublicFeedbackTestOverrides({
      session: async () => auth,
      user: async () => ({ id: 42, login: 'pm-user' }),
      version: async (target) => target.version,
      repository: async () => 'host/repo',
      snapshot: async () => completeSnapshot(),
      publication: async (_target, headSha) => ({ kind: 'ok', data: { complete: true, number: 7, headSha, diff: '+const token = "ghp_1234567890abcdefghijklmnopqrstuvwx12";\n' } }),
      authorId: async (_auth, login) => (login === 'pm-user' ? '42' : '77'),
      merge: async () => ({ ok: true, sha: HEAD })
    });
    assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.mergePullRequest, { interactive: false }), { ok: false, code: 'publication-blocked' });

    // Clean snapshot + clean publication merges and records idempotency
    installPublicFeedbackTestOverrides({
      session: async () => auth,
      user: async () => ({ id: 42, login: 'pm-user' }),
      version: async (target) => target.version,
      repository: async () => 'host/repo',
      snapshot: async () => completeSnapshot(),
      publication: async (_target, headSha) => ({ kind: 'ok', data: { complete: true, number: 7, headSha, diff: 'diff --git a/src/report.ts b/src/report.ts\n@@ -1 +1 @@\n-old\n+new\n' } }),
      authorId: async (_auth, login) => (login === 'pm-user' ? '42' : '77'),
      merge: async (_session, _repository, number, expectedHeadSha, commitTitle, commitMessage) => {
        mergesSent.push({ number, expectedHeadSha, commitTitle, commitMessage });
        return { ok: true, sha: HEAD };
      }
    });
    assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.mergePullRequest, { interactive: false }), { ok: true });
    assert.deepEqual(mergesSent, [{ number: 7, expectedHeadSha: HEAD, commitTitle: 'Add reports', commitMessage: 'Refs #12' }]);
    assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.mergePullRequest, { interactive: false }), { ok: true, code: 'already-merged' });
    assert.equal(mergesSent.length, 1);
    assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.configureMergeAuthority, { mode: 'human', interactive: false }), { ok: true, mode: 'human' });

    await vscode.commands.executeCommand(REPORT_COMMANDS.open, { kind: 'issue', number: 12 });
    assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.reviewPullRequest, { decision: 'approve', body: 'Not a PR', interactive: false }), { ok: false, code: 'no-pr-report-open' });
    assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.mergePullRequest, { interactive: false }), { ok: false, code: 'no-pr-report-open' });
    // Closing an Issue from its report: PM-configured publisher, a fixed reason, the Issue must be open now.
    const closesSent: Array<{ number: number; reason: string }> = [];
    let issueState: { state: string; stateReason?: string | null } = { state: 'open' };
    installPublicFeedbackTestOverrides({
      session: async () => auth,
      user: async () => ({ id: 42, login: 'pm-user' }),
      version: async (target) => target.version,
      repository: async () => 'host/repo',
      issue: async () => ({ kind: 'ok', data: { number: 12, ...issueState } }),
      closeIssue: async (_session, _repository, number, reason) => { closesSent.push({ number, reason }); return { ok: true, number }; }
    });
    assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.closeIssue, { reason: 'finished', interactive: false }), { ok: false, code: 'invalid-close-reason' });
    assert.equal(closesSent.length, 0);
    issueState = { state: 'closed', stateReason: 'completed' };
    assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.closeIssue, { reason: 'completed', interactive: false }), { ok: false, code: 'issue-not-open' });
    assert.equal(closesSent.length, 0, 'an Issue that is already closed is not closed again');
    issueState = { state: 'open' };
    assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.closeIssue, { reason: 'not_planned', interactive: false }), { ok: true });
    assert.deepEqual(closesSent, [{ number: 12, reason: 'not_planned' }]);
    assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.closeIssue, { reason: 'not_planned', interactive: false }), { ok: true, code: 'already-closed' });
    assert.equal(closesSent.length, 1, 'repeating the same close sends nothing');
    // Declining the confirmation closes nothing: the person, not a parameter, decides.
    installPublicFeedbackTestOverrides({ repository: async () => 'host/repo', pickCloseReason: async () => 'completed', confirm: async () => false });
    assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.closeIssue, { interactive: true }), { ok: false, code: 'cancelled' });
    assert.equal(closesSent.length, 1);

    const issuePrivateSaved = await vscode.commands.executeCommand<{ ok: boolean }>(REPORT_COMMANDS.feedback, { kind: 'issue', number: 12, note: 'Private issue note kept on this machine', interactive: false });
    assert.equal(issuePrivateSaved.ok, true);
    installPublicFeedbackTestOverrides({
      session: async () => auth,
      user: async () => ({ id: 42, login: 'pm-user' }),
      version: async (target) => target.version,
      repository: async () => 'host/repo',
      confirm: async () => true,
      comment: async () => { throw new Error('synthetic uncertain response'); }
    });
    assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.publicFeedback, { body: 'Leaking Private issue note kept on this machine', interactive: false }), { ok: false, code: 'content-blocked' });
    const unknownSend = await vscode.commands.executeCommand<{ ok: boolean; code?: string }>(REPORT_COMMANDS.publicFeedback, { body: 'A distinct public issue comment.', interactive: false });
    assert.deepEqual(unknownSend, { ok: false, code: 'outcome-unknown' });
    const refusedRetry = await vscode.commands.executeCommand<{ ok: boolean; code?: string }>(REPORT_COMMANDS.publicFeedback, { body: 'A distinct public issue comment.', interactive: false });
    assert.deepEqual(refusedRetry, { ok: false, code: 'outcome-unknown' }, 'an unknown write result is persisted and cannot be posted again after reopening');
    await vscode.commands.executeCommand(REPORT_COMMANDS.open, { kind: 'pullRequest', number: 7 });
    assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.closeIssue, { reason: 'completed', interactive: false }), { ok: false, code: 'no-issue-report-open' }, 'closing is only offered on an Issue report');

    // Feedback is bound to what the open report showed. A push while the input
    // box is open must not relabel A's note as if it had been written for B.
    const moved = 'e'.repeat(40);
    setReportDepsForTests({
      repository: async () => 'host/repo',
      readerFor: () => fakeReader({ getPullRequest: async () => ({ kind: 'ok', data: { number: 7, title: 'Moved', state: 'open', headSha: moved, headRepository: 'host/repo' } }) }),
      promptFeedback: async () => 'This was written while reading the old head'
    });
    const rejectedMovedHead = await vscode.commands.executeCommand<{ ok: boolean; code?: string }>(REPORT_COMMANDS.feedback);
    assert.deepEqual(rejectedMovedHead, { ok: false, code: 'head-changed' });

    // The same numbered PR in another workspace/repository must not receive the
    // note if the workspace changes while the input is waiting.
    let currentRepository = 'host/repo';
    setReportDepsForTests({
      repository: async () => currentRepository,
      readerFor: () => fakeReader(),
      promptFeedback: async () => { currentRepository = 'other/repo'; return 'Must stay with the old repository'; }
    });
    const rejectedWorkspace = await vscode.commands.executeCommand<{ ok: boolean; code?: string }>(REPORT_COMMANDS.feedback);
    assert.deepEqual(rejectedWorkspace, { ok: false, code: 'report-context-changed' });
    assert.match(await reportText('pullRequest', 7), /LOCAL FEEDBACK\nNone saved on this machine/, 'the new repository did not receive the note');
    setReportDepsForTests({ repository: async () => 'host/repo', readerFor: () => fakeReader() });

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
    // The adapter caches reads by default. Force both the files and the second head read,
    // otherwise the version check may compare cached A to cached A while GitHub is on B.
    let forcedFiles = false;
    let forcedHead = false;
    let cacheHeadReads = 0;
    setReportDepsForTests({ repository: async () => 'host/repo', readerFor: () => fakeReader({
      getPullRequest: async (_number, opts) => {
        cacheHeadReads += 1;
        if (cacheHeadReads > 1) forcedHead = opts?.forceRefresh === true;
        return { kind: 'ok', data: { number: 7, title: 'Cached head', state: 'open', headSha: opts?.forceRefresh ? 'e'.repeat(40) : HEAD, headRepository: 'external/reports' } };
      },
      getPullRequestFiles: async (_number, opts) => {
        forcedFiles = opts?.forceRefresh === true;
        return { kind: 'ok', data: [{ filename: opts?.forceRefresh ? 'new-head.ts' : 'old-cache.ts', status: 'modified', patch: '+new-head-only' }] };
      }
    }) });
    const cachedHead = await reportText('pullRequest', 7);
    assert.equal(forcedFiles, true);
    assert.equal(forcedHead, true);
    assert.match(cachedHead, /Diff for this head: unknown/);
    assert.equal(cachedHead.includes('new-head.ts'), false);
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

    // an incomplete or failed list is never shown as the whole list, and its count is not guessed either
    for (const kind of ['partial', 'truncated', 'denied', 'offline', 'rate_limited', 'invalid']) {
      setReportDepsForTests({ repository: async () => 'host/repo', readerFor: () => fakeReader({ listIssues: async () => ({ kind, data: [{ number: 99, title: 'Must not appear' }] }) }) });
      const shown = await labels('issue');
      assert.equal(shown.length, 1, kind);
      assert.equal(shown.some((label) => label.includes('99')), false, kind);
      assert.equal(reportBadgeForTests('issue'), undefined, kind);
      // Only an expired or refused session offers a one-click sign-in among these unknown-mode failures.
      const row = ((await reportTreeForTests('issue').getChildren()) ?? [])[0];
      assert.equal(row?.command?.command, kind === 'denied' ? 'multiagentSystem.github.signIn' : undefined, `${kind}: sign-in action`);
    }
    setReportDepsForTests({ repository: async () => 'host/repo', readerFor: () => fakeReader({
      listIssues: async () => ({ kind: 'rate_limited', authMode: 'anonymous', scope: 'primary', resetAt: '2026-10-19T04:00:00Z' })
    }) });
    const anonymousRate = ((await reportTreeForTests('issue').getChildren()) ?? [])[0];
    assert.match(anonymousRate.label?.toString() ?? '', /anonymous GitHub access.*Retry after 2026-10-19T04:00:00.000Z/);
    assert.equal(anonymousRate.command?.command, 'multiagentSystem.github.signIn');
    setReportDepsForTests({ repository: async () => 'host/repo', readerFor: () => fakeReader({ listIssues: async () => { throw new Error('network down'); } }) });
    assert.match((await labels('issue'))[0], /could not be read/);
    assert.equal(reportBadgeForTests('issue'), undefined, 'a failed read clears a previously shown count, rather than leaving it stale');
    setReportDepsForTests({ repository: async () => 'host/repo', readerFor: () => fakeReader({ listIssues: async () => ({ kind: 'empty', data: [] }) }) });
    assert.deepEqual(await labels('issue'), ['No issues were reported.']);
    for (const answer of [{ kind: 'ok' }, { kind: 'ok', data: [null] }, { kind: 'ok', data: [{ number: 0, title: 'bad' }] }, { kind: 'empty', data: [{ number: 99, title: 'bad' }] }]) {
      setReportDepsForTests({ repository: async () => 'host/repo', readerFor: () => fakeReader({ listIssues: async () => answer }) });
      assert.match((await labels('issue'))[0], /could not be read \(invalid\)/);
      assert.equal((await labels('issue')).some((label) => label.includes('No issues were reported.')), false);
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
