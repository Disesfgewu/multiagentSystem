'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const { contributes } = manifest;
const VIEWS = ['multiagentSystem.overviewView', 'multiagentSystem.planView', 'multiagentSystem.issuesReportView', 'multiagentSystem.prsReportView', 'multiagentSystem.githubView', 'multiagentSystem.accountsView', 'multiagentSystem.rolesView', 'multiagentSystem.toolsSetupView'];

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
  assert.deepEqual(overview.map((item) => item.command).sort(), ['multiagentSystem.overview.openPullRequest', 'multiagentSystem.sessions.focus', 'multiagentSystem.sessions.reopen', 'multiagentSystem.sessions.stop']);
  for (const item of overview) assert.match(item.when, /viewItem =~ \/\^multiagentOverviewAgent/);
  const open = overview.find((item) => item.command === 'multiagentSystem.overview.openPullRequest');
  assert.match(open.when, /\(Live\|Closed\)Pr\$/, 'the pull request button appears only on rows that have a verified pull request');
});

test('the overview activates the extension, and the extension never declares untrusted-workspace support', () => {
  assert.ok(manifest.activationEvents.includes('onView:multiagentSystem.overviewView'));
  assert.equal(Object.hasOwn(manifest, 'capabilities'), false, 'no capabilities block, so Restricted Mode keeps the extension off');
  assert.equal(JSON.stringify(manifest).includes('untrustedWorkspaces'), false);
});

test('Tools Setup has refresh and a gh-only retry action, and activates the extension', () => {
  const declared = new Set(contributes.commands.map((entry) => entry.command));
  for (const command of ['multiagentSystem.setup.refresh', 'multiagentSystem.setup.retryGh']) assert.ok(declared.has(command), command);
  assert.ok(manifest.activationEvents.includes('onView:multiagentSystem.toolsSetupView'));
  const retry = contributes.menus['view/item/context'].filter((item) => item.command === 'multiagentSystem.setup.retryGh');
  assert.deepEqual(retry.map((item) => item.when), ['view == multiagentSystem.toolsSetupView && viewItem == multiagentSetupGh']);
});

test('the report lists and the editor buttons for reading reports are declared', () => {
  const declared = new Set(contributes.commands.map((entry) => entry.command));
  for (const command of ['multiagentSystem.reports.open', 'multiagentSystem.reports.next', 'multiagentSystem.reports.previous', 'multiagentSystem.reports.backToOverview', 'multiagentSystem.reports.backToList', 'multiagentSystem.reports.showDiff', 'multiagentSystem.reports.refresh', 'multiagentSystem.reports.feedback']) assert.ok(declared.has(command), command);
  const editor = contributes.menus['editor/title'];
  assert.deepEqual(editor.map((item) => item.command).sort(), ['multiagentSystem.reports.backToList', 'multiagentSystem.reports.backToOverview', 'multiagentSystem.reports.feedback', 'multiagentSystem.reports.next', 'multiagentSystem.reports.previous', 'multiagentSystem.reports.showDiff']);
  for (const item of editor) {
    if (item.command === 'multiagentSystem.reports.showDiff') assert.equal(item.when, 'resourceScheme == multiagent-report && resourcePath =~ /pull-request-/', 'the diff button appears only on a PR report');
    else assert.equal(item.when, 'resourceScheme == multiagent-report', 'the buttons appear only on a report');
  }
  assert.ok(manifest.activationEvents.includes('onView:multiagentSystem.issuesReportView'));
  assert.ok(manifest.activationEvents.includes('onView:multiagentSystem.prsReportView'));
});
