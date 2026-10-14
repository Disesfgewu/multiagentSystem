'use strict';

// Synthetic GitHub-shaped payloads. No real accounts, repositories or tokens.
const REPO = { owner: 'example-org', name: 'example-repo' };
const WEB = 'https://github.com/example-org/example-repo';
const BASE = `/repos/${REPO.owner}/${REPO.name}`;

const sha = (char) => char.repeat(40);
const SHA_A = sha('a');
const SHA_B = sha('b');
const SHA_C = sha('c');

const user = (loginName) => ({ login: loginName, type: 'User' });

function issue(number, overrides = {}) {
  return {
    number,
    title: `Issue ${number}`,
    state: 'open',
    state_reason: null,
    body: 'Synthetic issue body',
    user: user('pm-user'),
    labels: [{ name: 'ready' }],
    assignees: [],
    comments: 0,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-02T00:00:00Z',
    closed_at: null,
    html_url: `${WEB}/issues/${number}`,
    ...overrides
  };
}

function pull(number, overrides = {}) {
  return {
    number,
    title: `PR ${number}`,
    state: 'open',
    draft: false,
    merged: false,
    merged_at: null,
    mergeable: true,
    mergeable_state: 'clean',
    body: 'Refs #15',
    user: user('worker-user'),
    labels: [],
    head: { sha: SHA_A, ref: 'feat/example', repo: { full_name: 'example-org/example-repo' } },
    base: { ref: 'main', sha: SHA_C },
    created_at: '2026-10-03T00:00:00Z',
    updated_at: '2026-10-04T00:00:00Z',
    closed_at: null,
    html_url: `${WEB}/pull/${number}`,
    ...overrides
  };
}

let reviewId = 100;
function review(reviewer, state, commitId, submittedAt, overrides = {}) {
  reviewId += 1;
  return {
    id: reviewId,
    user: user(reviewer),
    state,
    commit_id: commitId,
    submitted_at: submittedAt,
    author_association: 'MEMBER',
    body: '',
    html_url: `${WEB}/pull/7#pullrequestreview-${reviewId}`,
    ...overrides
  };
}

function checkRun(name, status, conclusion, headSha = SHA_A) {
  return {
    id: Math.floor(Math.random() * 1e6) + 1,
    name,
    status,
    conclusion,
    head_sha: headSha,
    app: { slug: 'example-ci' },
    html_url: `${WEB}/runs/1`,
    details_url: 'https://ci.example.invalid/run/1',
    completed_at: status === 'completed' ? '2026-10-04T01:00:00Z' : null
  };
}

function commitStatus(context, state) {
  return { id: Math.floor(Math.random() * 1e6) + 1, context, state, target_url: null, updated_at: '2026-10-04T01:00:00Z' };
}

function threadNode(id, isResolved, overrides = {}) {
  return {
    id,
    isResolved,
    isOutdated: false,
    path: 'src/example.js',
    line: 10,
    comments: {
      totalCount: 1,
      nodes: [{ author: { login: 'pm-user' }, body: 'Please change this', createdAt: '2026-10-04T00:00:00Z', url: `${WEB}/pull/7#discussion_r1` }]
    },
    ...overrides
  };
}

function threadsResponse(nodes, { hasNextPage = false, endCursor = null, headRefOid = SHA_A, reviewDecision = null } = {}) {
  return {
    data: {
      repository: {
        pullRequest: {
          headRefOid,
          reviewDecision,
          reviewThreads: { pageInfo: { hasNextPage, endCursor }, nodes }
        }
      }
    }
  };
}

module.exports = {
  REPO,
  WEB,
  BASE,
  SHA_A,
  SHA_B,
  SHA_C,
  sha,
  user,
  issue,
  pull,
  review,
  checkRun,
  commitStatus,
  threadNode,
  threadsResponse
};
