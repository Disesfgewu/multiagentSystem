'use strict';

/**
 * The Command Center's data, as plain values (issue #309): one fixed PM panel and a card for every other agent. Pure: no vscode, no
 * file, no network. Everything comes from what the existing services already worked out (the overview's presented agents and
 * accounts, the session list, the role groups); a value without a source is "unknown", never a guess and never a made-up number.
 * Text that came from outside (a session name, a label, a report line) is shown as one short clean line and is only ever rendered
 * as text by the page, never as HTML.
 */

const { describePermissionMode } = require('../observations/permissionMode');

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
/** An e-mail address the CLI reported, only when it is a plain address on one line; anything else is not shown (#357). */
const plainEmail = (value) => (typeof value === 'string' && /^[^\s@]{1,64}@[^\s@]{1,190}$/.test(value) ? value : null);

/** "Auto", "Ask", "Dangerous" or "unknown", from the label the session layer wrote (#357 cards). */
function modeWord(label) {
  if (typeof label !== 'string') return 'unknown';
  if (/^Dangerous mode: on/.test(label)) return 'Dangerous';
  // "Auto mode: on requested, but … none was passed (unknown)" is not auto mode: only "on (" is.
  if (/^Auto mode: on \(/.test(label)) return 'Auto';
  if (/^Auto mode: off/.test(label)) return 'Ask';
  return 'unknown';
}

function buildCards(input) {
  const { sessions, agents = [], accounts = [], roles = {}, reports = {}, assignments = {}, emails = {} } = isPlain(input) ? input : {};
  // The e-mail address of each account from this window's last sign-in check (#357): shown on the card only, never stored.
  const emailOf = (id) => (isPlain(emails) && typeof id === 'string' && Object.hasOwn(emails, id) ? plainEmail(emails[id]) : null);
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
      // The agent's codename (issue #342), what it signs GitHub posts with; only a well-formed one is shown.
      codename: parseCodename(session.codename) ? session.codename : null,
      role,
      roleName: line(roleInfo && roleInfo.name, role ? role : session.roleGroupId === 'unassigned' || !session.roleGroupId ? 'no role group' : UNKNOWN),
      provider: line(session.providerLabel ?? session.provider),
      account: account ? `${line(account.label, 'Account')}${emailOf(session.accountProfileId) ? ` (${emailOf(session.accountProfileId)})` : ''}` : (session.accountProfileId && session.accountProfileId !== 'unassigned' ? 'profile missing' : 'CLI default sign-in'),
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
      // The mode in one word for the card (#357): the full label stays in its details.
      mode: modeWord(session.autoModeLabel),
      // The mode the CLI itself reports, against the one asked for (#362): an agent that fell back to asking is an alert.
      permission: (() => { const mode = describePermissionMode({ provider: session.provider, requested: session.requestedAutoMode ?? null, reported: session.reportedPermissionMode ?? null }); return mode ? { text: line(mode.text, '', 200), attention: mode.attention, lines: mode.lines.map((entry) => line(entry, '', 300)) } : null; })(),
      // Whether its Claude Code was given this window's port (#354); shown as the extension worded it, only for sessions that have one.
      ide: line(session.ideLabel, '', 260) || null,
      trust: line(session.trustLabel, '', 260) || null,
      injected: isPlain(session.injectedCounts) && Number.isSafeInteger(session.injectedCounts.rules) && Number.isSafeInteger(session.injectedCounts.memories) && session.injectedCounts.rules >= 0 && session.injectedCounts.memories >= 0
        ? `Prepared for this agent: ${session.injectedCounts.rules} rule${session.injectedCounts.rules === 1 ? '' : 's'} and ${session.injectedCounts.memories} shared note${session.injectedCounts.memories === 1 ? '' : 's'} (the CLI is told; not proof it read them)`
        : 'Rules and notes given to this agent: unknown (not started in this window)',
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

// ---- accounts and their quota (issue #304) ----

const { UNKNOWN_REASONS } = require('../accounts/quota-gate');
const { parseCodename } = require('../sessions/codenames');
const WINDOW_LABELS = Object.freeze({ five_hour: '5-hour', seven_day: 'Weekly', seven_day_opus: 'Weekly (Opus)', seven_day_sonnet: 'Weekly (Sonnet)' });
const ACCOUNT_ACTIONS = Object.freeze(['create', 'login', 'check', 'limits', 'usageLog', 'configureStatusLine', 'details']);
// What a person can do about a missing reading, where there is something to click. Codes not listed have only the explanation.
const NEXT_STEP = Object.freeze({
  'bridge-not-enabled': { action: 'configureStatusLine', label: 'Enable the Claude status line bridge' },
  'bridge-other-statusline': { action: 'configureStatusLine', label: 'Review the status line setting' },
  'bridge-state-unknown': { action: 'configureStatusLine', label: 'Review the status line setting' },
  'file-unreadable': { action: 'details', label: 'Open the account details' },
  'codex-format-changed': { action: 'details', label: 'Open the account details' },
  'timestamp-future': { action: 'details', label: 'Open the account details' },
  'timestamp-invalid': { action: 'details', label: 'Open the account details' }
});
const NEXT_HINT = Object.freeze({
  'bridge-no-data': 'Readings arrive only while a Claude session runs on this account: start one.',
  'codex-no-sessions': 'Run Codex once with this account; its session log is what is read.',
  'codex-no-events': 'Run Codex once more with this account; no usage has been logged yet.',
  'reading-expired': 'Run the CLI again with this account to refresh the reading.',
  'codex-reading-expired': 'Run Codex again with this account to refresh the reading.'
});
const GATE_TEXT = Object.freeze({ block: 'new agents on this account are held back', confirm: 'a new agent on this account needs confirmation', warn: 'this account is near its limit' });

/** "in 2h 5m" / "5m ago" for a time and now, or null when the time is not a time. */
function relative(iso, nowMs) {
  const at = typeof iso === 'string' ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at) || !Number.isFinite(nowMs)) return null;
  const diff = at - nowMs;
  const total = Math.floor(Math.abs(diff) / 60000);
  const text = total < 1 ? 'under a minute' : total < 60 ? `${total}m` : total < 1440 ? `${Math.floor(total / 60)}h${total % 60 ? ` ${total % 60}m` : ''}` : `${Math.floor(total / 1440)}d${Math.floor((total % 1440) / 60) ? ` ${Math.floor((total % 1440) / 60)}h` : ''}`;
  return diff >= 0 ? `in ${text}` : `${text} ago`;
}

function windowRow(entry, nowMs) {
  const confidence = entry && (entry.confidence === 'actual' || entry.confidence === 'estimated') && Number.isFinite(entry.usedPercent) ? entry.confidence : 'unknown';
  const trust = confidence === 'unknown' ? 'unknown' : entry.gateEligible ? 'verified and current' : entry.fresh && confidence === 'estimated' ? 'estimate (not used to block)' : entry.fresh ? 'source unverified (not used to block)' : 'out of date (not used to block)';
  const resetsIn = relative(entry && entry.resetsAt, nowMs);
  return {
    window: line(entry && entry.window, UNKNOWN, 40),
    label: Object.hasOwn(WINDOW_LABELS, entry && entry.window) ? WINDOW_LABELS[entry.window] : line(entry && entry.window, 'Window', 40),
    usedPercent: confidence === 'unknown' ? null : entry.usedPercent,
    text: confidence === 'unknown' ? 'unknown' : `${entry.usedPercent}% used`,
    kind: confidence,
    trust,
    resets: resetsIn === null ? 'reset time unknown' : resetsIn.startsWith('in ') ? `resets ${resetsIn}` : 'reset time has passed',
    resetsAt: typeof (entry && entry.resetsAt) === 'string' && Number.isFinite(Date.parse(entry.resetsAt)) ? new Date(entry.resetsAt).toISOString() : null,
    read: relative(entry && entry.observedAt, nowMs) === null ? 'read time unknown' : `read ${relative(entry.observedAt, nowMs)}`,
    source: line(entry && entry.source, 'unknown source', 60)
  };
}

/**
 * One row per account for the Command Center. `accounts` are the profiles with what the sign-in checks said (`health`, `identity`,
 * `issues`, `label`, `provider`); `details` the quota detail of each by id (`quotaDetail`); `sessions` the running agents.
 * Everything unread is unknown, with why, and a next step the person can click when there is one.
 * @returns {{ rows: object[], alerts: string[] }}
 */
function buildAccountRows(input) {
  const { accounts, details, sessions, now } = isPlain(input) ? input : {};
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  const list = Array.isArray(accounts) ? accounts.filter((entry) => isPlain(entry) && typeof entry.id === 'string' && ID.test(entry.id)).slice(0, 50) : [];
  const byId = isPlain(details) ? details : {};
  const live = Array.isArray(sessions) ? sessions.filter((entry) => isPlain(entry) && typeof entry.id === 'string') : [];
  const alerts = [];
  const rows = list.map((account) => {
    const detail = Object.hasOwn(byId, account.id) && isPlain(byId[account.id]) ? byId[account.id] : null;
    const windows = detail && Array.isArray(detail.windows) ? detail.windows.filter(isPlain).slice(0, 6).map((entry) => windowRow(entry, nowMs)) : [];
    const reasonCode = detail && typeof detail.unknownReason === 'string' ? detail.unknownReason : null;
    const reason = reasonCode && Object.hasOwn(UNKNOWN_REASONS, reasonCode) ? UNKNOWN_REASONS[reasonCode] : null;
    const showReason = reason !== null && windows.every((entry) => entry.kind === 'unknown' || entry.trust.startsWith('out of date'));
    const next = showReason && Object.hasOwn(NEXT_STEP, reasonCode) ? { ...NEXT_STEP[reasonCode] } : null;
    const gate = detail && typeof detail.gate === 'string' && Object.hasOwn(GATE_TEXT, detail.gate) ? detail.gate : null;
    const identity = isPlain(account.identity) && account.identity.state === 'verified' ? `identity verified (${line(account.identity.fingerprint, '', 12)})` : `identity unknown${isPlain(account.identity) && account.identity.reason ? ` (${line(account.identity.reason, '', 60)})` : ''}`;
    const assigned = live.filter((entry) => entry.accountProfileId === account.id);
    if (gate) alerts.push(`${line(account.label, 'Account')}: ${GATE_TEXT[gate]}`);
    return {
      id: account.id,
      label: line(account.label, 'Account'),
      // Which real account it is (#352, #357): the e-mail address from this window's last sign-in check, memory only.
      email: plainEmail(account.email),
      provider: line(account.provider),
      signIn: account.health === 'ready' ? 'sign-in checked' : account.health === 'attention' ? 'sign-in needs attention' : 'sign-in not checked in this window',
      identity,
      issues: lines(account.issues, 160).slice(0, 3),
      plan: detail && typeof detail.plan === 'string' ? line(detail.plan, '', 32) || null : null,
      windows,
      usageKnown: windows.some((entry) => entry.kind !== 'unknown'),
      reason: showReason ? { short: line(reason.short, '', 120), detail: line(reason.detail, '', 400), hint: Object.hasOwn(NEXT_HINT, reasonCode) ? NEXT_HINT[reasonCode] : null, next } : (detail === null || detail.ok === false) && windows.length === 0 ? { short: 'usage could not be read', detail: 'The usage readings of this account could not be read, so nothing is shown. This is not zero.', hint: null, next: { action: 'details', label: 'Open the account details' } } : null,
      policy: detail ? line(detail.policy, 'Limits: could not be read.', 200) : 'Limits: could not be read.',
      gate,
      alert: gate ? GATE_TEXT[gate] : null,
      agents: assigned.slice(0, 6).map((entry) => line(entry.name, 'Session', 60)),
      agentCount: assigned.length
    };
  });
  return { rows, alerts };
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

/**
 * The Workbench tabs (#357) and what their next-step buttons open: a fixed name, never a command id the page chose. Each opens an
 * existing command with NO argument, so the command's own windows ask the person (which CLI, which account, what text, and the
 * confirmation); nothing here starts, stops, sends or publishes by itself.
 */
const TABS = Object.freeze(['agents', 'work', 'accounts', 'broadcast', 'ask', 'knowledge', 'setup']);
const TARGETS = Object.freeze({
  startAgent: 'multiagentSystem.launchAgent',
  sessions: 'multiagentSystem.sessions.list',
  createRole: 'multiagentSystem.roles.create',
  browseGitHub: 'multiagentSystem.github.browse',
  broadcastCreate: 'multiagentSystem.broadcasts.send',
  broadcastDeliver: 'multiagentSystem.broadcasts.deliver',
  discussWithPm: 'multiagentSystem.discuss.withPm',
  memoryAdd: 'multiagentSystem.memory.add',
  memoryReview: 'multiagentSystem.memory.review',
  skillsInstall: 'multiagentSystem.skills.install',
  setupRefresh: 'multiagentSystem.setup.refresh',
  setupDiagnose: 'multiagentSystem.setup.diagnose'
});

const COMMANDS = Object.freeze(['ready', 'refresh', 'setLayout', 'reorder', 'toggleCollapse', 'togglePin', 'focus', 'openReport', 'openPullRequest', 'openReports', 'startMeeting', 'accountAction', 'exportReport', 'editTeamRules', 'assignIssue', 'sendTask', 'talkToPm', 'open', 'showClassicViews']);
const SHAPES = Object.freeze({
  ready: [], refresh: [], setLayout: ['mode'], reorder: ['order'], toggleCollapse: ['id'], togglePin: ['id'], focus: ['id'], openReport: ['id'], openPullRequest: ['id'], openReports: ['kind'], accountAction: ['action', 'id'], exportReport: [], editTeamRules: [], assignIssue: [], sendTask: [], startMeeting: [], talkToPm: [], open: ['target'], showClassicViews: []
});

/**
 * Checks a message from the page: a known command, exactly its fields, of the right type. An id must be one of the cards on
 * screen. Anything else (an unknown command, an extra field, a wrong type, a long list) is refused, never partly obeyed.
 * @returns {{ ok: true, message: object } | { ok: false, reason: string }}
 */
function parseMessage(raw, knownIds, accountIds) {
  if (!isPlain(raw) || typeof raw.type !== 'string' || !COMMANDS.includes(raw.type)) return { ok: false, reason: 'unknown-command' };
  const allowed = SHAPES[raw.type];
  const extra = Object.keys(raw).filter((key) => key !== 'type' && !allowed.includes(key));
  if (extra.length > 0) return { ok: false, reason: 'unexpected-field' };
  const known = knownIds instanceof Set ? knownIds : new Set(Array.isArray(knownIds) ? knownIds : []);
  const accounts = accountIds instanceof Set ? accountIds : new Set(Array.isArray(accountIds) ? accountIds : []);
  const message = { type: raw.type };
  if (raw.type === 'accountAction') {
    // Creating an account names no account; every other action names one that is on the screen.
    if (typeof raw.action !== 'string' || !ACCOUNT_ACTIONS.includes(raw.action)) return { ok: false, reason: 'invalid-field' };
    message.action = raw.action;
    if (raw.action === 'create') return raw.id === undefined ? { ok: true, message } : { ok: false, reason: 'unexpected-field' };
    if (typeof raw.id !== 'string' || !ID.test(raw.id) || !accounts.has(raw.id)) return { ok: false, reason: 'unknown-id' };
    message.id = raw.id;
    return { ok: true, message };
  }
  for (const key of allowed) {
    const value = raw[key];
    if (key === 'id') {
      if (typeof value !== 'string' || !ID.test(value) || !known.has(value)) return { ok: false, reason: 'unknown-id' };
    } else if (key === 'mode') {
      if (!LAYOUTS.includes(value)) return { ok: false, reason: 'invalid-field' };
    } else if (key === 'target') {
      if (typeof value !== 'string' || !Object.hasOwn(TARGETS, value)) return { ok: false, reason: 'invalid-field' };
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

module.exports = { modeWord, buildCards, buildAccountRows, relative, ACCOUNT_ACTIONS, describeDecisions, normalizeLayout, arrange, parseMessage, applyLayoutMessage, statusOf, COMMANDS, LAYOUTS, MAX_CARDS, MAX_IDS, STATES, TABS, TARGETS };
