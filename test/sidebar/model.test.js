'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { homeItems, TABS } = require('../../src/sidebar/model');

test('the side bar keeps one view: Open Workbench first, then one line each for agents, what needs you and accounts (#357)', () => {
  const items = homeItems({ agents: { running: 3, waiting: 1 }, accounts: { total: 2, signedIn: 1, attention: 1 } });
  assert.deepEqual(items.map((item) => item.id), ['open', 'agents', 'attention', 'accounts']);
  assert.equal(items[0].label, 'Open Workbench');
  assert.deepEqual(items.map((item) => [item.label, item.state, item.tab]), [
    ['Open Workbench', 'normal', 'agents'],
    ['Agents: 3 running', 'attention', 'agents'],
    ['Needs you: 1 agent waiting, 1 account', 'attention', 'agents'],
    ['Accounts: 2 accounts, 1 signed in', 'attention', 'accounts']
  ]);
  assert.equal(items[1].description, '1 waiting for you');
  for (const item of items) assert.ok(TABS.includes(item.tab), `${item.id} opens a Workbench tab`);
});

test('nothing waiting is said so; only an account needing you opens the Accounts tab; an unread count is unknown, never zero (#357)', () => {
  const calm = homeItems({ agents: { running: 0, waiting: 0 }, accounts: { total: 0, signedIn: 0, attention: 0 } });
  assert.deepEqual(calm.map((item) => item.label), ['Open Workbench', 'Agents: none running', 'Needs you: nothing right now', 'Accounts: none yet']);
  assert.equal(calm[3].state, 'attention', 'no account yet is the first thing to do');
  assert.equal(calm[3].description, 'add one in the Accounts tab');
  const account = homeItems({ agents: { running: 1, waiting: 0 }, accounts: { total: 1, signedIn: 0, attention: 1 } });
  assert.deepEqual([account[2].label, account[2].tab], ['Needs you: 1 account', 'accounts']);
  const unknown = homeItems({ agents: null, accounts: null });
  assert.deepEqual(unknown.slice(1).map((item) => [item.label, item.state]), [['Agents: unknown', 'unknown'], ['Needs you: nothing right now', 'unknown'], ['Accounts: unknown', 'unknown']]);
  assert.equal(homeItems({ agents: { running: -1, waiting: 0 } })[1].label, 'Agents: unknown');
});

test('the manifest shows only the Multiagent view unless the classic views are switched on (#357)', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
  const views = manifest.contributes.views.multiagentSystem;
  assert.deepEqual([views[0].id, views[0].name, views[0].when], ['multiagentSystem.homeView', 'Multiagent', undefined]);
  assert.equal(views.length, 10);
  for (const view of views.slice(1)) assert.equal(view.when, 'config.multiagentSystem.showClassicViews', view.id);
  assert.equal(manifest.contributes.configuration.properties['multiagentSystem.showClassicViews'].default, false);
  assert.ok(manifest.contributes.commands.some((entry) => entry.command === 'multiagentSystem.workbench.open' && entry.title === 'Multiagent: Open Workbench'));
});
