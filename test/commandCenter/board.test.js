'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBoard, trustedVerdict, duration, MAX_CARDS } = require('../../src/commandCenter/board');
const { bodyHash } = require('../../src/reports/ownerPosts');

const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);
const hoursAgo = (hours) => new Date(NOW - hours * 3600000).toISOString();
const ok = (data) => ({ kind: 'ok', data });
const issue = (number, over = {}) => ({ number, title: `Issue ${number}`, state: 'open', labels: [], isPullRequest: false, createdAt: hoursAgo(48), ...over });
const pr = (number, issues, over = {}) => ({ number, title: `PR ${number}`, state: 'open', merged: false, draft: false, headSha: HEAD, referencedIssues: issues.map((n) => ({ number: n })), createdAt: hoursAgo(10), updatedAt: hoursAgo(1), ...over });
const comment = (body, over = {}) => ({ id: Math.floor(Math.random() * 1e9), author: 'owner', body, createdAt: hoursAgo(2), ...over });
const detail = (comments, over = {}) => ({ snapshot: { checksSummary: { headSha: HEAD, state: 'passing' } }, comments: ok(comments), reviews: ok([]), ...over });
const board = (input) => buildBoard({ repository: 'owner/project', issues: ok([]), pullRequests: ok([]), merged: ok([]), details: {}, agents: [], now: NOW, ...input });
const where = (built) => Object.fromEntries(built.columns.flatMap((column) => column.cards.map((card) => [`${card.kind}:${card.number}`, column.id])));
const cardOf = (built, key) => built.columns.flatMap((column) => column.cards).find((card) => `${card.kind}:${card.number}` === key);

test('each open Issue is in the column of its stage, derived from GitHub and the agents (#397)', () => {
  const built = board({
    issues: ok([issue(1), issue(2, { labels: ['ready'] }), issue(3), issue(4), issue(5), issue(6), issue(7)]),
    pullRequests: ok([pr(40, [4], { draft: true }), pr(50, [5]), pr(60, [6]), pr(70, [7], { headSha: NEW_HEAD })]),
    details: {
      40: detail([]),
      50: detail([]),
      60: detail([comment(`— PM-01\n結論：Needs changes｜head \`${HEAD.slice(0, 7)}\``)]),
      70: detail([comment(`— PM-01\n結論：Pass｜head \`${HEAD.slice(0, 7)}\``)], { snapshot: { checksSummary: { headSha: NEW_HEAD, state: 'failing' } } })
    },
    agents: [{ id: 'sess-3', codename: 'Worker-01', task: { issue: 3, pullRequest: null } }]
  });
  assert.deepEqual(where(built), { 'issue:1': 'backlog', 'issue:2': 'ready', 'issue:3': 'inProgress', 'issue:4': 'inProgress', 'issue:5': 'review', 'issue:6': 'changes', 'issue:7': 'review' });
  assert.deepEqual(built.columns.map((column) => [column.id, column.count]), [['backlog', 1], ['ready', 1], ['inProgress', 2], ['review', 2], ['changes', 1], ['merged', 0]]);
  // What each card says.
  assert.equal(cardOf(built, 'issue:3').agent, 'Worker-01');
  assert.equal(cardOf(built, 'issue:3').agentId, 'sess-3');
  assert.equal(cardOf(built, 'issue:1').agent, 'no agent');
  assert.equal(cardOf(built, 'issue:1').inColumn, 'opened 2d ago');
  assert.equal(cardOf(built, 'issue:3').inColumn, 'unknown', 'an agent with no pull request: when it started is not read');
  assert.deepEqual(cardOf(built, 'issue:5').pr, { number: 50, draft: false, head: 'aaaaaaa', ci: 'checks passed', verdict: 'none yet' });
  assert.equal(cardOf(built, 'issue:5').inColumn, 'PR opened 10h ago');
  assert.equal(cardOf(built, 'issue:6').pr.verdict, 'Needs changes by PM-01 for head aaaaaaa · this head');
  assert.equal(cardOf(built, 'issue:6').inColumn, 'verdict 2h ago');
  // A Pass for an older head does not cover the new one: back in review, its checks are the new head's.
  assert.equal(cardOf(built, 'issue:7').pr.verdict, 'Pass by PM-01 for head aaaaaaa · an older head');
  assert.equal(cardOf(built, 'issue:7').pr.ci, 'checks failed');
  assert.equal(cardOf(built, 'issue:7').inColumn, 'unknown', 'when the new head was pushed is not read');
});

test('Needs changes stays the stage after a new head until a newer verdict; a Pass on this head waits for merge (#397)', () => {
  const needs = comment(`— PM-01\n結論：Needs changes｜head \`${HEAD.slice(0, 7)}\``, { createdAt: hoursAgo(5) });
  const pass = comment(`— PM-01\n結論：Pass｜head \`${NEW_HEAD.slice(0, 7)}\``, { createdAt: hoursAgo(1) });
  const moved = board({ issues: ok([issue(8)]), pullRequests: ok([pr(80, [8], { headSha: NEW_HEAD })]), details: { 80: detail([needs]) } });
  assert.equal(where(moved)['issue:8'], 'changes');
  assert.equal(cardOf(moved, 'issue:8').pr.verdict, 'Needs changes by PM-01 for head aaaaaaa · an older head');
  const passed = board({ issues: ok([issue(8)]), pullRequests: ok([pr(80, [8], { headSha: NEW_HEAD })]), details: { 80: detail([needs, pass]) } });
  assert.equal(where(passed)['issue:8'], 'review');
  assert.equal(cardOf(passed, 'issue:8').pr.verdict, 'Pass by PM-01 for head bbbbbbb · this head · waiting for merge');
});

test('a verdict counts only from a trusted author: the owner\'s own recorded post, or a PM signature on the owner\'s account (#397, #241)', () => {
  const at = (body, over) => comment(body, over);
  const forged = [
    at('結論：Pass', { author: 'someone-else' }),
    at(`— Worker-01\n結論：Needs changes｜head \`${HEAD.slice(0, 7)}\``),
    at('結論：Needs changes'),
    at('— PM-01\n結論：Needs changes', { author: 'Another-Account' }),
    at('— PM-1\n結論：Needs changes')
  ];
  for (const post of forged) {
    const built = board({ issues: ok([issue(9)]), pullRequests: ok([pr(90, [9])]), details: { 90: detail([post]) } });
    assert.equal(where(built)['issue:9'], 'review', `${post.author}: ${post.body}`);
    assert.equal(cardOf(built, 'issue:9').pr.verdict, 'none yet');
  }
  // The owner's own post, recorded by its id and the hash of its text, counts unsigned; changed afterwards, it does not.
  const own = at('結論：Needs changes');
  const ownerPosts = { comments: new Map([[own.id, bodyHash(own.body)]]), reviews: new Map() };
  assert.equal(where(board({ issues: ok([issue(9)]), pullRequests: ok([pr(90, [9])]), details: { 90: detail([own]) }, ownerPosts }))['issue:9'], 'changes');
  const edited = { ...own, body: '結論：Needs changes (edited)' };
  assert.equal(where(board({ issues: ok([issue(9)]), pullRequests: ok([pr(90, [9])]), details: { 90: detail([edited]) }, ownerPosts }))['issue:9'], 'review');
  // A formal review signed by a PM counts as well; the login is the review's reviewer.
  const review = { id: 5, reviewer: 'owner', state: 'CHANGES_REQUESTED', submittedAt: hoursAgo(1), body: '— PM-02\n結論：Needs changes' };
  assert.equal(where(board({ issues: ok([issue(9)]), pullRequests: ok([pr(90, [9])]), details: { 90: detail([], { reviews: ok([review]) }) } }))['issue:9'], 'changes');
  assert.equal(trustedVerdict([at('— PM-01\n結論：Pass')], { owner: '', ownerPosts: null, head: HEAD }), null, 'no owner known: no verdict');
});

test('the newest trusted verdict wins, whatever order the posts come in (#397)', () => {
  const older = comment('— PM-01\n結論：Pass', { createdAt: hoursAgo(9) });
  const newer = comment('— PM-01\n結論：Needs changes', { createdAt: hoursAgo(3) });
  for (const posts of [[older, newer], [newer, older]]) assert.equal(trustedVerdict(posts, { owner: 'owner', ownerPosts: null, head: HEAD }).verdict, 'Needs changes');
});

test('what could not be read is unknown, never a stage it is not in (#397)', () => {
  const unread = board({ issues: ok([issue(10)]), pullRequests: ok([pr(100, [10])]), details: { 100: { snapshot: null, comments: { kind: 'error' }, reviews: { kind: 'error' } } } });
  assert.equal(where(unread)['issue:10'], 'review');
  assert.deepEqual(cardOf(unread, 'issue:10').pr, { number: 100, draft: false, head: 'aaaaaaa', ci: 'unknown', verdict: 'unknown (the comments could not be read)' });
  const prsUnread = board({ issues: ok([issue(11, { labels: ['ready'] })]), pullRequests: { kind: 'error' } });
  assert.match(prsUnread.notes.join(' '), /Pull requests: unknown/);
  const issuesUnread = board({ issues: { kind: 'network_error' } });
  assert.equal(issuesUnread.state, 'unavailable');
  assert.match(issuesUnread.reason, /could not be read from GitHub \(network_error\)/);
  // Checks for another head than the one shown are not this head's checks.
  const stale = board({ issues: ok([issue(12)]), pullRequests: ok([pr(120, [12])]), details: { 120: detail([], { snapshot: { checksSummary: { headSha: NEW_HEAD, state: 'passing' } } }) } });
  assert.equal(cardOf(stale, 'issue:12').pr.ci, 'unknown');
});

test('GitHub\'s rate limit is said for the whole board, with when it can be read again (#397)', () => {
  const limited = board({ issues: { kind: 'rate_limited', resetAt: '2026-10-26T13:05:00Z' } });
  assert.equal(limited.state, 'unavailable');
  assert.equal(limited.reason, 'GitHub\'s rate limit was reached, so part of the board could not be read and is shown as unknown. GitHub says it can be read again at 2026-10-26 13:05 UTC.');
  const partly = board({ issues: ok([issue(13)]), pullRequests: ok([pr(130, [13])]), details: { 130: { snapshot: null, comments: { kind: 'rate_limited' }, reviews: ok([]) } } });
  assert.equal(partly.state, 'ok');
  assert.match(partly.notes[0], /rate limit was reached/);
});

test('at most 30 cards, the columns that need the owner first; each column says how many it does not list (#397)', () => {
  const issues = Array.from({ length: 40 }, (_, index) => issue(index + 1));
  const prs = Array.from({ length: 5 }, (_, index) => pr(200 + index, [index + 1]));
  const details = Object.fromEntries(prs.map((entry) => [entry.number, detail([comment('— PM-01\n結論：Needs changes')])]));
  const built = board({ issues: ok(issues), pullRequests: ok(prs), details });
  const shown = built.columns.reduce((sum, column) => sum + column.cards.length, 0);
  assert.equal(shown, MAX_CARDS);
  const changes = built.columns.find((column) => column.id === 'changes');
  assert.deepEqual([changes.count, changes.cards.length, changes.more], [5, 5, 0], 'what needs changes is listed first');
  const backlog = built.columns.find((column) => column.id === 'backlog');
  assert.deepEqual([backlog.count, backlog.cards.length, backlog.more], [35, 25, 10]);
  assert.equal(backlog.cards[0].number, 40, 'newest first within a column');
});

test('merged pull requests of the last two weeks, with the Issues they close (#397)', () => {
  const built = board({ merged: ok([
    pr(300, [3], { state: 'closed', merged: true, mergedAt: hoursAgo(30) }),
    pr(301, [], { state: 'closed', merged: true, mergedAt: hoursAgo(24 * 15) }),
    pr(302, [4], { state: 'closed', merged: false, closedAt: hoursAgo(2) }),
    // Closed without merging, even if a time says otherwise: not merged.
    pr(303, [5], { state: 'closed', merged: false, mergedAt: hoursAgo(3), closedAt: hoursAgo(3) })
  ]) });
  const merged = built.columns.find((column) => column.id === 'merged');
  assert.deepEqual(merged.cards.map((card) => [card.kind, card.number, card.refs, card.inColumn]), [['pullRequest', 300, ['#3'], 'merged 30h ago']]);
});

test('an agent is found by its Issue or by its pull request, and how long is said in plain words (#397)', () => {
  const built = board({ issues: ok([issue(14)]), pullRequests: ok([pr(140, [14])]), details: { 140: detail([]) }, agents: [{ id: 's', codename: 'Worker-02', task: { issue: null, pullRequest: 140 } }] });
  assert.equal(cardOf(built, 'issue:14').agent, 'Worker-02');
  assert.deepEqual([duration(5 * 60000), duration(3 * 3600000), duration(3 * 86400000), duration(-1), duration(NaN)], ['5m', '3h', '3d', 'unknown', 'unknown']);
  // Text from GitHub is one plain line on the card.
  const hostile = board({ issues: ok([issue(15, { title: `<img src=x>\n${'x'.repeat(300)}` })]) });
  assert.ok(cardOf(hostile, 'issue:15').title.length <= 160 && !cardOf(hostile, 'issue:15').title.includes('\n'));
});
