import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { setReportDepsForTests, ReportReader } from '../../../src/reports/reportsView';

const HEAD = 'c'.repeat(40);

/** "Export Project Report (Markdown)" in a real Extension Host, against a fake GitHub reader: the report opens unsaved and writes nothing. */
export async function runExportReportChecks(workspace: string): Promise<void> {
  const issues = [{ number: 12, title: 'Read reports in the editor', state: 'open', labels: [], assignees: [], body: 'The user reads a report.\n\n## 驗收\n- [x] a\n- [ ] b' }, { number: 13, title: '# Fake heading [x](http://example.test)', state: 'open', labels: [], assignees: [], body: 'Another.' }];
  const prs = [{ number: 7, title: 'Add reports', state: 'open', draft: false, headRef: 'feat/reports', headSha: HEAD, referencedIssues: [{ number: 12 }] }];
  const reader = {
    listIssues: async () => ({ kind: 'ok', data: issues }),
    getIssue: async (n: number) => ({ kind: 'ok', data: issues.find((entry) => entry.number === n) }),
    getIssueComments: async () => ({ kind: 'ok', data: [] }),
    listPullRequests: async () => ({ kind: 'ok', data: prs }),
    getPullRequest: async (n: number) => ({ kind: 'ok', data: prs.find((entry) => entry.number === n) }),
    getPullRequestFiles: async () => ({ kind: 'ok', data: [] }),
    getPullRequestSnapshot: async () => ({ status: 'complete', consistent: true, headSha: HEAD, approval: { status: 'not_approved', reason: 'no_approval' }, checksSummary: { state: 'passing', requiredState: 'passing', headSha: HEAD }, unresolvedThreads: 0 }),
    getReviews: async () => ({ kind: 'ok', data: [] }),
    getReviewComments: async () => ({ kind: 'ok', data: [] })
  } as unknown as ReportReader;
  setReportDepsForTests({ repository: async () => 'host/repo', readerFor: () => reader });
  const before = fs.readdirSync(workspace).sort();
  const info: string[] = [];
  const ui = vscode.window as any;
  const original = ui.showInformationMessage;
  ui.showInformationMessage = async (message: string) => { info.push(message); return undefined; };
  try {
    await vscode.commands.executeCommand('multiagentSystem.export.projectReport', { path: '/tmp/ignored.md', content: 'ignored' });
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor, 'the report is open in an editor');
    const document = editor.document;
    assert.equal(document.languageId, 'markdown');
    assert.equal(document.isUntitled, true, 'the report is not tied to a file');
    const text = document.getText();
    for (const expected of ['# Project report', '### Issue #12: Read reports in the editor', 'Acceptance: 1 of 2 items ticked', '### Pull request #7: Add reports', 'Pull requests: #7', 'Head: cccccccccccc', '## What this report does not know']) assert.ok(text.includes(expected), expected);
    assert.ok(!text.split('\n').some((row) => /^#{1,6}\s.*Fake heading/.test(row) && !row.startsWith('### Issue #13:')), 'GitHub text did not become a heading of its own');
    assert.ok(text.includes('### Issue #13: \\# Fake heading \\[x\\]\\(http://example\\.test\\)'), 'GitHub text is shown escaped');
    assert.ok(!text.includes(workspace), 'the workspace path is not in the report');
    assert.deepEqual(fs.readdirSync(workspace).sort(), before, 'nothing was written to the workspace');
    assert.ok(info.some((message) => /Project report opened \(not saved\)/.test(message)));
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  } finally {
    ui.showInformationMessage = original;
    setReportDepsForTests(undefined);
  }
  console.log('host smoke: Export Project Report (Markdown) opens an unsaved editor with the report, escapes GitHub text, ignores arguments and writes nothing to the workspace');
}
