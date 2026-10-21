'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCards, describeDecisions, normalizeLayout, arrange, parseMessage, applyLayoutMessage, statusOf, COMMANDS, MAX_IDS } = require('../../src/commandCenter/model');

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
  for (const message of [{ type: 'ready' }, { type: 'refresh' }, { type: 'setLayout', mode: 'list' }, { type: 'reorder', order: ['b', 'a'] }, { type: 'toggleCollapse', id: 'a' }, { type: 'togglePin', id: 'b' }, { type: 'focus', id: 'a' }, { type: 'openReport', id: 'a' }, { type: 'openPullRequest', id: 'a' }, { type: 'openReports', kind: 'issue' }, { type: 'openReports', kind: 'pullRequest' }]) {
    assert.deepEqual(ok(message), { ok: true, message }, JSON.stringify(message));
  }
  const refused = [
    [{ type: 'delete' }, 'unknown-command'], [{ type: 'stop', id: 'a' }, 'unknown-command'], [{ type: 'executeCommand', command: 'x' }, 'unknown-command'], [{}, 'unknown-command'], [null, 'unknown-command'], ['focus', 'unknown-command'], [[], 'unknown-command'], [{ type: 5 }, 'unknown-command'], [{ type: '__proto__' }, 'unknown-command'],
    [{ type: 'focus', id: 'a', extra: 1 }, 'unexpected-field'], [{ type: 'ready', id: 'a' }, 'unexpected-field'], [{ type: 'focus', id: 'a', command: 'multiagentSystem.sessions.stop' }, 'unexpected-field'],
    [{ type: 'focus', id: 'zzz' }, 'unknown-id'], [{ type: 'focus' }, 'unknown-id'], [{ type: 'focus', id: 5 }, 'unknown-id'], [{ type: 'focus', id: '../a' }, 'unknown-id'], [{ type: 'togglePin', id: 'constructor' }, 'unknown-id'],
    [{ type: 'setLayout', mode: 'tiles' }, 'invalid-field'], [{ type: 'setLayout' }, 'invalid-field'], [{ type: 'reorder', order: 'a' }, 'invalid-field'], [{ type: 'reorder', order: ['a', 'a'] }, 'invalid-field'], [{ type: 'reorder', order: ['a', 'x'] }, 'invalid-field'], [{ type: 'reorder', order: Array(201).fill('a') }, 'invalid-field'], [{ type: 'openReports', kind: 'repo' }, 'invalid-field']
  ];
  for (const [message, reason] of refused) assert.deepEqual(ok(message), { ok: false, reason }, JSON.stringify(message));
  assert.deepEqual(parseMessage({ type: 'focus', id: 'a' }, undefined), { ok: false, reason: 'unknown-id' }, 'with no cards on screen no id is known');
  assert.deepEqual(parseMessage({ type: 'focus', id: 'a' }, ['a']), { ok: true, message: { type: 'focus', id: 'a' } }, 'a list works as well as a set');
});

test('the command list is exactly what the page can send: nothing that stops, starts, sends or publishes', () => {
  assert.deepEqual([...COMMANDS].sort(), ['focus', 'openPullRequest', 'openReport', 'openReports', 'ready', 'refresh', 'reorder', 'setLayout', 'toggleCollapse', 'togglePin']);
});
