'use strict';

/**
 * The Command Center's page (issue #309). The HTML is static: it carries no data. The host sends data as a message and the
 * page script builds the screen with `createElement` and `textContent` only, so nothing that came from GitHub, an agent or a
 * session name is ever parsed as HTML. The page may load nothing from outside: the content security policy allows no remote
 * source, no inline event handler and no inline style attribute, and allows exactly one script, identified by a nonce.
 */

const NONCE = /^[A-Za-z0-9+/=_-]{16,64}$/;

// Runs in the web page, not here. Plain functions, no libraries. It only ever posts the messages `parseMessage` accepts.
const SCRIPT = String.raw`
(function () {
  'use strict';
  var vscode = acquireVsCodeApi();
  var root = document.getElementById('app');
  var state = null;
  var dragId = null;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function button(label, onClick, title) {
    var node = el('button', 'btn', label);
    node.type = 'button';
    if (title) node.title = title;
    node.addEventListener('click', onClick);
    return node;
  }
  function post(message) { vscode.postMessage(message); }

  function quotaBlock(card) {
    var box = el('div', 'quota');
    if (card.quota.lines.length === 0) box.appendChild(el('div', 'muted', 'Usage: unknown for this account'));
    card.quota.lines.forEach(function (text) { box.appendChild(el('div', 'quota-line', text)); });
    return box;
  }

  function cardNode(card, pinnedPanel) {
    var node = el('section', 'card status-' + card.status.state + (card.pinned ? ' pinned' : '') + (card.alert ? ' alerting' : ''));
    node.setAttribute('data-id', card.id);
    node.setAttribute('aria-label', card.name);
    if (!pinnedPanel) {
      node.draggable = true;
      node.addEventListener('dragstart', function (event) { dragId = card.id; if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', ''); } });
      node.addEventListener('dragover', function (event) { event.preventDefault(); });
      node.addEventListener('drop', function (event) {
        event.preventDefault();
        if (!dragId || dragId === card.id) return;
        var ids = state.agents.map(function (entry) { return entry.id; });
        var from = ids.indexOf(dragId);
        var to = ids.indexOf(card.id);
        if (from < 0 || to < 0) { dragId = null; return; }
        // The dragged card takes the target's place: after it when it came from before it, before it when it came from after.
        ids.splice(from, 1);
        ids.splice(to, 0, dragId);
        dragId = null;
        post({ type: 'reorder', order: ids });
      });
    }
    var head = el('header', 'card-head');
    var title = el('div', 'card-title');
    title.appendChild(el('strong', null, card.name));
    title.appendChild(el('span', 'muted', ' · ' + card.roleName));
    head.appendChild(title);
    head.appendChild(el('span', 'badge badge-' + card.status.state, card.status.text));
    node.appendChild(head);
    if (card.alert) node.appendChild(el('div', 'alert', card.alert));
    if (!card.collapsed) {
      var body = el('div', 'card-body');
      body.appendChild(el('div', null, card.provider + ' · ' + card.account));
      body.appendChild(el('div', 'muted', 'Model: ' + card.model + ' (' + card.modelNote + ')'));
      body.appendChild(el('div', null, 'Working on: ' + card.task.text));
      if (card.injected) body.appendChild(el('div', 'muted', card.injected));
      if (card.assigned) body.appendChild(el('div', 'muted', 'Handed: ' + card.assigned));
      body.appendChild(el('div', null, 'Worktree: ' + card.worktree));
      var report = el('div', 'report');
      card.report.lines.forEach(function (text, index) { report.appendChild(el('div', index === 0 ? 'report-head' : 'report-line', text)); });
      body.appendChild(report);
      body.appendChild(el('div', 'muted', 'State: ' + card.status.source));
      if (card.autoMode) body.appendChild(el('div', 'muted', card.autoMode));
      body.appendChild(quotaBlock(card));
      if (card.details.length > 0) {
        var details = el('details');
        details.appendChild(el('summary', null, 'Evidence and details'));
        card.details.forEach(function (text) { details.appendChild(el('div', 'detail', text)); });
        body.appendChild(details);
      }
      node.appendChild(body);
    }
    var actions = el('footer', 'card-actions');
    actions.appendChild(button(card.terminalOpen ? 'Focus terminal' : 'Terminal closed', function () { post({ type: 'focus', id: card.id }); }));
    if (card.task.pullRequest !== null) {
      actions.appendChild(button('Open report', function () { post({ type: 'openReport', id: card.id }); }));
      actions.appendChild(button('Open PR', function () { post({ type: 'openPullRequest', id: card.id }); }));
    }
    actions.appendChild(button(card.collapsed ? 'Expand' : 'Collapse', function () { post({ type: 'toggleCollapse', id: card.id }); }));
    actions.appendChild(button(card.pinned ? 'Unpin' : 'Pin', function () { post({ type: 'togglePin', id: card.id }); }));
    node.appendChild(actions);
    return node;
  }

  function accountAction(account, action, label, title) {
    return button(label, function () { post({ type: 'accountAction', action: action, id: account.id }); }, title);
  }

  function accountNode(account) {
    var row = el('div', 'account' + (account.alert ? ' alerting' : ''));
    row.setAttribute('data-account', account.id);
    var head = el('div', 'card-head');
    var title = el('div', 'card-title');
    title.appendChild(el('strong', null, account.label));
    title.appendChild(el('span', 'muted', ' · ' + account.provider));
    head.appendChild(title);
    head.appendChild(el('span', 'badge', account.signIn));
    row.appendChild(head);
    row.appendChild(el('div', 'muted', account.identity + (account.plan ? ' · plan ' + account.plan : '')));
    account.issues.forEach(function (text) { row.appendChild(el('div', 'detail', text)); });
    if (account.alert) row.appendChild(el('div', 'alert', 'Quota: ' + account.alert));
    var usage = el('div', 'quota');
    account.windows.forEach(function (entry) {
      usage.appendChild(el('div', 'quota-line' + (entry.kind === 'unknown' ? ' muted' : ''), entry.label + ': ' + entry.text + ' · ' + entry.trust + ' · ' + entry.resets + ' · ' + entry.read + ' · from ' + entry.source));
    });
    if (account.windows.length === 0 && !account.reason) usage.appendChild(el('div', 'quota-line muted', 'Usage: unknown'));
    row.appendChild(usage);
    var next = null;
    if (account.reason) {
      var why = el('div', 'reason');
      why.appendChild(el('div', 'quota-line', 'Usage: unknown (' + account.reason.short + ')'));
      why.appendChild(el('div', 'detail muted', account.reason.detail));
      if (account.reason.hint) why.appendChild(el('div', 'detail', account.reason.hint));
      row.appendChild(why);
      next = account.reason.next;
    }
    row.appendChild(el('div', 'muted', account.policy));
    row.appendChild(el('div', 'muted', account.agentCount === 0 ? 'No running agent uses this account.' : 'Agents: ' + account.agents.join(', ') + (account.agentCount > account.agents.length ? ' (+' + (account.agentCount - account.agents.length) + ' more)' : '')));
    var actions = el('footer', 'card-actions');
    actions.appendChild(accountAction(account, 'login', 'Sign in'));
    actions.appendChild(accountAction(account, 'check', 'Check sign-in'));
    actions.appendChild(accountAction(account, 'limits', 'Set limits'));
    actions.appendChild(accountAction(account, 'usageLog', 'Token usage log'));
    if (next) actions.appendChild(accountAction(account, next.action, next.label));
    row.appendChild(actions);
    return row;
  }

  function decisionLines(decisions) {
    var box = el('div', 'decisions');
    box.appendChild(el('h3', null, 'Decisions waiting'));
    box.appendChild(el('div', decisions.issues.known ? '' : 'muted', decisions.issues.text));
    box.appendChild(el('div', decisions.pullRequests.known ? '' : 'muted', decisions.pullRequests.text));
    var row = el('div', 'row');
    row.appendChild(button('Issues report', function () { post({ type: 'openReports', kind: 'issue' }); }));
    row.appendChild(button('Pull requests report', function () { post({ type: 'openReports', kind: 'pullRequest' }); }));
    box.appendChild(row);
    return box;
  }

  function render() {
    root.textContent = '';
    if (!state) { root.appendChild(el('p', 'muted', 'Loading…')); return; }
    var bar = el('div', 'toolbar');
    bar.appendChild(el('h1', null, 'Command Center'));
    var tools = el('div', 'row');
    tools.appendChild(button(state.layout.mode === 'grid' ? 'List view' : 'Grid view', function () { post({ type: 'setLayout', mode: state.layout.mode === 'grid' ? 'list' : 'grid' }); }));
    tools.appendChild(button('Team rules…', function () { post({ type: 'editTeamRules' }); }));
    tools.appendChild(button('Export report…', function () { post({ type: 'exportReport' }); }));
    tools.appendChild(button('Assign Issue…', function () { post({ type: 'assignIssue' }); }));
    tools.appendChild(button('Send task…', function () { post({ type: 'sendTask' }); }));
    tools.appendChild(button('Refresh', function () { post({ type: 'refresh' }); }));
    bar.appendChild(tools);
    root.appendChild(bar);
    state.notes.forEach(function (text) { root.appendChild(el('div', 'note', text)); });

    var layout = el('div', 'layout');
    var pm = el('aside', 'pm-panel');
    pm.appendChild(el('h2', null, 'PM'));
    if (state.pm.length === 0) pm.appendChild(el('p', 'muted', 'No PM agent is running. Start a session with a PM role group to pin it here.'));
    state.pm.forEach(function (card) { pm.appendChild(cardNode(card, true)); });
    if (state.alerts.length > 0) {
      var alertBox = el('div', 'decisions');
      alertBox.appendChild(el('h3', null, 'Quota alerts'));
      state.alerts.forEach(function (text) { alertBox.appendChild(el('div', 'alert', text)); });
      pm.appendChild(alertBox);
    }
    pm.appendChild(decisionLines(state.decisions));
    layout.appendChild(pm);

    var rest = el('main', 'agents ' + state.layout.mode);
    rest.appendChild(el('h2', null, 'Agents (' + state.agents.length + ')'));
    if (state.agents.length === 0) rest.appendChild(el('p', 'muted', 'No other agents are running. Start one from an account.'));
    var grid = el('div', 'grid ' + state.layout.mode);
    state.agents.forEach(function (card) { grid.appendChild(cardNode(card, false)); });
    rest.appendChild(grid);
    layout.appendChild(rest);
    root.appendChild(layout);

    var accounts = el('section', 'accounts');
    var accountHead = el('div', 'toolbar');
    accountHead.appendChild(el('h2', null, 'Accounts (' + state.accounts.length + ')'));
    accountHead.appendChild(button('Add account', function () { post({ type: 'accountAction', action: 'create' }); }));
    accounts.appendChild(accountHead);
    if (state.accounts.length === 0) accounts.appendChild(el('p', 'muted', 'No account profiles yet. Add one to see its sign-in and usage here.'));
    state.accounts.forEach(function (account) { accounts.appendChild(accountNode(account)); });
    root.appendChild(accounts);
    root.appendChild(el('p', 'muted', 'Read-only view. Values without a source are shown as unknown.'));
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.type !== 'state' || typeof data.state !== 'object' || data.state === null) return;
    state = data.state;
    render();
  });
  render();
  post({ type: 'ready' });
})();
`;

const STYLE = `
  :root { color-scheme: light dark; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 12px 16px; }
  h1 { font-size: 1.3em; margin: 0; } h2 { font-size: 1.05em; margin: 0 0 8px; } h3 { font-size: 1em; margin: 12px 0 4px; }
  .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  .row { display: flex; gap: 6px; flex-wrap: wrap; }
  .layout { display: flex; gap: 16px; align-items: flex-start; }
  .pm-panel { flex: 0 0 320px; position: sticky; top: 8px; max-height: calc(100vh - 80px); overflow: auto; border-right: 1px solid var(--vscode-panel-border); padding-right: 12px; }
  .agents { flex: 1 1 auto; min-width: 0; }
  .grid.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 10px; }
  .grid.list { display: flex; flex-direction: column; gap: 8px; }
  .card { border: 1px solid var(--vscode-panel-border); border-left-width: 4px; border-radius: 4px; padding: 8px 10px; background: var(--vscode-sideBar-background); }
  .card.status-working { border-left-color: var(--vscode-charts-green); } .card.status-waiting { border-left-color: var(--vscode-charts-yellow); }
  .card.status-ended { border-left-color: var(--vscode-disabledForeground); } .card.status-unknown { border-left-color: var(--vscode-charts-orange); }
  .card.pinned { outline: 1px solid var(--vscode-focusBorder); } .card.alerting, .account.alerting { border-color: var(--vscode-errorForeground); }
  .card-head { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
  .badge { font-size: 0.85em; padding: 1px 6px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); white-space: nowrap; }
  .card-body { margin-top: 6px; display: flex; flex-direction: column; gap: 3px; }
  .card-actions { margin-top: 8px; display: flex; gap: 6px; flex-wrap: wrap; }
  .muted { color: var(--vscode-descriptionForeground); } .alert { color: var(--vscode-errorForeground); margin-top: 4px; }
  .note { padding: 6px 8px; margin-bottom: 8px; border: 1px solid var(--vscode-panel-border); }
  .report { margin-top: 4px; padding-left: 6px; border-left: 2px solid var(--vscode-panel-border); } .report-head { font-weight: 600; } .report-line { font-size: 0.92em; overflow-wrap: anywhere; }
  .quota { margin-top: 4px; } .quota-line, .detail { font-size: 0.92em; overflow-wrap: anywhere; }
  .accounts { margin-top: 16px; } .account { padding: 6px 8px; margin-bottom: 8px; border: 1px solid var(--vscode-panel-border); display: flex; flex-direction: column; gap: 3px; } .reason { margin: 2px 0; }
  .btn { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 0; padding: 3px 8px; cursor: pointer; border-radius: 2px; }
  .btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  @media (max-width: 760px) { .layout { flex-direction: column; } .pm-panel { position: static; flex: none; width: 100%; max-height: none; border-right: 0; padding-right: 0; } }
`;

/**
 * @param {{ nonce: string }} input a fresh random value for this page, used for its one script and its one style
 * @returns {string}
 */
function renderPage({ nonce }) {
  if (typeof nonce !== 'string' || !NONCE.test(nonce)) throw new TypeError('nonce-invalid');
  const policy = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    "img-src 'none'",
    "font-src 'none'",
    "connect-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'"
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Command Center</title><style nonce="${nonce}">${STYLE}</style></head>
<body><div id="app" role="main"></div><script nonce="${nonce}">${SCRIPT}</script></body></html>
`;
}

module.exports = { renderPage, SCRIPT, STYLE };
