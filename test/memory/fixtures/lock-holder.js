'use strict';

// Used by lock.test.js: takes the lock in a separate process, tells the parent
// it holds it, then either releases after `holdMs` or exits without releasing.
const { DirectoryLock } = require('../../../src/memory/lock');

const [lockFile, mode, holdMs] = process.argv.slice(2);
const lock = new DirectoryLock(lockFile, { retries: 0 });
const got = lock.acquire();
if (!got.ok) process.exit(3);
process.stdout.write('held\n');
if (mode === 'crash') process.exit(0);
setTimeout(() => {
  lock.release(got.token);
  process.exit(0);
}, Number(holdMs));
