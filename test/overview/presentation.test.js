'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOverview } = require('../../src/overview/model');
const { presentAgent, onboardingSteps, guideVisible, STATE_TEXT } = require('../../src/overview/presentation');

const session = (over = {}) => ({ id: 's1', roleGroupId: 'worker', accountProfileId: 'a1', worktree: '/private/place/wt', state: 'terminal-open', observedAt: null, ...over });
const account = (over = {}) => ({ id: 'a1', provider: 'claude', label: { value: 'Main' }, health: 'ready', verifiedIdentity: { state: 'unknown' }, issues: [], ...over });
const row = (sessionOver, accounts = [account()], roleGroups = { worker: 'Worker' }) => buildOverview({ sessions: [session(sessionOver)], accounts, roleGroups }).rows[0];
const view = (over) => presentAgent(row(over), { name: 'Agent One', providerLabel: 'Claude Code', terminalOpen: true });

test('an agent row names role, provider, account and state, and a shell alone is not "working"', () => {
  const shown = view();
  assert.equal(shown.label, 'Agent One');
  assert.equal(shown.description, 'Worker · Claude Code · Main · terminal open, CLI not started');
  assert.equal(/working|running|busy|active/i.test(shown.description + shown.tooltip.join(' ')), false);
  assert.equal(shown.terminalOpen, true);
});

test('every state the session layer can report has wording, and only an observed CLI says so', () => {
  for (const state of ['terminal-open', 'launch-requested', 'cli-observed', 'cli-exited', 'terminal-closed']) {
    assert.ok(STATE_TEXT[state], state);
    assert.match(view({ state }).description, new RegExp(STATE_TEXT[state]));
  }
  assert.equal(/observed/.test(STATE_TEXT['launch-requested']), false);
  assert.match(view({ state: 'launch-requested' }).description, /not confirmed/);
  assert.match(view({ state: 'unknown' }).description, /state unknown/);
  assert.match(view({ state: 'invented-state' }).description, /· unknown$/);
});

test('missing sources are shown as unknown, never filled in', () => {
  const shown = presentAgent(row({ roleGroupId: 'nobody', accountProfileId: 'ghost' }), { name: '   ' });
  assert.equal(shown.label, 'Session');
  assert.equal(shown.description, 'unknown · unknown · unknown · terminal open, CLI not started');
  assert.equal(shown.problems, 2);
  assert.match(shown.tooltip.join('\n'), /Branch: unknown/);
  assert.match(shown.tooltip.join('\n'), /Pull request: unknown/);
  assert.match(shown.tooltip.join('\n'), /CI: unknown/);
  assert.match(shown.tooltip.join('\n'), /no verified source/);
  assert.equal(shown.terminalOpen, false);
  assert.match(shown.tooltip.join('\n'), /Account: unknown \(account unknown\)/);
});

test('an account label is never presented as a verified identity', () => {
  const plain = view().tooltip.join('\n');
  assert.match(plain, /Account: Main \(identity unknown\)/);
  const verified = presentAgent(row({}, [account({ verifiedIdentity: { state: 'verified' } })]), { name: 'A', providerLabel: 'Claude Code' }).tooltip.join('\n');
  assert.match(verified, /identity verified by the CLI/);
  assert.match(presentAgent(row({}, [account({ health: undefined })]), { name: 'A' }).description, /unknown/);
});

test('no percentage and no progress is ever shown', () => {
  for (const over of [{}, { state: 'cli-observed' }, { roleGroupId: 'x' }]) {
    const shown = view(over);
    assert.equal(/%|progress|percent/i.test(`${shown.description} ${shown.tooltip.join(' ')}`), false);
  }
});

test('pull request and CI are shown only when the read result supplies them', () => {
  const github = { kind: 'ok', fetchedAt: 'now', pullRequests: [{ pullRequest: { number: 12, title: 't', state: 'open', draft: true, headRef: 'feat/x', headSha: 'a'.repeat(40), headRepository: 'o/r' }, checks: { state: 'passing', requiredState: 'passing', headSha: 'a'.repeat(40) } }] };
  const built = buildOverview({ sessions: [session()], accounts: [account()], roleGroups: { worker: 'Worker' }, branches: { s1: 'feat/x' }, repository: 'o/r', github }).rows[0];
  const text = presentAgent(built, { name: 'A', providerLabel: 'Claude Code' }).tooltip.join('\n');
  assert.match(text, /Branch: feat\/x/);
  assert.match(text, /Pull request: #12 \(draft\)/);
  assert.match(text, /CI: passing/);
});

test('guide steps follow the real counts; an unreadable count is unknown, not zero and not done', () => {
  const steps = (counts) => Object.fromEntries(onboardingSteps(counts).map((step) => [step.id, step.done]));
  assert.deepEqual(steps({ accounts: 0, roleGroups: 0, sessions: 0 }), { account: false, role: false, agent: false, issue: 'not-tracked' });
  assert.deepEqual(steps({ accounts: 2, roleGroups: 0, sessions: 0 }), { account: true, role: false, agent: false, issue: 'not-tracked' });
  assert.deepEqual(steps({ accounts: 1, roleGroups: 1, sessions: 3 }), { account: true, role: true, agent: true, issue: 'not-tracked' });
  assert.deepEqual(steps({ accounts: null, roleGroups: 1, sessions: 0 }), { account: 'unknown', role: true, agent: false, issue: 'not-tracked' });
  assert.equal(onboardingSteps({ accounts: 0, roleGroups: 0, sessions: 0 }).find((step) => step.id === 'issue').done, 'not-tracked', 'claiming an Issue is never ticked');
});

test('every step has one button that runs a real command and says what is missing', () => {
  for (const step of onboardingSteps({ accounts: 0, roleGroups: 0, sessions: 0 })) {
    assert.match(step.command, /^multiagentSystem\.[a-z]+\.[A-Za-z]+$/);
    assert.ok(step.button.length > 3 && step.missing.length > 20 && step.title.length > 3, step.id);
  }
  assert.deepEqual(onboardingSteps({ accounts: 0, roleGroups: 0, sessions: 0 }).map((step) => step.id), ['account', 'role', 'agent', 'issue']);
});

test('the guide stays while any tracked step is not done or unreadable, and goes when all are done', () => {
  assert.equal(guideVisible(onboardingSteps({ accounts: 0, roleGroups: 1, sessions: 1 })), true);
  assert.equal(guideVisible(onboardingSteps({ accounts: 1, roleGroups: 1, sessions: 0 })), true);
  assert.equal(guideVisible(onboardingSteps({ accounts: 1, roleGroups: null, sessions: 1 })), true);
  assert.equal(guideVisible(onboardingSteps({ accounts: 1, roleGroups: 1, sessions: 1 })), false);
});

test('rows carry no local path', () => {
  const shown = view();
  assert.equal(JSON.stringify(shown).includes('/private/place'), false);
});
