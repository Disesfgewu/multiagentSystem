'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { assessIsolation, decideLaunch, collectProbes } = require('./capabilities');
const { seatbeltProfile, credentialLocations, KEYCHAIN_SERVICES, safeProfilePath, SANDBOX_EXEC } = require('./macos');
const { createFilterProxy, parsePattern } = require('./filter-proxy');

/**
 * Enforced isolation for one launch (issue #25). Advice mode is the default and is not decided here: the caller only
 * comes here when the person chose enforced mode themselves, in their own user settings.
 *
 * Everything that could make the launch less isolated ends in a refusal, never in a launch without isolation:
 * an unsupported platform, no allowed domains, a probe that could not run (`decideLaunch` reads the evidence, and
 * any channel that is unknown or open refuses), a proxy that did not start, a profile that could not be written.
 * What is returned on success is `wrapCommand`, which turns the provider's command into the one to run INSTEAD (`sandbox-exec -f <profile> …`), the
 * environment that sends the program's HTTPS through the local proxy, and `dispose()`.
 *
 * Nothing is read from the workspace. The allowed domains and the choice of enforced mode come from the caller, who
 * reads them from user-level settings only. Results and refusals carry channel names and short codes, never paths,
 * account names or the proxy credential (the credential only appears in `env`, which the caller hands to the terminal).
 */

const refuse = (code, reasons = [], notice) => ({ ok: false, code, reasons, notice: notice ?? 'Enforced isolation is not available here, so nothing was started.' });

/** The proxy variables for a program that honours them; both spellings, because programs differ. */
function proxyEnvironment(url) {
  return { HTTPS_PROXY: url, https_proxy: url, ALL_PROXY: url, all_proxy: url, NO_PROXY: '', no_proxy: '' };
}

/** The sandbox for the program itself: what `macos-harness` probes, with the one local port its proxy listens on. */
function launchSpec({ home, proxyPort }) {
  return { denyRead: credentialLocations(home), allowLocalPorts: [proxyPort], denyMachServices: [...KEYCHAIN_SERVICES] };
}

/**
 * @param {{ platform?: string, allowedDomains: unknown, storageDir: string, home: string, createHarness: (options: { tmpRoot: string }) => { platform: string, probe: Function, dispose(): Promise<void> },
 *   createProxy?: typeof createFilterProxy, signal?: AbortSignal, now?: () => Date, probeTimeoutMs?: number }} input
 * @returns {Promise<{ ok: true, wrapCommand(executable: string, args: string[]): { executable: string, args: string[] }, env: Record<string, string>, notice: string, summary: string[], dispose(): Promise<void> } | { ok: false, code: string, reasons: string[], notice: string }>}
 */
async function prepareEnforcedLaunch({ platform = process.platform, allowedDomains, storageDir, home, createHarness, createProxy = createFilterProxy, signal, now, probeTimeoutMs } = {}) {
  if (platform !== 'darwin') return refuse('platform-not-supported', ['platform-not-supported'], 'Enforced isolation is only available on macOS for now, so nothing was started. Windows is not wired yet.');
  if (!Array.isArray(allowedDomains) || allowedDomains.length === 0 || allowedDomains.some((entry) => typeof entry !== 'string' || parsePattern(entry) === null)) {
    return refuse('allowed-domains-missing', ['allowed-domains-missing'], 'Enforced isolation needs the provider domains you allow (user setting multiagentSystem.isolation.allowedDomains), so nothing was started.');
  }
  if (!safeProfilePath(storageDir) || !safeProfilePath(home)) return refuse('storage-unavailable', ['storage-unavailable']);

  // Everything created below is removed again on every path out, success of the launch included only through dispose().
  const cleanup = [];
  const disposeAll = async () => { for (const step of cleanup.splice(0).reverse()) { try { await step(); } catch { /* best effort; nothing here may stop the rest */ } } };
  try {
    const work = path.join(storageDir, `isolation-${randomBytes(6).toString('hex')}`);
    fs.mkdirSync(work, { recursive: true, mode: 0o700 });
    cleanup.push(() => fs.rmSync(work, { recursive: true, force: true }));

    // 1. The evidence: every channel tried for real on this machine. Anything but "blocked/works with a control" refuses.
    let assessment;
    {
      const harness = createHarness({ tmpRoot: work });
      cleanup.push(() => harness.dispose());
      const collected = await collectProbes(harness, { signal, ...(now ? { now } : {}), ...(probeTimeoutMs ? { timeoutMs: probeTimeoutMs } : {}) });
      assessment = assessIsolation({ platform: collected.platform, probes: collected.probes, ...(now ? { now: now() } : {}) });
    }
    const decision = decideLaunch({ assessment, requested: 'enforced' });
    if (!decision.allowed) { await disposeAll(); return refuse('evidence-insufficient', decision.reasons, decision.notice); }

    // 2. The proxy: this launch's own, with a credential of its own.
    const proxy = createProxy({ allow: allowedDomains });
    const started = await proxy.start();
    cleanup.push(() => proxy.stop());
    if (!started || started.address !== '127.0.0.1' || !Number.isInteger(started.port) || typeof started.url !== 'string') { await disposeAll(); return refuse('proxy-unavailable', ['proxy-unavailable']); }

    // 3. The profile, written where only this person can read it.
    const profilePath = path.join(work, 'profile.sb');
    fs.writeFileSync(profilePath, seatbeltProfile(launchSpec({ home, proxyPort: started.port })), { mode: 0o600 });
    if (!safeProfilePath(profilePath)) { await disposeAll(); return refuse('storage-unavailable', ['storage-unavailable']); }

    return {
      ok: true,
      // The provider's program and its final arguments are only known when the terminal is told what to run.
      wrapCommand: (executable, args) => {
        if (typeof executable !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(executable) || !Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) throw Object.assign(new Error('launch-invalid'), { code: 'launch-invalid' });
        return { executable: SANDBOX_EXEC, args: ['-f', profilePath, executable, ...args] };
      },
      env: proxyEnvironment(started.url),
      notice: decision.notice,
      summary: [
        'Enforced isolation: every required bypass was tried on this machine and blocked.',
        'Not verified (#135): that the real CLI works through the proxy, and which domains it needs. If it cannot connect, add its domains to your allowed list.'
      ],
      dispose: disposeAll
    };
  } catch {
    await disposeAll();
    return refuse('isolation-failed', ['isolation-failed']);
  }
}

module.exports = { prepareEnforcedLaunch, launchSpec, proxyEnvironment };
