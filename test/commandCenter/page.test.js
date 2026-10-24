'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { renderPage, SCRIPT } = require('../../src/commandCenter/page');

const NONCE = 'AbCdEfGhIjKlMnOp-_12';
const html = () => renderPage({ nonce: NONCE });

test('the policy allows nothing from outside: no remote source, no frames, no forms, only this page\'s own nonce', () => {
  const page = html();
  const policy = /Content-Security-Policy" content="([^"]+)"/.exec(page)[1];
  const directives = Object.fromEntries(policy.split('; ').map((entry) => entry.split(' ')).map(([name, ...values]) => [name, values.join(' ')]));
  assert.equal(directives['default-src'], "'none'");
  assert.equal(directives['script-src'], `'nonce-${NONCE}'`);
  assert.equal(directives['style-src'], `'nonce-${NONCE}'`);
  for (const name of ['img-src', 'font-src', 'connect-src', 'frame-src', 'form-action', 'base-uri']) assert.equal(directives[name], "'none'", name);
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval|https?:|\*|data:/);
});

test('the page has exactly one script and one style, both carrying the nonce, and nothing else that runs', () => {
  const page = html();
  assert.equal([...page.matchAll(/<script\b/g)].length, 1);
  assert.equal([...page.matchAll(/<style\b/g)].length, 1);
  assert.equal([...page.matchAll(new RegExp(`nonce="${NONCE}"`, 'g'))].length, 2);
  assert.doesNotMatch(page, /<(iframe|object|embed|link|img|form|base)\b/i, 'no element that loads or submits anything');
  assert.doesNotMatch(page, /\son[a-z]+\s*=/i, 'no inline event handler');
  assert.doesNotMatch(page, /\sstyle\s*=/i, 'no inline style attribute');
  assert.doesNotMatch(page, /javascript:/i);
  assert.doesNotMatch(page, /https?:\/\//, 'the page names no address');
});

test('the page carries no data: it is the same for everything the host knows, and the data arrives as a message', () => {
  assert.equal(html(), renderPage({ nonce: NONCE }));
  assert.notEqual(html(), renderPage({ nonce: 'ZzZzZzZzZzZzZzZz9999' }), 'only the nonce differs');
  assert.doesNotMatch(html(), /\{\{|\$\{/);
});

test('a nonce that is not a fresh random value of the right shape is refused', () => {
  for (const bad of [undefined, null, '', 'short', 'x'.repeat(100), 'has space in it 1234', 'quote"inside1234567', "semi;colon12345678", 5]) assert.throws(() => renderPage({ nonce: bad }), /nonce-invalid/, String(bad));
  assert.throws(() => renderPage(), TypeError);
});

test('the page script builds the screen with text nodes only: no innerHTML, no document.write, no eval, no remote loading', () => {
  assert.doesNotMatch(SCRIPT, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\b|new Function|setTimeout\(\s*['"]|XMLHttpRequest|\bfetch\(|importScripts|\.src\s*=|WebSocket/);
  assert.match(SCRIPT, /textContent/);
  assert.match(SCRIPT, /createElement/);
});

test('the page script sends only messages the host accepts', () => {
  const sent = new Set([...SCRIPT.matchAll(/type: '([A-Za-z]+)'/g)].map((match) => match[1]));
  sent.delete('state');
  const { COMMANDS } = require('../../src/commandCenter/model');
  for (const type of sent) assert.ok(COMMANDS.includes(type), `${type} is not a command the host accepts`);
  for (const type of ['focus', 'openReport', 'openPullRequest', 'toggleCollapse', 'togglePin', 'reorder', 'setLayout', 'refresh', 'ready', 'openReports', 'exportReport', 'editTeamRules', 'assignIssue', 'sendTask', 'startMeeting']) assert.ok(sent.has(type), `${type} is sent by the page`);
});

test('the page really runs: given a state it draws every card, the PM panel and the accounts as text, even for hostile text', () => {
  const posted = [];
  const listeners = {};
  const nodes = [];
  function node(tag) {
    const entry = { tag, className: '', children: [], attrs: {}, listeners: {}, _text: '', draggable: false,
      appendChild(child) { this.children.push(child); return child; },
      setAttribute(name, value) { this.attrs[name] = value; },
      addEventListener(name, fn) { this.listeners[name] = fn; },
      get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); },
      set textContent(value) { this._text = String(value); if (value === '') this.children = []; } };
    nodes.push(entry);
    return entry;
  }
  const app = node('div');
  const sandbox = {
    document: { getElementById: () => app, createElement: node },
    acquireVsCodeApi: () => ({ postMessage: (message) => posted.push(message) }),
    window: { addEventListener: (name, fn) => { listeners[name] = fn; } }
  };
  vm.runInNewContext(SCRIPT, sandbox);
  assert.equal(JSON.stringify(posted), JSON.stringify([{ type: 'ready' }]), 'the page announces itself and nothing else');
  const hostile = '<img src=x onerror=alert(1)>';
  const card = (id, over = {}) => ({ id, name: hostile, role: 'worker', roleName: 'Worker', provider: 'Claude Code', account: 'Main', model: 'sonnet', modelNote: 'requested, not confirmed', status: { state: 'working', text: 'working', source: 'from the CLI\'s own hooks' }, terminalOpen: true, task: { issue: 1, pullRequest: 7, text: 'Issue #1 · PR #7' }, worktree: '2 changed, 0 untracked; 1 ahead, 0 behind its upstream', report: { lines: ['Latest report (PR #7): PM report current', 'User can: open the Command Center', 'Review: approval approved · CI passing'] }, summary: 's', details: ['Branch: x'], quota: { lines: ['Usage (five_hour): 42% used'], policy: '', gate: 'warn' }, autoMode: 'Auto mode: on', alert: 'quota: near the limit', pinned: false, collapsed: false, ...over });
  listeners.message({ data: { type: 'state', state: { layout: { mode: 'grid', order: [], collapsed: [], pinned: [] }, pm: [card('pm-1', { role: 'pm' })], agents: [card('a-1'), card('a-2', { collapsed: true, task: { issue: null, pullRequest: null, text: 'no task is known' } }), card('a-3', { status: { state: 'waiting', text: 'waiting for input', source: 'from the CLI\'s own hooks' }, ide: 'VS Code: not connected (no lock file)' }), card('a-6', { ide: "VS Code: connected through this window's Claude Code port (40002)", trust: 'Folder trust: not pre-written, so Codex asks once (x)' }), card('a-4', { status: { state: 'ended', text: 'ended', source: 'from the CLI\'s own hooks' }, permission: { text: 'Auto mode is not in effect: Claude Code reports default (asks before actions)', attention: true, lines: ['Next: reopen the session'] } }), card('a-5', { status: { state: 'unknown', text: 'state unknown', source: 'no hook evidence' } })], accounts: [
      { id: 'acct', label: 'Main', provider: 'Claude Code', signIn: 'sign-in checked', identity: 'identity verified (abcd1234)', issues: ['Another profile logs in to the same real account.'], plan: null, windows: [{ window: 'five_hour', label: '5-hour', usedPercent: 42, text: '42% used', kind: 'actual', trust: 'verified and current', resets: 'resets in 2h', resetsAt: '2026-10-22T12:00:00.000Z', read: 'read 1m ago', source: 'claude status line rate_limits' }], usageKnown: true, reason: null, policy: 'Limits: warn at 80% used.', gate: 'block', alert: 'new agents on this account are held back', agents: ['Worker One'], agentCount: 3 },
      { id: 'acct-2', label: `Codex <b>${hostile}`, provider: 'Codex CLI', signIn: 'sign-in not checked in this window', identity: 'identity unknown', issues: [], plan: 'plus', windows: [], usageKnown: false, reason: { short: 'no Codex session log yet', detail: 'This account has no session log yet.', hint: 'Run Codex once with this account.', next: { action: 'details', label: 'Open the account details' } }, policy: 'Limits: none set.', gate: null, alert: null, agents: [], agentCount: 0 }
    ],
    alerts: ['Main: new agents on this account are held back'], decisions: { issues: { known: false, text: 'issues: unknown (open the report list to load it)' }, pullRequests: { known: true, text: '2 pull requests need a decision' } }, notes: ['a note'] } } });
  // The Agents tab is shown first (#357); the accounts are on their own tab, reached with one click on it.
  const agentsText = app.textContent;
  assert.equal(agentsText.includes('Accounts (2)'), false, 'the accounts are not on the Agents tab');
  const accountsTab = nodes.filter((entry) => entry.tag === 'button' && entry.attrs.role === 'tab' && entry.textContent === 'Accounts').at(-1);
  assert.ok(accountsTab, 'there is an Accounts tab');
  accountsTab.listeners.click();
  const text = agentsText + app.textContent;
  assert.ok(nodes.some((entry) => entry.tag === 'div' && entry.className === 'detail alert' && entry.textContent === 'Auto mode is not in effect: Claude Code reports default (asks before actions)'), 'a fallen-back auto mode is an alert in the details (#362)');
  assert.ok(nodes.some((entry) => entry.tag === 'span' && entry.className === 'tag tag-warn' && entry.textContent === 'auto mode not in effect'), 'and a yellow tag on the card (#357)');
  assert.ok(text.includes('Next: reopen the session'));
  assert.ok(nodes.some((entry) => entry.tag === 'div' && entry.className === 'detail alert' && entry.textContent === 'VS Code: not connected (no lock file)'), 'a card whose Claude Code cannot reach VS Code says why in its details (#354)');
  assert.ok(nodes.some((entry) => entry.tag === 'div' && entry.className === 'detail' && entry.textContent === "VS Code: connected through this window's Claude Code port (40002)"));
  assert.ok(nodes.some((entry) => entry.tag === 'span' && entry.className === 'tag tag-warn' && entry.textContent === 'VS Code not connected'), 'not connected is a small yellow tag, not a red paragraph (#357)');
  assert.ok(nodes.some((entry) => entry.tag === 'div' && entry.className === 'detail alert' && entry.textContent === 'Folder trust: not pre-written, so Codex asks once (x)'), 'a CLI that will stop to ask is shown as an alert (#362)');
  for (const expected of ['Workbench', 'PM', 'Agents (6)', 'Accounts (2)', 'quota: near the limit', 'Usage: unknown (no Codex session log yet)', 'Decisions waiting', 'issues: unknown', '2 pull requests need a decision', 'a note', 'Values without a source are shown as unknown.']) assert.ok(text.includes(expected), expected);
  for (const expected of ['5-hour: 42% used · verified and current · resets in 2h · read 1m ago · from claude status line rate_limits', 'identity verified (abcd1234)', 'sign-in not checked in this window', 'plan plus', 'Limits: warn at 80% used.', 'Agents: Worker One (+2 more)', 'No running agent uses this account.', 'Quota alerts', 'Main: new agents on this account are held back', 'Quota: new agents on this account are held back', 'This account has no session log yet.', 'Run Codex once with this account.']) assert.ok(text.includes(expected), `the account panel draws: ${expected}`);
  for (const expected of ['waiting for input', 'ended', 'state unknown', 'working']) assert.ok(text.includes(expected), `the status text "${expected}" is drawn on a card`);
  assert.ok(text.includes('Worktree: 2 changed, 0 untracked; 1 ahead, 0 behind its upstream'), 'the card itself carries one line about the working folder');
  for (const expected of ['Latest report (PR #7): PM report current', 'User can: open the Command Center', 'Review: approval approved · CI passing']) assert.ok(text.includes(expected), `the latest report is drawn: ${expected}`);
  assert.ok(nodes.some((entry) => entry.tag === 'span' && entry.className === 'badge badge-waiting' && entry.textContent === 'waiting for input'));
  assert.ok(nodes.some((entry) => entry.tag === 'span' && entry.className === 'badge badge-ended' && entry.textContent === 'ended'));
  assert.ok(nodes.some((entry) => entry.tag === 'section' && /status-waiting/.test(entry.className)) && nodes.some((entry) => entry.tag === 'section' && /status-unknown/.test(entry.className)), 'each state has its own card class');
  const press = (label) => nodes.filter((entry) => entry.tag === 'button' && entry.textContent === label).forEach((entry) => entry.listeners.click());
  const beforeAccounts = posted.length;
  press('Add Claude Code account');
  assert.equal(JSON.stringify(posted.at(-1)), JSON.stringify({ type: 'accountAction', action: 'addClaude' }), 'adding an account names no account');
  assert.equal(posted.length, beforeAccounts + 1);
  press('Add Codex account');
  assert.equal(JSON.stringify(posted.at(-1)), JSON.stringify({ type: 'accountAction', action: 'addCodex' }));
  press('Add with a folder you choose…');
  assert.equal(JSON.stringify(posted.at(-1)), JSON.stringify({ type: 'accountAction', action: 'create' }));
  const second = nodes.find((entry) => entry.tag === 'div' && entry.attrs['data-account'] === 'acct-2');
  const clickIn = (container, label) => { const found = []; const walk = (n) => { if (n.tag === 'button' && n.textContent === label) found.push(n); n.children.forEach(walk); }; walk(container); found[0].listeners.click(); };
  clickIn(second, 'Open the account details');
  assert.equal(JSON.stringify(posted.at(-1)), JSON.stringify({ type: 'accountAction', action: 'details', id: 'acct-2' }), 'the next step is a click');
  for (const [label, action] of [['Sign in', 'login'], ['Check sign-in', 'check'], ['Set limits', 'limits'], ['Token usage log', 'usageLog']]) {
    clickIn(second, label);
    assert.equal(JSON.stringify(posted.at(-1)), JSON.stringify({ type: 'accountAction', action, id: 'acct-2' }), label);
  }
  assert.ok(text.includes(hostile), 'hostile text is drawn as text');
  assert.equal(nodes.some((entry) => entry.tag === 'img' || entry.tag === 'script'), false, 'no element was created from the text');
  // a click on "Focus terminal" posts exactly the whitelisted message
  const buttons = nodes.filter((entry) => entry.tag === 'button');
  buttons.find((entry) => entry.textContent === 'Focus terminal').listeners.click();
  assert.equal(JSON.stringify(posted.at(-1)), JSON.stringify({ type: 'focus', id: 'pm-1' }));
  buttons.find((entry) => entry.textContent === 'Open report').listeners.click();
  assert.equal(JSON.stringify(posted.at(-1)), JSON.stringify({ type: 'openReport', id: 'pm-1' }));
  // dragging one agent card onto another asks for the new order of the agent cards (the PM card cannot be dragged)
  const sections = nodes.filter((entry) => entry.tag === 'section');
  const dragged = sections.find((entry) => entry.attrs['data-id'] === 'a-1');
  const target = sections.find((entry) => entry.attrs['data-id'] === 'a-2');
  assert.equal(sections.find((entry) => entry.attrs['data-id'] === 'pm-1').draggable, false, 'the pinned PM card is not draggable');
  assert.equal(dragged.draggable, true);
  dragged.listeners.dragstart({ dataTransfer: { setData() {}, effectAllowed: '' } });
  target.listeners.drop({ preventDefault() {} });
  assert.equal(JSON.stringify(posted.at(-1)), JSON.stringify({ type: 'reorder', order: ['a-2', 'a-1', 'a-3', 'a-6', 'a-4', 'a-5'] }));
  const before = posted.length;
  target.listeners.drop({ preventDefault() {} });
  assert.equal(posted.length, before, 'a drop without a drag sends nothing');
  listeners.message({ data: { type: 'attack', state: {} } });
  listeners.message({ data: null });
  listeners.message({ data: { type: 'state', state: null } });
  assert.ok(app.textContent.includes('Workbench'), 'messages that are not a valid state change nothing');
});

test('the Workbench has seven tabs; each says what it is for and has a next step, and the host can open one by name (#357)', () => {
  const posted = [];
  const listeners = {};
  const nodes = [];
  function node(tag) {
    const entry = { tag, className: '', children: [], attrs: {}, listeners: {}, _text: '', draggable: false, type: '', id: '',
      appendChild(child) { this.children.push(child); return child; },
      setAttribute(name, value) { this.attrs[name] = value; },
      addEventListener(name, fn) { this.listeners[name] = fn; },
      get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); },
      set textContent(value) { this._text = String(value); if (value === '') this.children = []; } };
    nodes.push(entry);
    return entry;
  }
  const app = node('div');
  vm.runInNewContext(SCRIPT, { document: { getElementById: () => app, createElement: node }, acquireVsCodeApi: () => ({ postMessage: (message) => posted.push(message) }), window: { addEventListener: (name, fn) => { listeners[name] = fn; } } });
  const empty = { layout: { mode: 'grid', order: [], collapsed: [], pinned: [] }, pm: [], agents: [], accounts: [], alerts: [], decisions: { issues: { known: false, text: 'issues: unknown' }, pullRequests: { known: false, text: 'pull requests: unknown' } }, notes: [] };
  listeners.message({ data: { type: 'state', state: empty } });
  const tabs = () => nodes.filter((entry) => entry.tag === 'button' && entry.attrs.role === 'tab').slice(-7);
  assert.deepEqual(tabs().map((entry) => entry.textContent), ['Agents', 'Work', 'Accounts', 'Broadcast', 'Ask', 'Knowledge', 'Setup']);
  assert.equal(tabs()[0].attrs['aria-selected'], 'true', 'the Agents tab is shown first');
  assert.ok(app.textContent.includes('Start agent…') && app.textContent.includes('Next step'), 'with no agent the Agents tab says what to do next');
  for (const label of ['Agents', 'Work', 'Accounts', 'Broadcast', 'Ask', 'Knowledge', 'Setup']) {
    tabs().find((entry) => entry.textContent === label).listeners.click();
    assert.equal(tabs().find((entry) => entry.textContent === label).attrs['aria-selected'], 'true', label);
    assert.ok(app.textContent.includes('Next step'), `${label} has a next step`);
  }
  // The card grid's own rule must not also lay out the agents section (the heading was put into a column of its own, #357).
  assert.equal(nodes.some((entry) => entry.tag === 'main' && /(^| )grid( |$)/.test(entry.className)), false, 'the agents section is not a grid itself');
  // A next-step button posts only a fixed target name.
  tabs().find((entry) => entry.textContent === 'Broadcast').listeners.click();
  nodes.filter((entry) => entry.tag === 'button' && entry.textContent === 'Create broadcast notice…').at(-1).listeners.click();
  assert.equal(JSON.stringify(posted.at(-1)), JSON.stringify({ type: 'open', target: 'broadcastCreate' }));
  tabs().find((entry) => entry.textContent === 'Setup').listeners.click();
  nodes.filter((entry) => entry.tag === 'button' && entry.textContent === 'Show classic views').at(-1).listeners.click();
  assert.equal(JSON.stringify(posted.at(-1)), JSON.stringify({ type: 'showClassicViews' }));
  // The host opens a tab by name; an unknown name changes nothing.
  listeners.message({ data: { type: 'showTab', tab: 'accounts' } });
  assert.equal(tabs().find((entry) => entry.textContent === 'Accounts').attrs['aria-selected'], 'true');
  listeners.message({ data: { type: 'showTab', tab: 'nonsense' } });
  assert.equal(tabs().find((entry) => entry.textContent === 'Accounts').attrs['aria-selected'], 'true');
  const { TARGETS } = require('../../src/commandCenter/model');
  for (const match of SCRIPT.matchAll(/open\('([A-Za-z]+)'\)/g)) assert.ok(Object.hasOwn(TARGETS, match[1]), `the page only names known targets: ${match[1]}`);
});

test('a card says in four plain lines who it is, which account, which mode and what it is doing; the rest is under Details (#357)', () => {
  const nodes = [];
  function node(tag) {
    const entry = { tag, className: '', children: [], attrs: {}, listeners: {}, _text: '', draggable: false, type: '', id: '',
      appendChild(child) { this.children.push(child); return child; },
      setAttribute(name, value) { this.attrs[name] = value; },
      addEventListener(name, fn) { this.listeners[name] = fn; },
      get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); },
      set textContent(value) { this._text = String(value); if (value === '') this.children = []; } };
    nodes.push(entry);
    return entry;
  }
  const app = node('div');
  const listeners = {};
  vm.runInNewContext(SCRIPT, { document: { getElementById: () => app, createElement: node }, acquireVsCodeApi: () => ({ postMessage() {} }), window: { addEventListener: (name, fn) => { listeners[name] = fn; } } });
  const card = { id: 'a-1', codename: 'Worker-01', name: 'Agent One', role: 'worker', roleName: 'Developers', provider: 'Claude Code', account: 'Work A (owner-a@example.test)', model: 'CLI default', modelNote: 'requested, not confirmed', mode: 'Auto', status: { state: 'unknown', text: 'state unknown', source: 'no hook evidence' }, terminalOpen: true, task: { issue: null, pullRequest: null, text: 'no task is known' }, worktree: '0 changed; upstream unknown; at e68869580e0a', report: { lines: ['Latest report: none'] }, summary: '', details: ['Branch: x'], quota: { lines: [], policy: '', gate: null }, autoMode: 'Auto mode: on (won\'t ask)', ide: 'VS Code: not connected (no lock file)', injected: 'Prepared for this agent: 7 rules', alert: null, pinned: false, collapsed: false };
  listeners.message({ data: { type: 'state', state: { layout: { mode: 'grid', order: [], collapsed: [], pinned: [] }, pm: [], agents: [card], accounts: [], alerts: [], decisions: { issues: { known: false, text: 'x' }, pullRequests: { known: false, text: 'y' } }, notes: [] } } });
  const body = nodes.filter((entry) => entry.className === 'card-body').at(-1);
  const top = body.children.filter((child) => child.tag === 'div').map((child) => child.textContent);
  assert.deepEqual(top, ['Claude Code · CLI default', 'Account: Work A (owner-a@example.test)', 'Mode: Auto', 'Doing: no task is known']);
  const details = body.children.find((child) => child.tag === 'details');
  for (const hidden of ['Worktree: 0 changed', 'Prepared for this agent', 'State: no hook evidence', 'VS Code: not connected (no lock file)']) {
    assert.ok(details.textContent.includes(hidden), `${hidden} is in the details`);
    assert.equal(top.some((line) => line.includes(hidden)), false, `${hidden} is not in the plain lines`);
  }
  const footer = nodes.filter((entry) => entry.tag === 'footer').at(-1);
  assert.deepEqual(footer.children.map((child) => child.textContent), ['Focus terminal'], 'one main button');
});
