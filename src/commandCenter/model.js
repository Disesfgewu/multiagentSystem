'use strict';

/**
 * The Command Center's data, as plain values (issue #309): one fixed PM panel and a card for every other agent. Pure: no vscode, no
 * file, no network. Everything comes from what the existing services already worked out (the overview's presented agents and
 * accounts, the session list, the role groups); a value without a source is "unknown", never a guess and never a made-up number.
 * Text that came from outside (a session name, a label, a report line) is shown as one short clean line and is only ever rendered
 * as text by the page, never as HTML.
 */

const SHOWN_LIMIT = 120;
const MAX_LINES = 24;
const MAX_CARDS = 200;
const UNKNOWN = 'unknown';
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const line = (value, fallback = UNKNOWN, limit = SHOWN_LIMIT) => {
  const text = typeof value === 'string' ? Array.from(value.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim()).slice(0, limit).join('') : '';
  return text === '' ? fallback : text;
};
const lines = (values, limit = SHOWN_LIMIT) => (Array.isArray(values) ? values : []).slice(0, MAX_LINES).map((value) => line(value, '', limit)).filter((value) => value !== '');

const STATES = Object.freeze(['working', 'waiting', 'ended', 'unknown']);
const STATE_TEXT = Object.freeze({
  working: 'working',
  waiting: 'waiting for input',
  ended: 'ended',
  unknown: 'state unknown'
});

/**
 * What the CLI itself last said it is doing (`deliveryState`, from its own hook events), or unknown. A terminal that exists is never
 * described as an agent that is working: without hook evidence the state is unknown, with the reason on the card.
 */
function statusOf(session) {
  const delivery = isPlain(session.deliveryState) ? session.deliveryState : null;
  if (delivery && STATES.includes(delivery.state) && delivery.state !== 'unknown') {
    const since = typeof delivery.since === 'string' && Number.isFinite(Date.parse(delivery.since)) ? new Date(delivery.since).toISOString() : null;
    return { state: delivery.state, text: STATE_TEXT[delivery.state], source: since ? `from the CLI's own hooks, last event ${since}` : "from the CLI's own hooks" };
  }
  const reason = delivery && typeof delivery.reason === 'string' ? line(delivery.reason, '', 60) : '';
  return { state: 'unknown', text: STATE_TEXT.unknown, source: reason ? `no hook evidence (${reason})` : 'no hook evidence' };
}

const PM_TEXT = Object.freeze({
  current: 'PM report current',
  stale: 'PM report STALE (its evidence is for another head)',
  missing: 'no structured PM report yet',
  unknown: 'PM report unknown'
});

/**
 * The latest report of the agent's pull request, as a few lines: what the PM report says the person can do and what is next, the formal
 * approval and CI for the latest head. `undefined` means it was not loaded yet and `null` that it could not be read: both are said
 * plainly, never filled in. An agent with no pull request has no report.
 */
function reportLines(pullRequest, summary) {
  if (pullRequest === null) return ['Latest report: none (no pull request is linked to this agent)'];
  if (summary === undefined) return [`Latest report (PR #${pullRequest}): not loaded yet`];
  if (!isPlain(summary)) return [`Latest report (PR #${pullRequest}): unknown (the report could not be read)`];
  const out = [`Latest report (PR #${pullRequest}): ${Object.hasOwn(PM_TEXT, summary.pm) ? PM_TEXT[summary.pm] : PM_TEXT.unknown}`];
  if (typeof summary.userCan === 'string' && summary.userCan !== '') out.push(`User can: ${line(summary.userCan, '', 160)}`);
  if (typeof summary.next === 'string' && summary.next !== '') out.push(`Next: ${line(summary.next, '', 160)}`);
  const unresolved = Number.isSafeInteger(summary.unresolved) && summary.unresolved >= 0 ? ` · ${summary.unresolved} unresolved thread${summary.unresolved === 1 ? '' : 's'}` : '';
  out.push(`Review: approval ${line(summary.approval, UNKNOWN, 40)} · CI ${line(summary.ci, UNKNOWN, 20)}${unresolved}`);
  return out;
}

/** `role` is the role group's role id ('pm', 'worker', 'researcher', …), or null when the session has no role group. */
const isPm = (role) => role === 'pm';

/**
 * @param {{ sessions: object[], agents?: object[], accounts?: object[], roles?: Record<string, { name?: string, role?: string }>, reports?: Record<number, object|null>, assignments?: Record<string, { issueNumber: number, at: string }> }} input
 *   `reports`: a summary of the pull request's report by pull request number (`null` could not be read, a missing key not loaded yet).
 *   `agents`: the overview's presented agents (same ids as the sessions); `accounts`: its presented accounts (id, label, usage lines, gate).
 * @returns {{ pm: object[], agents: object[], accounts: object[], counts: { agents: number, pm: number } }}
 */
function buildCards(input) {
  const { sessions, agents = [], accounts = [], roles = {}, reports = {}, assignments = {} } = isPlain(input) ? input : {};
  const presented = new Map((Array.isArray(agents) ? agents : []).filter((entry) => isPlain(entry) && typeof entry.id === 'string').map((entry) => [entry.id, entry]));
  const accountById = new Map((Array.isArray(accounts) ? accounts : []).filter((entry) => isPlain(entry) && typeof entry.id === 'string').map((entry) => [entry.id, entry]));
  const cards = [];
  for (const session of (Array.isArray(sessions) ? sessions : []).slice(0, MAX_CARDS)) {
    if (!isPlain(session) || typeof session.id !== 'string' || !ID.test(session.id)) continue;
    const shownAgent = presented.get(session.id);
    const roleInfo = isPlain(roles) && typeof session.roleGroupId === 'string' && Object.hasOwn(roles, session.roleGroupId) && isPlain(roles[session.roleGroupId]) ? roles[session.roleGroupId] : null;
    const role = roleInfo && typeof roleInfo.role === 'string' ? roleInfo.role : null;
    const account = accountById.get(session.accountProfileId);
    const status = statusOf(session);
    const issue = shownAgent && Number.isSafeInteger(shownAgent.issueNumber) ? shownAgent.issueNumber : null;
    const pullRequest = shownAgent && Number.isSafeInteger(shownAgent.pullRequestNumber) ? shownAgent.pullRequestNumber : null;
    const handed = isPlain(assignments) && Object.hasOwn(assignments, session.id) && isPlain(assignments[session.id]) && Number.isSafeInteger(assignments[session.id].issueNumber) ? assignments[session.id] : null;
    const gate = account && isPlain(account.gate) && typeof account.gate.action === 'string' ? account.gate.action : null;
    const details = shownAgent ? lines(shownAgent.tooltip).filter((entry) => !/^Fields marked unknown/.test(entry)) : [];
    // The one line on the card itself about the working folder: what Git says right now, or that it does not know.
    const worktree = details.find((entry) => /^Git(?: |:)/.test(entry)) ?? null;
    cards.push({
      id: session.id,
      name: line(session.name, 'Session'),
      role,
      roleName: line(roleInfo && roleInfo.name, role ? role : session.roleGroupId === 'unassigned' || !session.roleGroupId ? 'no role group' : UNKNOWN),
      provider: line(session.providerLabel ?? session.provider),
      account: account ? line(account.label, 'Account') : (session.accountProfileId && session.accountProfileId !== 'unassigned' ? 'profile missing' : 'CLI default sign-in'),
      model: line(session.requestedModel, 'CLI default'),
      modelNote: 'requested, not confirmed',
      status,
      terminalOpen: session.terminalOpen === true,
      task: {
        issue,
        pullRequest,
        text: issue !== null || pullRequest !== null ? [issue !== null ? `Issue #${issue}` : null, pullRequest !== null ? `PR #${pullRequest}` : null].filter(Boolean).join(' · ') : 'no task is known (no branch or pull request is linked)'
      },
      assigned: handed ? `Issue #${handed.issueNumber} was typed into this terminal${typeof handed.at === 'string' && Number.isFinite(Date.parse(handed.at)) ? ` at ${new Date(handed.at).toISOString()}` : ''} (not proof the agent read it)` : null,
      summary: shownAgent ? line(shownAgent.description, UNKNOWN, 200) : UNKNOWN,
      details,
      worktree: worktree ? worktree.replace(/^Git(?: \([^)]*\))?:\s*/, '') : 'unknown (no Git reading for this session)',
      report: { lines: reportLines(pullRequest, pullRequest !== null && isPlain(reports) && Object.hasOwn(reports, String(pullRequest)) ? reports[String(pullRequest)] : undefined) },
      quota: account ? { lines: lines(account.usage).slice(0, 2), policy: line(account.policy, '', 160), gate } : { lines: [], policy: '', gate: null },
      autoMode: line(session.autoModeLabel, '', 140) || null,
      alert: gate === 'block' ? 'quota: new agents on this account are held back' : gate === 'confirm' ? 'quota: needs confirmation' : gate === 'warn' ? 'quota: near the limit' : null
    });
  }
  return {
    pm: cards.filter((card) => isPm(card.role)),
    agents: cards.filter((card) => !isPm(card.role)),
    accounts: (Array.isArray(accounts) ? accounts : []).filter((entry) => isPlain(entry) && typeof entry.id === 'string').slice(0, 50).map((entry) => ({ id: entry.id, label: line(entry.label, 'Account'), provider: line(entry.provider), lines: lines(entry.usage).slice(0, 3), gate: isPlain(entry.gate) && typeof entry.gate.action === 'string' ? entry.gate.action : null })),
    counts: { agents: cards.length, pm: cards.filter((card) => isPm(card.role)).length }
  };
}

/** The decisions waiting for the person, from what the report views have already read; unknown until they have. */
function describeDecisions(counts) {
  const read = (entry, noun) => (isPlain(entry) && Number.isSafeInteger(entry.count) && entry.count >= 0 && typeof entry.at === 'string'
    ? { known: true, count: entry.count, text: `${entry.count} ${noun} need a decision or more evidence (read ${line(entry.at, '', 40)})` }
    : { known: false, count: null, text: `${noun}: unknown (open the report list to load it)` });
  const source = isPlain(counts) ? counts : {};
  return { issues: read(source.issue, 'issues'), pullRequests: read(source.pullRequest, 'pull requests') };
}

// ---- layout the person arranges, kept in the workspace state ----

const LAYOUTS = Object.freeze(['grid', 'list']);
const MAX_IDS = 200;
const idList = (value) => {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  for (const entry of value.slice(0, MAX_IDS)) if (typeof entry === 'string' && ID.test(entry) && !seen.has(entry)) seen.add(entry);
  return [...seen];
};

/** Whatever was stored (or sent) becomes a valid layout: a mode, an order, and the collapsed and pinned ids. Never throws. */
function normalizeLayout(raw) {
  const source = isPlain(raw) ? raw : {};
  return { mode: LAYOUTS.includes(source.mode) ? source.mode : 'grid', order: idList(source.order), collapsed: idList(source.collapsed), pinned: idList(source.pinned) };
}

/** Pinned cards first, then the person's own order, then the rest by name; an id in the layout that no longer exists is ignored. */
function arrange(cards, layout) {
  const lay = normalizeLayout(layout);
  const rank = new Map(lay.order.map((id, index) => [id, index]));
  const pinned = new Set(lay.pinned);
  return [...cards].sort((a, b) => {
    const pa = pinned.has(a.id) ? 0 : 1;
    const pb = pinned.has(b.id) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const ra = rank.has(a.id) ? rank.get(a.id) : Number.MAX_SAFE_INTEGER;
    const rb = rank.has(b.id) ? rank.get(b.id) : Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1;
  }).map((card) => ({ ...card, pinned: pinned.has(card.id), collapsed: lay.collapsed.includes(card.id) }));
}

function toggled(list, id) {
  return list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id];
}

// ---- the only messages the page may send ----

const COMMANDS = Object.freeze(['ready', 'refresh', 'setLayout', 'reorder', 'toggleCollapse', 'togglePin', 'focus', 'openReport', 'openPullRequest', 'openReports', 'assignIssue', 'sendTask']);
const SHAPES = Object.freeze({
  ready: [], refresh: [], setLayout: ['mode'], reorder: ['order'], toggleCollapse: ['id'], togglePin: ['id'], focus: ['id'], openReport: ['id'], openPullRequest: ['id'], openReports: ['kind'], assignIssue: [], sendTask: []
});

/**
 * Checks a message from the page: a known command, exactly its fields, of the right type. An id must be one of the cards on
 * screen. Anything else (an unknown command, an extra field, a wrong type, a long list) is refused, never partly obeyed.
 * @returns {{ ok: true, message: object } | { ok: false, reason: string }}
 */
function parseMessage(raw, knownIds) {
  if (!isPlain(raw) || typeof raw.type !== 'string' || !COMMANDS.includes(raw.type)) return { ok: false, reason: 'unknown-command' };
  const allowed = SHAPES[raw.type];
  const extra = Object.keys(raw).filter((key) => key !== 'type' && !allowed.includes(key));
  if (extra.length > 0) return { ok: false, reason: 'unexpected-field' };
  const known = knownIds instanceof Set ? knownIds : new Set(Array.isArray(knownIds) ? knownIds : []);
  const message = { type: raw.type };
  for (const key of allowed) {
    const value = raw[key];
    if (key === 'id') {
      if (typeof value !== 'string' || !ID.test(value) || !known.has(value)) return { ok: false, reason: 'unknown-id' };
    } else if (key === 'mode') {
      if (!LAYOUTS.includes(value)) return { ok: false, reason: 'invalid-field' };
    } else if (key === 'kind') {
      if (value !== 'issue' && value !== 'pullRequest') return { ok: false, reason: 'invalid-field' };
    } else if (key === 'order') {
      if (!Array.isArray(value) || value.length > MAX_IDS || !value.every((entry) => typeof entry === 'string' && ID.test(entry) && known.has(entry)) || new Set(value).size !== value.length) return { ok: false, reason: 'invalid-field' };
    }
    message[key] = value;
  }
  return { ok: true, message };
}

/** The layout after a valid message, or the same layout when the message does not change it. */
function applyLayoutMessage(layout, message) {
  const lay = normalizeLayout(layout);
  if (message.type === 'setLayout') return { ...lay, mode: message.mode };
  if (message.type === 'reorder') return { ...lay, order: idList(message.order) };
  if (message.type === 'toggleCollapse') return { ...lay, collapsed: toggled(lay.collapsed, message.id) };
  if (message.type === 'togglePin') return { ...lay, pinned: toggled(lay.pinned, message.id) };
  return lay;
}

module.exports = { buildCards, describeDecisions, normalizeLayout, arrange, parseMessage, applyLayoutMessage, statusOf, COMMANDS, LAYOUTS, MAX_CARDS, MAX_IDS, STATES };
