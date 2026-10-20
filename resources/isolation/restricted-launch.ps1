# Starts one program under a restricted copy of the current process's token and reports what it did.
#
# What the restriction is: the copy of the token keeps every group, but the current user and the Administrators group are
# marked "deny only". They can no longer grant access, so a file or folder whose access list names only the user (and
# SYSTEM and Administrators) can no longer be opened by the program; places that also grant Users or Everyone still can.
# All privileges except the right to bypass traversal checks are removed. The program also runs in a job object that
# kills it, and everything it started, when the time limit is reached or this script ends.
#
# What it does NOT do: it does not block the network, and it does not hide anything that is open to Users or Everyone.
# Nothing here is downloaded, and no value is run through a shell: the program and its arguments are given as data.
#
# Input: -Request, a Base64 string of UTF-8 JSON: { "exe": absolute path, "args": [strings], "cwd": absolute path or "",
#   "env": ["NAME=value", ...], "stdin": text or "", "timeoutMs": number }.
# Output: one line of JSON on standard output: { "ok": true, "exitCode": n, "timedOut": bool, "output": Base64 of the
#   program's standard output and error } or { "ok": false, "reason": short code }. Any error is a failure, never a pass.

param([Parameter(Mandatory = $true)][string]$Request)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class RestrictedLaunch
{
    const uint TOKEN_ASSIGN_PRIMARY = 0x0001, TOKEN_DUPLICATE = 0x0002, TOKEN_QUERY = 0x0008;
    const uint DISABLE_MAX_PRIVILEGE = 0x1;
    const uint SE_GROUP_ENABLED = 0x4;
    const int TokenUser = 1, TokenGroups = 2;
    const uint STARTF_USESTDHANDLES = 0x100;
    const uint CREATE_SUSPENDED = 0x4, CREATE_NO_WINDOW = 0x08000000, CREATE_UNICODE_ENVIRONMENT = 0x400;
    const uint HANDLE_FLAG_INHERIT = 0x1;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const int JobObjectExtendedLimitInformation = 9;
    const uint WAIT_TIMEOUT = 0x102;

    [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb; public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES sa, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadFile(IntPtr h, byte[] buffer, uint toRead, out uint read, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteFile(IntPtr h, byte[] buffer, uint toWrite, out uint written, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr hTok);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr hTok, int cls, IntPtr buffer, int size, out int needed);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool CreateRestrictedToken(IntPtr existing, uint flags, uint disableCount, SID_AND_ATTRIBUTES[] disable, uint deleteCount, IntPtr deletePrivs, uint restrictCount, IntPtr restrict, out IntPtr newToken);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ConvertStringSidToSid(string s, out IntPtr sid);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool EqualSid(IntPtr a, IntPtr b);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessAsUserW(IntPtr hTok, string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

    public class Result { public bool Ok; public string Reason; public uint ExitCode; public bool TimedOut; public byte[] Output; }

    static Result Fail(string reason) { Result r = new Result(); r.Ok = false; r.Reason = reason; return r; }

    static IntPtr UserSid(IntPtr hTok, out IntPtr buffer)
    {
        int needed; GetTokenInformation(hTok, TokenUser, IntPtr.Zero, 0, out needed);
        buffer = Marshal.AllocHGlobal(needed);
        if (!GetTokenInformation(hTok, TokenUser, buffer, needed, out needed)) return IntPtr.Zero;
        return Marshal.ReadIntPtr(buffer); // TOKEN_USER begins with a SID_AND_ATTRIBUTES whose first field is the SID
    }

    static byte[] EnvBlock(string[] env)
    {
        StringBuilder sb = new StringBuilder();
        foreach (string pair in env) { sb.Append(pair); sb.Append('\0'); }
        sb.Append('\0');
        return Encoding.Unicode.GetBytes(sb.ToString());
    }

    public static Result Run(string exe, string commandLine, string cwd, string[] env, string stdinText, int timeoutMs)
    {
        IntPtr process = GetCurrentProcess(), hTok = IntPtr.Zero, hRestricted = IntPtr.Zero, job = IntPtr.Zero;
        IntPtr userBuffer = IntPtr.Zero, adminSid = IntPtr.Zero, envPtr = IntPtr.Zero;
        IntPtr inRead = IntPtr.Zero, inWrite = IntPtr.Zero, outRead = IntPtr.Zero, outWrite = IntPtr.Zero;
        PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
        bool created = false;
        try
        {
            if (!OpenProcessToken(process, TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY, out hTok)) return Fail("open-hTok-failed");
            IntPtr userSid = UserSid(hTok, out userBuffer);
            if (userSid == IntPtr.Zero) return Fail("user-sid-failed");
            if (!ConvertStringSidToSid("S-1-5-32-544", out adminSid)) return Fail("admin-sid-failed");
            SID_AND_ATTRIBUTES[] disable = new SID_AND_ATTRIBUTES[2];
            disable[0].Sid = userSid; disable[1].Sid = adminSid;
            if (!CreateRestrictedToken(hTok, DISABLE_MAX_PRIVILEGE, 2, disable, 0, IntPtr.Zero, 0, IntPtr.Zero, out hRestricted)) return Fail("hRestricted-hTok-failed");

            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) return Fail("job-failed");
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)))) return Fail("job-limits-failed");

            SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
            sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)); sa.bInheritHandle = true;
            if (!CreatePipe(out inRead, out inWrite, ref sa, 0)) return Fail("pipe-failed");
            if (!CreatePipe(out outRead, out outWrite, ref sa, 0)) return Fail("pipe-failed");
            // Only the child's ends are inherited.
            if (!SetHandleInformation(inWrite, HANDLE_FLAG_INHERIT, 0) || !SetHandleInformation(outRead, HANDLE_FLAG_INHERIT, 0)) return Fail("pipe-failed");

            STARTUPINFO si = new STARTUPINFO();
            si.cb = Marshal.SizeOf(typeof(STARTUPINFO)); si.dwFlags = (int)STARTF_USESTDHANDLES;
            si.hStdInput = inRead; si.hStdOutput = outWrite; si.hStdError = outWrite;
            byte[] block = EnvBlock(env);
            envPtr = Marshal.AllocHGlobal(block.Length);
            Marshal.Copy(block, 0, envPtr, block.Length);
            StringBuilder cmd = new StringBuilder(commandLine);
            if (!CreateProcessAsUserW(hRestricted, exe, cmd, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT, envPtr, string.IsNullOrEmpty(cwd) ? null : cwd, ref si, out pi)) return Fail("create-process-failed-" + Marshal.GetLastWin32Error());
            created = true;
            if (!AssignProcessToJobObject(job, pi.hProcess)) { TerminateJobObject(job, 1); return Fail("job-assign-failed"); }
            CloseHandle(inRead); inRead = IntPtr.Zero; CloseHandle(outWrite); outWrite = IntPtr.Zero;
            if (ResumeThread(pi.hThread) == 0xFFFFFFFF) { TerminateJobObject(job, 1); return Fail("resume-failed"); }

            MemoryStream captured = new MemoryStream();
            IntPtr readHandle = outRead;
            Thread reader = new Thread(delegate ()
            {
                byte[] buffer = new byte[8192]; uint got;
                while (ReadFile(readHandle, buffer, (uint)buffer.Length, out got, IntPtr.Zero) && got > 0)
                {
                    lock (captured) { if (captured.Length < 1048576) captured.Write(buffer, 0, (int)got); }
                }
            });
            reader.IsBackground = true; reader.Start();
            if (!string.IsNullOrEmpty(stdinText))
            {
                byte[] bytes = Encoding.UTF8.GetBytes(stdinText); uint written;
                WriteFile(inWrite, bytes, (uint)bytes.Length, out written, IntPtr.Zero);
            }
            CloseHandle(inWrite); inWrite = IntPtr.Zero;

            Result result = new Result();
            uint wait = WaitForSingleObject(pi.hProcess, (uint)timeoutMs);
            if (wait == WAIT_TIMEOUT) { TerminateJobObject(job, 1); result.TimedOut = true; WaitForSingleObject(pi.hProcess, 5000); }
            reader.Join(5000);
            uint code; GetExitCodeProcess(pi.hProcess, out code);
            result.Ok = true; result.ExitCode = code;
            lock (captured) { result.Output = captured.ToArray(); }
            return result;
        }
        catch (Exception) { return Fail("launch-exception"); }
        finally
        {
            if (created && job != IntPtr.Zero) TerminateJobObject(job, 1);
            foreach (IntPtr h in new IntPtr[] { pi.hProcess, pi.hThread, inRead, inWrite, outRead, outWrite, job, hRestricted, hTok })
                if (h != IntPtr.Zero) CloseHandle(h);
            if (userBuffer != IntPtr.Zero) Marshal.FreeHGlobal(userBuffer);
            if (envPtr != IntPtr.Zero) Marshal.FreeHGlobal(envPtr);
        }
    }
}
'@

function Quote-Argument([string]$argument) {
    # The rules the C runtime and CommandLineToArgvW read a command line by.
    if ($argument.Length -gt 0 -and $argument -notmatch '[\s"]') { return $argument }
    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append('"')
    $backslashes = 0
    foreach ($character in $argument.ToCharArray()) {
        if ($character -eq '\') { $backslashes++; continue }
        if ($character -eq '"') { [void]$builder.Append('\', $backslashes * 2 + 1); [void]$builder.Append('"'); $backslashes = 0; continue }
        if ($backslashes -gt 0) { [void]$builder.Append('\', $backslashes); $backslashes = 0 }
        [void]$builder.Append($character)
    }
    if ($backslashes -gt 0) { [void]$builder.Append('\', $backslashes * 2) }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Write-Failure([string]$reason) {
    [Console]::Out.WriteLine((@{ ok = $false; reason = $reason } | ConvertTo-Json -Compress))
    exit 3
}

try {
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Request))
    $spec = $json | ConvertFrom-Json
    $exe = [string]$spec.exe
    if (-not [IO.Path]::IsPathRooted($exe) -or $exe -match '[\x00-\x1f]' -or -not (Test-Path -LiteralPath $exe -PathType Leaf)) { Write-Failure 'program-invalid' }
    $arguments = @($spec.args | ForEach-Object { [string]$_ })
    foreach ($argument in $arguments) { if ($argument -match '\x00') { Write-Failure 'argument-invalid' } }
    $commandLine = ((@($exe) + $arguments) | ForEach-Object { Quote-Argument $_ }) -join ' '
    $environment = @($spec.env | ForEach-Object { [string]$_ })
    $timeout = [int]$spec.timeoutMs
    if ($timeout -lt 100 -or $timeout -gt 120000) { Write-Failure 'timeout-invalid' }
    $result = [RestrictedLaunch]::Run($exe, $commandLine, [string]$spec.cwd, $environment, [string]$spec.stdin, $timeout)
    if (-not $result.Ok) { Write-Failure ([string]$result.Reason) }
    $reply = @{ ok = $true; exitCode = [int64]$result.ExitCode; timedOut = [bool]$result.TimedOut; output = [Convert]::ToBase64String($result.Output) }
    [Console]::Out.WriteLine(($reply | ConvertTo-Json -Compress))
    exit 0
} catch {
    Write-Failure 'script-error'
}
