import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const POINTER_NAME = 'current.json';
const SHA = /^[a-f0-9]{64}$/;
const SAFE_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const DEFAULT_GRACE_MS = 30 * 60_000;

export interface PruneOptions {
  /** The root `current.json`: whichever install it names right now is never touched. */
  pointerFile: string;
  /** A folder younger than this may be another window's install that has not switched its pointer yet. */
  graceMs?: number;
  now?: () => number;
}

async function readCurrentId(pointerFile: string): Promise<string | null> {
  try {
    const stat = await fs.promises.lstat(pointerFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return null;
    const value = JSON.parse(await fs.promises.readFile(pointerFile, 'utf8'));
    return value && typeof value.installId === 'string' ? value.installId : null;
  } catch { return null; }
}

async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  const handle = await fs.promises.open(file, 'r');
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
    }
  } finally { await handle.close(); }
  return hash.digest('hex');
}

/**
 * Whether an install folder could still be a working install: it carries its own pointer, its retained
 * archive still hashes to what that pointer says, and its executable is a plain, non-empty file. This
 * deliberately knows nothing about the tool or release, so an older version that a terminal's PATH may
 * still use is kept. Anything that cannot be shown to be working (unreadable, missing, altered) is not.
 */
async function mightStillWork(dir: string): Promise<boolean> {
  try {
    const pointerPath = path.join(dir, POINTER_NAME);
    const pointerStat = await fs.promises.lstat(pointerPath);
    if (!pointerStat.isFile() || pointerStat.isSymbolicLink() || pointerStat.size > 4096) return false;
    const pointer = JSON.parse(await fs.promises.readFile(pointerPath, 'utf8'));
    if (!pointer || typeof pointer.archiveSha256 !== 'string' || !SHA.test(pointer.archiveSha256) || typeof pointer.executable !== 'string' || !SAFE_NAME.test(pointer.executable)) return false;
    const archive = path.join(dir, 'asset.bin');
    const archiveStat = await fs.promises.lstat(archive);
    if (!archiveStat.isFile() || archiveStat.isSymbolicLink() || archiveStat.size < 1) return false;
    const executableStat = await fs.promises.lstat(path.join(dir, 'bin', pointer.executable));
    if (!executableStat.isFile() || executableStat.isSymbolicLink() || executableStat.size < 1) return false;
    return (await sha256OfFile(archive)) === pointer.archiveSha256;
  } catch { return false; }
}

/**
 * Removes install folders that are provably of no use, after a new install has been verified and made
 * current: never the one just installed, never the one the pointer names now, never one younger than the
 * grace period (it may belong to another window that is mid-install), and never one that might still work
 * (an older version a running terminal may use). Nothing is followed: a stray file or symlink in the
 * installs folder is unlinked as itself, and if `installsDir` is not a plain directory nothing is touched.
 * Best effort; returns how many entries were removed.
 */
export async function pruneInstalls(installsDir: string, keepId: string, options: PruneOptions): Promise<number> {
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const nowMs = (options.now ?? Date.now)();
  let removed = 0;
  try {
    const top = await fs.promises.lstat(installsDir);
    if (!top.isDirectory() || top.isSymbolicLink()) return 0;
    const currentId = await readCurrentId(options.pointerFile);
    for (const name of await fs.promises.readdir(installsDir)) {
      if (name === keepId || name === currentId || name.includes(path.sep) || name === '..' || name === '.') continue;
      const entry = path.join(installsDir, name);
      try {
        const stat = await fs.promises.lstat(entry);
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          if (nowMs - stat.mtimeMs < graceMs) continue;
          if (await mightStillWork(entry)) continue;
          await fs.promises.rm(entry, { recursive: true, force: true });
        } else {
          await fs.promises.unlink(entry);
        }
        removed += 1;
      } catch { /* in use (Windows) or already gone: leave it for next time */ }
    }
  } catch { /* nothing to prune */ }
  return removed;
}
