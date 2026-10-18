import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Removes every install folder in `installsDir` except `keepId`, after a new install has been verified
 * and made current. Older and half-finished installs would otherwise pile up at about the size of the
 * download for every repair or upgrade. Nothing is followed: a symlink entry is unlinked as a link, and
 * if `installsDir` itself is not a plain directory nothing is touched at all. Best effort; returns how
 * many entries were removed.
 */
export async function pruneInstalls(installsDir: string, keepId: string): Promise<number> {
  let removed = 0;
  try {
    const top = await fs.promises.lstat(installsDir);
    if (!top.isDirectory() || top.isSymbolicLink()) return 0;
    for (const name of await fs.promises.readdir(installsDir)) {
      if (name === keepId || name.includes(path.sep) || name === '..' || name === '.') continue;
      const entry = path.join(installsDir, name);
      try {
        const stat = await fs.promises.lstat(entry);
        if (stat.isDirectory() && !stat.isSymbolicLink()) await fs.promises.rm(entry, { recursive: true, force: true });
        else await fs.promises.unlink(entry);
        removed += 1;
      } catch { /* in use (Windows) or already gone: leave it for next time */ }
    }
  } catch { /* nothing to prune */ }
  return removed;
}
