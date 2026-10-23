# Prototype for issue #289 (test code, not shipped and not used by any launch path): starts one program inside an
# AppContainer and reports what it did, or creates / deletes the AppContainer profile it runs in.
#
# What an AppContainer is: the program gets a token whose access checks ALSO need the container's own SID (or "ALL
# APPLICATION PACKAGES") to be granted, so files that grant only the user, Users or Everyone cannot be opened. Without the
# network capabilities it cannot open sockets to the internet or the private network, and loopback (127.0.0.1) is closed
# too unless the container is given a loopback exemption, which needs administrator rights and is done outside this script.
# The program runs in a job object that kills it, and everything it started, at the time limit or when this script ends.
#
# Nothing here is downloaded, and no value is run through a shell: the program and its arguments are given as data.
#
# Input: -Request, a Base64 string of UTF-8 JSON:
#   { "action": "create", "name": profile name } -> { "ok": true, "sid": "S-1-15-2-..." }; an existing profile is an error
#     (it is somebody else's: this script only creates fresh, uniquely named profiles).
#   { "action": "delete", "name": profile name } -> { "ok": true }
#   { "action": "run", "name": profile name, "exe", "args", "cwd", "env", "stdin", "timeoutMs", "capabilities": [SID strings] }
#     -> { "ok": true, "exitCode": n, "timedOut": bool, "output": Base64 of standard output and error }
# Output: one line of JSON on standard output; { "ok": false, "reason": short code } on any failure. Any error is a failure.

param([Parameter(Mandatory = $true)][string]$Request)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class AppContainerLaunch
{
    const uint STARTF_USESTDHANDLES = 0x100;
    const uint CREATE_SUSPENDED = 0x4, CREATE_UNICODE_ENVIRONMENT = 0x400, EXTENDED_STARTUPINFO_PRESENT = 0x80000;
    const uint HANDLE_FLAG_INHERIT = 0x1;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const int JobObjectExtendedLimitInformation = 9;
    const uint WAIT_TIMEOUT = 0x102;
    const int PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009;
    const int HRESULT_ALREADY_EXISTS = unchecked((int)0x800700B7);
    const uint SE_GROUP_ENABLED = 0x4;

    [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct SECURITY_CAPABILITIES { public IntPtr AppContainerSid; public IntPtr Capabilities; public uint CapabilityCount; public uint Reserved; }
    [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb; public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
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

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int CreateAppContainerProfile(string name, string display, string description, IntPtr capabilities, uint count, out IntPtr sid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr text);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ConvertStringSidToSidW(string text, out IntPtr sid);
    [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
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
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);

    public class Result { public bool Ok; public string Reason; public string Sid; public uint ExitCode; public bool TimedOut; public byte[] Output; }

    static Result Fail(string reason) { Result r = new Result(); r.Ok = false; r.Reason = reason; return r; }

    static string SidText(IntPtr sid)
    {
        IntPtr text;
        if (!ConvertSidToStringSidW(sid, out text)) return null;
        try { return Marshal.PtrToStringUni(text); } finally { LocalFree(text); }
    }

    public static Result Create(string name)
    {
        IntPtr sid;
        int hr = CreateAppContainerProfile(name, name, "multiagentSystem isolation prototype (issue 289)", IntPtr.Zero, 0, out sid);
        if (hr == HRESULT_ALREADY_EXISTS) return Fail("profile-exists");
        if (hr != 0) return Fail("profile-create-failed-" + (hr & 0xFFFF));
        try { Result r = new Result(); r.Ok = true; r.Sid = SidText(sid); return r.Sid == null ? Fail("sid-text-failed") : r; }
        finally { FreeSid(sid); }
    }

    public static Result Delete(string name)
    {
        int hr = DeleteAppContainerProfile(name);
        if (hr != 0) return Fail("profile-delete-failed-" + (hr & 0xFFFF));
        Result r = new Result(); r.Ok = true; return r;
    }

    static byte[] EnvBlock(string[] env)
    {
        StringBuilder sb = new StringBuilder();
        foreach (string pair in env) { sb.Append(pair); sb.Append('\0'); }
        sb.Append('\0');
        return Encoding.Unicode.GetBytes(sb.ToString());
    }

    public static Result Run(string name, string exe, string commandLine, string cwd, string[] env, string stdinText, int timeoutMs, string[] capabilities)
    {
        IntPtr containerSid = IntPtr.Zero, capsPtr = IntPtr.Zero, securityPtr = IntPtr.Zero, attributeList = IntPtr.Zero, envPtr = IntPtr.Zero, job = IntPtr.Zero;
        IntPtr inRead = IntPtr.Zero, inWrite = IntPtr.Zero, outRead = IntPtr.Zero, outWrite = IntPtr.Zero;
        IntPtr[] capabilitySids = new IntPtr[capabilities.Length];
        PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
        bool attributesReady = false, created = false;
        try
        {
            if (DeriveAppContainerSidFromAppContainerName(name, out containerSid) != 0) return Fail("derive-sid-failed");
            int entrySize = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
            if (capabilities.Length > 0)
            {
                capsPtr = Marshal.AllocHGlobal(entrySize * capabilities.Length);
                for (int i = 0; i < capabilities.Length; i++)
                {
                    if (!ConvertStringSidToSidW(capabilities[i], out capabilitySids[i])) return Fail("capability-invalid");
                    SID_AND_ATTRIBUTES entry = new SID_AND_ATTRIBUTES(); entry.Sid = capabilitySids[i]; entry.Attributes = SE_GROUP_ENABLED;
                    Marshal.StructureToPtr(entry, IntPtr.Add(capsPtr, i * entrySize), false);
                }
            }
            SECURITY_CAPABILITIES security = new SECURITY_CAPABILITIES();
            security.AppContainerSid = containerSid; security.Capabilities = capsPtr; security.CapabilityCount = (uint)capabilities.Length;
            securityPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)));
            Marshal.StructureToPtr(security, securityPtr, false);

            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            attributeList = Marshal.AllocHGlobal(size);
            if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref size)) return Fail("attribute-list-failed-" + Marshal.GetLastWin32Error());
            attributesReady = true;
            if (!UpdateProcThreadAttribute(attributeList, 0, (IntPtr)PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, securityPtr, (IntPtr)Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)), IntPtr.Zero, IntPtr.Zero)) return Fail("security-capabilities-failed-" + Marshal.GetLastWin32Error());

            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) return Fail("job-failed");
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)))) return Fail("job-limits-failed");

            SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
            sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)); sa.bInheritHandle = true;
            if (!CreatePipe(out inRead, out inWrite, ref sa, 0)) return Fail("pipe-failed");
            if (!CreatePipe(out outRead, out outWrite, ref sa, 0)) return Fail("pipe-failed");
            if (!SetHandleInformation(inWrite, HANDLE_FLAG_INHERIT, 0) || !SetHandleInformation(outRead, HANDLE_FLAG_INHERIT, 0)) return Fail("pipe-failed");

            STARTUPINFOEX si = new STARTUPINFOEX();
            si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX)); si.StartupInfo.dwFlags = (int)STARTF_USESTDHANDLES;
            si.StartupInfo.hStdInput = inRead; si.StartupInfo.hStdOutput = outWrite; si.StartupInfo.hStdError = outWrite;
            si.lpAttributeList = attributeList;
            byte[] block = EnvBlock(env);
            envPtr = Marshal.AllocHGlobal(block.Length);
            Marshal.Copy(block, 0, envPtr, block.Length);
            StringBuilder cmd = new StringBuilder(commandLine);
            if (!CreateProcessW(exe, cmd, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT, envPtr, string.IsNullOrEmpty(cwd) ? null : cwd, ref si, out pi)) return Fail("create-process-failed-" + Marshal.GetLastWin32Error());
            created = true;
            if (!AssignProcessToJobObject(job, pi.hProcess)) { TerminateProcess(pi.hProcess, 1); return Fail("job-assign-failed"); }
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
            foreach (IntPtr h in new IntPtr[] { pi.hProcess, pi.hThread, inRead, inWrite, outRead, outWrite, job })
                if (h != IntPtr.Zero) CloseHandle(h);
            if (attributesReady) DeleteProcThreadAttributeList(attributeList);
            foreach (IntPtr p in new IntPtr[] { attributeList, securityPtr, capsPtr, envPtr }) if (p != IntPtr.Zero) Marshal.FreeHGlobal(p);
            foreach (IntPtr s in capabilitySids) if (s != IntPtr.Zero) LocalFree(s);
            if (containerSid != IntPtr.Zero) FreeSid(containerSid);
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
    $name = [string]$spec.name
    # Only the prototype's own names: a fixed prefix and random hex, so another program's profile is never touched.
    if ($name -cnotmatch '^mas-proto-[0-9a-f]{16}$') { Write-Failure 'name-invalid' }
    $action = [string]$spec.action
    if ($action -ceq 'create') {
        $result = [AppContainerLaunch]::Create($name)
        if (-not $result.Ok) { Write-Failure ([string]$result.Reason) }
        [Console]::Out.WriteLine((@{ ok = $true; sid = $result.Sid } | ConvertTo-Json -Compress))
        exit 0
    }
    if ($action -ceq 'delete') {
        $result = [AppContainerLaunch]::Delete($name)
        if (-not $result.Ok) { Write-Failure ([string]$result.Reason) }
        [Console]::Out.WriteLine((@{ ok = $true } | ConvertTo-Json -Compress))
        exit 0
    }
    if ($action -cne 'run') { Write-Failure 'action-invalid' }
    $exe = [string]$spec.exe
    if (-not [IO.Path]::IsPathRooted($exe) -or $exe -match '[\x00-\x1f]' -or -not (Test-Path -LiteralPath $exe -PathType Leaf)) { Write-Failure 'program-invalid' }
    $arguments = @($spec.args | ForEach-Object { [string]$_ })
    foreach ($argument in $arguments) { if ($argument -match '\x00') { Write-Failure 'argument-invalid' } }
    $commandLine = ((@($exe) + $arguments) | ForEach-Object { Quote-Argument $_ }) -join ' '
    $environment = @($spec.env | ForEach-Object { [string]$_ })
    $capabilities = @($spec.capabilities | ForEach-Object { [string]$_ })
    foreach ($capability in $capabilities) { if ($capability -cnotmatch '^S-1-15-3-[0-9]{1,10}$') { Write-Failure 'capability-invalid' } }
    $timeout = [int]$spec.timeoutMs
    if ($timeout -lt 100 -or $timeout -gt 120000) { Write-Failure 'timeout-invalid' }
    $result = [AppContainerLaunch]::Run($name, $exe, $commandLine, [string]$spec.cwd, $environment, [string]$spec.stdin, $timeout, [string[]]$capabilities)
    if (-not $result.Ok) { Write-Failure ([string]$result.Reason) }
    $reply = @{ ok = $true; exitCode = [int64]$result.ExitCode; timedOut = [bool]$result.TimedOut; output = [Convert]::ToBase64String($result.Output) }
    [Console]::Out.WriteLine(($reply | ConvertTo-Json -Compress))
    exit 0
} catch {
    Write-Failure 'script-error'
}
