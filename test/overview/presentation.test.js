'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOverview } = require('../../src/overview/model');
const { presentAgent, onboardingSteps, guideVisible, countRunningAgents, STATE_TEXT } = require('../../src/overview/presentation');

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

const cp = (...codes) => String.fromCodePoint(...codes);

test('only a running agent counts for the guide: an open terminal with an assigned account', () => {
  const live = { terminalOpen: true, accountProfileId: 'acct-1' };
  assert.equal(countRunningAgents([live]), 1);
  assert.equal(countRunningAgents([{ ...live, terminalOpen: false }]), 0, 'a closed or restored session is a record');
  assert.equal(countRunningAgents([{ ...live, accountProfileId: 'unassigned' }]), 0, 'no account assigned yet');
  assert.equal(countRunningAgents([{ ...live, accountProfileId: '' }, { ...live, accountProfileId: undefined }, { ...live, accountProfileId: 7 }]), 0);
  assert.equal(countRunningAgents([live, { ...live, terminalOpen: false }, { ...live, accountProfileId: 'unassigned' }, live]), 2);
  for (const bad of [undefined, null, 'x', {}, [null, undefined, 3]]) assert.equal(countRunningAgents(bad), 0, String(bad));
  assert.equal(onboardingSteps({ accounts: 1, roleGroups: 1, sessions: countRunningAgents([{ terminalOpen: false, accountProfileId: 'a' }]) }).find((step) => step.id === 'agent').done, false);
});

test('text from outside is shown as one clean, short line', () => {
  const evil = `${cp(0x202e)}evil${cp(0)}\nname${cp(0x200b)}${cp(0x2028)}x`;
  const shown = presentAgent(row({}, [account({ label: { value: evil } })], { worker: evil }), { name: evil, providerLabel: evil });
  for (const text of [shown.label, shown.description, ...shown.tooltip]) {
    assert.equal(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text.replace(/\n/g, '')), false, `a control or format character survived: ${JSON.stringify(text)}`);
  }
  assert.equal(shown.label, 'evil name x');
  assert.equal(shown.description.includes('\n'), false);
  const long = 'x'.repeat(100000);
  const big = presentAgent(row({ branches: undefined }, [account({ label: { value: long } })], { worker: long }), { name: long, providerLabel: long });
  assert.ok(Array.from(big.label).length <= 80);
  assert.ok(big.description.length < 400, `${big.description.length}`);
  assert.ok(big.tooltip.join('\n').length < 600);
  const withBranch = buildOverview({ sessions: [session()], accounts: [account()], roleGroups: { worker: 'W' }, branches: { s1: long } }).rows[0];
  assert.ok(presentAgent(withBranch, { name: 'A' }).tooltip.join('\n').length < 700);
  assert.equal(presentAgent(row({}, [account({ label: { value: `${cp(0x202e)}${cp(0)}` } })]), { name: cp(0x200b) }).label, 'Session', 'a name that is only invisible characters falls back');
});

test('a state that is a property of every object is unknown, never shown as an object', () => {
  for (const state of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const shown = presentAgent({ ...row({}), sessionState: { state: 'known', value: state } }, { name: 'A', providerLabel: 'P' });
    assert.equal(shown.description.includes('[object'), false, state);
    assert.match(shown.description, /· unknown$/, state);
  }
});

test('a verified pull request and its checks appear in the row description, with a link only for an open pull request', () => {
  const sha = 'a'.repeat(40);
  const github = { kind: 'ok', fetchedAt: 'now', pullRequests: [{ pullRequest: { number: 12, title: 't', state: 'open', draft: false, headRef: 'feat/x', headSha: sha, headRepository: 'o/r' }, checks: { state: 'failing', requiredState: 'failing', headSha: sha } }] };
  const built = (extra = {}) => buildOverview({ sessions: [session()], accounts: [account()], roleGroups: { worker: 'W' }, branches: { s1: 'feat/x' }, repository: 'o/r', github, ...extra }).rows[0];
  const shown = presentAgent(built(), { name: 'A', providerLabel: 'P' });
  assert.match(shown.description, /· PR #12 · CI failing$/);
  assert.equal(shown.pullRequestUrl, 'https://github.com/o/r/pull/12');
  const draft = JSON.parse(JSON.stringify(github));
  draft.pullRequests[0].pullRequest.draft = true;
  assert.match(presentAgent(built({ github: draft }), { name: 'A' }).description, /PR #12 \(draft\) · CI failing/);
  const noChecks = JSON.parse(JSON.stringify(github));
  delete noChecks.pullRequests[0].checks;
  const unread = presentAgent(built({ github: noChecks }), { name: 'A' });
  assert.match(unread.description, /· PR #12$/, 'checks that were not read add nothing, not even "unknown"');
  assert.equal(unread.pullRequestUrl, 'https://github.com/o/r/pull/12');
  for (const odd of ['passing', 'pending', 'none']) {
    const copy = JSON.parse(JSON.stringify(github));
    copy.pullRequests[0].checks.state = odd;
    assert.match(presentAgent(built({ github: copy }), { name: 'A' }).description, new RegExp(`CI ${odd}$`));
  }
  const weird = JSON.parse(JSON.stringify(github));
  weird.pullRequests[0].checks.state = 'all green, merge now';
  assert.equal(presentAgent(built({ github: weird }), { name: 'A' }).description.includes('merge now'), false, 'only a known CI word is shown');
  for (const state of [undefined, { kind: 'partial', pullRequests: [] }, { kind: 'denied' }]) {
    const none = presentAgent(built({ github: state }), { name: 'A' });
    assert.equal(none.pullRequestUrl, null);
    assert.equal(/PR #/.test(none.description), false);
  }
  const noPr = presentAgent(built({ github: { kind: 'empty', fetchedAt: 'now', pullRequests: [] } }), { name: 'A' });
  assert.equal(noPr.pullRequestUrl, null);
  assert.equal(/PR #/.test(noPr.description), false, '"no pull request" is not shown as a pull request');
});

test('a known role group says its rules are not sent yet, and an unknown one adds no such claim', () => {
  assert.match(view().tooltip.join('\n'), /not sent to the CLI yet, so editing it does not change what an agent that is already started was told/);
  assert.equal(presentAgent(row({ roleGroupId: 'nobody' }), { name: 'A' }).tooltip.join('\n').includes('not sent to the CLI yet'), false);
});
