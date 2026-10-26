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
  // The cards whose Details are open: the cards are drawn again at every refresh, and an open Details stays open.
  var openDetails = {};

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
    // Connected to this window (#354): said as plainly as the opposite, so the owner sees /ide will work for this agent.
    else if (card.ide && /^VS Code: connected/.test(card.ide)) badges.appendChild(el('span', 'tag tag-ok', 'VS Code connected'));
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
      if (openDetails[card.id]) details.open = true;
      details.addEventListener('toggle', function () { if (details.open) openDetails[card.id] = true; else delete openDetails[card.id]; });
      details.appendChild(el('summary', null, 'Details'));
      var more = function (text, className) { details.appendChild(el('div', className || 'detail', text)); };
      // Each fact once, in plain words (#357); the extension decides the lines and which need a look.
      (card.facts || []).forEach(function (fact) { more(fact.text, fact.alert ? 'detail alert' : 'detail'); });
      card.report.lines.forEach(function (text, index) { more(text, index === 0 ? 'detail report-head' : 'detail'); });
      details.appendChild(quotaBlock(card));
      var tools = el('div', 'row');
      tools.appendChild(button(card.collapsed ? 'Expand' : 'Collapse', function () { post({ type: 'toggleCollapse', id: card.id }); }));
      tools.appendChild(button(card.pinned ? 'Unpin' : 'Pin', function () { post({ type: 'togglePin', id: card.id }); }));
      details.appendChild(tools);
      body.appendChild(details);
      node.appendChild(body);
    }
    var actions = el('footer', 'card-actions');
    actions.appendChild(button(card.terminalOpen ? 'Focus terminal' : 'Terminal closed', function () { post({ type: 'focus', id: card.id }); }));
    if (card.terminalOpen) actions.appendChild(button('Stop…', function () { post({ type: 'stopAgent', id: card.id }); }, 'Stop this agent and close its terminal (you are asked first)'));
    actions.appendChild(button('Restart…', function () { post({ type: 'restartAgent', id: card.id }); }, 'Start this agent again with the same account, role group and model, in a new conversation (you are asked first)'));
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
  // The Work tab's board (#397): asked for the first time the tab is shown, and again with its Refresh.
  var board = null;
  var boardAsked = false;
  function showingWork() { if (tab === 'work' && !boardAsked) { boardAsked = true; post({ type: 'loadBoard' }); } }
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
      var node = button(entry.label, function () { tab = entry.id; showingWork(); render(); });
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

  // The work-order board (#397): every open Issue in the column of its stage, read from GitHub and the agents, never written.
  function workTab(panel) {
    panel.appendChild(nextSteps('Next step', [['Refresh board', function () { board = null; render(); post({ type: 'loadBoard' }); }], ['Open Issue or pull request…', function () { open('openGitHubPage'); }], ['Browse GitHub…', function () { open('browseGitHub'); }], ['Assign Issue…', function () { post({ type: 'assignIssue' }); }], ['Export report…', function () { post({ type: 'exportReport' }); }]]));
    if (!board) { panel.appendChild(el('p', 'muted', 'Reading the board from GitHub…')); return; }
    var data = board.board;
    panel.appendChild(el('p', 'muted', 'Read from GitHub ' + (typeof board.readAt === 'string' ? board.readAt.replace('T', ' ').slice(0, 16) + ' UTC' : 'at an unknown time') + '. Each stage comes from GitHub and the agents; nothing here is written anywhere.'));
    if (data.state !== 'ok') { panel.appendChild(el('p', 'alert', data.reason || 'The board could not be read.')); return; }
    (data.notes || []).forEach(function (text) { panel.appendChild(el('p', 'alert', text)); });
    var lanes = el('div', 'board');
    data.columns.forEach(function (column) {
      var lane = el('section', 'lane');
      lane.setAttribute('data-column', column.id);
      lane.appendChild(el('h3', null, column.label + ' (' + column.count + ')'));
      column.cards.forEach(function (card) {
        var item = el('article', 'work-card');
        var title = button((card.kind === 'issue' ? '#' : 'PR #') + card.number + ' ' + card.title, function () { post({ type: 'openWorkItem', kind: card.kind, number: card.number }); }, 'Open its page');
        title.className = 'btn link-btn';
        item.appendChild(title);
        if (card.kind === 'issue') item.appendChild(el('div', 'muted', 'Agent: ' + card.agent));
        if (card.pr) {
          item.appendChild(el('div', null, (card.kind === 'issue' ? 'PR #' + card.pr.number + ' · ' : '') + 'head ' + card.pr.head + ' · ' + card.pr.ci));
          if (card.pr.verdict) item.appendChild(el('div', null, 'PM: ' + card.pr.verdict));
        }
        if (card.refs && card.refs.length) item.appendChild(el('div', 'muted', 'Closes ' + card.refs.join(', ')));
        item.appendChild(el('div', 'muted', 'In this column: ' + card.inColumn));
        var row = el('div', 'row');
        if (card.kind === 'issue' && card.pr) row.appendChild(button('Open PR', function () { post({ type: 'openWorkItem', kind: 'pullRequest', number: card.pr.number }); }));
        if (card.agentId) row.appendChild(button('Focus terminal', function () { post({ type: 'focus', id: card.agentId }); }));
        if (row.children.length) item.appendChild(row);
        lane.appendChild(item);
      });
      if (column.more > 0) lane.appendChild(el('p', 'muted', column.more + ' more not listed (the board shows 30 cards at most).'));
      if (column.count === 0) lane.appendChild(el('p', 'muted', 'none'));
      lanes.appendChild(lane);
    });
    panel.appendChild(lanes);
    panel.appendChild(decisionLines(state.decisions));
  }

  // The Broadcast tab (#357, #360 item 7): one line to every agent of a role group, or to the agents chosen; preview, then send through
  // the extension's own confirmation, then what happened to each agent. Kept across redraws: the choices and the text being written.
  var bc = { mode: 'group', group: null, ids: {}, text: '', preview: null, previewKey: null, results: null };
  var bcBox = null;
  function bcTarget() {
    if (bc.mode === 'group') return bc.group ? { group: bc.group } : null;
    var ids = Object.keys(bc.ids).filter(function (id) { return bc.ids[id]; });
    return ids.length ? { ids: ids } : null;
  }
  function bcKey() { return JSON.stringify([bc.text, bcTarget()]); }
  function broadcastTab(panel) {
    var cards = (state.pm || []).concat(state.agents || []);
    var groups = [];
    cards.forEach(function (card) { if (card.roleGroupId && !groups.some(function (entry) { return entry.id === card.roleGroupId; })) groups.push({ id: card.roleGroupId, name: card.roleName }); });
    if (bc.group && !groups.some(function (entry) { return entry.id === bc.group; })) bc.group = null;
    if (!bc.group && groups.length) bc.group = groups[0].id;
    panel.appendChild(el('p', null, 'Type one line into every running agent of a role group, or into the agents you choose. Each agent gets it only when its CLI is waiting for input.'));
    if (cards.length === 0) { panel.appendChild(el('p', 'muted', 'No agent is running.')); }
    else {
      var modes = el('div', 'row');
      [['group', 'A role group'], ['agents', 'Chosen agents']].forEach(function (entry) {
        var node = button(entry[1], function () { bc.mode = entry[0]; render(); }, null);
        node.className = bc.mode === entry[0] ? 'btn btn-on' : 'btn';
        node.setAttribute('aria-pressed', bc.mode === entry[0] ? 'true' : 'false');
        modes.appendChild(node);
      });
      panel.appendChild(el('h3', null, 'Send to'));
      panel.appendChild(modes);
      var who = el('div', 'bc-who');
      if (bc.mode === 'group') {
        var select = el('select', 'bc-group');
        groups.forEach(function (entry) {
          var option = el('option', null, entry.name + ' (' + cards.filter(function (card) { return card.roleGroupId === entry.id; }).length + ' running)');
          option.value = entry.id;
          if (entry.id === bc.group) option.selected = true;
          select.appendChild(option);
        });
        select.addEventListener('change', function () { bc.group = select.value; bc.preview = null; render(); });
        who.appendChild(select);
      } else {
        cards.forEach(function (card) {
          var label = el('label', 'bc-agent');
          var box = el('input');
          box.type = 'checkbox';
          box.checked = Boolean(bc.ids[card.id]);
          box.addEventListener('change', function () { bc.ids[card.id] = box.checked; bc.preview = null; render(); });
          label.appendChild(box);
          label.appendChild(document.createTextNode(' ' + (card.codename ? card.codename + ' · ' : '') + card.name + ' — ' + card.status.text));
          who.appendChild(label);
        });
      }
      panel.appendChild(who);
      panel.appendChild(el('h3', null, 'What to type'));
      if (!bcBox) {
        bcBox = el('textarea', 'bc-text');
        bcBox.rows = 3;
        bcBox.maxLength = 1500;
        bcBox.placeholder = 'One line, for example: Please pull main and run the tests before you push.';
        bcBox.addEventListener('input', function () { bc.text = bcBox.value; });
      }
      panel.appendChild(bcBox);
      var actions = el('div', 'row');
      var target = bcTarget();
      var previewButton = button('Preview', function () { var chosen = bcTarget(); if (!chosen || !bc.text.trim()) return; bc.previewKey = bcKey(); bc.preview = 'asking'; bc.results = null; render(); var message = { type: 'broadcastPreview', text: bc.text }; if (chosen.group) message.group = chosen.group; else message.ids = chosen.ids; post(message); }, 'See the exact line and who gets it; nothing is typed');
      previewButton.disabled = !target;
      actions.appendChild(previewButton);
      // Send only what was previewed: the same text and the same agents.
      var ready = bc.preview && bc.preview !== 'asking' && bc.preview.ok && bc.previewKey === bcKey();
      var sendButton = button('Send…', function () { var chosen = bcTarget(); if (!chosen) return; var message = { type: 'broadcastSend', text: bc.text }; if (chosen.group) message.group = chosen.group; else message.ids = chosen.ids; bc.results = 'asking'; render(); post(message); }, ready ? 'The extension asks you to confirm before anything is typed' : 'Preview it first');
      sendButton.disabled = !ready;
      actions.appendChild(sendButton);
      panel.appendChild(actions);
      if (bc.preview === 'asking') panel.appendChild(el('p', 'muted', 'Preparing the preview…'));
      else if (bc.preview && !bc.preview.ok) panel.appendChild(el('p', 'alert', bc.preview.reason));
      else if (bc.preview) {
        var box2 = el('section', 'bc-preview');
        box2.appendChild(el('h3', null, 'Preview' + (bc.previewKey === bcKey() ? '' : ' (out of date: preview again)')));
        box2.appendChild(el('pre', 'bc-line', bc.preview.prompt));
        bc.preview.recipients.forEach(function (entry) { box2.appendChild(recipientLine(entry)); });
        panel.appendChild(box2);
      }
      if (bc.results === 'asking') panel.appendChild(el('p', 'muted', 'Waiting for your confirmation in the window…'));
      else if (bc.results) panel.appendChild(resultsBox(bc.results));
    }
    panel.appendChild(nextSteps('Next step', [['Send task…', function () { post({ type: 'sendTask' }); }], ['Create broadcast notice…', function () { open('broadcastCreate'); }], ['Send broadcast to agents…', function () { open('broadcastDeliver'); }]]));
  }

  // The Ask tab (#357, #360 item 5): a question to one agent, with the selected code or not; the agent writes its answer to a file the
  // extension named, and it is shown here as the agent's text: drawn from a tree with textContent, and nothing in it does anything.
  var ask = { target: null, withSelection: true, context: null, status: null, asked: false };
  var askBox = null;
  function mdInline(nodes, parent) {
    (nodes || []).forEach(function (node) {
      if (!node || typeof node !== 'object') return;
      if (node.t === 'text') parent.appendChild(document.createTextNode(String(node.v)));
      else if (node.t === 'code') parent.appendChild(el('code', null, node.v));
      else if (node.t === 'break') parent.appendChild(el('br'));
      else if (node.t === 'strong' || node.t === 'em' || node.t === 'del') { var wrap = el(node.t); mdInline(node.c, wrap); parent.appendChild(wrap); }
      // A link or an image in an answer is shown as its words only: an answer cannot open anything.
      else if (node.t === 'link' || node.t === 'span') { var span = el('span', 'md-inert'); span.title = 'Links in an answer are not opened'; mdInline(node.c, span); parent.appendChild(span); }
      else if (node.t === 'image') parent.appendChild(el('span', 'md-inert', '[Image: ' + (node.alt || 'no description') + ']'));
    });
  }
  function mdBlocks(list, parent) {
    (list || []).forEach(function (block) {
      if (!block || typeof block !== 'object') return;
      if (block.t === 'heading') { var h = el('h' + Math.min(6, Math.max(3, block.level + 2))); mdInline(block.inline, h); parent.appendChild(h); }
      else if (block.t === 'paragraph') { var p = el('p'); mdInline(block.inline, p); parent.appendChild(p); }
      else if (block.t === 'code') { var pre = el('pre', 'md-code'); pre.appendChild(el('code', null, block.text)); parent.appendChild(pre); }
      else if (block.t === 'quote') { var q = el('blockquote'); mdBlocks(block.blocks, q); parent.appendChild(q); }
      else if (block.t === 'rule') parent.appendChild(el('hr'));
      else if (block.t === 'list') { var listNode = el(block.ordered ? 'ol' : 'ul'); (block.items || []).forEach(function (item) { var li = el('li'); if (item.checked === true || item.checked === false) li.appendChild(document.createTextNode(item.checked ? '☑ ' : '☐ ')); mdBlocks(item.blocks, li); listNode.appendChild(li); }); parent.appendChild(listNode); }
      else if (block.t === 'table') { var table = el('table', 'md-table'); var head = el('tr'); (block.head || []).forEach(function (cell) { var th = el('th'); mdInline(cell, th); head.appendChild(th); }); table.appendChild(head); (block.rows || []).forEach(function (row) { var tr = el('tr'); row.forEach(function (cell) { var td = el('td'); mdInline(cell, td); tr.appendChild(td); }); table.appendChild(tr); }); parent.appendChild(table); }
    });
  }
  function askTab(panel) {
    var cards = (state.pm || []).concat(state.agents || []);
    if (ask.target && !cards.some(function (card) { return card.id === ask.target; })) ask.target = null;
    if (!ask.target && cards.length) ask.target = (state.pm && state.pm[0] ? state.pm[0] : cards[0]).id;
    if (!ask.asked) { ask.asked = true; post({ type: 'askContext' }); }
    panel.appendChild(el('p', null, 'Ask one agent a question, for example what the selected code does. It writes its answer to a file of its own, and the answer is shown here.'));
    if (cards.length === 0) panel.appendChild(el('p', 'muted', 'No agent is running.'));
    else {
      panel.appendChild(el('h3', null, 'Ask'));
      var select = el('select', 'ask-agent');
      cards.forEach(function (card) { var option = el('option', null, (card.codename ? card.codename + ' · ' : '') + card.name + ' — ' + card.status.text); option.value = card.id; if (card.id === ask.target) option.selected = true; select.appendChild(option); });
      select.addEventListener('change', function () { ask.target = select.value; });
      panel.appendChild(select);
      var include = el('label', 'ask-include');
      var box = el('input');
      box.type = 'checkbox';
      box.checked = ask.withSelection;
      box.addEventListener('change', function () { ask.withSelection = box.checked; render(); });
      include.appendChild(box);
      include.appendChild(document.createTextNode(' Include the code selected in the editor'));
      panel.appendChild(include);
      var where = ask.context && ask.context.selection ? 'Selected: ' + ask.context.selection.file + ', lines ' + ask.context.selection.startLine + '–' + ask.context.selection.endLine : (ask.context && ask.context.reason ? ask.context.reason : 'Looking at the editor…');
      var row = el('div', 'row');
      row.appendChild(el('span', ask.withSelection ? null : 'muted', where));
      row.appendChild(button('Use the current selection', function () { post({ type: 'askContext' }); }, 'Read the selection of the last editor again'));
      panel.appendChild(row);
      if (!askBox) {
        askBox = el('textarea', 'ask-text');
        askBox.rows = 3;
        askBox.maxLength = 500;
        askBox.placeholder = 'Your question, for example: What does this function do, and when is it called?';
      }
      panel.appendChild(askBox);
      var actions = el('div', 'row');
      actions.appendChild(button('Ask…', function () {
        if (!ask.target || !askBox.value.trim()) return;
        ask.status = { state: 'asking' };
        render();
        post({ type: 'askSend', id: ask.target, question: askBox.value, withSelection: ask.withSelection });
      }, 'The extension shows you the whole question and asks you to confirm before anything is typed'));
      panel.appendChild(actions);
      var status = ask.status;
      if (status) {
        var out = el('section', 'ask-answer');
        if (status.state === 'asking') out.appendChild(el('p', 'muted', 'Waiting for your confirmation in the window…'));
        else if (status.state === 'refused') out.appendChild(el('p', 'alert', status.reason));
        else if (status.state === 'waiting') { out.appendChild(el('p', null, 'Asked ' + status.from + '. Waiting for the answer…')); out.appendChild(el('p', 'muted', 'It is written to ' + status.file + ' and shown here when it is there (up to ten minutes).')); }
        else if (status.state === 'timeout' || status.state === 'invalid') out.appendChild(el('p', 'alert', status.reason));
        else if (status.state === 'answered') {
          out.appendChild(el('h3', null, 'Answer from ' + status.from));
          out.appendChild(el('p', 'muted', 'Written by the agent — only its text, shown as data. Links in it are not opened.'));
          var md = el('div', 'md-answer');
          mdBlocks(status.blocks, md);
          if (status.truncated) md.appendChild(el('p', 'muted', 'The answer is longer than is shown here.'));
          out.appendChild(md);
        }
        panel.appendChild(out);
      }
    }
    panel.appendChild(nextSteps('Next step', [['Talk to PM via GitHub…', function () { post({ type: 'talkToPm' }); }], ['Discuss selection with PM…', function () { open('discussWithPm'); }], ['Start meeting…', function () { post({ type: 'startMeeting' }); }]]));
  }

  // Who gets a line, and what happened to it: the same words on the Broadcast tab and under the "say it" box.
  function recipientLine(entry) {
    var words = entry.decision === 'send' ? 'will receive it (' + entry.reason + ')' : entry.decision === 'unknown' ? 'state unknown: asked separately before it is typed' : 'skipped: ' + entry.reason;
    return el('div', entry.decision === 'skip' ? 'muted' : null, entry.label + ' — ' + words);
  }
  function resultsBox(results) {
    var box = el('section', 'bc-results');
    if (!results.sent) { box.appendChild(el('p', 'muted', 'Nothing was typed.')); return box; }
    var sent = results.results.filter(function (entry) { return entry.outcome === 'sent'; }).length;
    box.appendChild(el('h3', null, 'Typed into ' + sent + ' of ' + results.results.length + ' agents'));
    results.results.forEach(function (entry) { box.appendChild(el('div', entry.outcome === 'sent' ? null : 'muted', entry.label + ' — ' + (entry.outcome === 'sent' ? 'sent' : 'not sent: ' + entry.reason))); });
    box.appendChild(el('p', 'muted', '"Typed" is not proof that the agent read it or will do it.'));
    return box;
  }

  // The "say it" box at the top (#357, #360 guideline 3): one line in plain words. The extension says back what it understood, with the
  // exact line and who gets it; "Do it…" carries out only that, through the same confirmation as the Broadcast and Ask tabs.
  var say = { status: null, text: '' };
  var sayInput = null;
  var sayOut = null;
  var WHO = { agent: 'a task for one agent', group: 'a broadcast to a role group', agents: 'a broadcast to the agents named', everyone: 'a broadcast to every agent' };
  function sayPreview() {
    if (!sayInput.value.trim()) return;
    say.text = sayInput.value;
    say.status = { state: 'asking' };
    drawSay();
    post({ type: 'sayPreview', text: say.text });
  }
  function sayBar() {
    var box = el('div', 'say');
    if (!sayInput) {
      sayInput = el('input', 'say-text');
      sayInput.type = 'text';
      sayInput.maxLength = 500;
      sayInput.placeholder = 'Say what to do, for example: Worker-01, fix the error on the login page — or ask: What does this PR change?';
      sayInput.setAttribute('aria-label', 'Say what to do');
      // A changed line is not the line previewed: its preview goes.
      sayInput.addEventListener('input', function () { if (say.status && say.status.state === 'preview') { say.status = null; drawSay(); } });
      sayInput.addEventListener('keydown', function (event) { if (event.key === 'Enter') { event.preventDefault(); sayPreview(); } });
    }
    // The page is drawn again at every refresh: someone typing here keeps typing, where they were.
    var typing = document.activeElement === sayInput;
    var caret = typing ? [sayInput.selectionStart, sayInput.selectionEnd] : null;
    box.appendChild(sayInput);
    if (typing) setTimeout(function () { sayInput.focus(); if (caret) sayInput.setSelectionRange(caret[0], caret[1]); }, 0);
    box.appendChild(button('Preview', sayPreview, 'See what it would do; nothing is done yet'));
    sayOut = el('div', 'say-out');
    box.appendChild(sayOut);
    drawSay();
    return box;
  }
  function drawSay() {
    if (!sayOut) return;
    sayOut.textContent = '';
    var status = say.status;
    if (!status) return;
    if (status.state === 'asking') { sayOut.appendChild(el('p', 'muted', 'Working out what it means…')); return; }
    if (status.state === 'running') { sayOut.appendChild(el('p', 'muted', 'Waiting for your confirmation in the window…')); return; }
    if (status.state === 'refused') { sayOut.appendChild(el('p', 'alert', status.reason)); return; }
    if (status.state === 'asked') { sayOut.appendChild(el('p', null, 'Asked ' + status.to + '. The answer is shown on the Ask tab.')); return; }
    if (status.state === 'results') { sayOut.appendChild(resultsBox(status)); return; }
    if (status.state !== 'preview') return;
    var box = el('section', 'say-preview');
    if (status.kind === 'ask') {
      box.appendChild(el('h3', null, 'Understood: a question for ' + status.to));
      box.appendChild(el('pre', 'bc-line', status.question));
      if (status.selection) box.appendChild(el('div', null, 'With the selected code: ' + status.selection.file + ', lines ' + status.selection.startLine + '–' + status.selection.endLine));
      box.appendChild(el('p', 'muted', 'Its answer is shown on the Ask tab.'));
    } else {
      box.appendChild(el('h3', null, 'Understood: ' + (WHO[status.to] || 'a broadcast')));
      box.appendChild(el('pre', 'bc-line', status.prompt));
      (status.recipients || []).forEach(function (entry) { box.appendChild(recipientLine(entry)); });
    }
    var row = el('div', 'row');
    row.appendChild(button(status.kind === 'ask' ? 'Ask…' : 'Send…', function () { say.status = { state: 'running' }; drawSay(); post({ type: 'sayRun', text: say.text }); }, 'The extension shows it whole and asks you to confirm before anything is typed'));
    row.appendChild(button('Cancel', function () { say.status = null; drawSay(); }));
    box.appendChild(row);
    sayOut.appendChild(box);
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
    root.appendChild(sayBar());
    root.appendChild(tabBar());
    var panel = el('section', 'tab-panel');
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', 'tab-' + tab);
    if (tab === 'agents') agentsTab(panel);
    else if (tab === 'accounts') accountsTab(panel);
    else if (tab === 'work') workTab(panel);
    else if (tab === 'broadcast') broadcastTab(panel);
    else if (tab === 'ask') askTab(panel);
    else if (tab === 'knowledge') knowledgeTab(panel);
    else if (tab === 'setup') placeholderTab(panel, 'Tools, CLIs, modes and the default models.', '#357', [['Check tools again', function () { open('setupRefresh'); }], ['Open diagnostics', function () { open('setupDiagnose'); }], ['Sessions…', function () { open('sessions'); }], ['Show classic views', function () { post({ type: 'showClassicViews' }); }]]);
    root.appendChild(panel);
    root.appendChild(el('p', 'muted', 'Values without a source are shown as unknown.'));
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (data && data.type === 'showTab' && TABS.some(function (entry) { return entry.id === data.tab; })) { tab = data.tab; showingWork(); render(); return; }
    if (data && data.type === 'board' && data.board && typeof data.board === 'object') { board = data; if (tab === 'work') render(); return; }
    if (data && data.type === 'broadcastPreview') { bc.preview = data.ok ? { ok: true, prompt: String(data.prompt), recipients: Array.isArray(data.recipients) ? data.recipients : [] } : { ok: false, reason: String(data.reason) }; if (tab === 'broadcast') render(); return; }
    if (data && data.type === 'sayState') { say.status = data; drawSay(); return; }
    if (data && data.type === 'askState') {
      if (data.state === 'context') ask.context = { selection: data.selection && typeof data.selection === 'object' ? data.selection : null, reason: data.reason ? String(data.reason) : null };
      else ask.status = data;
      if (tab === 'ask') render();
      return;
    }
    if (data && data.type === 'broadcastResults') { bc.results = { sent: data.sent === true, results: Array.isArray(data.results) ? data.results : [] }; if (tab === 'broadcast') render(); return; }
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
  .say { display: grid; grid-template-columns: 1fr auto; gap: 6px; margin-bottom: 12px; }
  .say-text { padding: 6px 8px; font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); }
  .say-out { grid-column: 1 / -1; }
  .say-preview { border: 1px solid var(--vscode-panel-border); padding: 8px; }
  .row { display: flex; gap: 6px; flex-wrap: wrap; }
  .badges { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
  .tag { font-size: 0.8em; padding: 1px 6px; border-radius: 8px; white-space: nowrap; }
  .tag-warn { background: transparent; color: var(--vscode-editorWarning-foreground); border: 1px solid var(--vscode-editorWarning-foreground); }
  .tag-ok { background: transparent; color: var(--vscode-charts-green); border: 1px solid var(--vscode-charts-green); }
  .board { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 6px; align-items: start; margin: 8px 0; }
  @media (max-width: 900px) { .board { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
  .lane { min-width: 0; border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 6px; background: var(--vscode-sideBar-background); overflow-wrap: anywhere; }
  .lane h3 { margin: 0 0 6px; font-size: 0.95em; }
  .work-card { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 6px; margin-bottom: 6px; background: var(--vscode-editor-background); font-size: 0.9em; display: flex; flex-direction: column; gap: 2px; }
  .btn.link-btn { background: transparent; color: var(--vscode-textLink-foreground); padding: 0; text-align: left; font-weight: 600; }
  .btn-on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .bc-who { display: flex; flex-direction: column; gap: 2px; margin: 4px 0; } .bc-agent { cursor: pointer; }
  .bc-text { width: 100%; box-sizing: border-box; font-family: var(--vscode-editor-font-family); color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding: 6px; }
  .bc-preview, .bc-results { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 6px 10px; margin: 8px 0; }
  .bc-line { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--vscode-textCodeBlock-background); padding: 6px; }
  .ask-agent { margin: 4px 0; } .ask-include { display: block; margin: 6px 0; cursor: pointer; }
  .ask-text { width: 100%; box-sizing: border-box; font-family: var(--vscode-editor-font-family); color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding: 6px; margin: 6px 0; }
  .ask-answer { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 6px 12px; margin: 8px 0; }
  .md-answer { overflow-wrap: anywhere; line-height: 1.5; } .md-code { background: var(--vscode-textCodeBlock-background); padding: 6px 8px; overflow-x: auto; }
  .md-inert { text-decoration: underline dotted; } .md-table td, .md-table th { border: 1px solid var(--vscode-panel-border); padding: 2px 6px; }
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
