import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DIFF_SCHEME, REPORT_COMMANDS, setReportDepsForTests, ReportReader } from '../../../src/reports/reportsView';

const HEAD = 'd'.repeat(40);

/** Jumping from a pull request report to the code, in a real Extension Host with a fake GitHub reader and a temporary working folder. */
export async function runReviewJumpChecks(): Promise<void> {
  // A number no other host test opens, so the report document is read fresh.
  const prs = [{ number: 41, title: 'Add reports', state: 'open', draft: false, headRef: 'feat/reports', headRepository: 'host/repo', headSha: HEAD, baseRef: 'main', author: 'worker', body: 'Refs #12', referencedIssues: [] }];
  const reader = {
    listIssues: async () => ({ kind: 'empty' }),
    getIssue: async () => ({ kind: 'empty' }),
    getIssueComments: async () => ({ kind: 'ok', data: [] }),
    listPullRequests: async () => ({ kind: 'ok', data: prs }),
    getPullRequest: async (n: number) => ({ kind: 'ok', data: prs.find((entry) => entry.number === n) }),
    getPullRequestFiles: async () => ({ kind: 'ok', data: [{ filename: 'src/report.ts', status: 'modified', additions: 3, deletions: 1, patch: '@@ -1 +1,3 @@\n-old\n+new\n+two\n+three' }] }),
    getPullRequestSnapshot: async () => ({ status: 'complete', consistent: true, headSha: HEAD, approval: { status: 'not_approved', reason: 'no_approval' }, checksSummary: { state: 'passing', requiredState: 'passing', headSha: HEAD, failing: [] }, unresolvedThreads: 0 }),
    getReviews: async () => ({ kind: 'ok', data: [] }),
    getReviewComments: async () => ({ kind: 'ok', data: [{ author: 'reviewer', path: 'src/report.ts', line: 2, commitId: HEAD, body: 'Please look at this line.' }, { author: 'reviewer', path: 'src/not-in-the-pr.ts', line: 4, commitId: HEAD, body: 'Not a file of this pull request.' }] })
  } as unknown as ReportReader;
  const folder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mas-jump-')));
  fs.mkdirSync(path.join(folder, 'src'));
  const file = path.join(folder, 'src', 'report.ts');
  fs.writeFileSync(file, 'one\nnew\ntwo\nthree\nfour\n');
  let worktrees: Array<{ path: string; headSha: string }> = [{ path: folder, headSha: HEAD }];
  setReportDepsForTests({ repository: async () => 'host/repo', readerFor: () => reader, worktrees: async () => worktrees });
  const info: string[] = [];
  const ui = vscode.window as any;
  const original = ui.showInformationMessage;
  ui.showInformationMessage = async (message: string) => { info.push(message); return undefined; };
  try {
    await vscode.commands.executeCommand(REPORT_COMMANDS.open, { kind: 'pullRequest', number: 41 });
    const report = vscode.window.activeTextEditor!.document;
    const links = (await vscode.commands.executeCommand<vscode.DocumentLink[]>('vscode.executeLinkProvider', report.uri)) ?? [];
    const jumps = links.filter((link) => link.target?.toString().startsWith(`command:${REPORT_COMMANDS.openFileDiff}`)).map((link) => ({ link, args: JSON.parse(decodeURIComponent(link.target!.toString().split('?')[1])) as { reportUri: string; filename: string; line?: number } }));
    const inline = jumps.filter((entry) => entry.args.line !== undefined);
    assert.equal(inline.length, 1, 'the one inline comment on a file of this pull request is clickable, the one on another file is not');
    assert.deepEqual([inline[0].args.filename, inline[0].args.line], ['src/report.ts', 2]);
    assert.equal(report.getText(inline[0].link.range), 'src/report.ts:2', 'the clickable text is the path and line');
    assert.ok(jumps.some((entry) => entry.args.line === undefined), 'the changed file itself is still clickable');

    // A clean working folder at exactly the head: the real file opens at the line.
    const opened = await vscode.commands.executeCommand<{ ok: boolean; source?: string }>(REPORT_COMMANDS.openFileDiff, inline[0].args);
    assert.deepEqual([opened.ok, opened.source], [true, 'worktree']);
    const real = vscode.window.activeTextEditor!;
    assert.equal(real.document.uri.scheme, 'file');
    assert.equal(fs.realpathSync.native(real.document.uri.fsPath), file);
    assert.equal(real.selection.active.line, 1, 'line 2 is the second row');
    assert.ok(info.some((message) => /exactly this pull request's head/.test(message)));

    // Another commit, or no folder: the patch opens, at the row of that line.
    const patchRow = 5; // two header rows, then "@@", "-old", "+new", "+two"
    for (const other of [[{ path: folder, headSha: 'e'.repeat(40) }], []]) {
      worktrees = other;
      const result = await vscode.commands.executeCommand<{ ok: boolean; source?: string; row?: number }>(REPORT_COMMANDS.openFileDiff, inline[0].args);
      assert.deepEqual([result.ok, result.source, result.row], [true, 'patch', patchRow]);
      const diff = vscode.window.activeTextEditor!;
      assert.equal(diff.document.uri.scheme, DIFF_SCHEME);
      assert.equal(diff.selection.active.line, patchRow);
      assert.equal(diff.document.lineAt(patchRow).text, '+two');
    }

    // A line the patch does not show: the patch opens at the top and says so.
    info.length = 0;
    const outside = await vscode.commands.executeCommand<{ ok: boolean; source?: string; row?: number }>(REPORT_COMMANDS.openFileDiff, { ...inline[0].args, line: 999 });
    assert.deepEqual([outside.ok, outside.source, outside.row], [true, 'patch', undefined]);
    assert.ok(info.some((message) => /Line 999 is not part of the changed text/.test(message)));

    // A link out of the folder is not followed.
    if (process.platform !== 'win32') {
      const outsideFile = path.join(os.tmpdir(), `mas-jump-outside-${process.pid}.txt`);
      fs.writeFileSync(outsideFile, 'secret\n');
      fs.rmSync(file);
      fs.symlinkSync(outsideFile, file);
      worktrees = [{ path: folder, headSha: HEAD }];
      const linked = await vscode.commands.executeCommand<{ ok: boolean; source?: string }>(REPORT_COMMANDS.openFileDiff, inline[0].args);
      assert.deepEqual([linked.ok, linked.source], [true, 'patch'], 'a symbolic link is not followed out of the working folder');
      fs.rmSync(outsideFile, { force: true });
    }

    // Arguments that are not a line number are refused.
    for (const line of [0, -1, 1.5, '2', null, 10_000_001]) assert.deepEqual(await vscode.commands.executeCommand(REPORT_COMMANDS.openFileDiff, { ...inline[0].args, line }), { ok: false, code: 'invalid-file-diff' }, String(line));
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  } finally {
    ui.showInformationMessage = original;
    setReportDepsForTests(undefined);
    fs.rmSync(folder, { recursive: true, force: true });
  }
  console.log('host smoke: an inline review comment in a pull request report jumps to its line: in a clean working folder at exactly the head, else in the patch; links out of the folder and bad line numbers are refused');
}
