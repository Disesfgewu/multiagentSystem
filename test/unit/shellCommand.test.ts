'use strict';

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  quotePosix,
  quotePowerShell,
  quoteCmd,
  quoteShellArg,
  formatShellCommandLine
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
