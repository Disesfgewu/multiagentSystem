import { spawn, ChildProcess } from 'node:child_process';

export type RunOutcome = { code: number | null; stdout: string; timedOut?: boolean; truncated?: boolean; errorCode?: string };

const GRACE_MS = 1500;

/**
 * Runs one command with an argument array (no shell), a time limit and an output limit. Nothing the
 * command prints is kept except its standard output, which the caller parses and discards; standard
 * error is never read into a value.
 *
 * The time limit is enforced here, not left to the operating system's polite request: at the limit the
 * child gets SIGTERM, and if it ignores that it gets SIGKILL after a short grace period. The promise
 * resolves by a fixed hard deadline in every case, so a command that will not stop cannot leave the
 * caller waiting.
 */
export function runCommand(file: string, args: string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number; graceMs?: number }): Promise<RunOutcome> {
  const grace = options.graceMs ?? GRACE_MS;
  return new Promise((resolve) => {
    let settled = false;
    let stopping = false;
    let overflow = false;
    const timers: NodeJS.Timeout[] = [];
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (outcome: RunOutcome): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      resolve(outcome);
    };
    let child: ChildProcess;
    try {
      // spawn, not execFile: only spawn lets the child lead its own process group (POSIX), which is what
      // lets a timeout stop the child AND anything it started. Standard error is never read.
      child = spawn(file, args, { env: options.env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      finish({ code: null, stdout: '', errorCode: 'ERR_SPAWN' });
      return;
    }
    // Stops the child and, where the platform allows, everything it started: the whole process group on
    // POSIX, the process tree through taskkill on Windows. Falls back to the child alone.
    const stop = (signal: 'SIGTERM' | 'SIGKILL'): void => {
      const pid = child.pid;
      try {
        if (pid && process.platform !== 'win32') { process.kill(-pid, signal); return; }
        if (pid && process.platform === 'win32') {
          const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          // taskkill may fail to start or exit non-zero; either way it must not become an unhandled
          // error, and the direct child still needs a fallback signal so it does not run forever.
          killer.on('error', () => { try { child.kill(signal); } catch { /* already gone */ } });
          killer.on('exit', (killCode) => { if (killCode !== 0) { try { child.kill(signal); } catch { /* already gone */ } } });
          return;
        }
      } catch { /* fall through to the child alone */ }
      try { child.kill(signal); } catch { /* already gone */ }
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > options.maxOutputBytes) {
        if (!overflow) { overflow = true; stop('SIGKILL'); finish({ code: null, stdout: '', truncated: true }); }
        return;
      }
      chunks.push(chunk);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      const code = error.code;
      if (code === 'ENOENT') finish({ code: null, stdout: '', errorCode: 'ENOENT' });
      else if (code === 'EACCES' || code === 'EPERM') finish({ code: null, stdout: '', errorCode: 'EACCES' });
      else finish({ code: null, stdout: '', errorCode: typeof code === 'string' ? code : 'ERR_UNKNOWN' });
    });
    child.on('close', (code) => {
      // Once the time limit has stopped it, whatever the child reports is a timeout, however it died.
      // The direct child closing does not mean the group is empty: a grandchild can obey none of the
      // signals the direct child obeys. Send a final group-wide SIGKILL here, synchronously before
      // finish() cancels the scheduled one below, so a direct child that exits quickly after SIGTERM
      // cannot let an ignoring grandchild outlive the cleanup.
      if (stopping) { stop('SIGKILL'); finish({ code: null, stdout: '', timedOut: true }); return; }
      if (overflow) { finish({ code: null, stdout: '', truncated: true }); return; }
      if (code === null) { finish({ code: null, stdout: '', errorCode: 'ERR_SIGNAL' }); return; }
      finish({ code, stdout: Buffer.concat(chunks).toString('utf8') });
    });
    timers.push(setTimeout(() => {
      stopping = true;
      stop('SIGTERM');
      timers.push(setTimeout(() => stop('SIGKILL'), grace));
      // Whatever the child does, the caller is told at this point.
      timers.push(setTimeout(() => finish({ code: null, stdout: '', timedOut: true }), grace + 500));
    }, options.timeoutMs));
  });
}

/** The environment for the child: this process's, with the profile's overrides applied (null removes a variable). */
export function childEnvironment(overrides: Record<string, string | null>, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) delete env[name];
    else env[name] = value;
  }
  return env;
}
