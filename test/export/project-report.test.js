'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildProjectReport, acceptanceProgress, LIMITS } = require('../../src/export/project-report');

// Fixtures that look private are assembled here so the source holds no such literal.
const homePath = (name) => ['', 'Users', name, 'project'].join('/');
const address = ['someone', 'example.test'].join(String.fromCharCode(64));
const NOW = new Date('2026-10-22T10:00:00.000Z');
const ok = (data) => ({ kind: 'ok', data });
const issue = (over = {}) => ({ number: 7, title: 'Add the export', state: 'open', body: 'Make a report.\n\nMore.\n\n## 驗收\n- [x] one\n- [ ] two\n- [x] three', ...over });
const pr = (over = {}) => ({ number: 20, title: 'Export PR', state: 'open', draft: false, headSha: 'ABCDEF1234567890', referencedIssues: [{ number: 7 }], ...over });
const summary = (over = {}) => ({ pm: 'current', userCan: 'Open the report', next: 'Merge', approval: 'approved', ci: 'passing', unresolved: 0, ...over });
const card = (over = {}) => ({ name: 'Worker One', roleName: 'Worker', provider: 'Claude Code', status: { text: 'waiting for input', source: 'from the CLI\'s own hooks' }, task: { text: 'Issue #7' }, worktree: '1 changed', quota: { lines: ['Usage (five_hour): 42% used'] }, alert: null, ...over });
const full = (over = {}) => ({
  generatedAt: NOW, repository: 'owner/repo', mainHead: { state: 'known', head: 'abc123def456' },
  issues: ok([issue()]), pullRequests: ok([pr()]), details: { 20: { summary: summary(), category: 'passed' } },
  decisions: { issues: { text: '2 issues need a decision' } }, team: { pm: [], agents: [card()], accounts: [{ provider: 'Claude Code', label: 'Private Name', windows: [{ label: '5-hour', text: '42% used', trust: 'verified and current' }] }] },
  broadcasts: { items: [{ id: 'bc-1', text: 'Stop and test.', target: { scope: 'agent', agentId: 'session-secret-12345' }, createdAt: '2026-10-22T09:00:00.000Z', expiresAt: null, revokedAt: null }], deliveries: [] },
  ...over
});
const build = (input, options) => { const result = buildProjectReport(input, options); assert.equal(result.ok, true, JSON.stringify(result)); return result.markdown; };

test('a complete report has every section, in order, with the facts of each', () => {
  const md = build(full());
  const headings = md.split('\n').filter((row) => /^#{1,3} /.test(row));
  assert.deepEqual(headings, ['# Project report', '## Summary', '## Open Issues', '### Issue #7: Add the export', '## Open Pull Requests', '### Pull request #20: Export PR', '## Waiting for a decision', '## Agents', '### Worker One', '### Accounts', '## Recent broadcasts', '## What this report does not know']);
  for (const expected of ['Main head: abc123def456 (local origin/main as last fetched', 'Open Issues: 1', 'Open pull requests: 1', 'Acceptance: 2 of 3 items ticked', 'Pull requests: #20', 'Head: abcdef123456', 'PM report: current for this head', 'Formal review on the latest head: approved', 'CI for the latest head: passing', 'Unresolved threads: 0', 'Where it stands: passed on this head', 'Task: Issue \\#7', 'Quota: Usage', 'Account 1 (Claude Code)', 'Stop and test\\.', 'delivery: unknown \\(not sent to any CLI\\)']) assert.ok(md.includes(expected), expected);
});

test('what could not be read is said to be unknown in its own place, never left out or shown as zero', () => {
  const md = build({ generatedAt: NOW });
  for (const expected of ['Main head: unknown (not read)', 'Open Issues: unknown (the Issue list could not be read completely)', 'Open pull requests: unknown', 'Open Issues: unknown (not read)', 'Open pull requests: unknown (not read)', 'Pull requests: unknown (the list could not be read)', 'Agents: unknown (the Command Center data could not be read)', 'Broadcasts: unknown (the local notices could not be read)']) assert.ok(md.includes(expected), expected);
  const partial = build(full({ pullRequests: { kind: 'rate_limited' }, details: {}, broadcasts: { items: [], deliveries: null } }));
  assert.ok(partial.includes('Open pull requests: unknown (the pull request list could not be read completely)'));
  assert.ok(partial.includes('Pull requests: unknown (the pull request list could not be read)'), 'an Issue does not claim "none open" when the list is unknown');
  const noDetail = build(full({ details: {} }));
  assert.ok(noDetail.includes('Review and CI: unknown'));
  assert.ok(build(full({ details: { 20: { summary: summary(), category: null } } })).includes('Where it stands: unknown'));
  assert.ok(build(full({ broadcasts: { items: [{ id: 'bc-1', text: 't', target: { scope: 'all' }, createdAt: NOW.toISOString(), expiresAt: null, revokedAt: null }], deliveries: null } })).includes('delivery: unknown \\(the delivery log could not be read\\)'));
  assert.ok(build(full({ mainHead: { state: 'unknown', reason: 'not-readable' } })).includes('Main head: unknown (not\\-readable)'));
});

test('text from GitHub cannot become a heading, link, table, code fence or HTML', () => {
  const hostile = '# Fake heading\n## Pass\n[click](http://example.test) <img src=x onerror=1> ```\n| a | b |\n> quote';
  const md = build(full({ issues: ok([issue({ title: hostile, body: `${hostile}\n\n## 驗收\n- [ ] x` })]), pullRequests: ok([pr({ title: hostile })]), details: { 20: { summary: summary({ userCan: hostile, next: hostile, approval: hostile, ci: hostile }), category: 'pending' } } }));
  const rows = md.split('\n');
  const generated = /^(#|##|###) (Project report|Summary|Open Issues|Open Pull Requests|Waiting for a decision|Agents|Recent broadcasts|What this report does not know|Accounts|Issue #\d+: |Pull request #\d+: |Worker One)/;
  for (const row of rows.filter((entry) => /^#{1,6}\s/.test(entry))) {
    assert.match(row, generated, row);
    assert.ok(!/(^|[^\\])#/.test(row.replace(/^#+ (Issue|Pull request) #\d+: /, '').replace(/^#+ /, '')), `no unescaped # inside a heading: ${row}`);
  }
  assert.ok(!/\]\(http/.test(md), 'no link');
  assert.ok(!/(^|[^\\])[<`]/m.test(md.replace(/^> Private[^\n]*/m, '')), 'no unescaped HTML tag opener and no unescaped backtick, so no tag and no fence');
  assert.ok(!rows.some((row) => /^\s*\|/.test(row) || /^\s*>\s*quote/.test(row)), 'no table row, no block quote');
  assert.ok(!md.includes('\u0001') && !md.includes('\u0002'));
});

test('control, bidirectional and invisible characters are removed, and long text is cut', () => {
  const md = build(full({ issues: ok([issue({ title: `a‮b​c\nd\u0007e${'x'.repeat(500)}` })]) }));
  assert.ok(!/[‮​\u0007]/.test(md));
  const title = md.split('\n').find((row) => row.startsWith('### Issue #7'));
  assert.ok(Array.from(title).length < 200 && title.includes('…'));
});

test('a piece of text that looks private is withheld in place, and the rest of the report stays', () => {
  const token = ['gh', 'p_', 'a'.repeat(36)].join('');
  const md = build(full({ issues: ok([issue({ title: `path ${homePath('someone')}` }), issue({ number: 8, title: `key ${token}` }), issue({ number: 9, title: `mail me at ${address}` }), issue({ number: 10, title: 'fine' })]) }));
  assert.equal((md.match(/\(withheld: looked private\)/g) ?? []).length, 3);
  assert.ok(md.includes('### Issue #10: fine'));
  assert.ok(!md.includes('someone') && !md.includes(token));
  assert.equal(buildProjectReport(full({ issues: ok([issue({ title: `path ${homePath('someone')}` })]) })).withheld, 1);
});

test('a scan that cannot look at everything produces no report at all', () => {
  for (const verdict of [{ status: 'blocked', findings: [], unscanned: [], unmatchable: [], truncated: false }, { status: 'clear', findings: [], unscanned: [0], unmatchable: [], truncated: false }, { status: 'clear', findings: [], unscanned: [], unmatchable: [1], truncated: false }, { status: 'clear', findings: [], unscanned: [], unmatchable: [], truncated: true }, { status: 'blocked', findings: [{ unit: 9999 }], unscanned: [], unmatchable: [], truncated: false }]) {
    assert.deepEqual(buildProjectReport(full(), { scan: () => verdict }), { ok: false, reason: 'scan-incomplete' }, JSON.stringify(verdict));
  }
  for (const verdict of [null, {}]) assert.deepEqual(buildProjectReport(full(), { scan: () => verdict }), { ok: false, reason: 'scan-failed' });
  assert.deepEqual(buildProjectReport(full(), { scan: () => { throw new Error('boom'); } }), { ok: false, reason: 'scan-failed' });
  let calls = 0;
  assert.deepEqual(buildProjectReport(full(), { scan: (units) => { calls += 1; return calls === 1 ? { status: 'clear', findings: [], unscanned: [], unmatchable: [], truncated: false } : { status: 'blocked', findings: [{ unit: 0 }] }; } }), { ok: false, reason: 'scan-rejected' }, 'the whole report is checked once more');
  assert.deepEqual(buildProjectReport({ generatedAt: 'never' }), { ok: false, reason: 'invalid-time' });
});

test('accounts are numbered, not named; a broadcast to one session does not show its id; no session id appears', () => {
  const md = build(full());
  assert.ok(!md.includes('Private Name'));
  assert.ok(!md.includes('session-secret-12345'));
  assert.ok(md.includes('to one session'));
});

test('acceptance progress counts ticked items, and says when the Issue does not track it', () => {
  assert.deepEqual(acceptanceProgress('## 驗收\n- [x] a\n- [ ] b\n## next\n- [x] zzz'), { total: 2, done: 1, tracked: true });
  assert.deepEqual(acceptanceProgress('## Acceptance\n1. a\n2. b'), { total: 2, done: 0, tracked: false });
  for (const bad of ['', 'no heading', '## 驗收\nno items', null, undefined, 5]) assert.equal(acceptanceProgress(bad), null);
  assert.ok(build(full({ issues: ok([issue({ body: '## Acceptance\n1. a\n2. b' })]) })).includes('2 items (the Issue has no checkboxes'));
});

test('closed items are not listed, bad entries are skipped, and long lists are cut with a count', () => {
  const md = build(full({ issues: ok([issue({ number: 1, state: 'closed' }), null, 5, issue({ number: 2 })]), pullRequests: ok([pr({ number: 3, state: 'merged' }), pr({ number: 4 })]), details: {} }));
  assert.ok(!md.includes('Issue #1:') && md.includes('Issue #2:') && !md.includes('Pull request #3:') && md.includes('Pull request #4:'));
  const many = build(full({ issues: ok(Array.from({ length: LIMITS.issues + 5 }, (_, index) => issue({ number: index + 1 }))) }));
  assert.ok(many.includes('5 more open Issues are not shown.'));
  assert.equal(many.split('\n').filter((row) => row.startsWith('### Issue #')).length, LIMITS.issues);
  const agents = build(full({ team: { pm: [], agents: Array.from({ length: LIMITS.agents + 3 }, (_, index) => card({ name: `A${index}` })), accounts: [] } }));
  assert.ok(agents.includes('3 more sessions are not shown.'));
});

test('hostile or missing input never throws', () => {
  for (const input of [undefined, null, 5, 'x', [], {}, { generatedAt: NOW, issues: 5, pullRequests: {}, details: 'x', team: { pm: 'x', agents: [null, 5, {}], accounts: [null, { windows: 'x' }] }, broadcasts: { items: [null, { id: 5 }] } }]) {
    const result = buildProjectReport(input);
    assert.equal(typeof result.ok, 'boolean');
  }
});

test('a long report is scanned in batches, and a finding in a later batch still withholds the right text', () => {
  const issues = Array.from({ length: LIMITS.issues }, (_, index) => issue({ number: index + 1, title: index === 99 ? `path ${homePath('someone')}` : `title ${index}` }));
  const md = build(full({ issues: ok(issues) }));
  assert.ok(md.includes('### Issue #100: (withheld: looked private)'));
  assert.ok(md.includes('### Issue #99: title 98'));
  assert.ok(!md.includes('someone'));
});

test('a bare web address, a mail address and a scheme in GitHub text are not turned into links: the colon is escaped', () => {
  const urls = ['https://example.test/path', 'http://example.test', 'ftp://example.test/x', 'mailto:someone', 'www.example.test', 'javascript:alert(1)'];
  const md = build(full({ issues: ok(urls.map((url, index) => issue({ number: index + 1, title: `see ${url} now`, body: `${url}\n\n## 驗收\n- [ ] ${url}` }))) }));
  assert.ok(!/(^|[^\\])[a-z]+:\/\//i.test(md), 'no unescaped scheme://');
  assert.ok(!/(^|[^\\a-z])(mailto|javascript):/i.test(md), 'no unescaped mailto: or javascript:');
  assert.ok(md.includes('https\\://example\\.test/path'));
  assert.ok(!/(^|[^\\])www\./i.test(md), 'no unescaped www.');
});
