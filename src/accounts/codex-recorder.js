'use strict';

const { codexUsageEntry } = require('./codex-rate-limits');

/**
 * Keeping a Codex account's last request in the usage log whenever one of its sessions is observed again (issue #302, #294). Pure apart
 * from the three things it is given: the clock, how to read the account's session log, and how to append a log entry.
 *
 *  - Throttled per ACCOUNT: the session log is read at most once every `throttleMs` for one account, however many of its sessions
 *    report changes; another account is not slowed by it.
 *  - Written once per event: the entry is built from the last event of the log only, and the usage log recognises the same event
 *    again (same session key and time), so reading it twice cannot add a second record.
 *  - A clock that is not a time is not trusted: nothing is throttled by it (the read happens) and the reading's own expiry is judged
 *    by `codexQuotaFromSessionLog`, which treats an unusable clock as expired.
 * Never throws: a reading that cannot be kept never disturbs a session.
 */
function createCodexRecorder({ readReading, append, now = () => new Date(), throttleMs = 30_000 }) {
  const lastRead = new Map();
  return {
    /** @returns {'recorded'|'unchanged'|'throttled'|'no-entry'|'failed'} what happened, for tests and diagnostics */
    record(accountProfileId, context = {}) {
      try {
        const at = context && context.now !== undefined ? context.now : now();
        const atMs = at instanceof Date ? at.getTime() : Number.NaN;
        const before = lastRead.get(accountProfileId);
        // A clock that goes backwards, or is not a time, never throttles: the read is cheap and bounded.
        if (Number.isFinite(atMs) && before !== undefined && atMs >= before && atMs - before < throttleMs) return 'throttled';
        if (Number.isFinite(atMs)) lastRead.set(accountProfileId, atMs);
        const reading = readReading(accountProfileId, at, context);
        const entry = codexUsageEntry(reading, { accountProfileId });
        if (!entry) return 'no-entry';
        const result = append(entry, at, context);
        if (!result || result.ok !== true) return 'failed';
        return result.appended === false ? 'unchanged' : 'recorded';
      } catch { return 'failed'; }
    }
  };
}

module.exports = { createCodexRecorder };
