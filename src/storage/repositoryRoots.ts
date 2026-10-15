import * as fs from 'node:fs';
import * as nodePath from 'node:path';

// Finds the repositories a folder is part of by looking at the file system only: it walks up
// through the folder's ancestors and records every directory that holds a `.git` entry (a
// directory, or a file as in a linked worktree or a submodule).
//
// It deliberately does not run Git. Running Git can fail, be missing, time out, or be withheld
// (a workspace that is not trusted yet must not run programs named in its own configuration),
// and every one of those would otherwise look the same as "not in a repository". A walk over
// the file system either finds `.git` or it does not, and when it cannot tell (an error other
// than "not there") it says so and the caller refuses.
//
// What it does not see: a repository whose working tree has no `.git` entry (one configured
// with `core.worktree`), and a repository that does not exist yet. The second is covered by
// asking again on every use.

const MAX_DEPTH = 256;
const MAX_GIT_FILE_BYTES = 4096;

export interface FileProbe {
  /** Throws an error with a `code` when the path cannot be read. */
  lstat(path: string): { isFile(): boolean; isDirectory(): boolean };
  /** At most `maxBytes` of a text file. */
  readText(path: string, maxBytes: number): string;
  realpath(path: string): string;
}

export const nodeProbe: FileProbe = {
  lstat: (path) => fs.lstatSync(path),
  readText(path, maxBytes) {
    const descriptor = fs.openSync(path, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes);
      const read = fs.readSync(descriptor, buffer, 0, maxBytes, 0);
      return buffer.toString('utf8', 0, read);
    } finally {
      fs.closeSync(descriptor);
    }
  },
  realpath: (path) => fs.realpathSync.native(path)
};

export interface RootsResult {
  /** Every directory found to be (the working tree of) a repository the folder is inside of. */
  roots: string[];
  /** Set when the file system could not tell; the caller must refuse rather than assume. */
  problem: 'repo-root-unresolvable' | null;
}

const code = (error: unknown): string => (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
  ? (error as { code: string }).code
  : 'unknown');
const isAbsent = (error: unknown): boolean => code(error) === 'ENOENT' || code(error) === 'ENOTDIR';

class Unresolvable extends Error {}

// A linked worktree or a submodule has a `.git` file that points at the real Git directory.
// The checkout that owns it is another place the folder's repository lives, and private data
// kept there would be inside that repository too.
function linkedRoots(directory: string, probe: FileProbe): string[] {
  let text: string;
  try {
    text = probe.readText(nodePath.join(directory, '.git'), MAX_GIT_FILE_BYTES);
  } catch (error) {
    if (isAbsent(error)) return [];
    throw new Unresolvable();
  }
  const match = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(text);
  if (!match) return [];
  const gitDirectory = nodePath.resolve(directory, match[1]);

  let common = gitDirectory;
  try {
    const pointer = probe.readText(nodePath.join(gitDirectory, 'commondir'), MAX_GIT_FILE_BYTES).trim();
    if (pointer !== '') common = nodePath.resolve(gitDirectory, pointer);
  } catch (error) {
    if (!isAbsent(error)) throw new Unresolvable();
  }
  // A normal checkout keeps its Git directory in `<root>/.git`; a bare repository or a
  // separate Git directory is a place in its own right.
  return nodePath.basename(common) === '.git' ? [common, nodePath.dirname(common)] : [common];
}

function walk(start: string, probe: FileProbe, found: Set<string>): void {
  let directory = nodePath.resolve(start);
  for (let depth = 0; depth <= MAX_DEPTH; depth += 1) {
    let entry: { isFile(): boolean; isDirectory(): boolean } | null = null;
    try {
      entry = probe.lstat(nodePath.join(directory, '.git'));
    } catch (error) {
      if (!isAbsent(error)) throw new Unresolvable();
    }
    if (entry !== null) {
      found.add(directory);
      if (entry.isFile()) for (const root of linkedRoots(directory, probe)) found.add(root);
    }
    const parent = nodePath.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
  throw new Unresolvable(); // a path this deep is not one to reason about
}

/**
 * The repositories `folder` is inside of, found without running anything. The folder is walked
 * as given and as it really is on disk (a link into a repository is still in that repository).
 */
export function findRepositoryRoots(folder: string, probe: FileProbe = nodeProbe): RootsResult {
  const found = new Set<string>();
  try {
    walk(folder, probe, found);
    let real: string | null = null;
    try {
      real = probe.realpath(folder);
    } catch (error) {
      if (!isAbsent(error)) throw new Unresolvable();
    }
    if (real !== null && real !== nodePath.resolve(folder)) walk(real, probe, found);
  } catch (error) {
    if (error instanceof Unresolvable) return { roots: [], problem: 'repo-root-unresolvable' };
    throw error;
  }
  // One repository can be reached under two spellings (a link, or a system whose temporary folder
  // is a link). Roots are returned by their real location, so each repository is one entry.
  const roots = new Set<string>();
  try {
    for (const root of found) {
      try {
        roots.add(probe.realpath(root));
      } catch (error) {
        if (!isAbsent(error)) return { roots: [], problem: 'repo-root-unresolvable' };
        roots.add(root); // a Git directory that a link points at but that is not there
      }
    }
  } catch {
    return { roots: [], problem: 'repo-root-unresolvable' };
  }
  return { roots: [...roots], problem: null };
}
