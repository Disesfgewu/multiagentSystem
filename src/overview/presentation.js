'use strict';

// What the Multiagent overview shows, as plain data. It is pure: no vscode, no file, no network.
// Anything without a source is shown as "unknown"; nothing is guessed, no progress is invented,
// and a terminal that exists is never described as an agent that is working.

const UNKNOWN = 'unknown';

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
  const name = typeof session?.name === 'string' && session.name.trim() ? session.name.trim() : 'Session';
  const role = row.role.state === 'known' ? row.role.name : UNKNOWN;
  const provider = typeof session?.providerLabel === 'string' ? session.providerLabel : UNKNOWN;
  const account = row.account.state === 'known' ? (row.account.label || UNKNOWN) : UNKNOWN;
  const stateText = row.sessionState.state === 'known' ? (STATE_TEXT[row.sessionState.value] ?? UNKNOWN) : 'state unknown';
  const identity = row.account.state === 'known' ? (row.account.verified ? 'identity verified by the CLI' : 'identity unknown') : 'account unknown';
  const pr = row.pullRequest.state === 'open' ? `#${row.pullRequest.number}${row.pullRequest.draft ? ' (draft)' : ''}` : row.pullRequest.state === 'none' ? 'no open pull request' : UNKNOWN;
  const ci = row.ci.state === 'known' ? row.ci.value : UNKNOWN;
  return {
    id: row.sessionId,
    label: name,
    description: `${role} · ${provider} · ${account} · ${stateText}`,
    tooltip: [
      `Role: ${role}`,
      `Provider: ${provider}`,
      `Account: ${account} (${identity})`,
      `State: ${stateText}`,
      `Branch: ${row.branch.state === 'known' ? row.branch.value : UNKNOWN}`,
      `Pull request: ${pr}`,
      `CI: ${ci}`,
      ...(row.role.state === 'known' ? ['The role group is read from its current definition. Its rules are not sent to the CLI yet, so editing it does not change what an agent that is already started was told.'] : []),
      'Fields marked unknown have no verified source yet.'
    ],
    terminalOpen: session?.terminalOpen === true,
    problems: [row.role, row.account].filter((entry) => entry.state !== 'known').length
  };
}

/**
 * The first-use steps. A step is done only when the real state says so; when the state cannot be
 * read the step is `unknown` and says why. Step 4 cannot be known from here, so it is never ticked.
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

module.exports = { presentAgent, onboardingSteps, guideVisible, UNKNOWN, STATE_TEXT };
