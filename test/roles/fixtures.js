'use strict';

// Synthetic role groups and rule layers shared by the tests. Nothing here is a real
// account, repository or instruction.

const pmGroup = (extra) => ({
  id: 'pm-group',
  name: 'Planning and review',
  role: 'pm',
  provider: 'claude',
  version: 4,
  defaultAccountProfileId: 'claude-planning',
  allowedScope: { repositories: ['example-org/app'], paths: ['.'] },
  toolPermissions: { shell: 'ask', fileWrite: 'deny', network: 'ask', githubRead: 'allow', githubWrite: 'allow', merge: 'allow' },
  memoryScope: { mode: 'role-group' },
  rules: [
    { id: 'pm-triage', type: 'instruction', text: 'Write acceptance criteria before assigning work.', version: 2 },
    { id: 'pm-review-first', type: 'require', key: 'review.latest-head', version: 1 }
  ],
  ...extra
});

const workerGroup = (extra) => ({
  id: 'worker-group',
  name: 'Implementation',
  role: 'worker',
  provider: 'codex',
  version: 7,
  defaultAccountProfileId: null,
  allowedScope: { repositories: ['example-org/app'], paths: ['src', 'test'] },
  toolPermissions: { shell: 'allow', fileWrite: 'allow', network: 'deny', githubRead: 'allow', githubWrite: 'allow', merge: 'allow' },
  memoryScope: { mode: 'role-group' },
  rules: [
    { id: 'wk-small', type: 'instruction', text: 'Keep each change small and complete.', version: 3 },
    { id: 'wk-no-reqs', type: 'forbid', key: 'issue.define-requirements', version: 1 }
  ],
  ...extra
});

const layers = () => ({
  platform: [
    { id: 'pl-no-merge', type: 'forbid', key: 'tool:merge', version: 5 },
    { id: 'pl-no-private', type: 'forbid', key: 'publish.private-data', version: 5 }
  ],
  user: [{ id: 'us-brief', type: 'instruction', text: 'Reply briefly.', version: 2 }],
  project: [
    { id: 'pr-tests', type: 'require', key: 'tests.run', version: 1 },
    { id: 'pr-long', type: 'instruction', text: 'Explain in long form.', version: 1 }
  ],
  task: [{ id: 'tk-scope', type: 'instruction', text: 'Only touch the parser.', version: 1 }]
});

module.exports = { pmGroup, workerGroup, layers };
