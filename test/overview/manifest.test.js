'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const { contributes } = manifest;
const VIEWS = ['multiagentSystem.overviewView', 'multiagentSystem.issuesReportView', 'multiagentSystem.prsReportView', 'multiagentSystem.githubView', 'multiagentSystem.accountsView', 'multiagentSystem.rolesView', 'multiagentSystem.broadcastsView', 'multiagentSystem.toolsSetupView'];

test('the activity bar has a Multiagent container with an icon that exists', () => {
  const [container] = contributes.viewsContainers.activitybar;
  assert.deepEqual([container.id, container.title], ['multiagentSystem', 'Multiagent']);
  assert.equal(contributes.viewsContainers.activitybar.length, 1);
  const icon = path.join(root, container.icon);
  assert.ok(fs.existsSync(icon), 'icon file exists');
  const svg = fs.readFileSync(icon, 'utf8');
  assert.match(svg, /<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.equal(/<script|onload|href=|xlink:href|<image|<foreignObject/i.test(svg), false, 'the icon holds no script or external reference');
});

test('the overview is first, the three existing lists moved in, and nothing is left in the Explorer', () => {
  assert.deepEqual(contributes.views.multiagentSystem.map((view) => view.id), VIEWS);
  assert.equal(contributes.views.explorer, undefined);
  for (const id of VIEWS) assert.equal(Object.values(contributes.views).flat().filter((view) => view.id === id).length, 1, `${id} appears once`);
  for (const view of contributes.views.multiagentSystem) assert.ok(view.name && view.name.length > 2);
});

test('every list has an empty-state explanation with a button that runs a declared command', () => {
  const declared = new Set(contributes.commands.map((entry) => entry.command));
  for (const id of VIEWS) {
    const welcome = contributes.viewsWelcome.filter((entry) => entry.view === id);
    assert.equal(welcome.length, 1, `${id} has one welcome text`);
    const links = [...welcome[0].contents.matchAll(/\(command:([A-Za-z.]+)\)/g)].map((match) => match[1]);
    assert.ok(links.length >= 1, `${id} offers a next step`);
    for (const command of links) assert.ok(declared.has(command), `${command} is declared`);
    assert.ok(welcome[0].contents.split('\n')[0].length > 30, `${id} explains the empty state`);
  }
});

test('every command used by a menu is declared, and the overview row actions exist', () => {
  const declared = new Set(contributes.commands.map((entry) => entry.command));
  for (const menu of Object.values(contributes.menus)) for (const item of menu) assert.ok(declared.has(item.command), `${item.command} is used in a menu but not declared`);
  const overview = contributes.menus['view/item/context'].filter((item) => item.when.includes('multiagentSystem.overviewView'));
  const agentOverview = overview.filter((item) => item.when.includes('multiagentOverviewAgent'));
  assert.deepEqual(agentOverview.map((item) => item.command).sort(), ['multiagentSystem.overview.openPullRequest', 'multiagentSystem.overview.openReport', 'multiagentSystem.overview.showDiff', 'multiagentSystem.sessions.focus', 'multiagentSystem.sessions.rename', 'multiagentSystem.sessions.reopen', 'multiagentSystem.sessions.stop']);
  for (const item of agentOverview) assert.match(item.when, /viewItem =~ \/\^multiagentOverviewAgent/);
  for (const cmd of ['multiagentSystem.overview.openPullRequest', 'multiagentSystem.overview.openReport', 'multiagentSystem.overview.showDiff']) {
    const item = agentOverview.find((entry) => entry.command === cmd);
    assert.match(item.when, /\(Live\|Closed\)Pr\$/, `${cmd} appears only on rows that have a verified pull request`);
  }
  const accountOverview = overview.filter((item) => item.when.includes('multiagentOverviewAccount'));
  assert.deepEqual(accountOverview.map((item) => item.command).sort(), [
    'multiagentSystem.accounts.check',
    'multiagentSystem.accounts.details',
    'multiagentSystem.accounts.edit',
    'multiagentSystem.accounts.launch',
    'multiagentSystem.accounts.limits',
    'multiagentSystem.accounts.login'
  ]);
  for (const item of accountOverview) assert.match(item.when, /viewItem =~ \/\^multiagentOverviewAccount/);
});

test('the overview activates the extension, and the extension never declares untrusted-workspace support', () => {
  assert.ok(manifest.activationEvents.includes('onView:multiagentSystem.overviewView'));
  assert.equal(Object.hasOwn(manifest, 'capabilities'), false, 'no capabilities block, so Restricted Mode keeps the extension off');
  assert.equal(JSON.stringify(manifest).includes('untrustedWorkspaces'), false);
});

test('Tools Setup has refresh plus verified gh, Codex, and Claude retry actions, and activates the extension', () => {
  const declared = new Set(contributes.commands.map((entry) => entry.command));
  for (const command of ['multiagentSystem.setup.refresh', 'multiagentSystem.setup.retryGh', 'multiagentSystem.setup.retryCodex', 'multiagentSystem.setup.retryClaude']) assert.ok(declared.has(command), command);
  assert.ok(manifest.activationEvents.includes('onView:multiagentSystem.toolsSetupView'));
  const retry = contributes.menus['view/item/context'].filter((item) => item.command === 'multiagentSystem.setup.retryGh');
  assert.deepEqual(retry.map((item) => item.when), ['view == multiagentSystem.toolsSetupView && viewItem == multiagentSetupGh']);
  const retryCodex = contributes.menus['view/item/context'].filter((item) => item.command === 'multiagentSystem.setup.retryCodex');
  assert.deepEqual(retryCodex.map((item) => item.when), ['view == multiagentSystem.toolsSetupView && viewItem == multiagentSetupCodex']);
  const retryClaude = contributes.menus['view/item/context'].filter((item) => item.command === 'multiagentSystem.setup.retryClaude');
  assert.deepEqual(retryClaude.map((item) => item.when), ['view == multiagentSystem.toolsSetupView && viewItem == multiagentSetupClaude']);
});

test('the report lists and the editor buttons for reading reports are declared', () => {
  const declared = new Set(contributes.commands.map((entry) => entry.command));
  for (const command of ['multiagentSystem.reports.open', 'multiagentSystem.reports.next', 'multiagentSystem.reports.previous', 'multiagentSystem.reports.backToOverview', 'multiagentSystem.reports.backToList', 'multiagentSystem.reports.showDiff', 'multiagentSystem.reports.refresh', 'multiagentSystem.reports.feedback', 'multiagentSystem.reports.publicFeedback', 'multiagentSystem.reports.reviewPullRequest', 'multiagentSystem.reports.mergePullRequest', 'multiagentSystem.reports.deleteBranch', 'multiagentSystem.reports.closeIssue', 'multiagentSystem.reports.configurePublisher', 'multiagentSystem.reports.configureMergeAuthority']) assert.ok(declared.has(command), command);
  const editor = contributes.menus['editor/title'];
  assert.deepEqual(editor.map((item) => item.command).sort(), ['multiagentSystem.reports.backToList', 'multiagentSystem.reports.backToOverview', 'multiagentSystem.reports.closeIssue', 'multiagentSystem.reports.deleteBranch', 'multiagentSystem.reports.feedback', 'multiagentSystem.reports.mergePullRequest', 'multiagentSystem.reports.next', 'multiagentSystem.reports.previous', 'multiagentSystem.reports.publicFeedback', 'multiagentSystem.reports.reviewPullRequest', 'multiagentSystem.reports.showDiff']);
  const prOnly = new Set(['multiagentSystem.reports.showDiff', 'multiagentSystem.reports.reviewPullRequest', 'multiagentSystem.reports.mergePullRequest', 'multiagentSystem.reports.deleteBranch']);
  for (const item of editor) {
    if (item.command === 'multiagentSystem.reports.closeIssue') assert.equal(item.when, 'resourceScheme == multiagent-report && resourcePath =~ /issue-/', 'closing an Issue appears only on an Issue report');
    else if (prOnly.has(item.command)) assert.equal(item.when, 'resourceScheme == multiagent-report && resourcePath =~ /pull-request-/', 'PR actions appear only on a PR report');
    else assert.equal(item.when, 'resourceScheme == multiagent-report', 'the buttons appear only on a report');
  }
  assert.ok(manifest.activationEvents.includes('onView:multiagentSystem.issuesReportView'));
  assert.ok(manifest.activationEvents.includes('onView:multiagentSystem.prsReportView'));
});
