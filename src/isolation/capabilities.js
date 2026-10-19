'use strict';

/**
 * What a managed terminal environment can honestly claim about keeping an agent away from GitHub writes
 * (issues #25 for macOS and #26 for native Windows share this interface; each platform supplies its own probes).
 *
 * Nothing here isolates anything. It decides what may be SAID and what may be STARTED, from evidence that a
 * platform module collected by actually trying each bypass: a channel counts as enforced only when the attempt
 * was blocked AND a control run of the same probing method succeeded outside the isolation (so a probe that
 * simply could not run never reads as a closed door). Anything missing, malformed, stale, thrown or timed out is
 * unknown, and unknown is never better than open. A launch that asks for enforcement is refused unless every
 * required channel is enforced and interaction was preserved: it is never quietly downgraded to advice.
 */

/** Ways an agent could write to GitHub or reach a credential without the broker, plus what must keep working. */
const CHANNELS = Object.freeze({
  'git-commit': { kind: 'bypass', required: true, text: 'a direct `git commit` that skips the broker\'s checks' },
  'git-push': { kind: 'bypass', required: true, text: 'a direct `git push` to the remote' },
  'gh-cli': { kind: 'bypass', required: true, text: 'the `gh` command writing to GitHub' },
  'credential-helper': { kind: 'bypass', required: true, text: 'asking a git credential helper for a stored credential' },
  'direct-http': { kind: 'bypass', required: true, text: 'a direct HTTP request to the GitHub API' },
  'env-credentials': { kind: 'bypass', required: true, text: 'a GitHub credential in the environment of the terminal' },
  'file-credentials': { kind: 'bypass', required: true, text: 'a GitHub credential in a file the terminal can read' },
  'terminal-interaction': { kind: 'interaction', required: true, text: 'typing into the CLI, answering its prompts and interrupting it' },
  'cli-own-login': { kind: 'interaction', required: true, text: 'the CLI using its own sign-in' }
});

const PLATFORMS = Object.freeze(['darwin', 'win32']);
const DEFAULT_VALID_MS = 24 * 60 * 60 * 1000;
const GOOD = Object.freeze({ bypass: 'blocked', interaction: 'works' });
const BAD = Object.freeze({ bypass: 'open', interaction: 'broken' });

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * @param {{ platform: string, probes?: Record<string, unknown>, now?: Date, validForMs?: number }} input
 *   `probes[channel]` is `{ outcome, control, observedAt }` as a platform module recorded it.
 * @returns {{ platform: string, supported: boolean, mode: 'enforced' | 'advisory', channels: Array<{ channel: string, state: 'enforced' | 'open' | 'unknown', reason: string }>, reasons: string[] }}
 */
function assessIsolation({ platform, probes = {}, now = new Date(), validForMs = DEFAULT_VALID_MS } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const supported = PLATFORMS.includes(platform);
  const valid = Number.isFinite(validForMs) && validForMs > 0 ? validForMs : DEFAULT_VALID_MS;
  const channels = Object.keys(CHANNELS).map((channel) => {
    const spec = CHANNELS[channel];
    const result = (state, reason) => ({ channel, state, reason });
    if (!supported) return result('unknown', 'platform-not-supported');
    const probe = isPlain(probes) && Object.hasOwn(probes, channel) ? probes[channel] : undefined;
    if (!isPlain(probe)) return result('unknown', 'not-probed');
    if (probe.control !== true) return result('unknown', 'control-did-not-run');
    const observed = Date.parse(probe.observedAt);
    if (!Number.isFinite(observed) || !Number.isFinite(nowMs) || observed > nowMs) return result('unknown', 'evidence-time-invalid');
    if (nowMs - observed >= valid) return result('unknown', 'evidence-stale');
    if (probe.outcome === GOOD[spec.kind]) return result('enforced', 'attempt-blocked-with-control');
    if (probe.outcome === BAD[spec.kind]) return result('open', 'attempt-succeeded');
    return result('unknown', 'outcome-unrecognized');
  });
  const reasons = [];
  for (const entry of channels) {
    const spec = CHANNELS[entry.channel];
    if (spec.required && entry.state !== 'enforced') reasons.push(`${entry.channel}:${entry.state === 'open' ? 'open' : entry.reason}`);
  }
  return { platform: supported ? platform : 'unsupported', supported, mode: reasons.length === 0 ? 'enforced' : 'advisory', channels, reasons };
}

/**
 * Whether a launch may go ahead. Advice mode always may, and says it is only advice. Enforcement may only start
 * when the assessment is fully enforced: otherwise it is refused with the reasons, never run as advice instead.
 * @param {{ assessment: ReturnType<typeof assessIsolation>, requested: 'enforced' | 'advisory' }} input
 */
function decideLaunch({ assessment, requested } = {}) {
  if (!assessment || !Array.isArray(assessment.channels) || (requested !== 'enforced' && requested !== 'advisory')) {
    return { allowed: false, mode: 'none', reasons: ['input-invalid'], notice: 'The launch request could not be understood, so nothing was started.' };
  }
  if (requested === 'advisory') {
    return { allowed: true, mode: 'advisory', reasons: [], notice: 'Advice mode: GitHub writes are checked and advised, but nothing here prevents an agent from bypassing the checks.' };
  }
  if (assessment.mode === 'enforced' && assessment.supported === true) {
    return { allowed: true, mode: 'enforced', reasons: [], notice: 'Every required bypass was tried on this machine and blocked.' };
  }
  const reasons = assessment.reasons.length > 0 ? assessment.reasons : ['not-enforced'];
  return { allowed: false, mode: 'none', reasons, notice: 'Enforced mode was requested but is not available here, so nothing was started. Start in advice mode, or fix the listed items.' };
}

/** Plain lines for the screen: what was proven, what is open, what is not known. Never says "blocked" without evidence. */
function describeAssessment(assessment) {
  if (!assessment || !Array.isArray(assessment.channels)) return ['Isolation: unknown.'];
  const where = assessment.platform === 'darwin' ? 'macOS' : assessment.platform === 'win32' ? 'Windows' : 'this platform';
  const lines = [assessment.mode === 'enforced'
    ? `Isolation on ${where}: every required bypass was tried and blocked, and the CLI stayed usable.`
    : `Isolation on ${where}: not enforced. Advice mode only; nothing prevents an agent from bypassing the checks.`];
  for (const entry of assessment.channels) {
    const spec = CHANNELS[entry.channel];
    if (!spec) continue;
    const word = entry.state === 'enforced' ? (spec.kind === 'bypass' ? 'blocked' : 'works') : entry.state === 'open' ? (spec.kind === 'bypass' ? 'NOT blocked' : 'broken') : 'unknown';
    lines.push(`- ${spec.text}: ${word}${entry.state === 'unknown' ? ` (${entry.reason})` : ''}`);
  }
  return lines;
}

const TIMEOUT_MS = 15_000;

/**
 * Runs a platform module's probes one channel at a time. A probe that throws, hangs past the timeout, answers with
 * something that is not a plain object, or is aborted, leaves that channel unprobed (unknown). Never throws.
 * @param {{ platform: string, probe(channel: string, context: { signal: AbortSignal }): Promise<unknown> }} platformModule
 * @param {{ signal?: AbortSignal, timeoutMs?: number, now?: () => Date }} [options]
 */
async function collectProbes(platformModule, { signal, timeoutMs = TIMEOUT_MS, now = () => new Date() } = {}) {
  const probes = {};
  if (!platformModule || typeof platformModule.probe !== 'function') return { platform: platformModule ? platformModule.platform : undefined, probes };
  for (const channel of Object.keys(CHANNELS)) {
    if (signal && signal.aborted) break;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    let timer;
    try {
      const outcome = await Promise.race([
        Promise.resolve().then(() => platformModule.probe(channel, { signal: controller.signal })),
        new Promise((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(undefined); }, timeoutMs); })
      ]);
      if (isPlain(outcome)) probes[channel] = { ...outcome, observedAt: outcome.observedAt ?? now().toISOString() };
    } catch { /* an unprobed channel is unknown */ } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
  return { platform: platformModule.platform, probes };
}

module.exports = { CHANNELS, PLATFORMS, DEFAULT_VALID_MS, assessIsolation, decideLaunch, describeAssessment, collectProbes };
