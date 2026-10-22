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
    assert.equal(status.text, 'state unknown');
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
  for (const message of [{ type: 'ready' }, { type: 'refresh' }, { type: 'setLayout', mode: 'list' }, { type: 'reorder', order: ['b', 'a'] }, { type: 'toggleCollapse', id: 'a' }, { type: 'togglePin', id: 'b' }, { type: 'focus', id: 'a' }, { type: 'openReport', id: 'a' }, { type: 'openPullRequest', id: 'a' }, { type: 'openReports', kind: 'issue' }, { type: 'openReports', kind: 'pullRequest' }, { type: 'exportReport' }, { type: 'editTeamRules' }, { type: 'assignIssue' }, { type: 'sendTask' }]) {
    assert.deepEqual(ok(message), { ok: true, message }, JSON.stringify(message));
  }
  const refused = [
    [{ type: 'delete' }, 'unknown-command'], [{ type: 'stop', id: 'a' }, 'unknown-command'], [{ type: 'executeCommand', command: 'x' }, 'unknown-command'], [{}, 'unknown-command'], [null, 'unknown-command'], ['focus', 'unknown-command'], [[], 'unknown-command'], [{ type: 5 }, 'unknown-command'], [{ type: '__proto__' }, 'unknown-command'],
    [{ type: 'focus', id: 'a', extra: 1 }, 'unexpected-field'], [{ type: 'ready', id: 'a' }, 'unexpected-field'], [{ type: 'focus', id: 'a', command: 'multiagentSystem.sessions.stop' }, 'unexpected-field'],
    [{ type: 'focus', id: 'zzz' }, 'unknown-id'], [{ type: 'focus' }, 'unknown-id'], [{ type: 'focus', id: 5 }, 'unknown-id'], [{ type: 'focus', id: '../a' }, 'unknown-id'], [{ type: 'togglePin', id: 'constructor' }, 'unknown-id'],
    [{ type: 'setLayout', mode: 'tiles' }, 'invalid-field'], [{ type: 'setLayout' }, 'invalid-field'], [{ type: 'reorder', order: 'a' }, 'invalid-field'], [{ type: 'reorder', order: ['a', 'a'] }, 'invalid-field'], [{ type: 'reorder', order: ['a', 'x'] }, 'invalid-field'], [{ type: 'reorder', order: Array(201).fill('a') }, 'invalid-field'], [{ type: 'openReports', kind: 'repo' }, 'invalid-field'], [{ type: 'exportReport', path: '/tmp/x.md' }, 'unexpected-field'], [{ type: 'exportReport', text: 'x' }, 'unexpected-field'],
    [{ type: 'editTeamRules', text: 'be nice' }, 'unexpected-field'], [{ type: 'editTeamRules', rules: [] }, 'unexpected-field'],
    [{ type: 'assignIssue', issue: 5 }, 'unexpected-field'], [{ type: 'sendTask', text: 'do it' }, 'unexpected-field'], [{ type: 'sendTask', id: 'a' }, 'unexpected-field']
  ];
  for (const [message, reason] of refused) assert.deepEqual(ok(message), { ok: false, reason }, JSON.stringify(message));
  assert.deepEqual(parseMessage({ type: 'focus', id: 'a' }, undefined), { ok: false, reason: 'unknown-id' }, 'with no cards on screen no id is known');
  assert.deepEqual(parseMessage({ type: 'focus', id: 'a' }, ['a']), { ok: true, message: { type: 'focus', id: 'a' } }, 'a list works as well as a set');
});

test('the command list is exactly what the page can send: nothing that stops, starts, sends or publishes; exportReport, assignIssue and sendTask only open the command\'s own windows and carry no path or text', () => {
  assert.deepEqual([...COMMANDS].sort(), ['accountAction', 'assignIssue', 'editTeamRules', 'exportReport', 'focus', 'openPullRequest', 'openReport', 'openReports', 'ready', 'refresh', 'reorder', 'sendTask', 'setLayout', 'toggleCollapse', 'togglePin']);
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
  for (const action of ACCOUNT_ACTIONS.filter((name) => name !== 'create')) assert.deepEqual(parseMessage({ type: 'accountAction', action, id: 'acct-1' }, cards, accounts), { ok: true, message: { type: 'accountAction', action, id: 'acct-1' } }, action);
  assert.deepEqual(parseMessage({ type: 'accountAction', action: 'create' }, cards, accounts), { ok: true, message: { type: 'accountAction', action: 'create' } });
  for (const [message, reason] of [
    [{ type: 'accountAction', action: 'create', id: 'acct-1' }, 'unexpected-field'],
    [{ type: 'accountAction', action: 'remove', id: 'acct-1' }, 'invalid-field'], [{ type: 'accountAction', action: 'delete', id: 'acct-1' }, 'invalid-field'], [{ type: 'accountAction', id: 'acct-1' }, 'invalid-field'], [{ type: 'accountAction', action: 5, id: 'acct-1' }, 'invalid-field'], [{ type: 'accountAction', action: '__proto__', id: 'acct-1' }, 'invalid-field'],
    [{ type: 'accountAction', action: 'login' }, 'unknown-id'], [{ type: 'accountAction', action: 'login', id: 'someone-else' }, 'unknown-id'], [{ type: 'accountAction', action: 'login', id: 'a' }, 'unknown-id'], [{ type: 'accountAction', action: 'login', id: '../x' }, 'unknown-id'],
    [{ type: 'accountAction', action: 'login', id: 'acct-1', command: 'multiagentSystem.accounts.remove' }, 'unexpected-field']
  ]) assert.deepEqual(parseMessage(message, cards, accounts), { ok: false, reason }, JSON.stringify(message));
  assert.deepEqual(parseMessage({ type: 'accountAction', action: 'login', id: 'acct-1' }, cards), { ok: false, reason: 'unknown-id' }, 'with no account on the screen none is known');
  assert.deepEqual(parseMessage({ type: 'accountAction', action: 'login', id: 'acct-1' }, cards, ['acct-1']), { ok: true, message: { type: 'accountAction', action: 'login', id: 'acct-1' } }, 'a list works as well as a set');
  assert.deepEqual(ACCOUNT_ACTIONS.slice().sort(), ['check', 'configureStatusLine', 'create', 'details', 'limits', 'login', 'usageLog'], 'no action removes an account, changes a login credential or sends anything');
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

test('the state text of every state is what the person reads: working, waiting for input, ended, state unknown', () => {
  for (const [state, text] of [['working', 'working'], ['waiting', 'waiting for input'], ['ended', 'ended']]) assert.equal(statusOf(session({ deliveryState: hook(state) })).text, text, state);
  assert.equal(statusOf(session({ deliveryState: undefined })).text, 'state unknown');
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
