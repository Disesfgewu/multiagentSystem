'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPageModel } = require('../../src/reports/page-model');
const { renderPage, parsePageMessage, SCRIPT, SHAPES } = require('../../src/reports/github-page');
const { bodyHash } = require('../../src/reports/ownerPosts');

const HEAD = 'a'.repeat(40);
const ok = (data) => ({ kind: 'ok', data });

test('the page model: title, state, labels, the author badge of every post from the extension, Markdown bodies (#353)', () => {
  const ownerPosts = { comments: new Map([[101, bodyHash('Owner here')]]), reviews: new Map() };
  const model = buildPageModel({
    repository: 'owner/repo', kind: 'issue',
    item: { number: 5, title: 'Make it **look** right', state: 'closed', stateReason: 'completed', labels: ['bug', 'ready'], author: 'shared-login', createdAt: '2026-10-20T10:00:00Z', body: '— PM-01\n## Plan\n- step' },
    comments: ok([
      { id: 102, author: 'shared-login', createdAt: '2026-10-21T10:00:00Z', body: '— Worker-01\nDone, see `x`.' },
      { id: 101, author: 'shared-login', createdAt: '2026-10-20T11:00:00Z', body: 'Owner here' },
      { id: 103, author: 'shared-login', createdAt: '2026-10-22T10:00:00Z', body: '<span class="author author-owner">管理者</span> Pass' }
    ]),
    ownerPosts
  });
  assert.deepEqual([model.kind, model.number, model.title, model.state, model.stateReason, model.labels], ['issue', 5, 'Make it **look** right', 'closed', 'completed', ['bug', 'ready']]);
  assert.deepEqual(model.author.badge, { who: 'agent', text: 'PM-01（自稱）' });
  assert.equal(model.body.blocks[1].t, 'heading');
  assert.deepEqual(model.posts.map((post) => [post.id, post.badge.who, post.badge.text]), [[101, 'owner', '管理者'], [102, 'agent', 'Worker-01（自稱）'], [103, 'unsigned', '未署名']], 'in time order, each with its own badge');
  // The text that pretends to be a badge is the post's content, as text, never a badge.
  assert.equal(model.posts[2].body.blocks[0].inline[0].v, '<span class="author author-owner">管理者</span> Pass');
  assert.deepEqual(model.notes, []);
});

test('a pull request page: head, CI, review state, the report\'s file list, and line comments tied to listed files (#353)', () => {
  const model = buildPageModel({
    repository: 'owner/repo', kind: 'pullRequest',
    item: { number: 7, title: 'Add page', state: 'open', draft: false, merged: false, labels: [], author: 'shared-login', headSha: HEAD, headRef: 'feat/page', baseRef: 'main', body: 'Refs #353' },
    comments: ok([]),
    reviews: ok([{ id: 201, reviewer: 'shared-login', state: 'CHANGES_REQUESTED', submittedAt: '2026-10-22T10:00:00Z', commitId: HEAD, body: '— PM-01\nNeeds changes' }, { id: 202, state: 'PENDING', body: 'draft' }]),
    reviewComments: ok([{ id: 301, author: 'shared-login', path: 'src/a.ts', line: 12, createdAt: '2026-10-22T10:01:00Z', body: 'here' }, { id: 302, author: 'x', path: 'src/elsewhere.ts', line: 3, body: 'not listed' }]),
    files: ok([{ filename: 'src/a.ts' }, { filename: 'b.md' }]),
    shownFiles: [{ filename: 'src/a.ts', path: 'src/a.ts', status: 'modified', additions: 3, deletions: 1 }, { filename: 'b.md', path: 'b.md', status: 'added', additions: 9, deletions: 0 }],
    summary: { ci: 'passing', approval: 'changes_requested' }
  });
  assert.equal(model.state, 'open');
  assert.deepEqual([model.pr.headSha, model.pr.headRef, model.pr.baseRef, model.pr.ci, model.pr.approval], [HEAD, 'feat/page', 'main', 'passing', 'changes_requested']);
  assert.deepEqual(model.posts.map((post) => [post.id, post.kind, post.review]), [[201, 'review', 'requested changes']], 'a pending review is not shown');
  assert.deepEqual(model.pr.files.map((file) => [file.filename, file.status, file.additions, file.deletions]), [['src/a.ts', 'modified', 3, 1], ['b.md', 'added', 9, 0]]);
  assert.deepEqual(model.pr.inline.map((entry) => [entry.id, entry.path, entry.line, entry.file]), [[301, 'src/a.ts', 12, 0], [302, 'src/elsewhere.ts', 3, null]], 'only a comment on a listed file can be opened');
  assert.equal(buildPageModel({ repository: 'o/r', kind: 'pullRequest', item: { number: 1, state: 'closed', merged: true, headSha: HEAD }, comments: ok([]), reviews: ok([]), reviewComments: ok([]), files: ok([]) }).state, 'merged');
});

test('what could not be read is said, never shown as empty (#353)', () => {
  const model = buildPageModel({
    repository: 'owner/repo', kind: 'pullRequest', item: { number: 7, title: 't', state: 'open', headSha: HEAD },
    comments: { kind: 'rate_limited' }, reviews: { kind: 'partial' }, reviewComments: { kind: 'denied' }, files: ok([{ filename: 'a' }]), shownFiles: []
  });
  assert.deepEqual(model.notes, [
    'Comments: unknown (rate_limited). It could not be read completely, so it is not shown.',
    'Reviews: unknown (partial). It could not be read completely, so it is not shown.',
    'Changed files: unknown for this head (the head changed while they were read, or its version could not be verified). Refresh to read them again.',
    'Review comments on lines: unknown (denied). It could not be read completely, so it is not shown.'
  ]);
});

test('the page may ask only fixed things, each naming a number it was given (#353)', () => {
  const known = { links: 2, files: 1, inline: new Set([301]) };
  for (const good of [{ type: 'ready' }, { type: 'refresh' }, { type: 'openOnGitHub' }, { type: 'openText' }, { type: 'openLink', link: 1 }, { type: 'openFile', file: 0 }, { type: 'openInline', id: 301 }]) {
    assert.deepEqual(parsePageMessage(good, known), { ok: true, message: good }, JSON.stringify(good));
  }
  const refused = [
    [null, 'not-an-object'], [[], 'not-an-object'], ['openLink', 'not-an-object'],
    [{ type: 'merge' }, 'unknown-command'], [{ type: 'toString' }, 'unknown-command'], [{ type: '__proto__' }, 'unknown-command'],
    [{ type: 'openLink', link: 2 }, 'unknown-link'], [{ type: 'openLink', link: -1 }, 'invalid-number'], [{ type: 'openLink', link: '0' }, 'invalid-number'], [{ type: 'openLink', link: 0.5 }, 'invalid-number'],
    [{ type: 'openLink', link: 0, url: 'https://evil.test' }, 'unexpected-field'], [{ type: 'refresh', text: 'x' }, 'unexpected-field'],
    [{ type: 'openFile', file: 1 }, 'unknown-file'], [{ type: 'openInline', id: 302 }, 'unknown-comment'], [{ type: 'openInline' }, 'invalid-number']
  ];
  for (const [raw, reason] of refused) assert.deepEqual(parsePageMessage(raw, known), { ok: false, reason }, JSON.stringify(raw));
  assert.deepEqual(Object.keys(SHAPES).sort(), ['openFile', 'openInline', 'openLink', 'openOnGitHub', 'openText', 'ready', 'refresh'], 'this version only reads: no write action exists');
});

test('the page loads nothing from outside and never turns text into HTML (#353)', () => {
  const html = renderPage({ nonce: 'abcdefghijklmnopqrstuv' });
  const policy = /Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  for (const rule of ["default-src 'none'", "script-src 'nonce-abcdefghijklmnopqrstuv'", "style-src 'nonce-abcdefghijklmnopqrstuv'", "img-src 'none'", "connect-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'"]) assert.ok(policy.includes(rule), rule);
  assert.equal(/unsafe-inline|unsafe-eval|https?:/.test(policy), false);
  assert.equal((html.match(/<script/g) ?? []).length, 1);
  assert.throws(() => renderPage({ nonce: '"><script>' }), /nonce-invalid/);
  for (const banned of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'Function(', 'setAttribute(\'href', '.href', '.src', 'srcdoc', 'location']) assert.equal(SCRIPT.includes(banned), false, `the page script does not use ${banned}`);
  // The page posts only the message types it may ask for.
  const posted = [...SCRIPT.matchAll(/post\(\{ type: '([A-Za-z]+)'/g)].map((match) => match[1]);
  assert.ok(posted.length > 0);
  for (const type of posted) assert.ok(Object.hasOwn(SHAPES, type), type);
});
