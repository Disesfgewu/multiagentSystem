'use strict';

// What the Multiagent overview shows, as plain data. It is pure: no vscode, no file, no network.
// Anything without a source is shown as "unknown"; nothing is guessed, no progress is invented,
// and a terminal that exists is never described as an agent that is working.

const { cleanTitle } = require('./model');

const UNKNOWN = 'unknown';
const SHOWN_LIMIT = 80;
// Text that came from outside this module (a session name, a label, a branch) is shown as one clean,
// short line: control, bidirectional and separator characters are removed and the length is limited.
const shown = (value, fallback = UNKNOWN) => {
  const text = typeof value === 'string' ? Array.from(cleanTitle(value)).slice(0, SHOWN_LIMIT).join('') : '';
  return text === '' ? fallback : text;
};
const CI_WORDS = Object.freeze(['passing', 'failing', 'pending', 'none']);

const STATE_TEXT = Object.freeze({
  'terminal-open': 'terminal open, CLI not started',
  'launch-requested': 'CLI start requested, not confirmed',
  'cli-observed': 'CLI observed',
  'cli-exited': 'CLI exited',
  'terminal-closed': 'terminal closed'
});

function field(value, fallback = UNKNOWN) {
  return value && value.state === 'known' ? String(value.value ?? value.name ?? value.label ?? fallback) : fallback;
}

/**
 * One line per session. `row` is a row of `buildOverview`; `session` supplies the display name and
 * the state label that the session layer already worded honestly.
 */
function presentAgent(row, session) {
  const name = shown(session?.name, 'Session');
  const role = row.role.state === 'known' ? shown(row.role.name) : UNKNOWN;
  const provider = shown(session?.providerLabel);
  const account = row.account.state === 'known' ? shown(row.account.label) : UNKNOWN;
  const stateText = row.sessionState.state === 'known' ? (Object.hasOwn(STATE_TEXT, row.sessionState.value) ? STATE_TEXT[row.sessionState.value] : UNKNOWN) : 'state unknown';
  const identity = row.account.state === 'known' ? (row.account.verified ? 'identity verified by the CLI' : 'identity unknown') : 'account unknown';
  const pr = row.pullRequest.state === 'open' ? `#${row.pullRequest.number}${row.pullRequest.draft ? ' (draft)' : ''}` : row.pullRequest.state === 'none' ? 'no open pull request' : UNKNOWN;
  const ci = row.ci.state === 'known' ? row.ci.value : UNKNOWN;
  const prText = row.pullRequest.state === 'open' ? ` · PR #${row.pullRequest.number}${row.pullRequest.draft ? ' (draft)' : ''}${row.ci.state === 'known' && CI_WORDS.includes(row.ci.value) ? ` · CI ${row.ci.value}` : ''}` : '';
  return {
    id: row.sessionId,
    label: name,
    description: `${role} · ${provider} · ${account} · ${stateText}${prText}`,
    pullRequestUrl: row.pullRequest.state === 'open' && typeof row.pullRequest.url === 'string' ? row.pullRequest.url : null,
    tooltip: [
      `Role: ${role}`,
      `Provider: ${provider}`,
      `Requested model: ${shown(session?.requestedModel, 'CLI default')} (not confirmed)`,
      'Actual model: unknown (no provider model observation is connected)',
      `Account: ${account} (${identity})`,
      `State: ${stateText}`,
      `Branch: ${row.branch.state === 'known' ? shown(row.branch.value) : UNKNOWN}`,
      `Pull request: ${pr}`,
      `CI: ${ci}`,
      ...(session?.instructionStatusLabel
        ? [`Instructions: ${shown(session.instructionStatusLabel)}`]
        : (row.role.state === 'known' ? ['The role group is read from its current definition. Its rules are not sent to the CLI yet, so editing it does not change what an agent that is already started was told.'] : [])),
      'Fields marked unknown have no verified source yet.'
    ],
    terminalOpen: session?.terminalOpen === true,
    problems: [row.role, row.account].filter((entry) => entry.state !== 'known').length
  };
}

/**
 * Agents that are really running: a terminal this window holds, with an account assigned. A session that
 * was closed or restored, or that has no account yet, is a record, not a running agent.
 */
function countRunningAgents(sessions) {
  return Array.isArray(sessions) ? sessions.filter((entry) => entry && entry.terminalOpen === true && typeof entry.accountProfileId === 'string' && entry.accountProfileId !== '' && entry.accountProfileId !== 'unassigned').length : 0;
}

/**
 * The first-use steps. A step is done only when the real state says so; when the state cannot be
 * read the step is `unknown` and says why. Step 3 counts running agents only (see `countRunningAgents`). Step 4 cannot be known from here, so it is never ticked.
 * @param {{ accounts: number|null, roleGroups: number|null, sessions: number|null }} counts null = could not be read
 */
function onboardingSteps({ accounts, roleGroups, sessions }) {
  const done = (count) => (count === null ? UNKNOWN : count > 0);
  return [
    { id: 'account', title: 'Create an account profile', done: done(accounts), command: 'multiagentSystem.accounts.create', button: 'Create Account', missing: 'No account profile yet. An account says which CLI sign-in an agent uses.' },
    { id: 'role', title: 'Create a role group', done: done(roleGroups), command: 'multiagentSystem.roles.create', button: 'Create Role Group', missing: 'No role group yet. A role group says what an agent may do.' },
    { id: 'agent', title: 'Start an agent with an account', done: done(sessions), command: 'multiagentSystem.accounts.launch', button: 'Start Agent', missing: 'No agent session yet. Start one with an account profile.' },
    { id: 'issue', title: 'Pick up an Issue', done: 'not-tracked', command: 'multiagentSystem.github.browse', button: 'Browse GitHub Issues', missing: 'Claiming an Issue is not tracked here yet; open the GitHub list to choose one.' }
  ];
}

/** The guide stays visible while any tracked step is not done or cannot be read. */
function guideVisible(steps) {
  return steps.some((step) => step.done === false || step.done === UNKNOWN);
}

module.exports = { presentAgent, onboardingSteps, guideVisible, countRunningAgents, UNKNOWN, STATE_TEXT };
