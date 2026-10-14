'use strict';

// Used by private-store.test.js: writes `count` distinct records from a separate
// process so the test exercises real cross-process contention.
const { PrivateStore } = require('../../../src/storage/private-store');

const [dir, repoRoot, tag, count] = process.argv.slice(2);
const store = new PrivateStore({
  dir, repoRoot, collections: ['profiles', 'sessions'], lock: { retries: 800, waitMs: 10, staleMs: 60000 }
});
let failures = 0;
for (let i = 0; i < Number(count); i += 1) {
  const result = store.put('sessions', `${tag}-${i}`, { provider: 'claude', order: i });
  if (!result.ok) {
    failures += 1;
    // Only the reason and code, so a failing run says why without any path.
    process.stderr.write(`put ${tag}-${i} failed: ${result.reason}${result.detail ? `:${result.detail}` : ''}\n`);
  }
}
process.exit(failures === 0 ? 0 : 1);
