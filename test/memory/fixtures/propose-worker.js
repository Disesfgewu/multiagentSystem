'use strict';

// Used by store.test.js: proposes `count` distinct memories from a separate
// process so the test exercises real cross-process contention.
const { MemoryStore } = require('../../../src/memory/store');

const [dir, repoRoot, tag, count] = process.argv.slice(2);
const store = new MemoryStore({ dir, repoRoot, lock: { retries: 600, waitMs: 10, staleMs: 60000 } });
let failures = 0;
for (let i = 0; i < Number(count); i += 1) {
  const result = store.propose({
    repoId: 'repo-1',
    roleGroupId: 'impl',
    privacyDomain: 'domain-1',
    content: `Worker ${tag} recorded note number ${i} about the build pipeline.`,
    source: { kind: 'task', ref: `${tag}-${i}` }
  });
  if (!result.ok) failures += 1;
}
process.exit(failures === 0 ? 0 : 1);
