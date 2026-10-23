'use strict';

/**
 * How the Command Center refreshes (#368). Before, every refresh threw its result away when a newer one had started; agents keep
 * reporting changes every couple of seconds, so on a slow or busy machine every result was thrown away and the screen never showed
 * new agents. Now at most one refresh runs at a time and nothing it worked out is dropped: a request while one runs only marks the
 * screen as out of date, and once the running one has published its result, one more runs (however many requests came in between).
 *
 * `run()` does one refresh and publishes what it has, possibly in steps. A run that fails does not stop the loop.
 * @param {() => Promise<void>} run
 * @returns {{ request(): Promise<void>, running(): boolean }} `request` resolves once no refresh is left to do.
 */
function createRefreshLoop(run) {
  if (typeof run !== 'function') throw new TypeError('run is required');
  let active = null;
  let dirty = false;
  const loop = async () => {
    do {
      dirty = false;
      try { await run(); } catch { /* the next request tries again; the screen keeps what it last showed */ }
    } while (dirty);
    active = null;
  };
  return {
    request() {
      if (active) { dirty = true; return active; }
      active = loop();
      return active;
    },
    running: () => active !== null
  };
}

module.exports = { createRefreshLoop };
