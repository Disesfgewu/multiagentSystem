'use strict';

/**
 * Loaded into every process the unit tests run (through NODE_OPTIONS, by scripts/unit-tests.js) (#382): it records the id of every
 * child process started with `child_process.spawn` (which `exec`, `execFile` and `fork` use too), and whether it leads a process
 * group of its own (`detached`), in the file MULTIAGENT_UNIT_CHILDREN names. After the tests, scripts/unit-tests.js checks exactly
 * these processes and groups, so a test that leaves one running is found by what it started, never by a process name.
 */

const fs = require('node:fs');
const childProcess = require('node:child_process');

const file = process.env.MULTIAGENT_UNIT_CHILDREN;
if (typeof file === 'string' && file !== '' && !childProcess.__multiagentTracked) {
  childProcess.__multiagentTracked = true;
  const record = (child, options) => {
    try {
      if (child && Number.isSafeInteger(child.pid)) fs.appendFileSync(file, `${child.pid} ${options && options.detached ? 1 : 0}\n`);
    } catch { /* the record is best effort; the test itself is not changed */ }
    return child;
  };
  const spawn = childProcess.spawn;
  childProcess.spawn = function trackedSpawn(command, args, options) {
    const opts = Array.isArray(args) ? options : args;
    return record(spawn.apply(this, arguments), opts);
  };
  const promisified = require('node:util').promisify.custom;
  for (const name of ['execFile', 'exec', 'fork']) {
    const original = childProcess[name];
    const optionsOf = (input) => input.find((value, index) => index > 0 && value && typeof value === 'object' && !Array.isArray(value));
    const tracked = function tracked(...input) {
      return record(original.apply(this, input), optionsOf(input));
    };
    // util.promisify(execFile) and util.promisify(exec) resolve to { stdout, stderr }: keep that form, and record the child it carries.
    if (typeof original[promisified] === 'function') {
      tracked[promisified] = function trackedPromise(...input) {
        const promise = original[promisified].apply(this, input);
        record(promise && promise.child, optionsOf(input));
        return promise;
      };
    }
    childProcess[name] = tracked;
  }
}
