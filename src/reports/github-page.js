'use strict';

/**
 * The Issue and pull request page (#353). Like the Workbench page, the HTML is static and carries no data: the extension sends the
 * page model (`page-model.js`) as a message, and the script builds every element with `createElement` and `textContent`, so no text
 * from GitHub is ever parsed as HTML. Markdown arrives as a tree; a link is an index the extension looks up and checks again before
 * opening it in the browser; an image is never loaded, only offered as a link. The author badge of each post is drawn in the post's
 * header, outside the box that holds its content, from the extension's own answer, never from the post. The content security policy
 * allows no remote source, no image, no inline handler and one script, identified by a nonce.
 */

const NONCE = /^[A-Za-z0-9+/=_-]{16,64}$/;

// Runs in the web page, not here. It only ever posts the messages `parsePageMessage` accepts.
const SCRIPT = String.raw`
(function () {
  'use strict';
  var vscode = acquireVsCodeApi();
  var root = document.getElementById('app');
  var page = null;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function button(label, onClick, title, className) {
    var node = el('button', className || 'btn', label);
    node.type = 'button';
    if (title) node.title = title;
    node.addEventListener('click', onClick);
    return node;
  }
  function post(message) { vscode.postMessage(message); }
  function shortTime(value) { return typeof value === 'string' ? value.replace('T', ' ').slice(0, 16) + ' UTC' : 'time unknown'; }

  // A link of the content: no address in the page, only the index of one the extension checked.
  function linkNode(index, children) {
    var node = el('a', 'md-link');
    node.setAttribute('role', 'link');
    node.tabIndex = 0;
    node.title = 'Open in the browser';
    var open = function (event) { event.preventDefault(); post({ type: 'openLink', link: index }); };
    node.addEventListener('click', open);
    node.addEventListener('keydown', function (event) { if (event.key === 'Enter') open(event); });
    inline(children, node);
    return node;
  }

  function inline(nodes, parent) {
    (nodes || []).forEach(function (node) {
      if (!node || typeof node !== 'object') return;
      if (node.t === 'text') parent.appendChild(document.createTextNode(String(node.v)));
      else if (node.t === 'code') parent.appendChild(el('code', null, node.v));
      else if (node.t === 'break') parent.appendChild(el('br'));
      else if (node.t === 'strong' || node.t === 'em' || node.t === 'del') { var wrap = el(node.t === 'strong' ? 'strong' : node.t === 'em' ? 'em' : 'del'); inline(node.c, wrap); parent.appendChild(wrap); }
      else if (node.t === 'span') { var span = el('span', 'md-unlinked'); span.title = 'This link is not opened: only https addresses and this repository are'; inline(node.c, span); parent.appendChild(span); }
      else if (node.t === 'link' && typeof node.link === 'number') parent.appendChild(linkNode(node.link, node.c));
      else if (node.t === 'image') {
        var label = 'Image: ' + (node.alt || 'no description');
        if (typeof node.link === 'number') parent.appendChild(button(label + ' (open in the browser)', function () { post({ type: 'openLink', link: node.link }); }, 'Images are not loaded here, so nobody learns that you read this. Click to open it in the browser.', 'btn md-image'));
        else parent.appendChild(el('span', 'md-unlinked', '[' + label + ']'));
      }
    });
  }

  function blocks(list, parent) {
    (list || []).forEach(function (block) {
      if (!block || typeof block !== 'object') return;
      if (block.t === 'heading') { var h = el('h' + Math.min(6, Math.max(1, block.level)), 'md-h'); inline(block.inline, h); parent.appendChild(h); }
      else if (block.t === 'paragraph') { var p = el('p'); inline(block.inline, p); parent.appendChild(p); }
      else if (block.t === 'code') { var pre = el('pre'); pre.appendChild(el('code', null, block.text)); parent.appendChild(pre); }
      else if (block.t === 'quote') { var q = el('blockquote'); blocks(block.blocks, q); parent.appendChild(q); }
      else if (block.t === 'rule') parent.appendChild(el('hr'));
      else if (block.t === 'list') {
        var listNode = el(block.ordered ? 'ol' : 'ul');
        if (block.ordered && typeof block.start === 'number' && block.start !== 1) listNode.start = block.start;
        block.items.forEach(function (item) {
          var li = el('li', item.checked === null ? null : 'task');
          var rest = item.blocks;
          // A task's box goes in front of its first line, as on GitHub.
          if (item.checked !== null) {
            var first = el('p');
            first.appendChild(el('span', 'task-box', item.checked ? '☑ ' : '☐ '));
            if (rest.length && rest[0].t === 'paragraph') { inline(rest[0].inline, first); rest = rest.slice(1); }
            li.appendChild(first);
          }
          blocks(rest, li);
          listNode.appendChild(li);
        });
        parent.appendChild(listNode);
      } else if (block.t === 'table') {
        var table = el('table');
        var head = el('tr');
        block.head.forEach(function (cell, index) { var th = el('th', block.align[index] ? 'al-' + block.align[index] : null); inline(cell, th); head.appendChild(th); });
        var thead = el('thead'); thead.appendChild(head); table.appendChild(thead);
        var body = el('tbody');
        block.rows.forEach(function (row) {
          var tr = el('tr');
          row.forEach(function (cell, index) { var td = el('td', block.align[index] ? 'al-' + block.align[index] : null); inline(cell, td); tr.appendChild(td); });
          body.appendChild(tr);
        });
        table.appendChild(body);
        var scroll = el('div', 'table-scroll'); scroll.appendChild(table);
        parent.appendChild(scroll);
      }
    });
  }

  // The content of one post, in its own box. Nothing in it is a control of this page.
  function content(markdown) {
    var box = el('div', 'md');
    if (!markdown || !markdown.blocks || markdown.blocks.length === 0) box.appendChild(el('p', 'muted', 'No description provided.'));
    else blocks(markdown.blocks, box);
    if (markdown && markdown.truncated) box.appendChild(el('p', 'muted', 'This post is longer than is shown here; open it on GitHub to read the rest.'));
    return box;
  }

  // The header of a post: the extension's badge for who wrote it, then the GitHub account, the time and, for a review, its state.
  function postHeader(author, extra) {
    var head = el('div', 'post-head');
    head.appendChild(el('span', 'author author-' + author.badge.who, author.badge.text));
    head.appendChild(el('span', 'muted', author.login));
    head.appendChild(el('span', 'muted', shortTime(author.at)));
    if (extra) head.appendChild(el('span', 'review review-' + extra.replace(/\s+/g, '-'), extra));
    return head;
  }

  function postNode(entry, extra, actions) {
    var node = el('article', 'post');
    node.appendChild(postHeader(entry, extra));
    node.appendChild(content(entry.body));
    if (actions) node.appendChild(actions);
    return node;
  }

  function render() {
    root.textContent = '';
    if (!page) { root.appendChild(el('p', 'muted', 'Reading from GitHub…')); return; }
    if (page.error) {
      root.appendChild(el('p', 'alert', page.error));
      root.appendChild(button('Try again', function () { post({ type: 'refresh' }); }));
      return;
    }
    var m = page.model;
    var top = el('header', 'top');
    var title = el('h1');
    title.appendChild(document.createTextNode(m.title + ' '));
    title.appendChild(el('span', 'muted', '#' + m.number));
    top.appendChild(title);
    var meta = el('div', 'meta');
    meta.appendChild(el('span', 'state state-' + m.state, m.state === 'closed' && m.stateReason ? 'closed (' + m.stateReason.replace(/_/g, ' ') + ')' : m.state));
    meta.appendChild(el('span', 'muted', (m.kind === 'issue' ? 'Issue' : 'Pull request') + ' opened ' + shortTime(m.author.at) + ' by'));
    meta.appendChild(el('span', 'author author-' + m.author.badge.who, m.author.badge.text));
    meta.appendChild(el('span', 'muted', m.author.login));
    m.labels.forEach(function (label) { meta.appendChild(el('span', 'label', label)); });
    top.appendChild(meta);
    var tools = el('div', 'row');
    tools.appendChild(button('Refresh', function () { post({ type: 'refresh' }); }));
    tools.appendChild(button('Open on GitHub', function () { post({ type: 'openOnGitHub' }); }));
    tools.appendChild(button('Open as text report', function () { post({ type: 'openText' }); }));
    top.appendChild(tools);
    if (page.readAt) top.appendChild(el('div', 'muted', 'Read from GitHub ' + shortTime(page.readAt) + '.'));
    root.appendChild(top);

    if (m.pr) {
      var pr = el('section', 'pr-box');
      pr.appendChild(el('div', null, 'Head ' + (m.pr.headSha ? m.pr.headSha.slice(0, 12) : 'unknown') + ' · ' + (m.pr.headRef || 'branch unknown') + ' → ' + (m.pr.baseRef || 'base unknown')));
      pr.appendChild(el('div', null, 'CI: ' + m.pr.ci + ' · Review: ' + m.pr.approval));
      root.appendChild(pr);
    }
    m.notes.forEach(function (text) { root.appendChild(el('div', 'note', text)); });

    var timeline = el('section', 'timeline');
    timeline.appendChild(postNode({ badge: m.author.badge, login: m.author.login, at: m.author.at, body: m.body }));
    m.posts.forEach(function (entry) { timeline.appendChild(postNode(entry, entry.kind === 'review' ? 'review: ' + entry.review : null)); });
    root.appendChild(el('h2', null, 'Conversation (' + (m.posts.length + 1) + ')'));
    root.appendChild(timeline);

    if (m.pr) {
      root.appendChild(el('h2', null, 'Files changed (' + m.pr.files.length + ')'));
      var files = el('ul', 'files');
      m.pr.files.forEach(function (file, index) {
        var li = el('li');
        li.appendChild(button(file.filename, function () { post({ type: 'openFile', file: index }); }, 'Open the diff of this file', 'btn file-link'));
        li.appendChild(el('span', 'muted', ' ' + file.status + (file.additions !== null ? ' +' + file.additions : '') + (file.deletions !== null ? ' −' + file.deletions : '')));
        files.appendChild(li);
      });
      root.appendChild(files);
      if (m.pr.inline.length > 0) {
        root.appendChild(el('h2', null, 'Review comments on lines (' + m.pr.inline.length + ')'));
        m.pr.inline.forEach(function (entry) {
          var where = (entry.path || 'file unknown') + (entry.line ? ':' + entry.line : '');
          var actions = null;
          if (entry.file !== null) {
            actions = el('div', 'row');
            actions.appendChild(button('Go to ' + where, function () { post({ type: 'openInline', id: entry.id }); }, 'Open the diff of this file at this line'));
          }
          var node = postNode(entry, null, actions);
          node.insertBefore(el('div', 'where muted', where), node.firstChild);
          root.appendChild(node);
        });
      }
    }
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.type !== 'page') return;
    page = data;
    render();
  });
  render();
  post({ type: 'ready' });
})();
`;

const STYLE = `
  :root { color-scheme: light dark; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 16px 24px; max-width: 1000px; }
  h1 { font-size: 1.5em; margin: 0 0 6px; font-weight: 400; } h2 { font-size: 1.05em; margin: 20px 0 8px; }
  .top { border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 10px; margin-bottom: 12px; display: flex; flex-direction: column; gap: 8px; }
  .meta, .row, .post-head { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .state { padding: 2px 10px; border-radius: 12px; font-weight: 600; color: var(--vscode-button-foreground); background: var(--vscode-charts-green); }
  .state-closed { background: var(--vscode-charts-red); } .state-merged { background: var(--vscode-charts-purple); } .state-draft { background: var(--vscode-disabledForeground); }
  .label { font-size: 0.85em; padding: 1px 8px; border-radius: 10px; border: 1px solid var(--vscode-panel-border); }
  .author { font-size: 0.85em; font-weight: 600; padding: 1px 8px; border-radius: 4px; border: 1px solid var(--vscode-panel-border); }
  .author-owner { background: var(--vscode-charts-blue); color: var(--vscode-button-foreground); border-color: transparent; }
  .author-agent { border-color: var(--vscode-charts-green); }
  .author-modified, .author-legacy, .author-unknown { border-color: var(--vscode-editorWarning-foreground); color: var(--vscode-editorWarning-foreground); }
  .review { font-size: 0.85em; padding: 1px 6px; border-radius: 4px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .post { border: 1px solid var(--vscode-panel-border); border-radius: 6px; margin-bottom: 12px; }
  .post-head { padding: 6px 10px; background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-panel-border); border-radius: 6px 6px 0 0; }
  .post > .row { padding: 0 10px 8px; } .where { padding: 6px 10px 0; font-family: var(--vscode-editor-font-family); }
  .md { padding: 4px 14px; overflow-wrap: anywhere; line-height: 1.5; }
  .md pre { background: var(--vscode-textCodeBlock-background); padding: 8px 10px; overflow-x: auto; border-radius: 4px; }
  .md code { font-family: var(--vscode-editor-font-family); font-size: 0.92em; } .md p > code, .md li > code, .md td > code { background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; }
  .md blockquote { margin: 0 0 8px; padding: 0 12px; border-left: 3px solid var(--vscode-textBlockQuote-border); color: var(--vscode-descriptionForeground); }
  .md table { border-collapse: collapse; margin: 6px 0; } .md th, .md td { border: 1px solid var(--vscode-panel-border); padding: 4px 8px; }
  .table-scroll { overflow-x: auto; } .al-center { text-align: center; } .al-right { text-align: right; } .al-left { text-align: left; }
  .md-h { margin: 14px 0 6px; font-weight: 600; } h1.md-h { font-size: 1.6em; } h2.md-h { font-size: 1.35em; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 3px; } h3.md-h { font-size: 1.15em; }
  .md p { margin: 6px 0; } .md li > p { margin: 2px 0; } .md ul, .md ol { padding-left: 24px; margin: 4px 0; } li.task { list-style: none; } .md hr { border: 0; border-top: 1px solid var(--vscode-panel-border); }
  .md-link { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline; } .md-link:hover { color: var(--vscode-textLink-activeForeground); }
  .md-unlinked { border-bottom: 1px dotted var(--vscode-descriptionForeground); }
  .pr-box, .note { padding: 6px 10px; margin-bottom: 10px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
  .files { list-style: none; padding: 0; } .files li { margin: 2px 0; }
  .btn { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 0; padding: 3px 8px; cursor: pointer; border-radius: 2px; font: inherit; }
  .btn:hover { background: var(--vscode-button-secondaryHoverBackground); } .btn:focus-visible, .md-link:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .file-link { font-family: var(--vscode-editor-font-family); background: transparent; color: var(--vscode-textLink-foreground); padding: 0; }
  .muted { color: var(--vscode-descriptionForeground); } .alert { color: var(--vscode-errorForeground); }
`;

/**
 * @param {{ nonce: string }} input a fresh random value for this page, used for its one script and its one style
 * @returns {string}
 */
function renderPage({ nonce }) {
  if (typeof nonce !== 'string' || !NONCE.test(nonce)) throw new TypeError('nonce-invalid');
  const policy = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    "img-src 'none'",
    "media-src 'none'",
    "font-src 'none'",
    "connect-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'"
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="viewport" content="width=device-width, initial-scale=1"><title>GitHub page</title><style nonce="${nonce}">${STYLE}</style></head>
<body><div id="app" role="main"></div><script nonce="${nonce}">${SCRIPT}</script></body></html>
`;
}

// What the page may ask: fixed names, each with only the numbers it needs. Anything else is refused before it reaches a command.
const SHAPES = Object.freeze({ ready: [], refresh: [], openOnGitHub: [], openText: [], openLink: ['link'], openFile: ['file'], openInline: ['id'] });

/**
 * @param {unknown} raw what the page posted
 * @param {{ links: number, files: number, inline: Set<number> }} known how many links and files the page was given, and its inline comment ids
 * @returns {{ ok: true, message: { type: string, link?: number, file?: number, id?: number } } | { ok: false, reason: string }}
 */
function parsePageMessage(raw, known) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not-an-object' };
  const type = raw.type;
  if (typeof type !== 'string' || !Object.hasOwn(SHAPES, type)) return { ok: false, reason: 'unknown-command' };
  const fields = SHAPES[type];
  for (const key of Object.keys(raw)) if (key !== 'type' && !fields.includes(key)) return { ok: false, reason: 'unexpected-field' };
  for (const key of fields) if (!Number.isSafeInteger(raw[key]) || raw[key] < 0) return { ok: false, reason: 'invalid-number' };
  if (type === 'openLink' && raw.link >= known.links) return { ok: false, reason: 'unknown-link' };
  if (type === 'openFile' && raw.file >= known.files) return { ok: false, reason: 'unknown-file' };
  if (type === 'openInline' && !known.inline.has(raw.id)) return { ok: false, reason: 'unknown-comment' };
  const message = { type };
  for (const key of fields) message[key] = raw[key];
  return { ok: true, message };
}

module.exports = { renderPage, parsePageMessage, SCRIPT, STYLE, SHAPES };
