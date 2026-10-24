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
    if (card.codename) title.appendChild(el('span', 'codename', card.codename + ' · '));
    title.appendChild(el('strong', null, card.name));
    title.appendChild(el('span', 'muted', ' · ' + card.roleName));
    head.appendChild(title);
    var badges = el('div', 'badges');
    badges.appendChild(el('span', 'badge badge-' + card.status.state, card.status.text));
    // What needs a look is a small yellow tag in words (#357); the reason is in the details below.
    if (card.ide && /not connected/.test(card.ide)) badges.appendChild(el('span', 'tag tag-warn', 'VS Code not connected'));
    if (card.trust && /asks once/.test(card.trust)) badges.appendChild(el('span', 'tag tag-warn', 'will ask to trust the folder'));
    if (card.permission && card.permission.attention) badges.appendChild(el('span', 'tag tag-warn', 'auto mode not in effect'));
    head.appendChild(badges);
    node.appendChild(head);
    if (card.alert) node.appendChild(el('div', 'alert', card.alert));
    if (!card.collapsed) {
      // The card in plain words (#357): who, which account, which mode, what it is doing. Everything else is in Details.
      var body = el('div', 'card-body');
      body.appendChild(el('div', null, card.provider + ' · ' + card.model));
      body.appendChild(el('div', null, 'Account: ' + card.account));
      body.appendChild(el('div', null, 'Mode: ' + card.mode));
      body.appendChild(el('div', null, 'Doing: ' + card.task.text));
      var details = el('details');
      details.appendChild(el('summary', null, 'Details'));
      var more = function (text, className) { details.appendChild(el('div', className || 'detail', text)); };
      more('Model: ' + card.model + ' (' + card.modelNote + ')');
      if (card.autoMode) more(card.autoMode);
      if (card.permission) {
        more(card.permission.text, card.permission.attention ? 'detail alert' : 'detail');
        card.permission.lines.forEach(function (text) { more(text); });
      }
      if (card.ide) more(card.ide, /not connected/.test(card.ide) ? 'detail alert' : 'detail');
      if (card.trust) more(card.trust, /asks once/.test(card.trust) ? 'detail alert' : 'detail');
      if (card.injected) more(card.injected);
      if (card.assigned) more('Handed: ' + card.assigned);
      more('Worktree: ' + card.worktree);
      card.report.lines.forEach(function (text, index) { more(text, index === 0 ? 'detail report-head' : 'detail'); });
      more('State: ' + card.status.source);
      details.appendChild(quotaBlock(card));
      card.details.forEach(function (text) { more(text); });
      var tools = el('div', 'row');
      tools.appendChild(button(card.collapsed ? 'Expand' : 'Collapse', function () { post({ type: 'toggleCollapse', id: card.id }); }));
      tools.appendChild(button(card.pinned ? 'Unpin' : 'Pin', function () { post({ type: 'togglePin', id: card.id }); }));
      details.appendChild(tools);
      body.appendChild(details);
      node.appendChild(body);
    }
    var actions = el('footer', 'card-actions');
    actions.appendChild(button(card.terminalOpen ? 'Focus terminal' : 'Terminal closed', function () { post({ type: 'focus', id: card.id }); }));
    actions.appendChild(button('Switch account…', function () { post({ type: 'switchAccount', id: card.id }); }, 'Restart this agent with another account (you are asked first)'));
    if (card.task.pullRequest !== null) {
      actions.appendChild(button('Open report', function () { post({ type: 'openReport', id: card.id }); }));
      actions.appendChild(button('Open PR', function () { post({ type: 'openPullRequest', id: card.id }); }));
    }
    if (card.collapsed) actions.appendChild(button('Expand', function () { post({ type: 'toggleCollapse', id: card.id }); }));
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
    if (account.email) title.appendChild(el('span', null, ' · ' + account.email));
    title.appendChild(el('span', 'muted', ' · ' + account.provider));
    head.appendChild(title);
    head.appendChild(el('span', 'badge', account.signIn));
    row.appendChild(head);
    row.appendChild(el('div', 'muted', account.identity + (account.plan ? ' · plan ' + account.plan : '')));
    account.issues.forEach(function (text) { row.appendChild(el('div', 'detail', text)); });
    if (account.alert) row.appendChild(el('div', 'alert', 'Quota: ' + account.alert));
    // Usage in plain words (#352): how much is used and when it resets. How it was read, and from where, is under Details.
    var usage = el('div', 'quota');
    account.windows.forEach(function (entry) {
      var plain = entry.label + ': ' + entry.text + (entry.kind === 'unknown' ? '' : ', ' + entry.resets) + (entry.caveat ? ' (' + entry.caveat + ')' : '');
      usage.appendChild(el('div', 'quota-line' + (entry.kind === 'unknown' ? ' muted' : ''), plain));
    });
    if (account.windows.length === 0 && !account.reason) usage.appendChild(el('div', 'quota-line muted', 'Usage: unknown'));
    if (account.windows.length > 0) {
      var source = el('details');
      source.appendChild(el('summary', null, 'Details'));
      account.windows.forEach(function (entry) {
        source.appendChild(el('div', 'detail muted', entry.label + ': ' + entry.trust + ' · ' + entry.read + ' · from ' + entry.source));
      });
      usage.appendChild(source);
    }
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

  // The Workbench tabs (#357). Every tab says what it is for and has at least one next step; a tab whose own screen is not built yet
  // says which issue builds it and opens the existing commands meanwhile.
  var TABS = [
    { id: 'agents', label: 'Agents' }, { id: 'work', label: 'Work' }, { id: 'accounts', label: 'Accounts' },
    { id: 'broadcast', label: 'Broadcast' }, { id: 'ask', label: 'Ask' }, { id: 'knowledge', label: 'Knowledge' }, { id: 'setup', label: 'Setup' }
  ];
  var tab = 'agents';
  function open(target) { post({ type: 'open', target: target }); }
  function nextSteps(title, steps) {
    var box = el('div', 'next');
    box.appendChild(el('h3', null, title));
    var row = el('div', 'row');
    steps.forEach(function (step) { row.appendChild(button(step[0], step[1])); });
    box.appendChild(row);
    return box;
  }
  function tabBar() {
    var bar = el('div', 'tabs');
    bar.setAttribute('role', 'tablist');
    TABS.forEach(function (entry) {
      var node = button(entry.label, function () { tab = entry.id; render(); });
      node.className = 'tab' + (tab === entry.id ? ' tab-selected' : '');
      node.setAttribute('role', 'tab');
      node.setAttribute('aria-selected', tab === entry.id ? 'true' : 'false');
      node.id = 'tab-' + entry.id;
      bar.appendChild(node);
    });
    return bar;
  }

  function agentsTab(panel) {
    var tools = el('div', 'row');
    tools.appendChild(button('Start agent…', function () { open('startAgent'); }));
    tools.appendChild(button('Edit role group…', function () { open('editRole'); }, 'Rename a role group, set its default account, its tools or its instructions'));
    tools.appendChild(button(state.layout.mode === 'grid' ? 'List view' : 'Grid view', function () { post({ type: 'setLayout', mode: state.layout.mode === 'grid' ? 'list' : 'grid' }); }));
    tools.appendChild(button('Send task…', function () { post({ type: 'sendTask' }); }));
    tools.appendChild(button('Assign Issue…', function () { post({ type: 'assignIssue' }); }));
    tools.appendChild(button('Refresh', function () { post({ type: 'refresh' }); }));
    panel.appendChild(tools);
    state.notes.forEach(function (text) { panel.appendChild(el('div', 'note', text)); });
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
    // Not "agents grid": the .grid rule below lays out the cards, and would also have put the heading into a column of its own.
    var rest = el('main', 'agents agents-' + state.layout.mode);
    rest.appendChild(el('h2', null, 'Agents (' + state.agents.length + ')'));
    if (state.agents.length === 0) {
      rest.appendChild(el('p', 'muted', 'No other agents are running.'));
      rest.appendChild(nextSteps('Next step', [['Start agent…', function () { open('startAgent'); }], ['Add Claude Code account', function () { post({ type: 'accountAction', action: 'addClaude' }); }], ['Create role group…', function () { open('createRole'); }]]));
    }
    var grid = el('div', 'grid ' + state.layout.mode);
    state.agents.forEach(function (card) { grid.appendChild(cardNode(card, false)); });
    rest.appendChild(grid);
    layout.appendChild(rest);
    panel.appendChild(layout);
  }

  function accountsTab(panel) {
    var head = el('div', 'toolbar');
    head.appendChild(el('h2', null, 'Accounts (' + state.accounts.length + ')'));
    var adds = el('div', 'row');
    adds.appendChild(button('Add Claude Code account', function () { post({ type: 'accountAction', action: 'addClaude' }); }));
    adds.appendChild(button('Add Codex account', function () { post({ type: 'accountAction', action: 'addCodex' }); }));
    adds.appendChild(button('Add with a folder you choose…', function () { post({ type: 'accountAction', action: 'create' }); }));
    head.appendChild(adds);
    panel.appendChild(head);
    if (state.accounts.length === 0) {
      panel.appendChild(el('p', 'muted', 'No account profiles yet. Add one to see its sign-in and usage here.'));
      panel.appendChild(nextSteps('Next step', [['Add Claude Code account', function () { post({ type: 'accountAction', action: 'addClaude' }); }], ['Add Codex account', function () { post({ type: 'accountAction', action: 'addCodex' }); }]]));
    }
    state.accounts.forEach(function (account) { panel.appendChild(accountNode(account)); });
  }

  // The skills library (#359): what each skill is for, whether it is in use, which role groups get it, and the buttons for it.
  function knowledgeTab(panel) {
    var skills = state.skills || { known: false, text: 'Skills: unknown.', items: [] };
    var head = el('div', 'toolbar');
    head.appendChild(el('h2', null, skills.text));
    var adds = el('div', 'row');
    adds.appendChild(button('Add skill…', function () { open('skillAdd'); }, 'Write a new skill: its name, one line saying when to use it, and its steps'));
    adds.appendChild(button('Add starter skills…', function () { open('skillStarters'); }, 'Open a PR, run the tests, rebase, answer a review, take an issue, and more'));
    adds.appendChild(button('Bring in this repository\'s skills…', function () { open('skillImport'); }, 'The skills in .claude/skills and .agents/skills of this project'));
    adds.appendChild(button('Write skills into this repository…', function () { open('skillExport'); }, 'For the CLIs to find them in .claude/skills and .agents/skills (existing files are never replaced)'));
    head.appendChild(adds);
    panel.appendChild(head);
    panel.appendChild(el('p', 'muted', 'An agent is told only the name and one line of each skill given to its role group, and reads a skill when it needs it.'));
    if (skills.items.length === 0) {
      panel.appendChild(el('p', 'muted', skills.known ? 'No skill yet.' : 'The skills library could not be read; adding a skill tries again.'));
      panel.appendChild(nextSteps('Next step', [['Add starter skills…', function () { open('skillStarters'); }], ['Add skill…', function () { open('skillAdd'); }]]));
    }
    skills.items.forEach(function (skill) {
      var row = el('div', 'account skill');
      row.setAttribute('data-skill', skill.name);
      var top = el('div', 'card-head');
      top.appendChild(el('strong', null, skill.name));
      top.appendChild(el('span', skill.state === 'active' && skill.usable ? 'badge' : 'tag tag-warn', !skill.usable ? 'cannot be used' : skill.state === 'active' ? 'on' : skill.state === 'disabled' ? 'off' : skill.state === 'candidate' ? 'suggested by an agent' : 'unknown'));
      row.appendChild(top);
      row.appendChild(el('div', null, skill.description));
      row.appendChild(el('div', 'muted', skill.roles.length ? 'For: ' + skill.roles.join(', ') : 'For no role group yet'));
      if (skill.problem) row.appendChild(el('div', 'alert', 'Not given to any agent: ' + skill.problem + '. Edit it to fix it.'));
      var act = el('footer', 'card-actions');
      var action = function (name, label, title) { act.appendChild(button(label, function () { post({ type: 'skillAction', action: name, name: skill.name }); }, title)); };
      action('edit', 'Edit', 'Open the skill in the editor; save to keep it');
      if (skill.state === 'candidate') action('approve', 'Approve…', 'Read it first; an approved skill is an ordinary skill');
      else { action('toggle', skill.state === 'active' ? 'Turn off' : 'Turn on'); action('roles', 'Role groups…', 'Which role groups get this skill'); }
      action('remove', 'Remove…');
      row.appendChild(act);
      panel.appendChild(row);
    });
    panel.appendChild(nextSteps('Rules and shared memory', [['Team rules…', function () { post({ type: 'editTeamRules' }); }], ['Add shared memory note…', function () { open('memoryAdd'); }], ['Review suggested memory…', function () { open('memoryReview'); }]]));
  }

  function placeholderTab(panel, what, issue, steps) {
    panel.appendChild(el('p', null, what));
    panel.appendChild(el('p', 'muted', 'This tab gets its own screen in ' + issue + '. Until then these open the existing windows:'));
    panel.appendChild(nextSteps('Next step', steps));
  }

  function render() {
    root.textContent = '';
    if (!state) { root.appendChild(el('p', 'muted', 'Loading…')); return; }
    var bar = el('div', 'toolbar');
    bar.appendChild(el('h1', null, 'Workbench'));
    root.appendChild(bar);
    root.appendChild(tabBar());
    var panel = el('section', 'tab-panel');
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', 'tab-' + tab);
    if (tab === 'agents') agentsTab(panel);
    else if (tab === 'accounts') accountsTab(panel);
    else if (tab === 'work') {
      panel.appendChild(decisionLines(state.decisions));
      placeholderTab(panel, 'Issues and pull requests of this project, and what waits for your decision.', '#353', [['Open Issue or pull request…', function () { open('openGitHubPage'); }], ['Browse GitHub…', function () { open('browseGitHub'); }], ['Assign Issue…', function () { post({ type: 'assignIssue' }); }], ['Export report…', function () { post({ type: 'exportReport' }); }]]);
    } else if (tab === 'broadcast') placeholderTab(panel, 'Tell every agent of a role group, or the agents you choose, the same thing.', '#357', [['Send task…', function () { post({ type: 'sendTask' }); }], ['Create broadcast notice…', function () { open('broadcastCreate'); }], ['Send broadcast to agents…', function () { open('broadcastDeliver'); }]]);
    else if (tab === 'ask') placeholderTab(panel, 'Ask the PM or an agent a question, for example what the selected code does.', '#353', [['Talk to PM via GitHub…', function () { post({ type: 'talkToPm' }); }], ['Discuss selection with PM…', function () { open('discussWithPm'); }], ['Start meeting…', function () { post({ type: 'startMeeting' }); }]]);
    else if (tab === 'knowledge') knowledgeTab(panel);
    else if (tab === 'setup') placeholderTab(panel, 'Tools, CLIs, modes and the default models.', '#357', [['Check tools again', function () { open('setupRefresh'); }], ['Open diagnostics', function () { open('setupDiagnose'); }], ['Sessions…', function () { open('sessions'); }], ['Show classic views', function () { post({ type: 'showClassicViews' }); }]]);
    root.appendChild(panel);
    root.appendChild(el('p', 'muted', 'Values without a source are shown as unknown.'));
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (data && data.type === 'showTab' && TABS.some(function (entry) { return entry.id === data.tab; })) { tab = data.tab; render(); return; }
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
  .badges { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
  .tag { font-size: 0.8em; padding: 1px 6px; border-radius: 8px; white-space: nowrap; }
  .tag-warn { background: transparent; color: var(--vscode-editorWarning-foreground); border: 1px solid var(--vscode-editorWarning-foreground); }
  .tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 12px; flex-wrap: wrap; }
  .tab { background: transparent; color: var(--vscode-foreground); border: 0; border-bottom: 2px solid transparent; padding: 6px 12px; cursor: pointer; }
  .tab:hover { background: var(--vscode-toolbar-hoverBackground); }
  .tab:focus-visible, .btn:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .tab-selected { border-bottom-color: var(--vscode-focusBorder); font-weight: 600; }
  .next { margin: 12px 0; } .tab-panel > .row { margin-bottom: 10px; }
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
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Workbench</title><style nonce="${nonce}">${STYLE}</style></head>
<body><div id="app" role="main"></div><script nonce="${nonce}">${SCRIPT}</script></body></html>
`;
}

module.exports = { renderPage, SCRIPT, STYLE };
