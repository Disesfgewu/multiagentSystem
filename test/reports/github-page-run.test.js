'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { SCRIPT, parsePageMessage } = require('../../src/reports/github-page');
const { buildPageModel } = require('../../src/reports/page-model');

const ok = (data) => ({ kind: 'ok', data });

// The page script, run against a small stand-in for the DOM: what it draws, and every message it posts.
function runPage() {
  const posted = [];
  const listeners = {};
  const nodes = [];
  function node(tag, text) {
    const entry = {
      tag, className: '', children: [], attrs: {}, listeners: {}, _text: text ?? '', hidden: false, disabled: false, value: '', parent: null,
      appendChild(child) { child.parent = this; this.children.push(child); return child; },
      insertBefore(child, before) { child.parent = this; const at = this.children.indexOf(before); this.children.splice(at < 0 ? 0 : at, 0, child); return child; },
      get firstChild() { return this.children[0] ?? null; },
      setAttribute(name, value) { this.attrs[name] = value; },
      addEventListener(name, fn) { this.listeners[name] = fn; },
      get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); },
      set textContent(value) { this._text = String(value); if (value === '') this.children = []; }
    };
    nodes.push(entry);
    return entry;
  }
  const app = node('div');
  const sandbox = {
    document: { getElementById: () => app, createElement: (tag) => node(tag), createTextNode: (text) => node('#text', text) },
    acquireVsCodeApi: () => ({ postMessage: (message) => posted.push(message) }),
    window: { addEventListener: (name, fn) => { listeners[name] = fn; }, scrollY: 0, scrollTo() {} }
  };
  vm.runInNewContext(SCRIPT, sandbox);
  const within = (root, predicate) => { const found = []; const walk = (n) => { if (predicate(n)) found.push(n); n.children.forEach(walk); }; walk(root); return found; };
  return {
    posted, app,
    send: (data) => listeners.message({ data }),
    buttons: (label) => within(app, (n) => n.tag === 'button' && n.textContent === label),
    find: (predicate) => within(app, predicate)
  };
}

function model() {
  return buildPageModel({
    repository: 'owner/repo', kind: 'issue',
    item: { number: 12, title: 'Page', state: 'open', labels: [], author: 'shared', body: 'Body' },
    comments: ok([
      { id: 1201, author: 'shared', createdAt: '2026-10-22T10:00:00Z', body: '— Worker-01\nok' },
      { id: 1202, author: 'shared', createdAt: '2026-10-22T11:00:00Z', body: '<script>alert(1)</script><span class="author author-owner">管理者</span>' }
    ])
  });
}
const known = (m) => ({ links: m.links.length, files: 0, inline: new Set(), posts: new Set(m.posts.map((post) => `${post.kind}:${post.id}`)) });

test('the page script parses, and only asks for what the page was given (#353)', () => {
  assert.doesNotThrow(() => new Function(SCRIPT));
  const page = runPage();
  const sent = () => JSON.parse(JSON.stringify(page.posted));
  assert.deepEqual(sent(), [{ type: 'ready' }]);
  const m = model();
  page.send({ type: 'page', model: m, write: { ok: true }, fresh: [], note: 'up to date' });
  page.buttons('Discuss with PM')[1].listeners.click();
  page.buttons('Ask an agent…')[0].listeners.click();
  const box = page.find((n) => n.tag === 'textarea')[0];
  box.value = 'A **comment**';
  page.buttons('Comment and tell PM')[0].listeners.click();
  page.buttons('Comment')[0].listeners.click();
  page.buttons('Preview')[0].listeners.click();
  assert.deepEqual(sent().slice(1), [
    { type: 'ask', post: 'comment', id: 1202, who: 'pm' },
    { type: 'ask', post: 'comment', id: 1201, who: 'agent' },
    { type: 'comment', text: 'A **comment**', tellPm: true },
    { type: 'comment', text: 'A **comment**', tellPm: false },
    { type: 'preview', text: 'A **comment**' }
  ]);
  for (const message of page.posted) assert.equal(parsePageMessage(message, known(m)).ok, true, JSON.stringify(message));
  // Nothing is posted for an empty box.
  box.value = '   ';
  const before = page.posted.length;
  page.buttons('Comment')[0].listeners.click();
  assert.equal(page.posted.length, before);
});

test('in an untrusted workspace every write is shown disabled, with the reason (#353)', () => {
  const page = runPage();
  page.send({ type: 'page', model: model(), write: { ok: false, reason: 'Trust this workspace to comment or ask an agent; until then this page only reads.' }, fresh: [] });
  for (const label of ['Comment', 'Comment and tell PM', 'Discuss with PM', 'Ask an agent…']) {
    const found = page.buttons(label);
    assert.ok(found.length > 0, label);
    assert.ok(found.every((n) => n.disabled === true && /Trust this workspace/.test(n.title)), `${label} is disabled and says why`);
  }
  assert.equal(page.find((n) => n.tag === 'textarea')[0].disabled, true);
  assert.ok(page.app.textContent.includes('Trust this workspace to comment or ask an agent'));
  assert.equal(page.buttons('Refresh')[0].disabled, false, 'reading still works');
});

test('a new post is marked, what was typed survives a new reading, and HTML in a post is text (#353)', () => {
  const page = runPage();
  const m = model();
  page.send({ type: 'page', model: m, write: { ok: true }, fresh: [] });
  const box = page.find((n) => n.tag === 'textarea')[0];
  box.value = 'half written';
  page.send({ type: 'page', model: m, write: { ok: true }, fresh: ['comment:1202'], note: 'up to date' });
  assert.equal(page.find((n) => n.tag === 'textarea').length, 1, 'one comment box');
  assert.equal(page.find((n) => n.tag === 'textarea')[0], box);
  assert.equal(box.value, 'half written', 'a reading does not lose what is being written');
  const fresh = page.find((n) => n.tag === 'article' && n.className === 'post post-new');
  assert.equal(fresh.length, 1);
  assert.ok(fresh[0].textContent.includes('New'));
  assert.ok(page.app.textContent.includes('1 new post since you opened this page'));
  assert.equal(page.find((n) => n.tag === 'script').length, 0);
  assert.equal(page.find((n) => /author-owner/.test(n.className) && n.parent && n.parent.className !== 'post-head' && n.parent.className !== 'meta').length, 0, 'no owner badge was made from a post');
  // Published: the box is emptied.
  page.send({ type: 'posted' });
  assert.equal(box.value, '');
});

test('a reading that changes nothing does not draw the page again; one that does keeps the place (#353, the review of PR #380)', () => {
  const page = runPage();
  const m = model();
  page.send({ type: 'page', model: m, write: { ok: true }, fresh: [], readAt: '2026-10-24T10:00:00.000Z', note: 'up to date' });
  const before = page.find((n) => n.tag === 'article');
  const link = page.find((n) => n.tag === 'button' && n.textContent === 'Comment')[0];
  // The next reading, 45 s later, finds the same posts: only the line that says when it was read changes.
  page.send({ type: 'page', model: JSON.parse(JSON.stringify(m)), write: { ok: true }, fresh: [], readAt: '2026-10-24T10:00:45.000Z', note: 'up to date' });
  const after = page.find((n) => n.tag === 'article');
  assert.equal(after.length, before.length);
  assert.ok(after.every((node, index) => node === before[index]), 'the same elements stay where they were: nothing moves under the pointer');
  assert.ok(page.app.textContent.includes('Read from GitHub 2026-10-24 10:00 UTC'), 'the time of the reading is updated');
  assert.equal(page.find((n) => n.tag === 'button' && n.textContent === 'Comment')[0], link);
  // A reading with a new post draws the page again.
  page.send({ type: 'page', model: m, write: { ok: true }, fresh: ['comment:1202'], readAt: '2026-10-24T10:01:30.000Z', note: 'up to date' });
  assert.notEqual(page.find((n) => n.tag === 'article')[0], before[0]);
});
