'use strict';

const { isLive, appliesTo } = require('./model');

/**
 * Delivering a stored administrator broadcast to running agent CLIs as a prompt typed into their terminal (issue #295).
 * This module is pure logic: it builds the prompt, decides per session whether to send it, and checks the delivery record.
 * It sends nothing and decides nothing about WHO may broadcast: that stays with the interactive command that calls it,
 * which takes no argument at all (see `commands.ts`). A prompt is only ever built from a broadcast that command read from
 * the private store after the person confirmed it.
 *
 * "Sent" means the text was typed into that session's terminal. It is not proof that the CLI read it or will act on it.
 */

const PREFIX = '[Administrator broadcast';
const MAX_PROMPT_CHARS = 2200;
// Anything that could end the line, start an escape sequence or hide text. The broadcast text is already one clean line
// (`model.js`); this is the second guard, at the last step before a terminal.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * One line, starting with `[`: the first character cannot make a CLI read the prompt as a slash command, a shell escape or a
 * memory note. Throws on text a terminal must not receive.
 */
function buildPrompt(broadcast) {
  if (!isPlain(broadcast) || typeof broadcast.text !== 'string' || typeof broadcast.createdAt !== 'string') throw Object.assign(new Error('prompt-invalid'), { code: 'prompt-invalid' });
  const prompt = `${PREFIX}, created ${broadcast.createdAt}] ${broadcast.text}`;
  if (UNSAFE.test(prompt) || prompt.length > MAX_PROMPT_CHARS) throw Object.assign(new Error('prompt-invalid'), { code: 'prompt-invalid' });
  return prompt;
}

/** The same check for the manager, which types whatever it is given: one line, bounded, nothing a terminal would interpret. */
function promptIsSafe(prompt) {
  return typeof prompt === 'string' && prompt.length > 0 && prompt.length <= MAX_PROMPT_CHARS && !UNSAFE.test(prompt) && prompt.startsWith('[');
}

const RUNNING = new Set(['launch-requested', 'cli-observed']);

/**
 * Per targeted session: `send`, `unknown`, or `skip` with a reason.
 *  - `send`: the terminal is open, the CLI is recorded as running, AND the CLI's own last hook event says it is waiting for input
 *    (`session.deliveryState`, which does not age out after 30 seconds: an idle agent sends no further event).
 *  - `unknown`: the same, but nothing says what the CLI is doing (Codex, agy, a custom provider, a Claude without the hook bridge,
 *    an old or unbound hook record). Listed separately and NOT sent unless the person explicitly asks for it.
 *  - `skip`: the terminal is closed, the CLI is not running (a shell, exited), or the CLI is busy or ended. Never sent.
 * The prompt is never forced into a shell prompt or a busy CLI.
 *
 * @param {{ broadcast: object, sessions: Array<object>, roleOf?: (session: object) => (string|undefined), now: Date }} input
 * @returns {{ ok: true, prompt: string, recipients: Array<{ id: string, name: string, provider: string, decision: 'send'|'unknown'|'skip', reason: string }> } | { ok: false, reason: string }}
 */
function planDelivery({ broadcast, sessions, roleOf = () => undefined, now }) {
  if (!isPlain(broadcast) || !isLive(broadcast, now)) return { ok: false, reason: 'broadcast-not-live' };
  let prompt;
  try { prompt = buildPrompt(broadcast); } catch { return { ok: false, reason: 'prompt-invalid' }; }
  return planPromptDelivery({ prompt, sessions, matches: (session) => appliesTo(broadcast, { role: roleOf(session), agentId: session.id, provider: session.provider }) });
}

/** One session's place in a delivery: `send`, `unknown` or `skip`, with the reason. The one rule for broadcasts and for task prompts alike. */
function classifySession(session) {
  const entry = { id: session.id, name: typeof session.name === 'string' ? session.name : 'Session', provider: String(session.provider ?? ''), decision: 'skip', reason: '' };
  const delivery = isPlain(session.deliveryState) ? session.deliveryState.state : null;
  if (session.terminalOpen !== true) entry.reason = 'terminal-not-open';
  else if (!RUNNING.has(session.state)) entry.reason = 'cli-not-running';
  else if (delivery === 'waiting') { entry.decision = 'send'; entry.reason = 'waiting-for-input'; }
  else if (delivery === 'working') entry.reason = 'cli-busy';
  else if (delivery === 'ended') entry.reason = 'cli-not-waiting';
  else { entry.decision = 'unknown'; entry.reason = 'state-unknown'; }
  return entry;
}

/**
 * The same plan for any prompt that is typed into running agents (a broadcast, a task): who may receive it, who is left out and why.
 * `prompt` must already be one safe line (`promptIsSafe`); `matches(session)` says which sessions the prompt is for.
 * @returns {{ ok: true, prompt: string, recipients: object[] } | { ok: false, reason: string }}
 */
function planPromptDelivery({ prompt, sessions, matches }) {
  if (!promptIsSafe(prompt)) return { ok: false, reason: 'prompt-invalid' };
  const recipients = [];
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (!isPlain(session) || typeof session.id !== 'string') continue;
    let wanted = false;
    try { wanted = matches(session) === true; } catch { wanted = false; }
    if (wanted) recipients.push(classifySession(session));
  }
  return { ok: true, prompt, recipients };
}

const REASON_TEXT = Object.freeze({
  'waiting-for-input': 'waiting for input',
  'terminal-not-open': 'its terminal is not open',
  'cli-not-running': 'the CLI is not recorded as running (a shell prompt, or it exited)',
  'cli-busy': 'the CLI is busy working',
  'cli-not-waiting': 'the CLI has finished or ended',
  'state-unknown': 'state unknown (the CLI gave no hook evidence of what it is doing)',
  'sent-unknown-state': 'typed although its state was unknown (you chose to)',
  'broadcast-changed': 'not sent: the broadcast was revoked or changed while the window was open',
  'task-changed': 'not sent: the Issue or the task changed while the window was open',
  'send-failed': 'not sent: the terminal could not be written to'
});
const reasonText = (reason) => (Object.hasOwn(REASON_TEXT, reason) ? REASON_TEXT[reason] : 'unknown');

/** The lines of the confirmation window: who gets it, who does not and why, and the complete prompt. */
function describePlan(plan) {
  const send = plan.recipients.filter((entry) => entry.decision === 'send');
  const unknown = plan.recipients.filter((entry) => entry.decision === 'unknown');
  const skip = plan.recipients.filter((entry) => entry.decision === 'skip');
  return [
    send.length > 0 ? `Will be typed into ${send.length} session${send.length === 1 ? '' : 's'} that are waiting for input:` : 'No session is known to be waiting for input.',
    ...send.map((entry) => `  • ${entry.name} (${entry.provider})`),
    ...(unknown.length > 0 ? [`State unknown for ${unknown.length} (NOT sent unless you choose to):`, ...unknown.map((entry) => `  • ${entry.name} (${entry.provider}): ${reasonText(entry.reason)}`)] : []),
    ...(skip.length > 0 ? [`Will NOT be sent to ${skip.length}:`, ...skip.map((entry) => `  • ${entry.name} (${entry.provider}): ${reasonText(entry.reason)}`)] : []),
    '',
    'The complete prompt:',
    plan.prompt,
    '',
    '"Sent" means typed into the terminal. It is not proof that the CLI read it or will act on it.'
  ];
}

const RECORD_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OUTCOMES = new Set(['sent', 'skipped']);
const REASONS = new Set([...Object.keys(REASON_TEXT)]);

/** The per-session results of a delivery (broadcast or task): session id, provider, outcome and a known reason, nothing else. */
function validateDeliveryResults(raw) {
  if (!Array.isArray(raw) || raw.length > 200) return { ok: false, problem: 'invalid-results' };
  for (const entry of raw) {
    if (!isPlain(entry) || typeof entry.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(entry.sessionId) || !OUTCOMES.has(entry.outcome) || !REASONS.has(entry.reason) || typeof entry.provider !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(entry.provider)) return { ok: false, problem: 'invalid-result' };
  }
  return { ok: true, results: raw.map((entry) => Object.freeze({ sessionId: entry.sessionId, provider: entry.provider, outcome: entry.outcome, reason: entry.reason })) };
}

/**
 * A delivery record: what happened for each session, by session id and provider only (no names, paths or accounts).
 * @returns {{ ok: true, record: object } | { ok: false, problems: string[] }}
 */
function validateDelivery(raw) {
  if (!isPlain(raw)) return { ok: false, problems: ['invalid-delivery'] };
  const problems = [];
  if (typeof raw.id !== 'string' || !RECORD_ID.test(raw.id)) problems.push('invalid-id');
  if (typeof raw.broadcastId !== 'string' || !RECORD_ID.test(raw.broadcastId)) problems.push('invalid-broadcast-id');
  if (!Number.isSafeInteger(raw.version) || raw.version < 1) problems.push('invalid-version');
  if (typeof raw.at !== 'string' || !Number.isFinite(Date.parse(raw.at))) problems.push('invalid-time');
  const results = validateDeliveryResults(raw.results);
  if (!results.ok) problems.push(results.problem);
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, record: Object.freeze({ id: raw.id, broadcastId: raw.broadcastId, version: raw.version, at: new Date(raw.at).toISOString(), results: results.results }) };
}

/** `Delivery: 2 typed in, 1 not sent` for the list and the notice document. */
function summarizeDeliveries(records, broadcastId) {
  const mine = (Array.isArray(records) ? records : []).filter((entry) => entry && entry.broadcastId === broadcastId);
  if (mine.length === 0) return 'unknown (not sent to any CLI)';
  let sent = 0;
  let skipped = 0;
  for (const record of mine) for (const entry of record.results) { if (entry.outcome === 'sent') sent += 1; else skipped += 1; }
  return `typed into ${sent} session${sent === 1 ? '' : 's'}, not sent to ${skipped}`;
}

module.exports = { buildPrompt, promptIsSafe, planDelivery, planPromptDelivery, classifySession, describePlan, validateDelivery, validateDeliveryResults, summarizeDeliveries, reasonText, MAX_PROMPT_CHARS };
