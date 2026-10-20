import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { detectShellType, shellFileName } from '../../src/terminals/shellDetect';

type Row = [string, string | undefined, NodeJS.Platform, string | null];
const ROWS: Row[] = [
  ['posix path', '/bin/bash', 'linux', 'posix'],
  ['zsh on mac', '/bin/zsh', 'darwin', 'posix'],
  ['sh', '/bin/sh', 'linux', 'posix'],
  ['dash', '/usr/bin/dash', 'linux', 'posix'],
  ['ksh', '/usr/bin/ksh', 'linux', 'posix'],
  ['upper case', '/BIN/ZSH', 'darwin', 'posix'],
  ['git bash backslashes', 'C:\\Program Files\\Git\\bin\\bash.exe', 'win32', 'posix'],
  ['git bash forward slashes, upper case', 'C:/Program Files/Git/USR/BIN/BASH.EXE', 'win32', 'posix'],
  ['windows system bash is the WSL launcher', 'C:\\Windows\\System32\\bash.exe', 'win32', null],
  ['sysnative bash is the WSL launcher', 'c:/windows/sysnative/bash.exe', 'win32', null],
  ['wsl.exe', 'C:\\Windows\\System32\\wsl.exe', 'win32', null],
  ['powershell.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'win32', 'powershell'],
  ['pwsh.exe', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'win32', 'powershell'],
  ['pwsh on mac', '/usr/local/bin/pwsh', 'darwin', 'powershell'],
  ['pwsh without extension on windows', 'pwsh', 'win32', 'powershell'],
  ['cmd.exe', 'C:\\Windows\\System32\\cmd.exe', 'win32', 'cmd'],
  ['CMD.EXE upper case', 'C:\\WINDOWS\\SYSTEM32\\CMD.EXE', 'win32', 'cmd'],
  ['cmd without extension', 'cmd', 'win32', 'cmd'],
  ['cmd is not a shell off Windows', '/usr/bin/cmd', 'linux', null],
  ['.exe means nothing off Windows', '/tmp/bash.exe', 'linux', null],
  ['look-alike notcmd', 'C:\\tools\\notcmd.exe', 'win32', null],
  ['look-alike notcmd, no extension', '/usr/bin/notcmd', 'linux', null],
  ['look-alike zshell-tool', '/usr/bin/zshell-tool', 'linux', null],
  ['look-alike powershell-fake.sh', '/opt/powershell-fake.sh', 'linux', null],
  ['look-alike bash directory only', '/opt/bash/fish', 'linux', null],
  ['trailing slash', '/bin/bash/', 'linux', null],
  ['fish', '/usr/bin/fish', 'linux', null],
  ['nu', '/usr/bin/nu', 'linux', null],
  ['xonsh', '/usr/local/bin/xonsh', 'darwin', null],
  ['tcsh', '/bin/tcsh', 'linux', null],
  ['empty', '', 'linux', null],
  ['blank', '   ', 'win32', null],
  ['undefined', undefined, 'win32', null]
];

for (const [label, shell, platform, expected] of ROWS) {
  test(`detectShellType: ${label}`, () => {
    assert.equal(detectShellType(shell, platform), expected);
  });
}

test('shellFileName never returns a directory and drops forged or hidden characters', () => {
  assert.equal(shellFileName('C:\\Users\\someone\\bin\\fish.exe'), 'fish.exe');
  assert.equal(shellFileName('/home/someone/bin/nu'), 'nu');
  assert.equal(shellFileName(undefined), '');
  assert.equal(shellFileName('/x/' + 'a'.repeat(100)).length, 40);
  const hidden = ['/x/f', String.fromCodePoint(0x202e), 'ish', String.fromCodePoint(0x0a), 'x'].join('');
  assert.equal(shellFileName(hidden), 'fishx');
});
