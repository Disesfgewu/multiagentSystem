'use strict';

const { builtIn } = require('../providers/registry');
const { claudeIdentityFromAuthStatus, unknown } = require('./observation');
const { validateProfile } = require('./profile');

// Asking a provider's own CLI who is signed in for one account profile. The CLI is run by an
// injected runner with an argument array (never a shell string), a time limit and an output limit,
// in the environment of THAT profile's configuration folder. Its output is parsed as JSON and
// reduced to the observation the account view already understands; the raw output (which holds an
// email address) is never kept, shown, logged or put in an error. Anything that goes wrong is
// "unknown" with a reason, never "ready".

const TIMEOUT_MS = 10_000;
// The runner is expected to stop a command at TIMEOUT_MS. If it does not answer at all, the check gives up
// at this hard limit and reports a timeout, so a runner that never returns cannot hold the screen.
const HARD_LIMIT_MS = TIMEOUT_MS + 5_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
// Plan names that are shown. Anything else the CLI reports is dropped (unknown) rather than shown: the text
// comes from outside and could say anything. The list is a guess at current names, not a verified one.
const PLAN_NAMES = Object.freeze(['free', 'pro', 'max', 'team', 'enterprise']);

// The status command for each provider that has one. A provider not listed here cannot be checked and
// says so; no command is guessed. Codex needs a protocol session (app-server), which is not run here.
const CHECKS = Object.freeze({
  claude: Object.freeze({ args: Object.freeze(['auth', 'status', '--json']), source: 'claude auth status --json' })
});

const REASONS = Object.freeze({
  'provider-not-supported': { summary: 'This provider has no sign-in check in this extension yet.', hint: 'Its sign-in cannot be verified here. The identity stays unknown.' },
  'profile-rejected': { summary: 'The account folder no longer passes the safety checks, so the check was not run.', hint: 'Edit the account and choose its folder again.' },
  'cli-not-found': { summary: 'The command-line tool could not be started.', hint: 'Check that the CLI is installed and on your PATH, then check again.' },
  'timed-out': { summary: 'The check took too long and was stopped.', hint: 'Try again. If it keeps happening, run the CLI\'s own status command in a terminal.' },
  'output-too-large': { summary: 'The CLI answered with more text than expected, so the answer was ignored.', hint: 'The identity stays unknown.' },
  'not-json': { summary: 'The CLI\'s answer was not in the expected format.', hint: 'The CLI may be a different version. The identity stays unknown.' },
  'unexpected-shape': { summary: 'The CLI\'s answer did not have the expected fields.', hint: 'The CLI may be a different version. The identity stays unknown.' },
  'nonzero-exit': { summary: 'The CLI reported an error (it may not be signed in).', hint: 'Sign in with this account, then check again.' },
  'run-failed': { summary: 'The check could not be run.', hint: 'Try the check again in a moment.' }
});

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const unknownResult = (reason, checkedAt, source) => ({ ok: false, state: 'unknown', reason, checkedAt, source, identity: null });

/**
 * @param {{
 *   profile: object,
 *   runner: (file: string, args: string[], options: { env: object, timeoutMs: number, maxOutputBytes: number }) => Promise<{ code: number|null, stdout: string, timedOut?: boolean, truncated?: boolean, errorCode?: string }>,
 *   env?: object,
 *   context?: object,
 *   now?: () => Date,
 *   hardLimitMs?: number
 * }} input `env` is the full environment for the child, already built for this profile
 */
async function checkAccountIdentity({ profile, runner, env = {}, context, now = () => new Date(), hardLimitMs = HARD_LIMIT_MS } = {}) {
  const checkedAt = now().toISOString();
  const spec = isPlain(profile) && typeof profile.provider === 'string' && Object.hasOwn(CHECKS, profile.provider) ? CHECKS[profile.provider] : null;
  if (!spec) return unknownResult('provider-not-supported', checkedAt, null);
  const executable = builtIn.get(profile.provider)?.executable;
  if (typeof executable !== 'string') return unknownResult('provider-not-supported', checkedAt, spec.source);
  if (!validateProfile(profile, context).ok) return unknownResult('profile-rejected', checkedAt, spec.source);

  let outcome;
  let timer;
  try {
    const limit = new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), hardLimitMs); });
    outcome = await Promise.race([runner(executable, [...spec.args], { env, timeoutMs: TIMEOUT_MS, maxOutputBytes: MAX_OUTPUT_BYTES }), limit]);
  } catch {
    return unknownResult('run-failed', checkedAt, spec.source);
  } finally {
    clearTimeout(timer);
  }
  if (!isPlain(outcome)) return unknownResult('run-failed', checkedAt, spec.source);
  if (outcome.errorCode === 'ENOENT') return unknownResult('cli-not-found', checkedAt, spec.source);
  if (outcome.timedOut === true) return unknownResult('timed-out', checkedAt, spec.source);
  if (outcome.truncated === true || (typeof outcome.stdout === 'string' && Buffer.byteLength(outcome.stdout) > MAX_OUTPUT_BYTES)) return unknownResult('output-too-large', checkedAt, spec.source);
  if (typeof outcome.errorCode === 'string') return unknownResult('run-failed', checkedAt, spec.source);
  if (outcome.code !== 0) return unknownResult('nonzero-exit', checkedAt, spec.source);

  let status;
  try {
    status = JSON.parse(outcome.stdout);
  } catch {
    return unknownResult('not-json', checkedAt, spec.source);
  }
  if (!isPlain(status) || typeof status.loggedIn !== 'boolean') return unknownResult('unexpected-shape', checkedAt, spec.source);

  const identity = claudeIdentityFromAuthStatus(status, { profile, observedAt: checkedAt, context });
  // Only a plan name from the list above is passed on, in lower case; anything else is dropped rather than shown.
  if (identity.plan && identity.plan.value !== null) {
    const name = typeof identity.plan.value === 'string' ? identity.plan.value.trim().toLowerCase() : '';
    if (PLAN_NAMES.includes(name)) identity.plan = { ...identity.plan, value: name };
  }
  if (identity.plan && identity.plan.value !== null && !(typeof identity.plan.value === 'string' && PLAN_NAMES.includes(identity.plan.value))) {
    identity.plan = unknown('plan', { source: spec.source, observedAt: checkedAt, reason: 'unusable-value' });
  }
  return { ok: true, state: 'checked', reason: 'checked', checkedAt, source: spec.source, identity };
}

// Two different things the account view can say about the configuration folder: whether it passes this
// extension's own safety checks, and whether the CLI confirmed that it is using that folder. A CLI that
// could not be asked has not confirmed anything, which says nothing against the folder itself.
const CLI_CONFIRMATION_CODES = Object.freeze(['config-dir-mismatch', 'config-dir-unverified']);
function splitFolderIssues(issues) {
  const folder = [];
  const confirmation = [];
  for (const issue of Array.isArray(issues) ? issues : []) {
    if (!issue || typeof issue.code !== 'string' || !issue.code.startsWith('config-dir')) continue;
    (CLI_CONFIRMATION_CODES.includes(issue.code) ? confirmation : folder).push(typeof issue.hint === 'string' ? issue.hint : 'Needs attention.');
  }
  return { folder, confirmation };
}

/** Words for a person. Never includes the CLI's output. */
function describeCheck(result) {
  if (!isPlain(result)) return { summary: 'The check has not been run.', hint: 'Choose Check Sign-in.' };
  if (result.state === 'unknown') return REASONS[result.reason] ?? REASONS['run-failed'];
  const identity = result.identity;
  if (!identity.loggedIn) return { summary: 'The CLI says this account is not signed in.', hint: 'Open the login terminal and sign in, then check again.' };
  if (identity.subject && identity.subject.confidence === 'actual') {
    return { summary: 'Signed in. The CLI confirmed an account (shown here only as a short fingerprint).', hint: identity.anomalies.length > 0 ? 'Something looks wrong: see the problems listed for this account.' : 'You can start a session with this account.' };
  }
  return { summary: 'Signed in, but the CLI did not confirm who the account is.', hint: 'The identity stays unknown, so this account cannot be used for a managed launch.' };
}

module.exports = { checkAccountIdentity, describeCheck, splitFolderIssues, CHECKS, REASONS, TIMEOUT_MS, MAX_OUTPUT_BYTES, HARD_LIMIT_MS };
