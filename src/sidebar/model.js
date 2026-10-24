'use strict';

/**
 * The one view the Multiagent side bar keeps (#357): a large "Open Workbench" entry and one line each for the agents, what needs the
 * person and the accounts. Every line opens the Workbench at the tab it is about, so nothing in the side bar needs a command name.
 * Pure: the caller gives the counts it read; a count it could not read is shown as unknown, never as zero.
 */

const TABS = Object.freeze(['agents', 'work', 'accounts', 'broadcast', 'ask', 'knowledge', 'setup']);
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

/**
 * @param {{ agents?: { running: number, waiting: number } | null, accounts?: { total: number, signedIn: number, attention: number } | null }} input
 * @returns {Array<{ id: string, label: string, description: string, tooltip: string, tab: string, state: 'normal'|'attention'|'unknown' }>}
 */
function homeItems({ agents = null, accounts = null } = {}) {
  const items = [{ id: 'open', label: 'Open Workbench', description: 'agents, work, accounts, broadcast, ask, knowledge, setup', tooltip: 'Everything Multiagent does, on one screen with tabs.', tab: 'agents', state: 'normal' }];
  if (agents && isCount(agents.running) && isCount(agents.waiting)) {
    items.push({ id: 'agents', label: `Agents: ${agents.running === 0 ? 'none running' : `${agents.running} running`}`, description: agents.waiting > 0 ? `${agents.waiting} waiting for you` : '', tooltip: 'Open the Agents tab: one card per agent working on this project.', tab: 'agents', state: agents.waiting > 0 ? 'attention' : 'normal' });
  } else {
    items.push({ id: 'agents', label: 'Agents: unknown', description: 'the session list could not be read', tooltip: 'Open the Agents tab to see what is known.', tab: 'agents', state: 'unknown' });
  }
  const needs = [
    ...(agents && isCount(agents.waiting) && agents.waiting > 0 ? [plural(agents.waiting, 'agent') + ' waiting'] : []),
    ...(accounts && isCount(accounts.attention) && accounts.attention > 0 ? [plural(accounts.attention, 'account')] : [])
  ];
  items.push(needs.length > 0
    ? { id: 'attention', label: `Needs you: ${needs.join(', ')}`, description: '', tooltip: 'Open the tab where it can be dealt with.', tab: accounts && accounts.attention > 0 && !(agents && agents.waiting > 0) ? 'accounts' : 'agents', state: 'attention' }
    : { id: 'attention', label: 'Needs you: nothing right now', description: '', tooltip: 'Nothing waits for you that this window knows of.', tab: 'agents', state: agents && accounts ? 'normal' : 'unknown' });
  if (accounts && isCount(accounts.total) && isCount(accounts.signedIn)) {
    items.push({ id: 'accounts', label: accounts.total === 0 ? 'Accounts: none yet' : `Accounts: ${plural(accounts.total, 'account')}, ${accounts.signedIn} signed in`, description: accounts.total === 0 ? 'add one in the Accounts tab' : '', tooltip: 'Open the Accounts tab: sign-in, plan and usage of each account.', tab: 'accounts', state: accounts.total === 0 || accounts.attention > 0 ? 'attention' : 'normal' });
  } else {
    items.push({ id: 'accounts', label: 'Accounts: unknown', description: 'the account list could not be read', tooltip: 'Open the Accounts tab to see what is known.', tab: 'accounts', state: 'unknown' });
  }
  return items;
}

module.exports = { homeItems, TABS };
