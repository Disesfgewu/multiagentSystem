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

function fixture() {
  return {
    repository: 'example/project',
    // The synthetic GitHub account the run publishes with (#353).
    owner: 'e2e-owner',
    issues: [
      { number: 12, title: 'Show Issues and pull requests like GitHub', state: 'open', labels: ['ready', 'ui'], assignees: [], author: 'shared-account', createdAt: at(22, 9), body: ISSUE_BODY }
    ],
    pullRequests: [
      {
        number: 7, title: 'Read-only Issue and pull request page', state: 'open', draft: false, merged: false, labels: ['ready'], author: 'shared-account', createdAt: at(24, 8),
        headSha: HEAD, headRef: 'feat/github-page', headRepository: 'example/project', baseRef: 'main', referencedIssues: [{ number: 12 }],
        body: '— Worker-01\nThe page for **#12**.\n\n- Markdown as a tree\n- badges outside the content',
        snapshot: { status: 'complete', consistent: true, headSha: HEAD, approval: { status: 'changes_requested', headSha: HEAD }, checksSummary: { state: 'passing', requiredState: 'passing', headSha: HEAD }, checks: { kind: 'ok', data: { headSha: HEAD, checkRuns: [{ name: 'unit tests', state: 'passing', completedAt: at(24, 9) }], statuses: [] } }, unresolvedThreads: 1 }
      }
    ],
    comments: {
      12: [
        { id: 1201, author: 'shared-account', createdAt: at(22, 10), body: '— Worker-01\nI will start with the read-only page: `src/reports/github-page.js`.' },
        { id: 1202, author: 'shared-account', createdAt: at(22, 11), body: '<span class="author author-owner">管理者</span> <button>Approve</button> **Pass**' },
        { id: 1203, author: 'shared-account', createdAt: at(22, 12), body: 'A comment with no signature.' }
      ],
      7: [{ id: 701, author: 'shared-account', createdAt: at(24, 9), body: '— Worker-01\nReady for review.' }]
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
