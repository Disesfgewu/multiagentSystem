'use strict';

/**
 * Shell command line formatting and quoting.
 *
 * This module is pure: it imports no vscode, starts no process, and makes no network calls.
 * Its purpose is to format command lines safely so that paths with spaces, symbols, and
 * special characters can be typed into a terminal shell without breaking or leaking,
 * while strictly rejecting any control characters, newlines or carriage returns that could
 * cause command injection.
 */

// Characters allowed in raw unquoted arguments across POSIX and Windows shells.
const SAFE_UNQUOTED = /^[A-Za-z0-9._=:/@+-]+$/;

// Control characters, null byte, carriage return and newline.
// eslint-disable-next-line no-control-regex
const UNSAFE_CONTROL = /[\u0000-\u001f\u007f]/;

export type ShellType = 'posix' | 'powershell' | 'cmd';

export interface ShellFormatOptions {
  platform?: NodeJS.Platform;
  shellType?: ShellType;
}

function resolveShellType(options: ShellFormatOptions = {}): ShellType {
  if (options.shellType) return options.shellType;
  const platform = options.platform ?? process.platform;
  return platform === 'win32' ? 'powershell' : 'posix';
}

function assertNoControlChars(value: string, fieldName: string): void {
  if (typeof value !== 'string') {
    throw new TypeError(`${fieldName} must be a string`);
  }
  if (UNSAFE_CONTROL.test(value)) {
    throw new TypeError(`Unsafe control characters or newlines in ${fieldName}`);
  }
}

/**
 * Quotes an argument for POSIX shells (sh, bash, zsh).
 * Single quotes preserve the literal value of all characters within them.
 * Internal single quotes are escaped via: '\''
 */
export function quotePosix(arg: string): string {
  assertNoControlChars(arg, 'argument');
  if (arg === '') return "''";
  if (SAFE_UNQUOTED.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Quotes an argument for PowerShell (powershell.exe, pwsh).
 * In PowerShell, single-quoted strings are verbatim literals.
 * Internal single quotes are escaped by doubling them: ''
 *
 * PowerShell treats the typographic single quotes U+2018, U+2019, U+201A and U+201B exactly like the
 * ASCII one: each can close the string, and each is escaped by doubling. Doubling only the ASCII
 * quote would let an argument such as `a’; calc; ‘b` end the string and run the rest as commands.
 */
export function quotePowerShell(arg: string): string {
  assertNoControlChars(arg, 'argument');
  if (arg === '') return "''";
  if (SAFE_UNQUOTED.test(arg)) return arg;
  return `'${arg.replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&')}'`;
}

/**
 * Quotes an argument for Windows Command Prompt (cmd.exe).
 * In cmd, double quotes are used: "..."
 * Internal double quotes are escaped as: ""
 */
export function quoteCmd(arg: string): string {
  assertNoControlChars(arg, 'argument');
  if (arg === '') return '""';
  if (SAFE_UNQUOTED.test(arg)) return arg;
  // If argument contains % or ^ which cmd expands even inside quotes, reject for safety
  if (/[%^]/.test(arg)) {
    throw new TypeError('Unsafe cmd characters in argument');
  }
  return `"${arg.replace(/"/g, '""')}"`;
}

/**
 * Quotes an argument based on the specified shell type.
 */
export function quoteShellArg(arg: string, shellType: ShellType = 'posix'): string {
  if (shellType === 'powershell') return quotePowerShell(arg);
  if (shellType === 'cmd') return quoteCmd(arg);
  return quotePosix(arg);
}

/**
 * Safely formats an executable and its argument list into a single command line string.
 */
export function formatShellCommandLine(
  executable: string,
  args: string[] = [],
  options: ShellFormatOptions = {}
): string {
  assertNoControlChars(executable, 'executable');
  if (executable.trim() === '') {
    throw new TypeError('executable must not be empty');
  }

  const shellType = resolveShellType(options);
  const quotedArgs = args.map((arg) => quoteShellArg(arg, shellType));

  if (shellType === 'powershell') {
    const isQuotedExe = !SAFE_UNQUOTED.test(executable);
    const formattedExe = isQuotedExe ? quotePowerShell(executable) : executable;
    const prefix = isQuotedExe ? '& ' : '';
    return `${prefix}${formattedExe}${quotedArgs.length > 0 ? ' ' + quotedArgs.join(' ') : ''}`;
  }

  if (shellType === 'cmd') {
    const formattedExe = quoteCmd(executable);
    return `${formattedExe}${quotedArgs.length > 0 ? ' ' + quotedArgs.join(' ') : ''}`;
  }

  // POSIX (default)
  const formattedExe = quotePosix(executable);
  return `${formattedExe}${quotedArgs.length > 0 ? ' ' + quotedArgs.join(' ') : ''}`;
}

/**
 * What goes in front of a typed command line so that `dir` comes first on PATH for that program (issue #342: the per-session `gh`
 * wrapper). It is typed after the shell has read its profile, which may have reordered PATH (macOS login shells do).
 * - POSIX: `PATH='<dir>':"$PATH" ` applies to the one program typed after it.
 * - PowerShell: sets the terminal's own PATH and the process-only script policy (`RemoteSigned`, so the `gh.ps1` shim can run).
 * - cmd.exe: the same two for the program started after it. The CLI runs its own commands through Git Bash or PowerShell, which
 *   inherit them and find the shims; only `gh` typed into cmd.exe itself is not wrapped. Null for a folder cmd.exe would read
 *   differently (`%`, `^`, `"` and the like), which is refused rather than quoted.
 */
export function formatPathPrefix(dir: string, shellType: ShellType): string | null {
  assertNoControlChars(dir, 'path');
  if (dir.trim() === '') throw new TypeError('path must not be empty');
  if (shellType === 'posix') return `PATH=${quotePosix(dir)}:"$PATH" `;
  if (shellType === 'powershell') return `$env:PSExecutionPolicyPreference = 'RemoteSigned'; $env:PATH = '${dir.replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&')};' + $env:PATH; `;
  if (/[%^"&|<>!]/.test(dir)) return null;
  return `set "PATH=${dir};%PATH%" && set "PSExecutionPolicyPreference=RemoteSigned" && `;
}
