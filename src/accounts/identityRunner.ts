import { execFile } from 'node:child_process';

export type RunOutcome = { code: number | null; stdout: string; timedOut?: boolean; truncated?: boolean; errorCode?: string };

/**
 * Runs one command with an argument array (no shell), a time limit and an output limit. Nothing the
 * command prints is kept except its standard output, which the caller parses and discards; standard
 * error is never read into a value.
 */
export function runCommand(file: string, args: string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number }): Promise<RunOutcome> {
  return new Promise((resolve) => {
    try {
      const child = execFile(file, args, {
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: options.maxOutputBytes,
        shell: false,
        windowsHide: true,
        encoding: 'utf8'
      }, (error, stdout) => {
        if (!error) { resolve({ code: 0, stdout }); return; }
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: string | number };
        if (failure.code === 'ENOENT') { resolve({ code: null, stdout: '', errorCode: 'ENOENT' }); return; }
        if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') { resolve({ code: null, stdout: '', truncated: true }); return; }
        if (failure.killed === true && failure.signal) { resolve({ code: null, stdout: '', timedOut: true }); return; }
        if (typeof failure.code === 'number') { resolve({ code: failure.code, stdout: typeof stdout === 'string' ? stdout : '' }); return; }
        resolve({ code: null, stdout: '', errorCode: typeof failure.code === 'string' ? failure.code : 'ERR_UNKNOWN' });
      });
      child.stdin?.end();
    } catch {
      resolve({ code: null, stdout: '', errorCode: 'ERR_SPAWN' });
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
