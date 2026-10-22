import * as fs from 'node:fs';

const BUSY = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY']);

/**
 * Removes a temporary folder or file a host check made, without failing the run.
 *
 * On Windows VS Code can keep a handle on a file it had open for a while after the editor closes,
 * and `fs.rmSync`'s own `maxRetries` does not cover EBUSY on a folder (Refs #324). So this waits
 * between tries without blocking the extension host, and if the path is still busy it is left in the
 * temporary folder with a warning: a leftover there does no harm, and a throw here would hide the
 * check's own result.
 */
export async function removeTemp(target: string, tries = 20, delayMs = 250): Promise<boolean> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!BUSY.has(code) || attempt >= tries) {
        console.warn(`host cleanup: left ${target} behind (${code || String(error)})`);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
