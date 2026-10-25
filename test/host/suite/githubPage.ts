import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { DIFF_SCHEME, REPORT_COMMANDS, setReportDepsForTests, ReportReader } from '../../../src/reports/reportsView';
import { githubPageForTests } from '../../../src/reports/githubPage';

const HEAD = 'c'.repeat(40);
const ok = (data: unknown) => ({ kind: 'ok', data });

function reader(): ReportReader {
  const issue = { number: 353, title: 'GitHub-like pages', state: 'open', labels: ['ready'], assignees: [], author: 'shared', createdAt: '2026-10-23T08:00:00Z', body: '— PM-01\n## 驗收\n- **Markdown** rendered\n- [link](https://example.test/doc)\n\n<script>alert(1)</script>' };
  const pull = { number: 900, title: 'Read-only page', state: 'open', draft: false, merged: false, labels: [], author: 'shared', createdAt: '2026-10-24T08:00:00Z', headSha: HEAD, headRef: 'feat/page', baseRef: 'main', body: '— Worker-01\nRefs #353\n\n| a | b |\n|---|---|\n| 1 | 2 |' };
  return {
    listIssues: async () => ok([issue]),
    getIssue: async (n) => (n === 353 ? ok(issue) : { kind: 'not_found' }),
    getIssueComments: async (n) => ok(n === 353
      ? [{ id: 5001, author: 'shared', createdAt: '2026-10-23T09:00:00Z', body: '<span class="author author-owner">管理者</span>\n**Pass**' }, { id: 5002, author: 'shared', createdAt: '2026-10-23T10:00:00Z', body: '— Worker-01\nOn it: `src/reports/markdown.js`.' }]
      : []),
    listPullRequests: async () => ok([pull]),
    getPullRequest: async () => ok(pull),
    getPullRequestFiles: async () => ok([{ filename: 'src/reports/markdown.js', status: 'added', additions: 2, deletions: 0, patch: '@@ -0,0 +1,2 @@\n+one\n+two' }]),
    getPullRequestSnapshot: async () => ({ status: 'complete', consistent: true, headSha: HEAD, approval: { status: 'not_approved' }, checksSummary: { state: 'passing', headSha: HEAD }, checks: { kind: 'ok', data: { headSha: HEAD, checkRuns: [], statuses: [] } }, unresolvedThreads: 0 }),
    getReviews: async () => ok([{ id: 6001, reviewer: 'shared', state: 'CHANGES_REQUESTED', submittedAt: '2026-10-24T09:00:00Z', commitId: HEAD, body: '— PM-01\nNeeds changes' }]),
    getReviewComments: async () => ok([{ id: 7001, author: 'shared', path: 'src/reports/markdown.js', line: 2, createdAt: '2026-10-24T09:01:00Z', body: '— PM-01\nwhy?' }])
  };
}

/**
 * #353 in a real Extension Host: an Issue and a pull request open as pages in the editor, with Markdown as a tree the page draws,
 * the extension's author badge on every post, and for the pull request its head, CI, files and line comments. A file and a line
 * comment open the diff exactly as from the text report; anything the page asks that it was not given is refused.
 */
export async function runGitHubPageChecks(): Promise<void> {
  setReportDepsForTests({ repository: async () => 'host/repo', readerFor: () => reader() });
  try {
    const opened = await vscode.commands.executeCommand<{ ok: boolean }>(REPORT_COMMANDS.openPage, { kind: 'issue', number: 353 });
    assert.equal(opened?.ok, true);
    const issue = githubPageForTests('issue', 353)!;
    const model = issue.model as any;
    assert.equal(model.title, 'GitHub-like pages');
    assert.deepEqual(model.author.badge, { who: 'agent', text: 'PM-01（自稱）' });
    assert.deepEqual(model.body.blocks.map((block: any) => block.t), ['paragraph', 'heading', 'list', 'paragraph']);
    assert.equal(model.body.blocks[3].inline[0].v, '<script>alert(1)</script>', 'HTML in a body is text');
    assert.deepEqual(model.links, ['https://example.test/doc']);
    assert.deepEqual(model.posts.map((post: any) => [post.id, post.badge.text]), [[5001, '未署名'], [5002, 'Worker-01（自稱）']], 'a post that types a 管理者 badge is still unsigned');
    // The tab list follows the panel a moment later.
    let tabs: readonly vscode.Tab[] = [];
    for (let tries = 0; tries < 50; tries += 1) {
      tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
      if (tabs.some((tab) => tab.label === 'Issue #353')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(tabs.some((tab) => tab.label === 'Issue #353' && tab.input instanceof vscode.TabInputWebview), `the page is an editor tab (${tabs.map((tab) => tab.label).join(', ')})`);

    // Anything the page was not given is refused before it reaches a command.
    for (const [raw, reason] of [[{ type: 'openLink', link: 1 }, 'unknown-link'], [{ type: 'openFile', file: 0 }, 'unknown-file'], [{ type: 'merge', id: 900 }, 'unexpected-field'], [{ type: 'approveAll' }, 'unknown-command'], [{ type: 'openLink', link: 0, url: 'javascript:x' }, 'unexpected-field']] as const) {
      assert.deepEqual(await issue.send(raw), { ok: false, reason }, JSON.stringify(raw));
    }

    await vscode.commands.executeCommand(REPORT_COMMANDS.openPage, { kind: 'pullRequest', number: 900 });
    const pull = githubPageForTests('pullRequest', 900)!;
    const pr = (pull.model as any).pr;
    assert.deepEqual([pr.headSha, pr.ci, pr.files.length, pr.inline.length], [HEAD, 'checks passed', 1, 1]);
    assert.equal((pull.model as any).body.blocks[1].t, 'table');
    assert.deepEqual((pull.model as any).posts.map((post: any) => [post.kind, post.review, post.badge.text]), [['review', 'requested changes', 'PM-01（自稱）']]);

    // A changed file opens its diff, as the file of the text report does.
    assert.deepEqual(await pull.send({ type: 'openFile', file: 0 }), { ok: true });
    const diff = vscode.window.activeTextEditor!;
    assert.equal(diff.document.uri.scheme, DIFF_SCHEME);
    assert.match(diff.document.getText(), /\+two/);
    // A line comment opens it at its line.
    await vscode.commands.executeCommand(REPORT_COMMANDS.openPage, { kind: 'pullRequest', number: 900 });
    assert.deepEqual(await pull.send({ type: 'openInline', id: 7001 }), { ok: true });
    const atLine = vscode.window.activeTextEditor!;
    assert.equal(atLine.document.uri.scheme, DIFF_SCHEME);
    assert.equal(atLine.document.lineAt(atLine.selection.active.line).text, '+two', 'at the line of the comment');
    assert.deepEqual(await pull.send({ type: 'openInline', id: 7002 }), { ok: false, reason: 'unknown-comment' });

    // The text report is one click away.
    assert.deepEqual(await pull.send({ type: 'openText' }), { ok: true });
    assert.match(vscode.window.activeTextEditor!.document.getText(), /Pull request #900/);
  } finally {
    setReportDepsForTests(undefined);
  }
}
