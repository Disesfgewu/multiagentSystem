import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { planTreeForTests, setPlanEvidenceDepsForTests, PLAN_COMMANDS, PLAN_VIEW, PlanEvidenceReader } from '../../../src/plan/planView';
import { setReportDepsForTests, REPORT_SCHEME } from '../../../src/reports/reportsView';

export async function runPlanChecks(workspace: string): Promise<string> {
  const commands = await vscode.commands.getCommands(true);
  for (const command of Object.values(PLAN_COMMANDS)) assert.ok(commands.includes(command));
  const manifest = vscode.extensions.all.find((candidate) => candidate.packageJSON?.name === 'multiagentsystem')?.packageJSON;
  assert.ok(manifest.contributes.views.multiagentSystem.some((view: { id: string }) => view.id === PLAN_VIEW));

  const tree = planTreeForTests();
  const firstTask = async () => {
    const currentSections = await tree.getChildren();
    return (await tree.getChildren(currentSections?.[0]))?.[0];
  };
  const empty = await tree.getChildren();
  assert.match(String(empty?.[0]?.label), /No core plan yet/);
  await vscode.commands.executeCommand(PLAN_COMMANDS.create);
  const uri = vscode.Uri.file(path.join(workspace, 'docs', 'MASTER_PLAN.md'));
  const created = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  assert.match(created, /DEC-001/);
  await vscode.commands.executeCommand(PLAN_COMMANDS.create);
  assert.equal(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)), created, 'create never overwrites the project plan');

  const lines = ['# Project plan', '## M1 — many tasks', ...Array.from({ length: 100 }, (_, index) => `- [ ] M1-${String(index + 1).padStart(3, '0')} Task ${index + 1}`), '## Decisions', '- [ ] DEC-001 Review the evidence.'];
  const document = await vscode.workspace.openTextDocument(uri);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(0, 0, document.lineCount, 0), lines.join('\n') + '\n');
  assert.equal(await vscode.workspace.applyEdit(edit), true);
  assert.equal(await document.save(), true);
  await vscode.commands.executeCommand(PLAN_COMMANDS.refresh);
  const sections = await tree.getChildren();
  assert.equal(sections?.length, 2);
  assert.match(String(sections?.[0]?.description), /100 open \/ 100 total/);
  const tasks = await tree.getChildren(sections?.[0]);
  assert.equal(tasks?.length, 100);
  assert.equal(tasks?.[99]?.label, 'M1-100 Task 100');
  assert.match(String((await tree.getChildren(tasks?.[99]))?.[0]?.label), /待連結/);
  await vscode.commands.executeCommand(PLAN_COMMANDS.filter, 'done');
  assert.match(String((await tree.getChildren())?.[0]?.label), /No recorded TODOs/);
  const completed = new vscode.WorkspaceEdit();
  completed.replace(uri, new vscode.Range(3, 0, 3, lines[3].length), '- [x] M1-002 Task 2');
  assert.equal(await vscode.workspace.applyEdit(completed), true);
  const doneSections = await tree.getChildren();
  assert.equal(doneSections?.length, 1);
  assert.equal((await tree.getChildren(doneSections?.[0]))?.[0]?.label, 'M1-002 Task 2');
  await vscode.commands.executeCommand(PLAN_COMMANDS.filter, 'open');
  const openSections = await tree.getChildren();
  assert.match(String(openSections?.[0]?.description), /99 open \/ 100 total/);
  assert.equal((await tree.getChildren(openSections?.[0]))?.length, 99);
  await vscode.commands.executeCommand(PLAN_COMMANDS.filter, 'all');
  const unsaved = new vscode.WorkspaceEdit();
  unsaved.replace(uri, new vscode.Range(2, 0, 2, lines[2].length), '- [ ] M1-001 Task 1 updated。負責：PM；依賴：#412；驗收依據：PR #407；');
  assert.equal(await vscode.workspace.applyEdit(unsaved), true);
  const liveTasks = await tree.getChildren(sections?.[0]);
  assert.equal(liveTasks?.[0]?.label, 'M1-001 Task 1', 'a stale section retains its snapshot until refresh');
  const refreshed = await tree.getChildren();
  const currentTasks = await tree.getChildren(refreshed?.[0]);
  assert.equal(currentTasks?.[0]?.label, 'M1-001 Task 1 updated', 'unsaved changes appear in Core Plan');
  const links = (await tree.getChildren(currentTasks?.[0])) ?? [];
  assert.deepEqual(links.map((link) => link.label), ['Issue #412', 'PR #407']);
  await vscode.commands.executeCommand(PLAN_COMMANDS.filter, 'role:pm');
  const pmSections = await tree.getChildren();
  assert.equal(pmSections?.length, 1);
  const pmTasks = await tree.getChildren(pmSections?.[0]);
  assert.deepEqual(pmTasks?.map((item) => item.label), ['M1-001 Task 1 updated']);
  await vscode.commands.executeCommand(PLAN_COMMANDS.filter, 'role:researcher');
  assert.match(String((await tree.getChildren())?.[0]?.label), /No Role: Researcher TODOs/);
  await vscode.commands.executeCommand(PLAN_COMMANDS.filter, 'all');
  const head = 'a'.repeat(40);
  setReportDepsForTests({ repository: async () => 'host/repo', readerFor: () => ({
    listIssues: async () => ({ kind: 'empty' }),
    getIssue: async (number) => ({ kind: 'ok', data: { number, title: 'Linked requirement', state: 'open', body: 'Core Plan linked this Issue.' } }),
    getIssueComments: async () => ({ kind: 'empty' }),
    listPullRequests: async () => ({ kind: 'empty' }),
    getPullRequest: async (number) => ({ kind: 'ok', data: { number, title: 'Linked delivery', state: 'open', headSha: head, body: 'Core Plan linked this PR.' } }),
    getPullRequestFiles: async () => ({ kind: 'empty' }),
    getPullRequestSnapshot: async () => ({ status: 'partial' }),
    getReviews: async () => ({ kind: 'empty' })
  }) });
  try {
    for (const [index, expected] of ['Issue #412: Linked requirement', 'Pull request #407: Linked delivery'].entries()) {
      const command = links[index].command!;
      await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
      assert.equal(vscode.window.activeTextEditor?.document.uri.scheme, REPORT_SCHEME);
      assert.ok(vscode.window.activeTextEditor?.document.getText().includes(expected), 'TODO links open the corresponding report without a browser or typed number');
    }
  } finally { setReportDepsForTests(undefined); }

  // M1-001 Task 1 updated。負責：PM；依賴：#412；證據：PR #407；  -- #412 is a dependency (never
  // flagged), #407 is this TODO's own acceptance evidence (flagged when it disagrees with the box).
  let prState: { number: number; state: string; merged: boolean; draft: boolean; headSha: string } = { number: 407, state: 'open', merged: false, draft: false, headSha: head };
  const forcedReads: boolean[] = [];
  const evidenceReader: PlanEvidenceReader = {
    getIssue: async (number, options) => { forcedReads.push(options?.forceRefresh === true); return { kind: 'ok', data: { number, state: options?.forceRefresh ? 'closed' : 'open' } }; },
    getPullRequest: async (_number, options) => {
      forcedReads.push(options?.forceRefresh === true);
      return { kind: 'ok', data: options?.forceRefresh ? prState : { ...prState, state: 'closed', merged: true } };
    }
  };
  try {
    setPlanEvidenceDepsForTests({ repository: async () => 'host/repo', readerFor: () => evidenceReader, now: () => new Date('2026-10-17T00:00:00Z') });
    const evidenceSections = await tree.getChildren();
    const evidenceTasks = await tree.getChildren(evidenceSections?.[0]);
    const unchecked = (await tree.getChildren(evidenceTasks?.[0])) ?? [];
    assert.match(String(unchecked[0]?.description), /^closed · host\/repo$/, 'a dependency Issue being closed is shown, but is never read as this TODO failing or succeeding');
    assert.equal(String(unchecked[0]?.tooltip).includes('dependency (informational only)'), true);
    assert.match(String(unchecked[1]?.description), /^open · host\/repo · a{40}$/, 'the TODO is unchecked and its acceptance PR is still open: consistent, no warning');
    assert.equal(forcedReads.every(Boolean), true, 'an expansion never labels a cached response as freshly read');
    assert.match(String(unchecked[1]?.tooltip), /source: host\/repo; full PR head: a{40}/);

    prState = { number: 407, state: 'closed', merged: true, draft: false, headSha: head };
    const mergedWhileUnchecked = (await tree.getChildren(evidenceTasks?.[0])) ?? [];
    assert.match(String(mergedWhileUnchecked[1]?.description), /^⚠ merged: needs human review · host\/repo · a{40}$/, 'the TODO is still unchecked but its own acceptance evidence already merged');
    assert.equal(String(mergedWhileUnchecked[1]?.tooltip).includes('disagree'), true);
    assert.equal(mergedWhileUnchecked[1]?.iconPath instanceof vscode.ThemeIcon && (mergedWhileUnchecked[1].iconPath as vscode.ThemeIcon).id, 'warning');

    // A merge can change state without changing head. The final read is authoritative.
    let sameHeadReads = 0;
    setPlanEvidenceDepsForTests({ repository: async () => 'host/repo', readerFor: () => ({
      getIssue: async (number) => ({ kind: 'ok', data: { number, state: 'closed' } }),
      getPullRequest: async () => ({ kind: 'ok', data: sameHeadReads++ === 0
        ? { ...prState, state: 'open', merged: false }
        : prState })
    }), now: () => new Date() });
    const sameHeadMerge = (await tree.getChildren(await firstTask())) ?? [];
    assert.match(String(sameHeadMerge[1]?.description), /^⚠ merged: needs human review/, 'same-head open to merged uses the last validated response');

    setPlanEvidenceDepsForTests({ repository: async () => 'host/repo', readerFor: () => evidenceReader, now: () => new Date() });
    const beforeRefreshSections = await tree.getChildren();
    await vscode.commands.executeCommand(PLAN_COMMANDS.refresh);
    const oldSectionTasks = await tree.getChildren(beforeRefreshSections?.[0]);
    const oldSectionEvidence = (await tree.getChildren(oldSectionTasks?.[0])) ?? [];
    assert.equal(oldSectionEvidence[1]?.description, 'unknown', 'expanding a stale section must not stamp its old TODO snapshot with the current generation');

    let transitionReads = 0;
    setPlanEvidenceDepsForTests({ repository: async () => 'host/repo', readerFor: () => ({
      getIssue: async (number) => ({ kind: 'ok', data: { number, state: 'closed' } }),
      getPullRequest: async (_number, options) => ({ kind: 'ok', data: { ...prState, headSha: options?.forceRefresh && transitionReads++ === 0 ? 'a'.repeat(40) : 'b'.repeat(40) } })
    }), now: () => new Date() });
    const changedHead = (await tree.getChildren(await firstTask())) ?? [];
    assert.equal(changedHead[1]?.description, 'unknown', 'a PR whose head changes from A to B during the read stays unknown');

    const delayedRead = async (changeWhilePending: () => Promise<void> | void, repositoryAfter?: () => string) => {
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const began = new Promise<void>((resolve) => { started = resolve; });
      setPlanEvidenceDepsForTests({
        repository: async () => repositoryAfter?.() ?? 'host/repo',
        readerFor: () => ({
          getIssue: async (number) => ({ kind: 'ok', data: { number, state: 'closed' } }),
          getPullRequest: async () => { started(); await gate; return { kind: 'ok', data: prState }; }
        }),
        now: () => new Date()
      });
      const pending = tree.getChildren(await firstTask());
      await began;
      await changeWhilePending();
      release();
      return (await pending) ?? [];
    };

    const afterRefresh = await delayedRead(async () => { await vscode.commands.executeCommand(PLAN_COMMANDS.refresh); });
    assert.equal(afterRefresh[1]?.description, 'unknown', 'refresh discards an older in-flight GitHub answer');

    let switchedRepository = 'host/repo';
    const afterWorkspaceSwitch = await delayedRead(() => { switchedRepository = 'other/repo'; }, () => switchedRepository);
    assert.equal(afterWorkspaceSwitch[1]?.description, 'unknown', 'a repository change discards the old project answer');

    let beforeCheckboxSections = await tree.getChildren();
    const checkedEdit = new vscode.WorkspaceEdit();
    checkedEdit.replace(uri, new vscode.Range(2, 0, 2, '- [ ] M1-001 Task 1 updated。負責：PM；依賴：#412；驗收依據：PR #407；'.length), '- [x] M1-001 Task 1 updated。負責：PM；依賴：#412；驗收依據：PR #407；');
    const afterCheckboxChange = await delayedRead(async () => { beforeCheckboxSections = await tree.getChildren(); assert.equal(await vscode.workspace.applyEdit(checkedEdit), true); });
    assert.equal(afterCheckboxChange[1]?.description, 'unknown', 'a checkbox edit discards the answer for the old TODO snapshot');
    const checkboxOldTasks = await tree.getChildren(beforeCheckboxSections?.[0]);
    const checkboxOldEvidence = (await tree.getChildren(checkboxOldTasks?.[0])) ?? [];
    assert.equal(checkboxOldEvidence[1]?.description, 'unknown', 'a section captured before a checkbox edit remains stale when expanded afterwards');
    // A stale section snapshot still carries the old checkbox; re-fetch from the root to pick it up.
    setPlanEvidenceDepsForTests({ repository: async () => 'host/repo', readerFor: () => evidenceReader, now: () => new Date() });
    const freshSections = await tree.getChildren();
    const freshTasks = await tree.getChildren(freshSections?.[0]);
    const afterCheck = (await tree.getChildren(freshTasks?.[0])) ?? [];
    assert.match(String(afterCheck[1]?.description), /^merged · host\/repo/, 'checked and merged agree: no warning');

    setPlanEvidenceDepsForTests({ repository: async () => null, readerFor: () => evidenceReader, now: () => new Date() });
    const noRepoSections = await tree.getChildren();
    const noRepoTasks = await tree.getChildren(noRepoSections?.[0]);
    const noRepository = (await tree.getChildren(noRepoTasks?.[0])) ?? [];
    assert.equal(noRepository[0]?.description, 'unknown', 'no connected GitHub repository: shown as unknown, never guessed');
    assert.equal(noRepository[1]?.description, 'unknown');

    setPlanEvidenceDepsForTests({ repository: async () => 'host/repo', readerFor: () => ({ getIssue: async () => { throw new Error('offline'); }, getPullRequest: async () => ({ kind: 'denied' }) }), now: () => new Date() });
    const failedSections = await tree.getChildren();
    const failedTasks = await tree.getChildren(failedSections?.[0]);
    const failedRead = (await tree.getChildren(failedTasks?.[0])) ?? [];
    assert.equal(failedRead[0]?.description, 'unknown', 'a thrown read is unknown, not a crash');
    assert.equal(failedRead[1]?.description, 'unknown', 'a denied read is unknown, not treated as resolved or as a conflict');

    // A dependency outside this module's control (finding the repository itself) can also throw.
    setPlanEvidenceDepsForTests({ repository: async () => { throw new Error('worktree lookup failed'); }, readerFor: () => evidenceReader, now: () => new Date() });
    const failedRepoSections = await tree.getChildren();
    const failedRepoTasks = await tree.getChildren(failedRepoSections?.[0]);
    const failedRepository = (await tree.getChildren(failedRepoTasks?.[0])) ?? [];
    assert.equal(failedRepository[0]?.description, 'unknown', 'a thrown repository lookup is unknown, not a crash that breaks the whole tree');
    assert.equal(failedRepository[1]?.description, 'unknown');
  } finally { setPlanEvidenceDepsForTests(undefined); }

  await vscode.commands.executeCommand(PLAN_COMMANDS.open, { line: 101 });
  assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, uri.fsPath);
  assert.equal(vscode.window.activeTextEditor?.selection.active.line, 101);
  await vscode.commands.executeCommand(PLAN_COMMANDS.returnToOverview);
  return 'host smoke: Core Plan filters 100 TODOs, opens linked Issue/PR reports and the source line, and returns to Overview';
}
