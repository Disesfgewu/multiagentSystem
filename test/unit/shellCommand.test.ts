'use strict';

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  quotePosix,
  quotePowerShell,
  quoteCmd,
  quoteShellArg,
  formatShellCommandLine,
  formatClearPrefix
} from '../../src/terminals/shellCommand';

test('quotePosix keeps safe unquoted arguments unchanged', () => {
  assert.equal(quotePosix('claude'), 'claude');
  assert.equal(quotePosix('--append-system-prompt-file'), '--append-system-prompt-file');
  assert.equal(quotePosix('/usr/local/bin/agent'), '/usr/local/bin/agent');
  assert.equal(quotePosix('model=sonnet:3.5'), 'model=sonnet:3.5');
});

test('quotePosix wraps arguments with spaces or symbols in single quotes', () => {
  assert.equal(quotePosix('/Users/disesfgewu/Library/Application Support/context.md'), "'/Users/disesfgewu/Library/Application Support/context.md'");
  assert.equal(quotePosix("file with 'single' quotes"), "'file with '\\''single'\\'' quotes'");
  assert.equal(quotePosix(''), "''");
});

test('quotePosix rejects control characters, newlines and null bytes', () => {
  assert.throws(() => quotePosix('arg\nwith-newline'), /Unsafe control characters/);
  assert.throws(() => quotePosix('arg\rwith-cr'), /Unsafe control characters/);
  assert.throws(() => quotePosix('arg\0with-null'), /Unsafe control characters/);
});

test('quotePowerShell wraps arguments with single quotes and escapes quotes by doubling', () => {
  assert.equal(quotePowerShell('C:\\Program Files\\App\\context.md'), "'C:\\Program Files\\App\\context.md'");
  assert.equal(quotePowerShell("Don't touch"), "'Don''t touch'");
  assert.equal(quotePowerShell('simple'), 'simple');
  assert.equal(quotePowerShell(''), "''");
});

test('quoteCmd wraps arguments in double quotes and rejects unsafe cmd expansions', () => {
  assert.equal(quoteCmd('C:\\Program Files\\context.md'), '"C:\\Program Files\\context.md"');
  assert.throws(() => quoteCmd('bad%variable%'), /Unsafe cmd characters/);
  assert.throws(() => quoteCmd('bad^escape'), /Unsafe cmd characters/);
});

test('formatShellCommandLine formats POSIX commands correctly', () => {
  const line = formatShellCommandLine('claude', [
    '--append-system-prompt-file',
    '/Users/disesfgewu/Library/Application Support/context.md',
    '--model',
    'sonnet'
  ], { platform: 'darwin', shellType: 'posix' });

  assert.equal(line, "claude --append-system-prompt-file '/Users/disesfgewu/Library/Application Support/context.md' --model sonnet");
});

test('formatShellCommandLine formats PowerShell commands with call operator when executable has spaces', () => {
  const line = formatShellCommandLine('C:\\Program Files\\Claude\\claude.exe', [
    '--append-system-prompt-file',
    'C:\\Users\\User Name\\context.md'
  ], { platform: 'win32', shellType: 'powershell' });

  assert.equal(line, "& 'C:\\Program Files\\Claude\\claude.exe' --append-system-prompt-file 'C:\\Users\\User Name\\context.md'");
});

test('formatShellCommandLine formats PowerShell commands without call operator when executable is a simple name', () => {
  const line = formatShellCommandLine('claude', [
    '--model',
    'sonnet'
  ], { platform: 'win32', shellType: 'powershell' });

  assert.equal(line, "claude --model sonnet");
});

test('formatShellCommandLine rejects empty executable or control characters', () => {
  assert.throws(() => formatShellCommandLine(''), /executable must not be empty/);
  assert.throws(() => formatShellCommandLine('claude\nrm -rf /', []), /Unsafe control characters/);
  assert.throws(() => formatShellCommandLine('claude', ['good', 'bad\narg']), /Unsafe control characters/);
});

// PowerShell reads a single-quoted string like this: any of the five single-quote characters ends the
// string unless the next character is also one of them, in which case the pair is one literal quote.
// This reader lets the tests prove that a quoted argument is ONE string that ends at its last character.
function readPowerShellSingleQuoted(text: string): { value: string; end: number } | null {
  const quotes = new Set(["'", '\u2018', '\u2019', '\u201a', '\u201b']);
  if (!quotes.has(text[0])) return null;
  let value = '';
  let index = 1;
  while (index < text.length) {
    const char = text[index];
    if (quotes.has(char)) {
      if (index + 1 < text.length && quotes.has(text[index + 1])) { value += char; index += 2; continue; }
      return { value, end: index + 1 };
    }
    value += char;
    index += 1;
  }
  return null;
}

test('quotePowerShell treats the typographic single quotes as quotes: an argument cannot end its own string and run the rest as commands', () => {
  const hostile = [
    'a\u2019; calc; \u2018b', '\u2018', '\u2019', '\u201a', '\u201b', "x'y\u2019z\u2018w", '\u2019\u2019', 'end\u2019', '\u2018start',
    "it's", 'C:\\Users\\x y\\a\u2019s file', '\u201cdouble\u201d and \u2018single\u2019'
  ];
  for (const arg of hostile) {
    const quoted = quotePowerShell(arg);
    const parsed = readPowerShellSingleQuoted(quoted);
    assert.ok(parsed, JSON.stringify(arg));
    assert.equal(parsed.end, quoted.length, `${JSON.stringify(arg)} must be one string that ends at the last character, got ${quoted}`);
    assert.equal(parsed.value, arg, 'and it must read back as exactly the original');
  }
  assert.equal(quotePowerShell('a\u2019b'), "'a\u2019\u2019b'");
});

test('formatShellCommandLine keeps a hostile executable path and arguments inside their strings for PowerShell', () => {
  const line = formatShellCommandLine('C:\\Program Files\\tool\u2019s\\claude.exe', ['--append-system-prompt-file', 'C:\\p\\a\u2019; calc; \u2018b.md'], { shellType: 'powershell' });
  const reader = (text: string) => readPowerShellSingleQuoted(text);
  assert.ok(line.startsWith('& '));
  const exe = reader(line.slice(2));
  assert.ok(exe);
  const rest = line.slice(2 + exe.end);
  assert.equal(rest.startsWith(' --append-system-prompt-file '), true);
  const arg = reader(rest.slice(' --append-system-prompt-file '.length));
  assert.ok(arg);
  assert.equal(arg.end, rest.length - ' --append-system-prompt-file '.length, 'nothing follows the last argument');
});

test('the clear prefix wipes the long command and prints one plain line, in each shell; an unsafe note is not printed (#357)', () => {
  assert.equal(formatClearPrefix('Multiagent: starting Claude Code (Worker-01)', 'posix'), "clear 2>/dev/null; printf '%s\\n' 'Multiagent: starting Claude Code (Worker-01)'; ");
  assert.equal(formatClearPrefix('Multiagent: starting Codex CLI', 'powershell'), "Clear-Host; Write-Host 'Multiagent: starting Codex CLI'; ");
  assert.equal(formatClearPrefix('Multiagent: starting agy', 'cmd'), 'cls & echo Multiagent: starting agy & ');
  for (const note of ['$(rm -rf /)', 'a; b', 'x & y', "it's", 'a\nb', '%PATH%', '', 'x'.repeat(81)]) {
    for (const shell of ['posix', 'powershell', 'cmd'] as const) {
      const prefix = formatClearPrefix(note, shell);
      assert.ok(['clear 2>/dev/null; ', 'Clear-Host; ', 'cls & '].includes(prefix), `${shell}: ${JSON.stringify(note)} -> ${prefix}`);
    }
  }
});
