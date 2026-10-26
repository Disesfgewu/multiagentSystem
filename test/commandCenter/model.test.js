'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCards, buildAccountRows, relative, ACCOUNT_ACTIONS, describeDecisions, normalizeLayout, arrange, parseMessage, applyLayoutMessage, statusOf, COMMANDS, MAX_IDS } = require('../../src/commandCenter/model');

const hook = (state, since = '2026-10-22T08:00:00.000Z') => ({ state, reason: 'last-hook-event', since });
const session = (over = {}) => ({ id: 'worker-1', name: 'Worker One', provider: 'claude', providerLabel: 'Claude Code', roleGroupId: 'g-worker', accountProfileId: 'acct-1', requestedModel: 'sonnet', terminalOpen: true, state: 'cli-observed', deliveryState: hook('working'), autoModeLabel: 'Auto mode: on (synthetic)', ...over });
const agent = (over = {}) => ({ id: 'worker-1', label: 'Worker One', description: 'Worker · Claude Code · Main · CLI observed · PR #7', tooltip: ['Role: Worker', 'Branch: feat/x', 'Pull request: #7', 'CI: passing', 'Fields marked unknown have no verified source yet.'], terminalOpen: true, pullRequestUrl: 'https://github.com/o/r/pull/7', pullRequestNumber: 7, issueNumber: 12, ...over });
const account = (over = {}) => ({ id: 'acct-1', label: 'Main', provider: 'Claude Code', policy: 'Limits: warn at 80% used.', usage: ['Usage (five_hour): 42% used, verified and current.', 'Usage (seven_day): 10% used.', 'extra'], gate: { action: 'warn' }, ...over });
const roles = { 'g-pm': { name: 'PM', role: 'pm' }, 'g-worker': { name: 'Worker', role: 'worker' } };
const build = (sessions, extra = {}) => buildCards({ sessions, agents: [agent()], accounts: [account()], roles, ...extra });

test('a card carries what the services know and calls everything else unknown, with where the state came from', () => {
  const { agents, pm } = build([session()]);
  assert.equal(pm.length, 0);
  const [card] = agents;
  assert.equal(card.name, 'Worker One');
  assert.equal(card.roleName, 'Worker');
  assert.equal(card.provider, 'Claude Code');
  assert.equal(card.account, 'Main');
  assert.deepEqual([card.model, card.modelNote], ['sonnet', 'requested, not confirmed']);
  assert.deepEqual(card.status, { state: 'working', text: 'working', source: "from the CLI's own hooks, last event 2026-10-22T08:00:00.000Z" });
  assert.deepEqual([card.task.issue, card.task.pullRequest, card.task.text], [12, 7, 'Issue #12 · PR #7']);
  assert.deepEqual(card.quota.lines, ['Usage (five_hour): 42% used, verified and current.', 'Usage (seven_day): 10% used.'], 'two usage lines at most');
  assert.equal(card.alert, 'quota: near the limit');
  assert.equal(card.autoMode, 'Auto mode: on (synthetic)');
  assert.ok(card.details.includes('Branch: feat/x'));
  assert.ok(!card.details.some((entry) => /^Fields marked unknown/.test(entry)));
});

test('a terminal that exists is not "working": without hook evidence the state is unknown, with the reason', () => {
  for (const deliveryState of [undefined, null, { state: 'unknown', reason: 'no-hook-bridge', since: null }, { state: 'bogus' }, 'working', 5]) {
    const status = statusOf(session({ deliveryState }));
    assert.equal(status.state, 'unknown', JSON.stringify(deliveryState));
    assert.equal(status.text, 'not reported yet');
  }
  assert.match(statusOf(session({ deliveryState: { state: 'unknown', reason: 'no-hook-bridge', since: null } })).source, /no hook evidence \(no-hook-bridge\)/);
  for (const state of ['waiting', 'ended']) assert.equal(statusOf(session({ deliveryState: hook(state) })).state, state);
});

test('a session with no known task, role, account or model says so instead of inventing one', () => {
  const { agents } = buildCards({ sessions: [session({ id: 'x-1', roleGroupId: 'unassigned', accountProfileId: 'unassigned', requestedModel: null, autoModeLabel: undefined })], agents: [], accounts: [], roles: {} });
  const [card] = agents;
  assert.deepEqual([card.roleName, card.account, card.model], ['no role group', 'CLI default sign-in', 'CLI default']);
  assert.equal(card.task.text, 'no task is known (no branch or pull request is linked)');
  assert.equal(card.autoMode, null);
  assert.deepEqual(card.quota, { lines: [], policy: '', gate: null });
  assert.equal(card.alert, null);
  const missing = buildCards({ sessions: [session({ accountProfileId: 'gone' })], agents: [], accounts: [], roles: {} }).agents[0];
  assert.equal(missing.account, 'profile missing');
  assert.equal(buildCards({ sessions: [session({ roleGroupId: 'ghost' })], roles: {} }).agents[0].roleName, 'unknown');
});

test('PM sessions go to the PM panel, everyone else to the cards; a quota hold or confirmation is an alert', () => {
  const sessions = [session({ id: 'pm-1', name: 'PM Agent', roleGroupId: 'g-pm' }), session({ id: 'worker-1' }), session({ id: 'r-1', roleGroupId: 'unassigned' })];
  const built = buildCards({ sessions, agents: [], accounts: [account({ gate: { action: 'block' } })], roles });
  assert.deepEqual(built.pm.map((card) => card.id), ['pm-1']);
  assert.deepEqual(built.agents.map((card) => card.id), ['worker-1', 'r-1']);
  assert.equal(built.agents[0].alert, 'quota: new agents on this account are held back');
  assert.deepEqual(built.counts, { agents: 3, pm: 1 });
  assert.equal(buildCards({ sessions: [session()], accounts: [account({ gate: { action: 'confirm' } })], roles }).agents[0].alert, 'quota: needs confirmation');
  assert.equal(buildCards({ sessions: [session()], accounts: [account({ gate: { action: 'allow' } })], roles }).agents[0].alert, null);
});

test('text from outside is one clean short line; ids that could break the page and malformed entries are dropped', () => {
  const nasty = '<img src=x onerror=alert(1)>‮evil​\nline2 ' + 'x'.repeat(500);
  const { agents } = buildCards({ sessions: [session({ name: nasty }), session({ id: 'bad id<script>' }), session({ id: '' }), null, 5, {}], agents: [agent({ description: nasty, tooltip: [nasty] })], accounts: [account({ label: nasty })], roles });
  assert.equal(agents.length, 1, 'only the session with a safe id is kept');
  assert.ok(agents[0].name.length <= 120);
  assert.equal(/[‮​\n]/.test(JSON.stringify(agents)), false);
  assert.ok(agents[0].summary.length <= 200);
});

test('there is never more than a bounded number of cards, and bad inputs give empty results rather than errors', () => {
  const many = Array.from({ length: 500 }, (_, index) => session({ id: `s-${index}` }));
  assert.equal(buildCards({ sessions: many }).agents.length, 200);
  for (const bad of [undefined, null, {}, { sessions: 'x' }, { sessions: null, agents: 5, accounts: 'y', roles: 7 }]) assert.deepEqual(buildCards(bad).counts, { agents: 0, pm: 0 });
});

test('decisions waiting are shown only when a report list was read completely, and say unknown otherwise', () => {
  const known = describeDecisions({ issue: { count: 3, at: '2026-10-22T08:00:00.000Z' }, pullRequest: { count: 0, at: '2026-10-22T08:00:00.000Z' } });
  assert.deepEqual([known.issues.known, known.issues.count], [true, 3]);
  assert.match(known.issues.text, /3 issues need a decision or more evidence \(read 2026-10-22T08:00:00\.000Z\)/);
  assert.equal(known.pullRequests.count, 0);
  const unknown = describeDecisions({ issue: null, pullRequest: { count: -1, at: 'x' } });
  assert.deepEqual([unknown.issues.known, unknown.pullRequests.known], [false, false]);
  assert.match(unknown.issues.text, /unknown \(open the report list to load it\)/);
  for (const bad of [undefined, null, 'x', 5]) assert.equal(describeDecisions(bad).issues.known, false);
});

test('a stored or sent layout always becomes a valid one: unknown modes, bad ids, duplicates and long lists are cleaned', () => {
  assert.deepEqual(normalizeLayout(undefined), { mode: 'grid', order: [], collapsed: [], pinned: [] });
  assert.deepEqual(normalizeLayout({ mode: 'tiles', order: ['a', 'a', 'b c', 5, '<x>', 'd'], collapsed: 'x', pinned: ['p'] }), { mode: 'grid', order: ['a', 'd'], collapsed: [], pinned: ['p'] });
  assert.equal(normalizeLayout({ order: Array.from({ length: 1000 }, (_, index) => `i${index}`) }).order.length, MAX_IDS);
  for (const bad of [null, 'x', 5, []]) assert.deepEqual(normalizeLayout(bad), { mode: 'grid', order: [], collapsed: [], pinned: [] });
});

test('cards are arranged: pinned first, then the person\'s order, then by name; ids that no longer exist are ignored', () => {
  const cards = ['d', 'c', 'b', 'a'].map((id) => ({ id, name: `Name ${id}` }));
  assert.deepEqual(arrange(cards, {}).map((card) => card.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(arrange(cards, { order: ['c', 'gone', 'a'] }).map((card) => card.id), ['c', 'a', 'b', 'd']);
  assert.deepEqual(arrange(cards, { order: ['c', 'a'], pinned: ['d', 'b'], collapsed: ['b'] }).map((card) => [card.id, card.pinned, card.collapsed]), [['b', true, true], ['d', true, false], ['c', false, false], ['a', false, false]]);
});

test('layout messages change only the layout: mode, order, collapse and pin toggles', () => {
  let layout = normalizeLayout({});
  layout = applyLayoutMessage(layout, { type: 'setLayout', mode: 'list' });
  layout = applyLayoutMessage(layout, { type: 'reorder', order: ['b', 'a'] });
  layout = applyLayoutMessage(layout, { type: 'toggleCollapse', id: 'a' });
  layout = applyLayoutMessage(layout, { type: 'togglePin', id: 'b' });
  assert.deepEqual(layout, { mode: 'list', order: ['b', 'a'], collapsed: ['a'], pinned: ['b'] });
  layout = applyLayoutMessage(layout, { type: 'toggleCollapse', id: 'a' });
  layout = applyLayoutMessage(layout, { type: 'togglePin', id: 'b' });
  assert.deepEqual([layout.collapsed, layout.pinned], [[], []], 'a second toggle undoes the first');
  assert.deepEqual(applyLayoutMessage(layout, { type: 'focus', id: 'a' }), layout, 'other messages leave the layout alone');
});

test('only the known commands with exactly their fields are accepted, and an id must be a card on screen', () => {
  const known = new Set(['a', 'b']);
  const ok = (message) => parseMessage(message, known);
  for (const message of [{ type: 'ready' }, { type: 'refresh' }, { type: 'setLayout', mode: 'list' }, { type: 'reorder', order: ['b', 'a'] }, { type: 'toggleCollapse', id: 'a' }, { type: 'togglePin', id: 'b' }, { type: 'focus', id: 'a' }, { type: 'openReport', id: 'a' }, { type: 'openPullRequest', id: 'a' }, { type: 'openReports', kind: 'issue' }, { type: 'openReports', kind: 'pullRequest' }, { type: 'exportReport' }, { type: 'editTeamRules' }, { type: 'assignIssue' }, { type: 'sendTask' }, { type: 'startMeeting' }]) {
    assert.deepEqual(ok(message), { ok: true, message }, JSON.stringify(message));
  }
  const refused = [
    [{ type: 'delete' }, 'unknown-command'], [{ type: 'stop', id: 'a' }, 'unknown-command'], [{ type: 'executeCommand', command: 'x' }, 'unknown-command'], [{}, 'unknown-command'], [null, 'unknown-command'], ['focus', 'unknown-command'], [[], 'unknown-command'], [{ type: 5 }, 'unknown-command'], [{ type: '__proto__' }, 'unknown-command'],
    [{ type: 'focus', id: 'a', extra: 1 }, 'unexpected-field'], [{ type: 'ready', id: 'a' }, 'unexpected-field'], [{ type: 'focus', id: 'a', command: 'multiagentSystem.sessions.stop' }, 'unexpected-field'],
    [{ type: 'focus', id: 'zzz' }, 'unknown-id'], [{ type: 'focus' }, 'unknown-id'], [{ type: 'focus', id: 5 }, 'unknown-id'], [{ type: 'focus', id: '../a' }, 'unknown-id'], [{ type: 'togglePin', id: 'constructor' }, 'unknown-id'],
    [{ type: 'setLayout', mode: 'tiles' }, 'invalid-field'], [{ type: 'setLayout' }, 'invalid-field'], [{ type: 'reorder', order: 'a' }, 'invalid-field'], [{ type: 'reorder', order: ['a', 'a'] }, 'invalid-field'], [{ type: 'reorder', order: ['a', 'x'] }, 'invalid-field'], [{ type: 'reorder', order: Array(201).fill('a') }, 'invalid-field'], [{ type: 'openReports', kind: 'repo' }, 'invalid-field'], [{ type: 'exportReport', path: '/tmp/x.md' }, 'unexpected-field'], [{ type: 'exportReport', text: 'x' }, 'unexpected-field'],
    [{ type: 'editTeamRules', text: 'be nice' }, 'unexpected-field'], [{ type: 'editTeamRules', rules: [] }, 'unexpected-field'],
    [{ type: 'assignIssue', issue: 5 }, 'unexpected-field'], [{ type: 'sendTask', text: 'do it' }, 'unexpected-field'], [{ type: 'sendTask', id: 'a' }, 'unexpected-field'], [{ type: 'startMeeting', topic: 'x' }, 'unexpected-field'], [{ type: 'startMeeting', ids: ['a'] }, 'unexpected-field']
  ];
  for (const [message, reason] of refused) assert.deepEqual(ok(message), { ok: false, reason }, JSON.stringify(message));
  assert.deepEqual(parseMessage({ type: 'focus', id: 'a' }, undefined), { ok: false, reason: 'unknown-id' }, 'with no cards on screen no id is known');
  assert.deepEqual(parseMessage({ type: 'focus', id: 'a' }, ['a']), { ok: true, message: { type: 'focus', id: 'a' } }, 'a list works as well as a set');
});

test('the command list is exactly what the page can send: it stops or restarts nothing by itself (switchAccount only opens the session command, which asks first); exportReport, assignIssue and sendTask only open the command\'s own windows and carry no path or text', () => {
  assert.deepEqual([...COMMANDS].sort(), ['accountAction', 'askContext', 'askSend', 'assignIssue', 'broadcastPreview', 'broadcastSend', 'editTeamRules', 'exportReport', 'focus', 'guideHide', 'guideShow', 'loadBoard', 'loadSetup', 'open', 'openPullRequest', 'openReport', 'openReports', 'openSetting', 'openWorkItem', 'ready', 'refresh', 'reorder', 'restartAgent', 'sayPreview', 'sayRun', 'sendTask', 'setLayout', 'showClassicViews', 'skillAction', 'startMeeting', 'stopAgent', 'switchAccount', 'talkToPm', 'toggleCollapse', 'togglePin']);
  // The board (#397): loadBoard carries nothing; openWorkItem names only an item the board showed, by kind and number.
  const items = new Set(['issue:12', 'pullRequest:7']);
  assert.deepEqual(parseMessage({ type: 'loadBoard' }, new Set(), new Set(), new Set(), items), { ok: true, message: { type: 'loadBoard' } });
  assert.deepEqual(parseMessage({ type: 'openWorkItem', kind: 'issue', number: 12 }, new Set(), new Set(), new Set(), items), { ok: true, message: { type: 'openWorkItem', kind: 'issue', number: 12 } });
  for (const [raw, reason] of [
    [{ type: 'openWorkItem', kind: 'issue', number: 7 }, 'unknown-item'], [{ type: 'openWorkItem', kind: 'pullRequest', number: 12 }, 'unknown-item'],
    [{ type: 'openWorkItem', kind: 'issue', number: '12' }, 'unknown-item'], [{ type: 'openWorkItem', kind: 'commit', number: 12 }, 'invalid-field'],
    [{ type: 'openWorkItem', kind: 'issue', number: 12, url: 'https://evil.test' }, 'unexpected-field'], [{ type: 'loadBoard', repository: 'x/y' }, 'unexpected-field']
  ]) assert.deepEqual(parseMessage(raw, new Set(), new Set(), new Set(), items), { ok: false, reason }, JSON.stringify(raw));
  assert.equal(parseMessage({ type: 'openWorkItem', kind: 'issue', number: 12 }, new Set(), new Set(), new Set()).ok, false, 'without a board, nothing can be opened');
  // The Broadcast tab (#357): the typed text and exactly one target on the screen, a role group or agents; nothing else.
  const cards = new Set(['s-1', 's-2']);
  const groups = new Set(['role-a']);
  const parse = (raw) => parseMessage(raw, cards, new Set(), new Set(), new Set(), groups);
  assert.deepEqual(parse({ type: 'broadcastPreview', text: 'Run the tests.', group: 'role-a' }), { ok: true, message: { type: 'broadcastPreview', text: 'Run the tests.', group: 'role-a' } });
  assert.deepEqual(parse({ type: 'broadcastSend', text: 'Run the tests.', ids: ['s-1', 's-2'] }), { ok: true, message: { type: 'broadcastSend', text: 'Run the tests.', ids: ['s-1', 's-2'] } });
  for (const [raw, reason] of [
    [{ type: 'broadcastSend', text: 'x', group: 'role-a', ids: ['s-1'] }, 'invalid-target'], [{ type: 'broadcastSend', text: 'x' }, 'invalid-target'],
    [{ type: 'broadcastSend', text: 'x', group: 'role-b' }, 'unknown-group'], [{ type: 'broadcastSend', text: 'x', ids: ['s-9'] }, 'unknown-id'],
    [{ type: 'broadcastSend', text: 'x', ids: [] }, 'unknown-id'], [{ type: 'broadcastSend', text: 'x', ids: ['s-1', 's-1'] }, 'unknown-id'],
    [{ type: 'broadcastSend', text: 'x'.repeat(1501), ids: ['s-1'] }, 'invalid-text'], [{ type: 'broadcastSend', text: 5, ids: ['s-1'] }, 'invalid-text'],
    [{ type: 'broadcastSend', text: 'x', ids: ['s-1'], confirm: false }, 'unexpected-field']
  ]) assert.deepEqual(parse(raw), { ok: false, reason }, JSON.stringify(raw));
  // stopAgent and restartAgent (#357) name a card on screen and nothing else; the session commands ask before anything stops.
  for (const type of ['stopAgent', 'restartAgent']) {
    assert.deepEqual(parseMessage({ type, id: 's-1' }, new Set(['s-1'])), { ok: true, message: { type, id: 's-1' } });
    assert.equal(parseMessage({ type, id: 's-9' }, new Set(['s-1'])).ok, false, `${type}: a card not on the screen`);
    assert.equal(parseMessage({ type, id: 's-1', force: true }, new Set(['s-1'])).ok, false, `${type}: nothing else`);
  }
  // sayPreview and sayRun (#357, #360 guideline 3) carry only the typed line; the extension works out what it means and to whom.
  for (const type of ['sayPreview', 'sayRun']) {
    assert.deepEqual(parseMessage({ type, text: 'Worker-01 fix it' }), { ok: true, message: { type, text: 'Worker-01 fix it' } });
    assert.equal(parseMessage({ type, text: 'x'.repeat(501) }).reason, 'invalid-text');
    assert.equal(parseMessage({ type, text: 7 }).reason, 'invalid-text');
    assert.equal(parseMessage({ type, text: 'q', ids: ['s-1'] }, new Set(['s-1'])).ok, false, 'no target from the page');
  }
  // guideHide and guideShow (#357) carry nothing.
  assert.deepEqual(parseMessage({ type: 'guideHide' }), { ok: true, message: { type: 'guideHide' } });
  assert.equal(parseMessage({ type: 'guideShow', step: 'review' }).ok, false);
  // askSend (#357) names an agent on the screen, the typed question and whether to include the selection; nothing else.
  assert.deepEqual(parseMessage({ type: 'askSend', id: 's-1', question: 'What does this do?', withSelection: true }, new Set(['s-1'])), { ok: true, message: { type: 'askSend', id: 's-1', question: 'What does this do?', withSelection: true } });
  for (const [raw, reason] of [
    [{ type: 'askSend', id: 's-9', question: 'q', withSelection: false }, 'unknown-id'], [{ type: 'askSend', id: 's-1', question: 5, withSelection: false }, 'invalid-text'],
    [{ type: 'askSend', id: 's-1', question: 'x'.repeat(2001), withSelection: false }, 'invalid-text'], [{ type: 'askSend', id: 's-1', question: 'q', withSelection: 'yes' }, 'invalid-field'],
    [{ type: 'askSend', id: 's-1', question: 'q', withSelection: false, answerTo: '/etc/passwd' }, 'unexpected-field'], [{ type: 'askContext', file: 'x' }, 'unexpected-field']
  ]) assert.deepEqual(parseMessage(raw, new Set(['s-1'])), { ok: false, reason }, JSON.stringify(raw));
  // skillAction (#359) names a skill on screen and one fixed action; the skill's text and every confirmation come from the command.
  const skills = new Set(['run-tests']);
  assert.deepEqual(parseMessage({ type: 'skillAction', action: 'roles', name: 'run-tests' }, new Set(), new Set(), skills), { ok: true, message: { type: 'skillAction', action: 'roles', name: 'run-tests' } });
  for (const raw of [{ type: 'skillAction', action: 'roles', name: 'gone' }, { type: 'skillAction', action: 'save', name: 'run-tests' }, { type: 'skillAction', action: 'edit', name: 'run-tests', body: 'x' }, { type: 'skillAction', action: 'edit', name: 'Run Tests' }, { type: 'skillAction', action: 'toString', name: 'run-tests' }]) assert.equal(parseMessage(raw, new Set(), new Set(), skills).ok, false, JSON.stringify(raw));
  // switchAccount names a card on screen and nothing else: the account and the confirmation come from the command's windows.
  assert.deepEqual(parseMessage({ type: 'switchAccount', id: 'a' }, new Set(['a'])), { ok: true, message: { type: 'switchAccount', id: 'a' } });
  for (const raw of [{ type: 'switchAccount', id: 'gone' }, { type: 'switchAccount', id: 'a', accountProfileId: 'acct-2' }, { type: 'switchAccount', id: 'a', confirmed: true }]) assert.equal(parseMessage(raw, new Set(['a'])).ok, false, JSON.stringify(raw));
});

// ---- accounts and quota (issue #304) ----
const NOW = new Date('2026-10-22T10:00:00.000Z');
const iso = (minutes) => new Date(NOW.getTime() + minutes * 60_000).toISOString();
const win = (over = {}) => ({ window: 'five_hour', usedPercent: 42, source: 'claude status line rate_limits', observedAt: iso(-1), confidence: 'actual', fresh: true, gateEligible: true, resetsAt: iso(125), ...over });
const acct = (over = {}) => ({ id: 'acct-1', label: 'Main', provider: 'Claude Code', health: 'ready', identity: { state: 'verified', fingerprint: 'abcd1234' }, issues: [], ...over });
const detail = (over = {}) => ({ ok: true, windows: [win(), win({ window: 'seven_day', usedPercent: 10, resetsAt: iso(60 * 24 * 3) })], unknownReason: null, policy: 'Limits: warn at 80% used.', gate: 'allow', gateReason: null, plan: null, ...over });
const rows = (accounts, details, sessions = []) => buildAccountRows({ accounts, details, sessions, now: NOW });

test('an account row has its sign-in, identity, both usage windows with percent, reset, read time and source, and the agents using it', () => {
  const { rows: [row], alerts } = rows([acct()], { 'acct-1': detail() }, [session({ id: 'w-1', name: 'Worker One', accountProfileId: 'acct-1' }), session({ id: 'w-2', accountProfileId: 'other' })]);
  assert.deepEqual([row.label, row.provider, row.signIn, row.identity], ['Main', 'Claude Code', 'sign-in checked', 'identity verified (abcd1234)']);
  assert.deepEqual(row.windows.map((entry) => [entry.label, entry.text, entry.kind, entry.trust, entry.resets, entry.read, entry.source]), [
    ['5-hour', '42% used', 'actual', 'verified and current', 'resets in 2h 5m', 'read 1m ago', 'claude status line rate_limits'],
    ['Weekly', '10% used', 'actual', 'verified and current', 'resets in 3d', 'read 1m ago', 'claude status line rate_limits']
  ]);
  assert.equal(row.usageKnown, true);
  assert.equal(row.reason, null);
  assert.deepEqual([row.agents, row.agentCount], [['Worker One'], 1]);
  assert.equal(row.policy, 'Limits: warn at 80% used.');
  assert.deepEqual(alerts, []);
});

test('an estimate, an old reading and an unknown one are each said so, and a window past its reset says that instead of a percent', () => {
  const [row] = rows([acct()], { 'acct-1': detail({ windows: [win({ confidence: 'estimated', gateEligible: false }), win({ window: 'seven_day', fresh: false, gateEligible: false, observedAt: iso(-120) }), win({ window: 'month', usedPercent: null, confidence: 'unknown', fresh: false, gateEligible: false, resetsAt: null, observedAt: null, source: null }), win({ window: 'five_hour2', resetsAt: iso(-5) })] }) }).rows;
  assert.equal(row.windows[0].trust, 'estimate (not used to block)');
  assert.equal(row.windows[1].trust, 'out of date (not used to block)');
  // The usage line keeps only a few plain words of that; the rest is under Details (#352).
  assert.equal(row.windows[0].caveat, 'an estimate');
  assert.equal(row.windows[1].caveat, 'out of date');
  assert.deepEqual([row.windows[1].read], ['read 2h ago']);
  assert.deepEqual([row.windows[2].text, row.windows[2].kind, row.windows[2].resets, row.windows[2].read, row.windows[2].source], ['unknown', 'unknown', 'reset time unknown', 'read time unknown', 'unknown source']);
  assert.equal(row.windows[3].resets, 'reset time has passed');
  assert.equal(row.windows[2].label, 'month');
});

test('with no usable reading the row says why, in the words of the quota table, and offers the next step when there is one to click', () => {
  const cases = [
    ['bridge-not-enabled', { action: 'configureStatusLine', label: 'Enable the Claude status line bridge' }, null],
    ['bridge-other-statusline', { action: 'configureStatusLine', label: 'Review the status line setting' }, null],
    ['codex-no-sessions', null, 'Run Codex once with this account; its session log is what is read.'],
    ['bridge-no-data', null, 'Readings arrive only while a Claude session runs on this account: start one.'],
    ['file-unreadable', { action: 'details', label: 'Open the account details' }, null]
  ];
  for (const [code, next, hint] of cases) {
    const [row] = rows([acct()], { 'acct-1': detail({ windows: [], unknownReason: code }) }).rows;
    assert.equal(row.usageKnown, false, code);
    assert.ok(row.reason.short.length > 0 && row.reason.detail.length > 0, code);
    assert.deepEqual(row.reason.next, next, code);
    assert.equal(row.reason.hint, hint, code);
  }
  const [unreadable] = rows([acct()], { 'acct-1': detail({ ok: false, windows: [], unknownReason: null }) }).rows;
  assert.equal(unreadable.reason.short, 'usage could not be read');
  assert.match(unreadable.reason.detail, /This is not zero\./);
  const [missing] = rows([acct()], {}).rows;
  assert.equal(missing.reason.short, 'usage could not be read', 'no detail at all is unknown, never zero');
  assert.equal(missing.policy, 'Limits: could not be read.');
  const [stale] = rows([acct()], { 'acct-1': detail({ windows: [win({ fresh: false, gateEligible: false })], unknownReason: 'reading-expired' }) }).rows;
  assert.ok(stale.reason, 'an out-of-date reading is listed with why it is not used');
  const [current] = rows([acct()], { 'acct-1': detail({ unknownReason: 'bridge-not-enabled' }) }).rows;
  assert.equal(current.reason, null, 'a stale reason never sits beside a current number');
});

test('near a limit, held back or needing confirmation raises an alert on the account and in the list for the PM panel', () => {
  const out = rows([acct({ id: 'a-1', label: 'Near' }), acct({ id: 'a-2', label: 'Held' }), acct({ id: 'a-3', label: 'Ask' }), acct({ id: 'a-4', label: 'Fine' })], { 'a-1': detail({ gate: 'warn' }), 'a-2': detail({ gate: 'block' }), 'a-3': detail({ gate: 'confirm' }), 'a-4': detail({ gate: 'allow' }) });
  assert.deepEqual(out.alerts, ['Near: this account is near its limit', 'Held: new agents on this account are held back', 'Ask: a new agent on this account needs confirmation']);
  assert.deepEqual(out.rows.map((row) => row.alert), ['this account is near its limit', 'new agents on this account are held back', 'a new agent on this account needs confirmation', null]);
});

test('sign-in and identity are what the checks said, never more: unchecked, needing attention, verified or unknown with the reason', () => {
  const state = (account) => rows([account], { 'acct-1': detail() }).rows[0];
  assert.equal(state(acct({ health: 'unknown', identity: { state: 'unknown', reason: 'not-inspected' } })).signIn, 'sign-in not checked in this window');
  assert.equal(state(acct({ health: 'unknown', identity: { state: 'unknown', reason: 'not-inspected' } })).identity, 'identity unknown (not-inspected)');
  assert.equal(state(acct({ health: 'attention', issues: ['Not logged in.', 'Another profile uses the same folder.'] })).signIn, 'sign-in needs attention');
  assert.deepEqual(state(acct({ health: 'attention', issues: ['Not logged in.', 'x', 'y', 'z'] })).issues, ['Not logged in.', 'x', 'y'], 'three hints at most');
  assert.equal(state(acct({ identity: undefined })).identity, 'identity unknown');
  assert.equal(state(acct({ plan: 'x' })).plan, null, 'a plan comes only from the quota detail');
  assert.equal(rows([acct()], { 'acct-1': detail({ plan: 'plus' }) }).rows[0].plan, 'plus');
});

test('bad inputs, hostile text and too many accounts give bounded, clean rows', () => {
  for (const bad of [undefined, null, {}, { accounts: 'x' }, { accounts: [null, 5, {}, { id: 'bad id!' }] }]) assert.deepEqual(buildAccountRows(bad), { rows: [], alerts: [] });
  const nasty = '<img src=x onerror=1>\u202e\nline';
  const { rows: [row] } = rows([acct({ label: nasty, provider: nasty, issues: [nasty] })], { 'acct-1': detail({ windows: [win({ source: nasty, window: nasty })], plan: nasty }) }, [session({ accountProfileId: 'acct-1', name: nasty })]);
  assert.equal(/[\u202e\n]/.test(JSON.stringify(row)), false);
  const many = Array.from({ length: 80 }, (_, index) => acct({ id: `a-${index}` }));
  assert.equal(rows(many, {}).rows.length, 50);
  const crowded = rows([acct()], { 'acct-1': detail() }, Array.from({ length: 20 }, (_, index) => session({ id: `s-${index}`, accountProfileId: 'acct-1' })));
  assert.deepEqual([crowded.rows[0].agents.length, crowded.rows[0].agentCount], [6, 20]);
});

test('relative times read as in the future or in the past, and anything that is not a time is null', () => {
  const at = (minutes) => new Date(NOW.getTime() + minutes * 60_000).toISOString();
  assert.deepEqual([relative(at(0), NOW.getTime()), relative(at(30), NOW.getTime()), relative(at(-30), NOW.getTime()), relative(at(90), NOW.getTime()), relative(at(60 * 24 * 2 + 180), NOW.getTime())], ['in under a minute', 'in 30m', '30m ago', 'in 1h 30m', 'in 2d 3h']);
  for (const bad of [undefined, null, 'soon', 5, {}]) assert.equal(relative(bad, NOW.getTime()), null);
  assert.equal(relative(at(5), Number.NaN), null);
});

test('an account action is one of the known ones, names an account that is on the screen, and creating an account names none', () => {
  const cards = new Set(['a']);
  const accounts = new Set(['acct-1']);
  const making = ['create', 'addClaude', 'addCodex'];
  for (const action of ACCOUNT_ACTIONS.filter((name) => !making.includes(name))) assert.deepEqual(parseMessage({ type: 'accountAction', action, id: 'acct-1' }, cards, accounts), { ok: true, message: { type: 'accountAction', action, id: 'acct-1' } }, action);
  // Making an account names none, whichever way (#352 wizard included).
  for (const action of making) {
    assert.deepEqual(parseMessage({ type: 'accountAction', action }, cards, accounts), { ok: true, message: { type: 'accountAction', action } }, action);
    assert.deepEqual(parseMessage({ type: 'accountAction', action, id: 'acct-1' }, cards, accounts), { ok: false, reason: 'unexpected-field' }, `${action} with an id`);
  }
  for (const [message, reason] of [
    [{ type: 'accountAction', action: 'create', id: 'acct-1' }, 'unexpected-field'],
    [{ type: 'accountAction', action: 'remove', id: 'acct-1' }, 'invalid-field'], [{ type: 'accountAction', action: 'delete', id: 'acct-1' }, 'invalid-field'], [{ type: 'accountAction', id: 'acct-1' }, 'invalid-field'], [{ type: 'accountAction', action: 5, id: 'acct-1' }, 'invalid-field'], [{ type: 'accountAction', action: '__proto__', id: 'acct-1' }, 'invalid-field'],
    [{ type: 'accountAction', action: 'login' }, 'unknown-id'], [{ type: 'accountAction', action: 'login', id: 'someone-else' }, 'unknown-id'], [{ type: 'accountAction', action: 'login', id: 'a' }, 'unknown-id'], [{ type: 'accountAction', action: 'login', id: '../x' }, 'unknown-id'],
    [{ type: 'accountAction', action: 'login', id: 'acct-1', command: 'multiagentSystem.accounts.remove' }, 'unexpected-field']
  ]) assert.deepEqual(parseMessage(message, cards, accounts), { ok: false, reason }, JSON.stringify(message));
  assert.deepEqual(parseMessage({ type: 'accountAction', action: 'login', id: 'acct-1' }, cards), { ok: false, reason: 'unknown-id' }, 'with no account on the screen none is known');
  assert.deepEqual(parseMessage({ type: 'accountAction', action: 'login', id: 'acct-1' }, cards, ['acct-1']), { ok: true, message: { type: 'accountAction', action: 'login', id: 'acct-1' } }, 'a list works as well as a set');
  assert.deepEqual(ACCOUNT_ACTIONS.slice().sort(), ['addClaude', 'addCodex', 'check', 'configureStatusLine', 'create', 'details', 'limits', 'login', 'usageLog'], 'no action removes an account, changes a login credential or sends anything');
});

const review = (over = {}) => ({ pm: 'current', userCan: 'Open it', next: 'Merge', approval: 'approved', ci: 'passing', unresolved: 1, ...over });

test('a card says one line about the working folder, from what Git said, or that nothing is known', () => {
  const withGit = buildCards({ sessions: [session()], agents: [agent({ tooltip: ['Role: Worker', 'Git (local, read just now): 2 changed, 0 untracked; 1 ahead, 0 behind its upstream; at abc1234', 'Fields marked unknown have no verified source yet.'] })], roles }).agents[0];
  assert.equal(withGit.worktree, '2 changed, 0 untracked; 1 ahead, 0 behind its upstream; at abc1234');
  const unknownGit = buildCards({ sessions: [session()], agents: [agent({ tooltip: ['Git: unknown (Git could not read the working folder)'] })], roles }).agents[0];
  assert.equal(unknownGit.worktree, 'unknown (Git could not read the working folder)');
  assert.equal(buildCards({ sessions: [session()], agents: [agent({ tooltip: ['Role: Worker'] })], roles }).agents[0].worktree, 'unknown (no Git reading for this session)');
  assert.equal(buildCards({ sessions: [session()], agents: [], roles }).agents[0].worktree, 'unknown (no Git reading for this session)');
});

test('a card shows the latest report of its pull request: what it says, or that it is not loaded, could not be read, or does not exist', () => {
  const card = (reports, over = {}) => buildCards({ sessions: [session()], agents: [agent(over)], accounts: [account()], roles, reports }).agents[0].report.lines;
  assert.deepEqual(card({ 7: review() }), ['Latest report (PR #7): PM report current', 'User can: Open it', 'Next: Merge', 'Review: approval approved · CI passing · 1 unresolved thread']);
  assert.equal(card({ 7: review({ pm: 'stale', unresolved: 0 }) })[0], 'Latest report (PR #7): PM report STALE (its evidence is for another head)');
  assert.equal(card({ 7: review({ pm: 'missing', userCan: null, next: null }) }).length, 2, 'no invented fields');
  assert.equal(card({ 7: review({ unresolved: null }) }).at(-1), 'Review: approval approved · CI passing');
  assert.deepEqual(card({}), ['Latest report (PR #7): not loaded yet']);
  assert.deepEqual(card({ 7: null }), ['Latest report (PR #7): unknown (the report could not be read)']);
  assert.deepEqual(card({ 7: 'x' }), ['Latest report (PR #7): unknown (the report could not be read)']);
  assert.deepEqual(card({ 7: review() }, { pullRequestNumber: null, pullRequestUrl: null }), ['Latest report: none (no pull request is linked to this agent)']);
  assert.equal(card({ 7: review({ pm: 'bogus' }) })[0], 'Latest report (PR #7): PM report unknown');
  assert.equal(card({ 7: review({ pm: '__proto__' }) })[0], 'Latest report (PR #7): PM report unknown');
  assert.equal(buildCards({ sessions: [session()], agents: [agent()], reports: 'x' }).agents[0].report.lines[0], 'Latest report (PR #7): not loaded yet');
});

test('the PM card carries the same report lines, so the pinned panel shows the latest report too', () => {
  const built = buildCards({ sessions: [session({ id: 'pm-1', roleGroupId: 'g-pm' })], agents: [agent({ id: 'pm-1', pullRequestNumber: 9 })], roles, reports: { 9: review({ pm: 'missing', userCan: null, next: null }) } });
  assert.deepEqual(built.pm[0].report.lines, ['Latest report (PR #9): no structured PM report yet', 'Review: approval approved · CI passing · 1 unresolved thread']);
});

test('the state text of every state is what the person reads: working, waiting for input, ended, not reported yet', () => {
  for (const [state, text] of [['working', 'working'], ['waiting', 'waiting for input'], ['ended', 'ended']]) assert.equal(statusOf(session({ deliveryState: hook(state) })).text, text, state);
  assert.equal(statusOf(session({ deliveryState: undefined })).text, 'not reported yet');
  assert.deepEqual(buildCards({ sessions: ['working', 'waiting', 'ended'].map((state) => session({ id: `s-${state}`, deliveryState: hook(state) })) }).agents.map((card) => card.status.text).sort(), ['ended', 'waiting for input', 'working']);
});

test('a card says which Issue was typed into its terminal, from the dispatch log only', () => {
  const session = { id: 'a', name: 'A', provider: 'claude', roleGroupId: 'g', terminalOpen: true };
  const at = '2026-10-21T10:00:00.000Z';
  const card = (assignments) => buildCards({ sessions: [session], assignments }).agents[0];
  assert.match(card({ a: { issueNumber: 305, at } }).assigned, /^Issue #305 was typed into this terminal at 2026-10-21T10:00:00.000Z \(not proof the agent read it\)$/);
  assert.equal(card({}).assigned, null);
  for (const bad of [undefined, null, 5, { a: null }, { a: { issueNumber: 'x', at } }, { b: { issueNumber: 1, at } }, JSON.parse('{"__proto__": {"issueNumber": 1}}')]) assert.equal(card(bad).assigned, null, JSON.stringify(bad));
});

test('a card says how many rules and shared notes were prepared for the agent, and that this is not proof the CLI read them', () => {
  const base = { id: 'a', name: 'A', provider: 'claude', roleGroupId: 'g', terminalOpen: true };
  const card = (injectedCounts) => buildCards({ sessions: [{ ...base, injectedCounts }] }).agents[0];
  assert.equal(card({ rules: 3, memories: 1 }).injected, 'Prepared for this agent: 3 rules and 1 shared note (the CLI is told; not proof it read them)');
  assert.match(card({ rules: 1, memories: 2 }).injected, /1 rule and 2 shared notes/);
  for (const bad of [undefined, null, 5, {}, { rules: -1, memories: 0 }, { rules: 1.5, memories: 0 }, { rules: 'x', memories: 0 }]) assert.match(card(bad).injected, /^Rules and notes given to this agent: unknown/, JSON.stringify(bad));
});

test('a card carries the agent\'s codename when it is a well-formed one, and nothing else in its place (issue #342)', () => {
  assert.equal(build([session({ codename: 'Worker-01' })]).agents[0].codename, 'Worker-01');
  for (const codename of [undefined, null, 'Worker-1', '<b>PM-01</b>', 'PM-01\n', 7]) assert.equal(build([session({ codename })]).agents[0].codename, null, String(codename));
});

test('a card says whether its Claude Code reaches this VS Code window, and nothing when that was not checked (#354)', () => {
  const [connected] = build([session({ ideLabel: "VS Code: connected through this window's Claude Code port (40002)" })]).agents;
  assert.equal(connected.ide, "VS Code: connected through this window's Claude Code port (40002)");
  const [unchecked] = build([session()]).agents;
  assert.equal(unchecked.ide, null);
});

test('a card says whether its CLI will stop to ask to trust its worktree (#362)', () => {
  const [card] = build([session({ trustLabel: 'Folder trust: not pre-written, so Claude Code asks once (x)' })]).agents;
  assert.equal(card.trust, 'Folder trust: not pre-written, so Claude Code asks once (x)');
  assert.equal(build([session()]).agents[0].trust, null);
});

test('a card says which permission mode Claude Code reports, and an alert when auto mode fell back (#362)', () => {
  const [fell] = build([session({ requestedAutoMode: 'on', reportedPermissionMode: { mode: 'default', since: '2026-10-24T00:00:00.000Z' } })]).agents;
  assert.equal(fell.permission.text, 'Auto mode is not in effect: Claude Code reports default (asks before actions)');
  assert.equal(fell.permission.attention, true);
  assert.ok(fell.permission.lines.length > 0);
  assert.equal(build([session({ provider: 'codex' })]).agents[0].permission, null);
});

test('the Workbench next steps open only a fixed list of existing commands, none of which stops, removes, merges or publishes by itself (#357)', () => {
  const { TARGETS, TABS } = require('../../src/commandCenter/model');
  const manifest = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '../../package.json'), 'utf8'));
  const declared = new Set(manifest.contributes.commands.map((entry) => entry.command));
  for (const [name, command] of Object.entries(TARGETS)) {
    assert.ok(declared.has(command), `${name} opens a declared command (${command})`);
    assert.doesNotMatch(command, /stop|remove|delete|clear|revoke|merge|publish|close|reopen/i, `${name} does nothing irreversible by itself`);
  }
  assert.deepEqual([...TABS], ['agents', 'work', 'accounts', 'broadcast', 'ask', 'knowledge', 'setup']);
  assert.deepEqual(parseMessage({ type: 'open', target: 'startAgent' }, new Set()), { ok: true, message: { type: 'open', target: 'startAgent' } });
  for (const target of ['multiagentSystem.sessions.stop', 'constructor', '__proto__', 'toString', '', 5, undefined]) assert.equal(parseMessage({ type: 'open', target }, new Set()).ok, false, String(target));
  assert.equal(parseMessage({ type: 'open', target: 'startAgent', args: ['x'] }, new Set()).reason, 'unexpected-field', 'no argument reaches the command');
  assert.deepEqual(parseMessage({ type: 'showClassicViews' }, new Set()), { ok: true, message: { type: 'showClassicViews' } });
  assert.equal(parseMessage({ type: 'showClassicViews', value: false }, new Set()).reason, 'unexpected-field');
});

test('a card names its account with the e-mail address this window read, and only a plain address (#357)', () => {
  const [card] = build([session()], { emails: { 'acct-1': 'owner-a@example.test' } }).agents;
  assert.equal(card.account, 'Main (owner-a@example.test)');
  assert.equal(build([session()]).agents[0].account, 'Main');
  for (const bad of ['not-an-email', 'a b@example.test', 'x@example.test\nInjected line', 7, null]) assert.equal(build([session()], { emails: { 'acct-1': bad } }).agents[0].account, 'Main', String(bad));
});

test('the card names the mode in one word (#357)', () => {
  const { modeWord } = require('../../src/commandCenter/model');
  assert.equal(modeWord("Auto mode: on (won't ask for each approval) — passed: --permission-mode auto"), 'Auto');
  assert.equal(modeWord('Auto mode: off (the CLI asks for approval as usual)'), 'Ask');
  assert.equal(modeWord('Dangerous mode: on (no approval prompts and no sandbox)'), 'Dangerous');
  for (const label of ['Auto mode: unknown (not started in this window)', 'Auto mode: on requested, but this provider has no documented flag, so none was passed (unknown)', undefined, 5]) assert.equal(modeWord(label), 'unknown', String(label));
  assert.equal(build([session()]).agents[0].mode, 'Auto');
});

test('an account row says which real account it is: the e-mail address this window read, only a plain one (#352, #357)', () => {
  const { buildAccountRows } = require('../../src/commandCenter/model');
  const rows = (email) => buildAccountRows({ accounts: [{ id: 'acct-1', label: 'Work A', provider: 'Claude Code', email }], details: {}, sessions: [], now: new Date() }).rows[0];
  assert.equal(rows('owner-a@example.test').email, 'owner-a@example.test');
  for (const bad of [undefined, null, 'no-at', 'a b@example.test', 'x@example.test\nInjected', 7]) assert.equal(rows(bad).email, null, String(bad));
});

test('the Knowledge tab lists each skill in short plain lines; a long description is cut at a whole word (#359)', () => {
  const { buildSkills } = require('../../src/commandCenter/model');
  const long = `${'word '.repeat(60)}end`;
  const built = buildSkills({ ok: true, skills: [{ name: 'run-tests', description: long, state: 'active', usable: true, roles: ['E2E Developers'] }, { name: 'bad', description: 'x', state: 'active', usable: false, problem: 'the steps contain wording that tells an agent to ignore its rules', roles: [] }, { name: '../x', description: 'y' }] });
  assert.equal(built.known, true);
  assert.deepEqual(built.items.map((item) => item.name), ['run-tests', 'bad'], 'a name that is not a skill name is left out');
  assert.ok(built.items[0].description.endsWith('word…') && Array.from(built.items[0].description).length <= 200, built.items[0].description);
  assert.deepEqual(built.items[0].roles, ['E2E Developers']);
  assert.equal(built.items[1].problem, 'the steps contain wording that tells an agent to ignore its rules');
  assert.deepEqual(buildSkills({ ok: false, reason: 'storage-unavailable' }), { known: false, text: 'Skills: unknown (the library could not be read).', items: [] });
});

test('a card says what its agent was given: rules, notes and skills counted, and the size with an estimate of tokens (#359)', () => {
  const { describeSizes, describeInjected } = require('../../src/commandCenter/model');
  assert.equal(describeInjected({ rules: 7, memories: 1, skills: 2 }), 'Prepared for this agent: 7 rules, 1 shared note and 2 skills (listed, not their text) (the CLI is told; not proof it read them)');
  assert.equal(describeInjected({ rules: 1, memories: 0 }), 'Prepared for this agent: 1 rule and 0 shared notes (the CLI is told; not proof it read them)', 'as before when no skills were counted');
  assert.equal(describeInjected({ rules: -1, memories: 0 }), 'Rules and notes given to this agent: unknown (not started in this window)');
  const size = (chars, tokens) => ({ chars, tokens });
  assert.equal(describeSizes({ rules: size(1234, 300), memories: size(0, 0), skills: size(456, 114), total: size(1800, 450) }), 'Given at start: about 450 tokens (an estimate) — rules 1,234 characters, shared notes 0, skills list 456');
  for (const bad of [null, {}, { rules: size(1, 1), memories: size(1, 1), skills: size(1, 1) }, { rules: size(-1, 1), memories: size(1, 1), skills: size(1, 1), total: size(1, 1) }]) assert.equal(describeSizes(bad), null, JSON.stringify(bad));
});

test('the card\'s Details carry what the agent was given, from its session (#359)', () => {
  const size = (chars, tokens) => ({ chars, tokens });
  const [card] = build([session({ injectedCounts: { rules: 2, memories: 0, skills: 1 }, injectedSizes: { rules: size(100, 25), memories: size(0, 0), skills: size(80, 20), total: size(200, 50) } })]).agents;
  assert.equal(card.given, 'Given at start: about 50 tokens (an estimate) — rules 100 characters, shared notes 0, skills list 80');
  assert.match(card.injected, /and 1 skill \(listed, not their text\)/);
  assert.equal(build([session()]).agents[0].given, null, 'nothing is said when it is not known');
});

test('a card\'s Details say each thing once, in plain words, and only what the card does not show already (#357)', () => {
  const { describeGiven } = require('../../src/commandCenter/model');
  const ide = "VS Code: connected through this window's Claude Code port (40123)";
  // The overview's tooltip as the #384 screenshot showed it: most of it repeats the card.
  const tooltip = ['Role: E2E Developers', 'Provider: Claude Code', 'Requested model: CLI default (not confirmed)', 'Actual model: claude-sonnet-4-5',
    'Auto mode: on (won\'t ask for each approval) — passed: --permission-mode auto', 'Permission mode: auto (a classifier approves actions instead of you), reported by Claude Code', ide,
    'Git (local, read just now): 0 changed, 2 untracked; at 5bc9841556ad', "Provider session: the observation file's id is consistent; terminal routing is not verified", 'Session cost: unknown',
    'Account: Work A (identity verified by the CLI)', 'Provider state: waiting (from the CLI\'s own hooks)', 'Terminal lifecycle: CLI launch requested, not confirmed', 'Branch: main', 'Issue: unknown',
    'Pull request: no open pull request', 'CI: unknown', 'The role group is read from its current definition. Its rules are not sent to the CLI yet, so editing it does not change what an agent that is already started was told.', 'Fields marked unknown have no verified source yet.'];
  const [card] = buildCards({
    sessions: [session({ requestedModel: null, ideLabel: ide, autoModeLabel: 'Auto mode: on (won\'t ask for each approval) — passed: --permission-mode auto', requestedAutoMode: 'on', reportedPermissionMode: { mode: 'auto' }, injectedCounts: { rules: 7, memories: 0, skills: 1 }, injectedSizes: { rules: { chars: 433, tokens: 100 }, memories: { chars: 0, tokens: 0 }, skills: { chars: 575, tokens: 150 }, total: { chars: 1008, tokens: 334 } } })],
    agents: [agent({ tooltip })], accounts: [account()], roles
  }).agents;
  const texts = card.facts.map((fact) => fact.text);
  assert.equal(texts[0], 'Model: asked for CLI default; the CLI reports claude-sonnet-4-5');
  for (const [word, times] of [[/auto mode|permission mode/i, 1], [/^VS Code/, 1], [/Given at start/, 1], [/^Folder \(Git\)/, 1], [/^State: /, 1]]) {
    assert.equal(texts.filter((text) => word.test(text)).length, times, `${word} once: ${texts.join(' | ')}`);
  }
  for (const repeated of [/^Role:/, /^Provider:/, /^Requested model:/, /^Actual model:/, /^Account:/, /^Provider state:/, /^Terminal lifecycle:/, /^Issue:/, /^Pull request:/, /^Git/, /unknown$/, /^Provider session:/, /^Fields marked/, /^The role group is read/]) {
    assert.equal(texts.some((text) => repeated.test(text)), false, `${repeated} is not repeated in Details`);
  }
  assert.ok(texts.includes('Branch: main'));
  assert.equal(texts.some((text) => /session:/i.test(text) && !/^State:/.test(text)), false, 'the normal CLI session says nothing');
  const [mismatched] = buildCards({ sessions: [session()], agents: [agent({ tooltip: ['Provider session: the CLI session changed, so its evidence is turned off for this session'] })], accounts: [account()], roles }).agents;
  assert.ok(mismatched.facts.some((fact) => fact.text === 'CLI session: the CLI session changed, so its evidence is turned off for this session'), 'a problem with it is said');
  assert.ok(texts.includes('Sign-in: the CLI confirmed which account this is'));
  assert.ok(texts.includes(describeGiven({ rules: 7, memories: 0, skills: 1 }, { rules: { chars: 433, tokens: 100 }, memories: { chars: 0, tokens: 0 }, skills: { chars: 575, tokens: 150 }, total: { chars: 1008, tokens: 334 } })));
  assert.ok(texts.length <= 10, `${texts.length} lines: ${texts.join(' | ')}`);
});

test('the Details say the mode that was asked for only when the CLI has not reported one, and mark what needs a look (#357)', () => {
  const [asked] = build([session({ autoModeLabel: 'Auto mode: on (synthetic)' })]).agents;
  assert.ok(asked.facts.some((fact) => fact.text === 'Auto mode: on (synthetic)'));
  const [fell] = build([session({ requestedAutoMode: 'on', reportedPermissionMode: { mode: 'default' }, ideLabel: 'VS Code: not connected (no lock file)', trustLabel: 'Folder trust: not pre-written, so Codex asks once (x)' })]).agents;
  const alerts = fell.facts.filter((fact) => fact.alert).map((fact) => fact.text);
  assert.equal(fell.facts.some((fact) => fact.text === 'Auto mode: on (synthetic)'), false, 'the reported mode takes its place');
  assert.equal(alerts.length, 3, alerts.join(' | '));
  assert.ok(alerts.some((text) => /not connected/.test(text)) && alerts.some((text) => /asks once/.test(text)));
  assert.equal(fell.facts.find((fact) => fact.text === 'Branch: feat/x').alert, false);
  assert.ok(fell.facts.some((fact) => fact.text === 'CI: passing'), 'a known CI result is kept');
  assert.ok(build([session()]).agents[0].facts.some((fact) => fact.text === 'Model: asked for sonnet; the CLI has not said which one it uses yet'));
});

test('what an agent was given is one line: what was prepared, about how many tokens, and what that does not prove (#357, #359)', () => {
  const { describeGiven } = require('../../src/commandCenter/model');
  const size = (chars, tokens) => ({ chars, tokens });
  assert.equal(describeGiven({ rules: 7, memories: 1, skills: 2 }, { rules: size(1234, 300), memories: size(10, 3), skills: size(456, 114), total: size(1700, 1450) }), 'Given at start: 7 rules, 1 shared note and 2 skills (their names, not their text) — about 1,450 tokens (an estimate). The CLI is told about them; that does not prove it read them.');
  assert.equal(describeGiven({ rules: 1, memories: 0 }), 'Given at start: 1 rule and 0 shared notes. The CLI is told about them; that does not prove it read them.');
  assert.equal(describeGiven({ rules: -1, memories: 0 }), 'Given at start: unknown (it was not started in this window)');
});

test('the card says how many shared notes did not fit the size limit, and only when some did not (#359)', () => {
  const { describeGiven } = require('../../src/commandCenter/model');
  assert.equal(describeGiven({ rules: 7, memories: 1, skills: 1, leftOutNotes: 2 }), 'Given at start: 7 rules, 1 shared note and 1 skill (their names, not their text). 2 more shared notes did not fit the size limit (listed by title only). The CLI is told about them; that does not prove it read them.');
  assert.match(describeGiven({ rules: 7, memories: 1, leftOutNotes: 1 }), /\. 1 more shared note did not fit the size limit \(listed by title only\)\./);
  for (const none of [0, -1, undefined, 'x']) assert.equal(/did not fit/.test(describeGiven({ rules: 7, memories: 1, leftOutNotes: none })), false, String(none));
});

test('a card carries its role group, so the Broadcast tab can send to everyone of one (#357)', () => {
  assert.equal(build([session({ roleGroupId: 'g-worker' })]).agents[0].roleGroupId, 'g-worker');
  assert.equal(build([session({ roleGroupId: 'unassigned' })]).agents[0].roleGroupId, null);
  assert.equal(build([session({ roleGroupId: undefined })]).agents[0].roleGroupId, null);
});

test('the five first steps: done only when what was read says so, unknown with its reason when it could not be read, and the next one named (#357)', () => {
  const { buildGettingStarted } = require('../../src/commandCenter/model');
  const fresh = buildGettingStarted({ accounts: 0, roleGroups: 0, agents: 0, tasks: 0, reviewed: false });
  assert.deepEqual(fresh.steps.map((step) => [step.id, step.done, step.action]), [['account', false, 'addAccount'], ['role', false, 'createRole'], ['agent', false, 'startAgent'], ['task', false, 'sendTask'], ['review', false, 'openWork']]);
  assert.deepEqual([fresh.done, fresh.next, fresh.complete], [0, 'account', false]);
  const some = buildGettingStarted({ accounts: 2, roleGroups: 1, agents: 0, tasks: 3, reviewed: false });
  assert.deepEqual([some.done, some.next], [3, 'agent'], 'the next is the first not done, in order');
  const all = buildGettingStarted({ accounts: 1, roleGroups: 1, agents: 1, tasks: 1, reviewed: true });
  assert.deepEqual([all.done, all.next, all.complete], [5, null, true]);
  // Unread is unknown, with why; it is never done, and it is the next step.
  const unread = buildGettingStarted({ accounts: null, roleGroups: 1, agents: 1, tasks: 1, reviewed: null });
  assert.deepEqual(unread.steps.map((step) => step.done), ['unknown', true, true, true, 'unknown']);
  assert.match(unread.steps[0].reason, /could not be read/);
  assert.deepEqual([unread.next, unread.complete], ['account', false]);
  for (const bad of [undefined, null, [], { accounts: -1, roleGroups: 1.5, agents: '1', tasks: NaN, reviewed: 'yes' }]) {
    assert.deepEqual(buildGettingStarted(bad).steps.map((step) => step.done), ['unknown', 'unknown', 'unknown', 'unknown', 'unknown'], JSON.stringify(bad));
  }
});

test('the Setup tab says each tool\'s state in plain words, with its existing setup command only when it needs one (#357)', () => {
  const { describeTools } = require('../../src/commandCenter/model');
  assert.deepEqual(describeTools(null), { known: false, rows: [] });
  const read = describeTools({ git: { onPath: true }, gh: { state: 'ready', version: '2.60.1' }, claude: { state: 'missing', reason: 'not-prepared' }, codex: { state: 'unsupported' }, agy: { onPath: false } });
  assert.deepEqual(read.rows.map((row) => [row.id, row.state, row.action]), [['git', 'ready', null], ['gh', 'ready', null], ['claude', 'attention', 'setupRetryClaude'], ['codex', 'attention', null], ['agy', 'attention', null]]);
  assert.match(read.rows[1].text, /^Ready · 2\.60\.1, checked by its fixed release and SHA-256$/);
  assert.equal(read.rows[2].text, 'Needs setup: not set up yet');
  assert.equal(read.rows[3].text, 'Not available on this computer');
  assert.match(read.rows[4].text, /cannot be set up here/);
  // Preparing, unreadable, odd reasons and versions: never shown as given, never ready.
  const odd = describeTools({ gh: { state: 'missing', reason: 'Bad <b>reason</b>' }, claude: { state: 'ready', version: '1.0 <script>' }, codex: { preparing: true, state: 'ready' }, git: { onPath: 'yes' }, agy: { onPath: true } });
  assert.equal(odd.rows[1].text, 'Needs setup: the reason is unknown');
  assert.equal(odd.rows[2].text, 'Ready, checked by its fixed release and SHA-256', 'a version that is not one is left out');
  assert.deepEqual([odd.rows[3].state, odd.rows[3].text, odd.rows[3].action], ['unknown', 'Setting up…', null]);
  assert.equal(odd.rows[0].state, 'attention', 'only true means found');
  assert.equal(odd.rows[4].state, 'unknown', 'agy found is still not checked');
  assert.equal(describeTools({ gh: {} }).rows[1].state, 'unknown');
  assert.equal(describeTools({ gh: { state: 'missing', reason: 'managed-binary-changed' } }).rows[1].text, 'Needs setup: managed binary changed');
});

test('the Setup tab says the modes from the user settings, the defaults when unset, and unknown for a value it does not know (#357)', () => {
  const { describeModes, MODE_SETTINGS } = require('../../src/commandCenter/model');
  const unset = describeModes({});
  assert.deepEqual(unset.map((mode) => mode.key), MODE_SETTINGS);
  assert.match(unset[0].value, /^on: /);
  assert.equal(unset[0].note, 'The same for every CLI');
  assert.match(unset[1].value, /^advisory: /);
  assert.equal(unset[2].value, 'ask once, then remember');
  const set = describeModes({ autoMode: 'off', overrides: { claude: 'on', 'bad key!': 'on', codex: 'maybe' }, isolation: 'enforced', preTrust: 'on' });
  assert.deepEqual(set.map((mode) => mode.value.split(':')[0]), ['off', 'enforced', 'trusted without asking']);
  assert.equal(set[0].note, 'Per CLI: claude: on');
  for (const mode of describeModes({ autoMode: 'yes', isolation: 3, preTrust: null })) assert.match(mode.value, /^unknown/);
});

test('the Setup tab can open only the three mode settings, and reading it carries nothing (#357)', () => {
  const { MODE_SETTINGS } = require('../../src/commandCenter/model');
  for (const key of MODE_SETTINGS) assert.deepEqual(parseMessage({ type: 'openSetting', key }), { ok: true, message: { type: 'openSetting', key } });
  for (const key of ['multiagentSystem.providers.custom', 'workbench.colorTheme', '', 5, undefined]) assert.equal(parseMessage({ type: 'openSetting', key }).ok, false, String(key));
  assert.equal(parseMessage({ type: 'openSetting', key: MODE_SETTINGS[0], value: 'off' }).ok, false, 'it cannot set a value');
  assert.deepEqual(parseMessage({ type: 'loadSetup' }), { ok: true, message: { type: 'loadSetup' } });
  assert.equal(parseMessage({ type: 'loadSetup', force: true }).ok, false);
});
