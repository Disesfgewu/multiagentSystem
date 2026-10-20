'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * A working folder that belongs to one research tool, inside the extension's private storage:
 * `<private>/research-tools/<serverId>` and its `tmp` folder. Each level is looked at with `lstat` before it is
 * used: a link, something that is not a folder, a folder owned by someone else, or one that other users can read or
 * write is refused. A level that does not exist is created private (0700). A folder that already exists but is too
 * open is refused, not quietly changed: it is not known who else holds it.
 *
 * Windows does not give these checks (no owner or mode bits to read here); the links and "is it a folder" checks
 * still apply there, and the folder inherits the access rules of the private storage folder it sits in.
 */

const SERVER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const refuse = (reason) => ({ ok: false, reason });

/**
 * @param {{ base: string, serverId: string, fsImpl?: object, uid?: number|null, platform?: string }} input
 * @returns {{ ok: true, dir: string, tmp: string } | { ok: false, reason: string }}
 */
function ensureToolFolder({ base, serverId, fsImpl = fs, uid = typeof process.getuid === 'function' ? process.getuid() : null, platform = process.platform } = {}) {
  if (typeof base !== 'string' || !path.isAbsolute(base) || typeof serverId !== 'string' || !SERVER_ID.test(serverId)) return refuse('storage-input-invalid');
  const posix = platform !== 'win32';
  const levels = [path.join(base, 'research-tools'), path.join(base, 'research-tools', serverId), path.join(base, 'research-tools', serverId, 'tmp')];
  for (const level of levels) {
    let info = null;
    try {
      info = fsImpl.lstatSync(level);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') return refuse('storage-unreadable');
    }
    if (info === null) {
      try {
        fsImpl.mkdirSync(level, { mode: 0o700 });
        // The creation mode is cut by the umask and is not applied to a folder that raced into existence: set it, then look again.
        if (posix) fsImpl.chmodSync(level, 0o700);
        info = fsImpl.lstatSync(level);
      } catch {
        return refuse('storage-create-failed');
      }
    }
    if (typeof info.isSymbolicLink === 'function' && info.isSymbolicLink()) return refuse('storage-is-link');
    if (typeof info.isDirectory !== 'function' || !info.isDirectory()) return refuse('storage-not-a-folder');
    if (posix) {
      if (uid !== null && info.uid !== uid) return refuse('storage-not-owned');
      if ((info.mode & 0o077) !== 0) return refuse('storage-too-open');
    }
  }
  return { ok: true, dir: levels[1], tmp: levels[2] };
}

module.exports = { ensureToolFolder };
