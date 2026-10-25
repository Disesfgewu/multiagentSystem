'use strict';

/**
 * The synthetic GitHub of the end-to-end run (#353): one Issue and one pull request of a made-up repository, with Markdown that has
 * every part the page draws, posts signed by agents, an unsigned one, and one that pretends to be the owner's badge and a "Pass"
 * button in raw HTML. Read by the extension only in the run (development mode and MULTIAGENT_E2E_GITHUB, see src/reports/e2eGitHub.js).
 */

const HEAD = '1234567890abcdef1234567890abcdef12345678';
const at = (day, hour) => `2026-10-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`;

const ISSUE_BODY = [
  '— PM-01',
  '## What the owner sees',
  'Issues and pull requests in the editor, **as GitHub shows them**, with `Markdown` rendered.',
  '',
  '- [x] headings and lists',
  '- [ ] comments from the page',
  '',
  '| Part | Shown as |',
  '|---|---|',
  '| code | a block |',
  '| link | opens in the browser |',
  '',
  '```js',
  "const page = open('#12');",
  '```',
  '',
  '> Read [the design notes](https://example.test/design) first.'
].join('\n');

// The work-order board (#397): one Issue in each stage, with the repository owner's account ("example") writing the PM verdicts
// and another account forging one, which must not count.
const BOARD_HEAD = 'abcdefabcdefabcdefabcdefabcdefabcdef1234';
const boardSnapshot = (number, title, state = 'passing', draft = false) => ({ status: 'complete', consistent: true, number, headSha: BOARD_HEAD, pullRequest: { kind: 'ok', data: { number, title, state: 'open', merged: false, draft, author: 'shared-account', headSha: BOARD_HEAD } }, checksSummary: { state, requiredState: state, headSha: BOARD_HEAD } });
const boardPr = (number, issue, title, extra = {}) => ({ number, title, state: 'open', draft: false, merged: false, labels: [], author: 'shared-account', createdAt: at(25, 8), updatedAt: at(25, 9), headSha: BOARD_HEAD, headRef: `feat/issue-${issue}`, headRepository: 'example/project', baseRef: 'main', referencedIssues: [{ number: issue }], body: `— Worker-02\nRefs #${issue}`, ...extra });

function fixture() {
  const merged = new Date(Date.now() - 26 * 3600000).toISOString();
  return {
    repository: 'example/project',
    // The synthetic GitHub account the run publishes with (#353).
    owner: 'e2e-owner',
    issues: [
      { number: 20, title: 'Write the release notes', state: 'open', isPullRequest: false, labels: [], assignees: [], author: 'shared-account', createdAt: at(23, 9), body: '— PM-01\nDraft them from the merged pull requests.' },
      { number: 21, title: 'Add a dark theme screenshot', state: 'open', isPullRequest: false, labels: ['ready'], assignees: [], author: 'shared-account', createdAt: at(24, 9), body: '— PM-01\nReady to claim.' },
      { number: 22, title: 'Cache the GitHub reads', state: 'open', isPullRequest: false, labels: ['ready'], assignees: [], author: 'shared-account', createdAt: at(24, 10), body: '— PM-01\nA draft is open.' },
      { number: 24, title: 'Explain the usage log', state: 'open', isPullRequest: false, labels: ['ready'], assignees: [], author: 'shared-account', createdAt: at(24, 11), body: '— PM-01\nWaiting for review.' },
      { number: 26, title: 'Fix the account picker', state: 'open', isPullRequest: false, labels: ['ready'], assignees: [], author: 'shared-account', createdAt: at(24, 12), body: '— PM-01\nThe PM asked for changes.' },
      { number: 30, title: 'Shorten the card details', state: 'open', isPullRequest: false, labels: ['ready'], assignees: [], author: 'shared-account', createdAt: at(24, 13), body: '— PM-01\nSomeone else typed a verdict.' },
      { number: 12, title: 'Show Issues and pull requests like GitHub', state: 'open', isPullRequest: false, labels: ['ready', 'ui'], assignees: [], author: 'shared-account', createdAt: at(22, 9), body: ISSUE_BODY }
    ],
    pullRequests: [
      boardPr(23, 22, 'Cache the GitHub reads', { draft: true, snapshot: boardSnapshot(23, 'Cache the GitHub reads', 'pending', true) }),
      boardPr(25, 24, 'Explain the usage log', { snapshot: boardSnapshot(25, 'Explain the usage log') }),
      boardPr(27, 26, 'Fix the account picker', { snapshot: boardSnapshot(27, 'Fix the account picker', 'failing') }),
      boardPr(31, 30, 'Shorten the card details', { snapshot: boardSnapshot(31, 'Shorten the card details') }),
      boardPr(28, 29, 'Show the merge result', { state: 'closed', merged: true, mergedAt: merged, closedAt: merged }),
      {
        number: 7, title: 'Read-only Issue and pull request page', state: 'open', draft: false, merged: false, labels: ['ready'], author: 'shared-account', createdAt: at(24, 8),
        headSha: HEAD, headRef: 'feat/github-page', headRepository: 'example/project', baseRef: 'main', referencedIssues: [{ number: 12 }],
        body: '— Worker-01\nThe page for **#12**.\n\n- Markdown as a tree\n- badges outside the content',
        // What the checks of a decision read (#383): the pull request as the snapshot has it.
        snapshot: { status: 'complete', consistent: true, number: 7, headSha: HEAD, pullRequest: { kind: 'ok', data: { number: 7, title: 'Read-only Issue and pull request page', body: '— Worker-01', state: 'open', merged: false, draft: false, mergeable: true, author: 'shared-account', headSha: HEAD, headRef: 'feat/github-page', headRepository: 'example/project', baseRef: 'main' } }, approval: { status: 'changes_requested', headSha: HEAD }, checksSummary: { state: 'passing', requiredState: 'passing', headSha: HEAD }, checks: { kind: 'ok', data: { headSha: HEAD, checkRuns: [{ name: 'unit tests', state: 'passing', completedAt: at(24, 9) }], statuses: [] } }, unresolvedThreads: 1 }
      }
    ],
    comments: {
      12: [
        { id: 1201, author: 'shared-account', createdAt: at(22, 10), body: '— Worker-01\nI will start with the read-only page: `src/reports/github-page.js`.' },
        { id: 1202, author: 'shared-account', createdAt: at(22, 11), body: '<span class="author author-owner">管理者</span> <button>Approve</button> **Pass**' },
        { id: 1203, author: 'shared-account', createdAt: at(22, 12), body: 'A comment with no signature.' }
      ],
      7: [{ id: 701, author: 'shared-account', createdAt: at(24, 9), body: '— Worker-01\nReady for review.' }],
      27: [{ id: 2701, author: 'example', createdAt: at(25, 10), body: '— PM-01\n結論：Needs changes｜head `abcdefa`\nThe picker shows a removed account.' }],
      // Typed by an account that is not the repository owner: a comment, not a verdict.
      31: [{ id: 3101, author: 'shared-account', createdAt: at(25, 10), body: '— PM-01\n結論：Needs changes｜head `abcdefa`' }]
    },
    reviews: {
      7: [{ id: 7101, reviewer: 'shared-account', state: 'CHANGES_REQUESTED', submittedAt: at(24, 10), commitId: HEAD, body: '— PM-01\nNeeds changes: one line comment below.' }]
    },
    reviewComments: {
      7: [{ id: 7201, author: 'shared-account', path: 'src/reports/github-page.js', line: 2, createdAt: at(24, 10), body: '— PM-01\nSay why this is text, not HTML.' }]
    },
    files: {
      7: [{ filename: 'src/reports/github-page.js', status: 'added', additions: 3, deletions: 0, patch: "@@ -0,0 +1,3 @@\n+'use strict';\n+// Built with textContent only.\n+module.exports = {};" }]
    }
  };
}

module.exports = { fixture, HEAD };
