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
  unsaved.replace(uri, new vscode.Range(2, 0, 2, lines[2].length), '- [ ] M1-001 Task 1 updated。負責：PM；依賴：#412；證據：PR #407；');
  assert.equal(await vscode.workspace.applyEdit(unsaved), true);
  const liveTasks = await tree.getChildren(sections?.[0]);
  assert.equal(liveTasks?.[0]?.label, 'M1-001 Task 1', 'a stale section retains its snapshot until refresh');
  const refreshed = await tree.getChildren();
  const currentTasks = await tree.getChildren(refreshed?.[0]);
  assert.equal(currentTasks?.[0]?.label, 'M1-001 Task 1 updated', 'unsaved changes appear in Core Plan');
  const links = (await tree.getChildren(currentTasks?.[0])) ?? [];
  assert.deepEqual(links.map((link) => link.label), ['Issue #412', 'PR #407']);
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
  let prState: { state: string; merged: boolean; draft: boolean } = { state: 'open', merged: false, draft: false };
  const evidenceReader: PlanEvidenceReader = {
    getIssue: async () => ({ kind: 'ok', data: { state: 'closed' } }),
    getPullRequest: async () => ({ kind: 'ok', data: prState })
  };
  try {
    setPlanEvidenceDepsForTests({ repository: async () => 'host/repo', readerFor: () => evidenceReader, now: () => new Date('2026-10-17T00:00:00Z') });
    const unchecked = (await tree.getChildren(currentTasks?.[0])) ?? [];
    assert.equal(unchecked[0]?.description, 'closed', 'a dependency Issue being closed is shown, but is never read as this TODO failing or succeeding');
    assert.equal(String(unchecked[0]?.tooltip).includes('dependency (informational only)'), true);
    assert.equal(unchecked[1]?.description, 'open', 'the TODO is unchecked and its evidence PR is still open: consistent, no warning');

    prState = { state: 'closed', merged: true, draft: false };
    const mergedWhileUnchecked = (await tree.getChildren(currentTasks?.[0])) ?? [];
    assert.equal(mergedWhileUnchecked[1]?.description, '⚠ merged: needs human review', 'the TODO is still unchecked but its own acceptance evidence already merged');
    assert.equal(String(mergedWhileUnchecked[1]?.tooltip).includes('disagree'), true);
    assert.equal(mergedWhileUnchecked[1]?.iconPath instanceof vscode.ThemeIcon && (mergedWhileUnchecked[1].iconPath as vscode.ThemeIcon).id, 'warning');

    const checkedEdit = new vscode.WorkspaceEdit();
    checkedEdit.replace(uri, new vscode.Range(2, 0, 2, '- [ ] M1-001 Task 1 updated。負責：PM；依賴：#412；證據：PR #407；'.length), '- [x] M1-001 Task 1 updated。負責：PM；依賴：#412；證據：PR #407；');
    assert.equal(await vscode.workspace.applyEdit(checkedEdit), true);
    // A stale section snapshot still carries the old checkbox; re-fetch from the root to pick it up.
    const freshSections = await tree.getChildren();
    const freshTasks = await tree.getChildren(freshSections?.[0]);
    const afterCheck = (await tree.getChildren(freshTasks?.[0])) ?? [];
    assert.equal(afterCheck[1]?.description, 'merged', 'checked and merged agree: no warning');

    setPlanEvidenceDepsForTests({ repository: async () => null, readerFor: () => evidenceReader, now: () => new Date() });
    const noRepository = (await tree.getChildren(freshTasks?.[0])) ?? [];
    assert.equal(noRepository[0]?.description, 'unknown', 'no connected GitHub repository: shown as unknown, never guessed');
    assert.equal(noRepository[1]?.description, 'unknown');

    setPlanEvidenceDepsForTests({ repository: async () => 'host/repo', readerFor: () => ({ getIssue: async () => { throw new Error('offline'); }, getPullRequest: async () => ({ kind: 'denied' }) }), now: () => new Date() });
    const failedRead = (await tree.getChildren(freshTasks?.[0])) ?? [];
    assert.equal(failedRead[0]?.description, 'unknown', 'a thrown read is unknown, not a crash');
    assert.equal(failedRead[1]?.description, 'unknown', 'a denied read is unknown, not treated as resolved or as a conflict');

    // A dependency outside this module's control (finding the repository itself) can also throw.
    setPlanEvidenceDepsForTests({ repository: async () => { throw new Error('worktree lookup failed'); }, readerFor: () => evidenceReader, now: () => new Date() });
    const failedRepository = (await tree.getChildren(freshTasks?.[0])) ?? [];
    assert.equal(failedRepository[0]?.description, 'unknown', 'a thrown repository lookup is unknown, not a crash that breaks the whole tree');
    assert.equal(failedRepository[1]?.description, 'unknown');
  } finally { setPlanEvidenceDepsForTests(undefined); }

  await vscode.commands.executeCommand(PLAN_COMMANDS.open, { line: 101 });
  assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, uri.fsPath);
  assert.equal(vscode.window.activeTextEditor?.selection.active.line, 101);
  await vscode.commands.executeCommand(PLAN_COMMANDS.returnToOverview);
  return 'host smoke: Core Plan filters 100 TODOs, opens linked Issue/PR reports and the source line, and returns to Overview';
}
