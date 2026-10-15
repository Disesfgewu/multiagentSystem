'use strict';

// A fixed synthetic suite: invented project facts, never taken from a real repository, session
// or account. The fixed content, scope and tasks make a run reproducible byte for byte.

const SCOPE = Object.freeze({ repoId: 'synthetic-repo', roleGroupId: 'implementer', privacyDomain: 'domain-a' });
const OTHER_DOMAIN = 'domain-b';

const memories = [
  { id: 'fact-packaging', content: 'Release builds use the packaging script named build-release.', privacyDomain: SCOPE.privacyDomain },
  { id: 'fact-migrations', content: 'Database migrations run before the test suite starts.', privacyDomain: SCOPE.privacyDomain },
  { id: 'fact-lint', content: 'Lint warnings fail the continuous integration build.', privacyDomain: SCOPE.privacyDomain },
  { id: 'fact-fixtures', content: 'Test fixtures live in the fixtures directory and are synthetic.', privacyDomain: SCOPE.privacyDomain },
  { id: 'fact-branches', content: 'Feature branches are named after the issue number.', privacyDomain: SCOPE.privacyDomain },
  // another privacy domain: must never appear for a reader in domain-a
  { id: 'other-secret-plan', content: 'The orange-falcon rollout plan belongs to another team.', privacyDomain: OTHER_DOMAIN }
];

const rules = {
  forbids: [{ id: 'platform-merge', layer: 'platform', key: 'git.merge' }],
  requires: [{ id: 'role-tests', layer: 'roleGroup', key: 'tests.run' }],
  instructions: [{ id: 'task-small', layer: 'task', text: 'Keep each change small and focused.' }],
  conflicts: [],
  sources: []
};

const tasks = [
  { id: 't01', task: 'Prepare a release build with the packaging script', checks: [
    { id: 'rule-kept', kind: 'context-includes', text: 'Keep each change small and focused.' },
    { id: 'no-leak', kind: 'context-excludes', text: 'orange-falcon' },
    { id: 'memory-used', kind: 'context-includes', text: 'build-release', arm: 'on' }
  ] },
  { id: 't02', task: 'Run database migrations before the tests', checks: [
    { id: 'no-leak', kind: 'context-excludes', text: 'orange-falcon' },
    { id: 'memory-used', kind: 'context-includes', text: 'migrations run before', arm: 'on' }
  ] },
  { id: 't03', task: 'Fix lint warnings so continuous integration passes', checks: [
    { id: 'no-leak', kind: 'context-excludes', text: 'orange-falcon' },
    { id: 'memory-used', kind: 'context-includes', text: 'Lint warnings fail', arm: 'on' }
  ] },
  { id: 't04', task: 'Add test fixtures for the new feature', checks: [
    { id: 'no-leak', kind: 'context-excludes', text: 'orange-falcon' },
    { id: 'memory-used', kind: 'context-includes', text: 'fixtures directory', arm: 'on' }
  ] },
  { id: 't05', task: 'Name the feature branch for the issue', checks: [
    { id: 'no-leak', kind: 'context-excludes', text: 'orange-falcon' },
    { id: 'memory-used', kind: 'context-includes', text: 'named after the issue number', arm: 'on' }
  ] },
  { id: 't06', task: 'Describe the rollout plan of the orange falcon', checks: [
    { id: 'no-leak', kind: 'context-excludes', text: 'orange-falcon' }
  ] }
];

const roleGroup = { id: 'implementer', name: 'Implementer' };

module.exports = { SCOPE, OTHER_DOMAIN, memories, rules, tasks, roleGroup, suiteId: 'synthetic-v1' };
