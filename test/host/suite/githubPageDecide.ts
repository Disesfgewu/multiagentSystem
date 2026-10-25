import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { privateStorage } from '../../../src/storage/storageCommands';
import { REPORT_COMMANDS, setReportDepsForTests } from '../../../src/reports/reportsView';
import { installPublicFeedbackTestOverrides, setPublicFeedbackTestMode } from '../../../src/reports/publicFeedback';
import { currentPageActions, currentPageWrites, githubPageForTests, setPageActions, setPageWrites } from '../../../src/reports/githubPage';

/**
 * #383 in a real Extension Host: the decisions of the Issue and pull request page. A synthetic GitHub (the report reader and the
 * publishing hooks) and the real private storage. Each button is on or off as the existing checks say, with their reason; a click goes
 * through the same function as the text report's command, with its confirmation (declining sends nothing), bound to the head the page
 * showed; and after it the page is read again and shows the new state.
 */
export async function runGitHubPageDecideChecks(): Promise<void> {
  const opened = await privateStorage()?.use();
  assert.ok(opened?.ok);
  const store = opened.store as any;
  const REPO = 'host/decide';
  const HEAD = 'c'.repeat(40);
  // The publisher and the merge authority are one record each: what the other suites set is put back afterwards.
  const kept = { publisher: store.get('policies', 'public-feedback-publisher'), merge: store.get('policies', 'merge-authority-policy') };

  const pr: Record<string, any> = { number: 70, title: 'Add decisions', body: 'Refs #383', state: 'open', merged: false, draft: false, author: 'external-worker', headSha: HEAD, headRef: 'feat/decide', headRepository: 'host/decide', baseRef: 'main', mergeable: true, labels: [], createdAt: '2026-10-25T01:00:00Z' };
  const issue: Record<string, any> = { number: 71, title: 'Decide here', body: 'Agenda', state: 'open', stateReason: null, isPullRequest: false, labels: [], author: 'pm-user', createdAt: '2026-10-25T01:00:00Z' };
  let approved = false;
  let checks = 'passing';
  const snapshot = () => ({
    repository: { owner: 'host', name: 'decide' }, number: 70, status: 'complete', consistent: true, headSha: pr.headSha,
    pullRequest: { kind: 'ok', data: { ...pr } },
    reviews: { kind: 'ok', data: [] },
    approval: approved
      ? { status: 'approved', reason: 'approved_on_current_head', headSha: pr.headSha, currentApprovals: [{ reviewer: 'pm-user', reviewId: 1, commitId: pr.headSha }], staleApprovals: [], changesRequested: [], selfApprovalsIgnored: [] }
      : { status: 'not_approved', reason: 'no_approval', headSha: pr.headSha, currentApprovals: [], staleApprovals: [], changesRequested: [], selfApprovalsIgnored: [] },
    checks: { kind: 'ok', data: { headSha: pr.headSha, checkRuns: [{}], statuses: [] } },
    checksSummary: { headSha: pr.headSha, state: checks, requiredState: checks, counts: { passing: checks === 'passing' ? 1 : 0, failing: checks === 'failing' ? 1 : 0, pending: 0 }, failing: checks === 'failing' ? ['unit'] : [], pending: [], missingRequired: [] },
    threads: { kind: 'empty', data: { headSha: pr.headSha, threads: [], unresolvedCount: 0 } },
    unresolvedThreads: 0,
    requirements: { kind: 'ok', data: { complete: true, ruleTypes: ['pull_request'], requireCodeOwnerReview: false, requireLastPushApproval: false, strictStatusChecks: false } }
  });
  let reads = 0;
  const reader: any = {
    listIssues: async () => ({ kind: 'ok', data: [issue] }),
    listPullRequests: async () => ({ kind: 'ok', data: [pr] }),
    getIssue: async () => ({ kind: 'ok', data: { ...issue } }),
    getPullRequest: async () => { reads += 1; return { kind: 'ok', data: { ...pr } }; },
    getPullRequestSnapshot: async () => snapshot(),
    getReviews: async () => ({ kind: 'empty', data: [] }),
    getIssueComments: async () => ({ kind: 'empty', data: [] }),
    getReviewComments: async () => ({ kind: 'empty', data: [] }),
    getPullRequestFiles: async () => ({ kind: 'ok', data: [{ filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' }] })
  };
  setReportDepsForTests({ repository: async () => REPO, readerFor: () => reader });
  const auth = { id: 'session', accessToken: 'x', account: { id: '42', label: 'pm-user' }, scopes: ['repo'] };
  const confirmations: string[] = [];
  let answer = true;
  const sent: string[] = [];
  let currentHead = (): string => pr.headSha;
  setPublicFeedbackTestMode(true);
  installPublicFeedbackTestOverrides({
    session: async () => auth as any,
    user: async () => ({ id: 42, login: 'pm-user' }) as any,
    version: async (target) => (target.kind === 'pullRequest' ? currentHead() : target.version),
    repository: async () => REPO,
    snapshot: async () => snapshot(),
    publication: async (_target, headSha) => ({ kind: 'ok', data: { complete: true, number: 70, headSha, diff: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n' } }),
    authorId: async (_auth, login) => (login === 'pm-user' ? '42' : '77'),
    issue: async () => ({ kind: 'ok', data: { ...issue } }),
    confirm: async (text: string) => { confirmations.push(text); return answer; },
    promptReview: async () => { throw new Error('the input box was asked although the page gave the review'); },
    pickReviewDecision: async () => { throw new Error('the decision was asked although the page gave it'); },
    pickCloseReason: async () => { throw new Error('the reason was asked although the page gave it'); },
    review: async (_auth, _repository, number, decision, body, expectedHeadSha) => { sent.push(`review ${number} ${decision} ${expectedHeadSha.slice(0, 7)} ${body}`); approved = decision === 'approve'; return { ok: true, number: 9100 }; },
    merge: async (_auth, _repository, number, expectedHeadSha) => { sent.push(`merge ${number} ${expectedHeadSha.slice(0, 7)}`); pr.state = 'closed'; pr.merged = true; return { ok: true, sha: HEAD }; },
    repositoryInfo: async () => ({ kind: 'ok', data: { defaultBranch: 'main' } }),
    branchRequirements: async () => ({ kind: 'empty', data: { complete: true, ruleTypes: [] } }),
    branchHead: async () => ({ kind: 'ok', data: { sha: HEAD } }),
    deleteBranch: async (_auth, _repository, branch, expectedHeadSha) => { sent.push(`delete ${branch} ${expectedHeadSha.slice(0, 7)}`); return { ok: true }; },
    closeIssue: async (_auth, _repository, number, reason) => { sent.push(`close ${number} ${reason}`); issue.state = 'closed'; issue.stateReason = reason; return { ok: true, number }; }
  });
  const realActions = currentPageActions();
  const realWrites = currentPageWrites();
  let trusted = true;
  setPageActions({ trusted: () => trusted, comment: async () => ({ ok: false, code: 'not-in-this-test' }), ask: async () => ({ ok: false, code: 'not-in-this-test' }) });
  const ui = vscode.window as any;
  const original = { info: ui.showInformationMessage, error: ui.showErrorMessage };
  const told: string[] = [];
  ui.showInformationMessage = async (text: string) => { told.push(text); return undefined; };
  ui.showErrorMessage = async (text: string) => { told.push(text); return undefined; };
  const codes = (abilities: Record<string, any>) => Object.fromEntries(Object.entries(abilities).map(([name, value]) => [name, value.ok ? 'on' : value.code]));
  try {
    assert.ok(currentPageWrites(), 'the reports module gives the page its decisions');
    // Before a publisher is set nothing can be decided, and the page says why.
    await vscode.commands.executeCommand(REPORT_COMMANDS.openPage, { kind: 'pullRequest', number: 70 });
    const page = githubPageForTests('pullRequest', 70)!;
    page.stop();
    assert.deepEqual(new Set(Object.values(codes(page.abilities))), new Set(['publisher-not-configured']), JSON.stringify(page.abilities));
    assert.deepEqual(await page.send({ type: 'review', decision: 'approve', text: 'Looks right.' }), { ok: false, reason: 'not-allowed', code: 'publisher-not-configured' });
    assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.configurePublisher), { ok: true });
    confirmations.length = 0;

    // A. Set up, Human-only merge authority (the default): review on, merge off with its reason, branch off until merged.
    await page.reload(); page.stop();
    assert.deepEqual(codes(page.abilities), { approve: 'on', requestChanges: 'on', merge: 'human-merge-required', deleteBranch: 'pr-not-merged' });
    assert.match(page.abilities.merge.reason ?? "", /Human only/);
    assert.deepEqual(await page.send({ type: 'merge' }), { ok: false, reason: 'not-allowed', code: 'human-merge-required' });
    assert.deepEqual(await page.send({ type: 'close', reason: 'completed' }), { ok: false, reason: 'wrong-page' });
    assert.equal(sent.length, 0);

    // B. Approve with the typed review, declined at the confirmation: nothing sent. Then confirmed: sent, bound to the shown head, and
    //    the page is read again.
    answer = false;
    assert.deepEqual(await page.send({ type: 'review', decision: 'approve', text: 'Checked on this head.' }), { ok: false, code: 'cancelled' });
    assert.equal(sent.length, 0, 'declined: nothing sent');
    assert.match(confirmations.at(-1) ?? '', new RegExp(`\\(approve\\) to ${REPO} PR #70 \\(head ${HEAD}\\)\\?\\n\\nChecked on this head\\.$`), 'the confirmation shows the whole review');
    answer = true;
    const before = reads;
    assert.deepEqual(await page.send({ type: 'review', decision: 'approve', text: 'Checked on this head.' }), { ok: true });
    assert.deepEqual(sent, [`review 70 approve ${HEAD.slice(0, 7)} Checked on this head.`]);
    assert.ok(reads > before, 'the page was read again after the review');
    page.stop();

    // C. The head moved after the page was read: the review is refused and nothing is sent.
    currentHead = () => 'd'.repeat(40);
    assert.deepEqual(await page.send({ type: 'review', decision: 'request_changes', text: 'Please add a test.' }), { ok: false, code: 'report-context-changed' });
    assert.equal(sent.length, 1);
    currentHead = () => pr.headSha;
    page.stop();

    // D. PM merge authority: with the approval and passing checks the merge is on; failing checks turn it off with their words.
    assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.configureMergeAuthority, { mode: 'pm', interactive: false }), { ok: true, mode: 'pm' });
    checks = 'failing';
    await page.reload(); page.stop();
    assert.equal(page.abilities.merge.code, 'ci-failing');
    assert.equal(page.abilities.merge.reason, 'Checks failed on this head.');
    checks = 'passing';
    await page.reload(); page.stop();
    assert.equal(page.abilities.merge.ok, true, JSON.stringify(page.abilities.merge));
    assert.deepEqual(await page.send({ type: 'merge' }), { ok: true });
    assert.deepEqual(sent.slice(1), [`merge 70 ${HEAD.slice(0, 7)}`]);
    assert.ok(confirmations.at(-1)?.startsWith(`Merge ${REPO} PR #70 (head ${HEAD})`), 'the merge was confirmed');
    page.stop();
    // Read again: merged; review and merge off, the branch can go.
    assert.equal((page.model as any)?.state, 'merged');
    assert.deepEqual(codes(page.abilities), { approve: 'pr-not-open', requestChanges: 'pr-not-open', merge: 'pr-not-open', deleteBranch: 'on' });
    assert.deepEqual(await page.send({ type: 'deleteBranch' }), { ok: true });
    assert.deepEqual(sent.slice(2), [`delete feat/decide ${HEAD.slice(0, 7)}`]);
    assert.match(confirmations.at(-1) ?? '', /Delete the branch “feat\/decide”/);
    page.stop();

    // E. The Issue page: close as completed, confirmed; read again, closed, and both close buttons off.
    await vscode.commands.executeCommand(REPORT_COMMANDS.openPage, { kind: 'issue', number: 71 });
    const issuePage = githubPageForTests('issue', 71)!;
    issuePage.stop();
    assert.deepEqual(codes(issuePage.abilities), { closeCompleted: 'on', closeNotPlanned: 'on' });
    assert.deepEqual(await issuePage.send({ type: 'merge' }), { ok: false, reason: 'wrong-page' });
    answer = false;
    assert.deepEqual(await issuePage.send({ type: 'close', reason: 'completed' }), { ok: false, code: 'cancelled' });
    answer = true;
    assert.deepEqual(await issuePage.send({ type: 'close', reason: 'completed' }), { ok: true });
    issuePage.stop();
    assert.deepEqual(sent.slice(3), ['close 71 completed']);
    assert.match(confirmations.at(-1) ?? '', /Close host\/decide Issue #71 as completed\?/);
    assert.equal((issuePage.model as any)?.state, 'closed');
    assert.deepEqual(codes(issuePage.abilities), { closeCompleted: 'issue-not-open', closeNotPlanned: 'issue-not-open' });

    // F. An untrusted workspace: everything off with that reason, and a click is refused before any function runs.
    trusted = false;
    issue.state = 'open';
    await issuePage.reload(); issuePage.stop();
    assert.deepEqual(new Set(Object.values(codes(issuePage.abilities))), new Set(['untrusted']));
    assert.deepEqual(await issuePage.send({ type: 'close', reason: 'not_planned' }), { ok: false, reason: 'untrusted' });
    assert.equal(sent.length, 4, 'nothing sent from an untrusted workspace');
    assert.ok(told.some((text) => text === 'Issue closed and verified.'), told.join(' | '));
  } finally {
    ui.showInformationMessage = original.info;
    ui.showErrorMessage = original.error;
    setPageActions(realActions);
    setPageWrites(realWrites);
    installPublicFeedbackTestOverrides({});
    setReportDepsForTests(undefined);
    githubPageForTests('pullRequest', 70)?.stop();
    githubPageForTests('issue', 71)?.stop();
    for (const [id, found] of [['public-feedback-publisher', kept.publisher], ['merge-authority-policy', kept.merge]] as const) {
      if (found?.ok && found.found) store.put('policies', id, found.value); else store.delete('policies', id);
    }
  }
  console.log('host smoke: the Issue and pull request page turns each decision on or off by the existing checks and says why; Approve, Merge, Delete branch and Close go through their own functions after the confirmation, bound to the head shown, and the page shows the new state; declining, a moved head, the wrong page or an untrusted workspace sends nothing');
}
