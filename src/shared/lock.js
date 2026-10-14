'use strict';

const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const DEFAULTS = Object.freeze({ retries: 100, waitMs: 20, staleMs: 30000 });
const CONFIRM_RECOVER = 'recover-stale-lock';
// On Windows a file that another process has just deleted stays "pending delete" until every
// handle to it is closed, and creating a file of that name in the meantime fails with one of
// these codes instead of EEXIST. The state is brief and clears by itself, so for acquiring the
// lock it is treated like "someone else holds it": waited out within the same retry budget.
// Elsewhere these codes mean what they say (no permission, busy) and fail at once.
const WINDOWS_TRANSIENT_CODES = Object.freeze(['EPERM', 'EACCES', 'EBUSY']);

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// An unexpected I/O failure while locking (not "someone else holds it").
class LockIoError extends Error {
  constructor(code) {
    super(`lock-io:${code}`);
    this.code = code;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error.code === 'EPERM';
  }
}

// A single-writer lock file. The lock is never taken away automatically while
// its owner might still be writing, so the single-writer promise cannot be broken
// by a slow or stalled writer:
//
//   * a lock held by a live process (or by a process whose state cannot be
//     determined, such as one on another host) makes `acquire` return "locked";
//   * `recover` removes a lock only when its owner is provably gone, or when a
//     person confirms it is stale. A live owner is refused unless `force` is set,
//     and `force` is meant for cases a program cannot know, for example a process
//     id that was reused after a restart.
//
// Acquiring waits within one retry budget (`retries` attempts, `waitMs` apart). Waiting
// ends in one of two ways: "locked" when the lock is held by someone, or a LockIoError
// when the file system itself kept failing (on Windows, the transient codes above; on any
// platform, any other code, which fails at once). The wait is never unbounded.
//
// The lock is advisory and per directory, and relies on local-file-system
// exclusive-create semantics: it does not cover network file systems.
class DirectoryLock {
  constructor(file, options) {
    this.file = file;
    this.options = { ...DEFAULTS, ...options };
    this.host = os.hostname();
    // Injectable so the Windows behaviour can be tested on any platform.
    this.platform = this.options.platform || process.platform;
  }

  acquire() {
    const { retries, waitMs } = this.options;
    const token = crypto.randomBytes(8).toString('hex');
    let transient = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const descriptor = fs.openSync(this.file, 'wx', 0o600);
        try {
          fs.writeSync(descriptor, JSON.stringify({
            token, pid: process.pid, host: this.host, createdAt: new Date().toISOString()
          }));
        } finally {
          fs.closeSync(descriptor);
        }
        return { ok: true, token };
      } catch (error) {
        if (error.code === 'EEXIST') {
          transient = null;
        } else if (this.platform === 'win32' && WINDOWS_TRANSIENT_CODES.includes(error.code)) {
          transient = error.code;
        } else {
          throw new LockIoError(error.code || 'unknown');
        }
        sleep(waitMs);
      }
    }
    // The budget ran out. If the last attempt still failed with a transient code the file
    // system never settled, which is an I/O failure, not a lock held by someone else.
    if (transient !== null) throw new LockIoError(transient);
    const info = this.inspect();
    return { ok: false, reason: 'locked', detail: info.held ? info.detail : 'owner-unreadable' };
  }

  // Reports who holds the lock without changing it.
  inspect() {
    let text;
    let stat;
    try {
      stat = fs.statSync(this.file);
      text = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { held: false };
      throw new LockIoError(error.code || 'unknown');
    }
    const ageMs = Math.max(0, Date.now() - stat.mtimeMs);
    const stale = ageMs > this.options.staleMs;
    let owner;
    try {
      owner = JSON.parse(text);
    } catch {
      return { held: true, detail: 'owner-unreadable', ageMs, stale, text };
    }
    if (!owner || typeof owner.token !== 'string' || !Number.isInteger(owner.pid) || typeof owner.host !== 'string') {
      return { held: true, detail: 'owner-unreadable', ageMs, stale, text };
    }
    if (owner.host !== this.host) return { held: true, detail: 'owner-other-host', ageMs, stale, text };
    return { held: true, detail: pidAlive(owner.pid) ? 'owner-alive' : 'owner-dead', ageMs, stale, text };
  }

  // Removes a lock that should no longer be there. Requires the confirmation
  // string. Returns what it found so the caller can show it.
  recover({ confirm, force = false } = {}) {
    if (confirm !== CONFIRM_RECOVER) return { ok: false, reason: 'confirmation-required' };
    const info = this.inspect();
    if (!info.held) return { ok: true, recovered: false };

    const provablyGone = info.detail === 'owner-dead';
    const permitted = provablyGone || (force === true && info.stale);
    if (!permitted) {
      return {
        ok: false,
        reason: force === true ? 'not-stale' : 'owner-not-confirmed-gone',
        detail: info.detail,
        ageMs: info.ageMs
      };
    }
    try {
      // Only remove the lock that was inspected, not one taken since.
      if (fs.readFileSync(this.file, 'utf8') !== info.text) return { ok: false, reason: 'lock-changed' };
      fs.unlinkSync(this.file);
    } catch (error) {
      if (error.code === 'ENOENT') return { ok: true, recovered: false };
      throw new LockIoError(error.code || 'unknown');
    }
    return { ok: true, recovered: true, detail: info.detail };
  }

  // Releases only a lock this holder took; a lock that was recovered and
  // re-taken by someone else is left alone.
  release(token) {
    try {
      const owner = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (owner && owner.token === token) fs.unlinkSync(this.file);
    } catch {
      // Already removed or replaced.
    }
  }
}

module.exports = { DirectoryLock, LockIoError, CONFIRM_RECOVER, WINDOWS_TRANSIENT_CODES, pidAlive };
