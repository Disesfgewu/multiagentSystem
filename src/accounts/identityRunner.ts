import { execFile } from 'node:child_process';

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
    const timers: NodeJS.Timeout[] = [];
    const finish = (outcome: RunOutcome): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      resolve(outcome);
    };
    try {
      const child = execFile(file, args, {
        env: options.env,
        maxBuffer: options.maxOutputBytes,
        shell: false,
        windowsHide: true,
        encoding: 'utf8'
      }, (error, stdout) => {
        if (!error) { finish({ code: 0, stdout }); return; }
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: string | number };
        if (failure.code === 'ENOENT') { finish({ code: null, stdout: '', errorCode: 'ENOENT' }); return; }
        if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') { finish({ code: null, stdout: '', truncated: true }); return; }
        if (failure.killed === true && failure.signal) { finish({ code: null, stdout: '', timedOut: true }); return; }
        if (typeof failure.code === 'number') { finish({ code: failure.code, stdout: typeof stdout === 'string' ? stdout : '' }); return; }
        finish({ code: null, stdout: '', errorCode: typeof failure.code === 'string' ? failure.code : 'ERR_UNKNOWN' });
      });
      timers.push(setTimeout(() => {
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        timers.push(setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, grace));
        // Whatever the child does, the caller is told at this point.
        timers.push(setTimeout(() => finish({ code: null, stdout: '', timedOut: true }), grace + 500));
      }, options.timeoutMs));
      child.stdin?.end();
    } catch {
      finish({ code: null, stdout: '', errorCode: 'ERR_SPAWN' });
    }
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
