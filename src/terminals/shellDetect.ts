'use strict';

/**
 * Shell recognition for the line typed into a native terminal. This module is pure: it imports no
 * vscode, starts no process and reads no file. It looks at the file name only.
 *
 * Fail closed: a shell that is not on the list below is not guessed. Quoting written for the wrong
 * shell can turn an argument into a command, so the caller must refuse to type anything.
 */

export type DetectedShell = 'posix' | 'powershell' | 'cmd';

const POSIX_SHELLS = new Set(['bash', 'zsh', 'sh', 'dash', 'ksh']);
const POWERSHELLS = new Set(['powershell', 'pwsh']);

const isHidden = (cp: number): boolean =>
  cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x2028 && cp <= 0x202f) || (cp >= 0x2060 && cp <= 0x206f) || cp === 0xfeff;

/** The part of a path after the last slash or backslash, trimmed. Both kinds are separators on every platform. */
function splitPath(shellPath: string): { dir: string; base: string } {
  const text = shellPath.trim();
  const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  return { dir: text.slice(0, cut + 1).toLowerCase(), base: text.slice(cut + 1) };
}

/**
 * The file name of a shell path, for messages. It never returns a directory. Characters that could
 * forge or hide text in a message are dropped, and the result is capped.
 */
export function shellFileName(shellPath: string | undefined): string {
  if (typeof shellPath !== 'string') return '';
  const kept = Array.from(splitPath(shellPath).base).filter((ch) => !isHidden(ch.codePointAt(0) as number));
  return kept.join('').slice(0, 40);
}

/**
 * Returns the quoting family of a shell, or null when it is not one this extension can quote for.
 * Not recognized (null): an empty or missing path, fish, nu, xonsh, tcsh, wsl.exe, a look-alike such
 * as `notcmd` or `zshell-tool`, and the Windows `bash.exe` in the system folder, which is the WSL launcher.
 * Git Bash on Windows is `posix`; its path conventions are not translated here.
 */
export function detectShellType(shellPath: string | undefined, platform: NodeJS.Platform): DetectedShell | null {
  if (typeof shellPath !== 'string' || shellPath.trim() === '') return null;
  const windows = platform === 'win32';
  const { dir, base } = splitPath(shellPath);
  let name = base.toLowerCase();
  if (name.endsWith('.exe')) {
    // A Windows executable suffix means nothing on another platform.
    if (!windows) return null;
    name = name.slice(0, -4);
  }
  if (POWERSHELLS.has(name)) return 'powershell';
  if (name === 'cmd') return windows ? 'cmd' : null;
  if (POSIX_SHELLS.has(name)) {
    if (windows && name === 'bash' && /[\\/]windows[\\/](system32|sysnative|syswow64)[\\/]$/.test(dir)) return null;
    return 'posix';
  }
  return null;
}
