'use strict';

/**
 * GitHub-flavoured Markdown for the Issue and pull request page (#353), parsed into a plain tree, never into HTML. All text on GitHub
 * is untrusted (the repository is public), so the page builds every element itself with `createElement` and `textContent` from this
 * tree: raw HTML in a comment is shown as the text it is, a link is an index into a list of addresses this module checked (https, or
 * a path in this repository on github.com), and an image is never loaded, only offered as a link. Nothing here can produce a button,
 * a badge or an attribute the page did not make.
 *
 * Blocks: heading, paragraph, code, quote, list, table, rule. Inline: text, code, strong, em, del, link, image, break.
 * Limits keep a hostile comment from costing much: the text is cut at `maxChars`, nesting at MAX_DEPTH, and the number of nodes at
 * MAX_NODES; what was cut is said (`truncated`).
 */

const MAX_DEPTH = 8;
const MAX_NODES = 5000;
const DEFAULT_MAX_CHARS = 60000;
const MAX_LINKS = 500;
// Removed from all text: control characters other than tab and newline, and invisible format characters (bidirectional overrides
// among them) except the zero-width joiner, which emoji need.
const UNSAFE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B\u200C\u200E\u200F\u2028-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB]/g;

const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const BULLET = /^( {0,3})([-*+])([ \t]+)(.*)$/;
const ORDERED = /^( {0,3})(\d{1,9})([.)])([ \t]+)(.*)$/;
const TASK = /^\[([ xX])\][ \t]+/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const DELIMITER_ROW = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const PUNCTUATION = /[!-/:-@[-`{-~]/;

/**
 * Checks a link target. Only https addresses without credentials, and paths of this repository resolved against `base` (the
 * Issue's or pull request's own page on github.com), are kept; anything else (javascript:, data:, http:, file:, another site's
 * protocol-relative address, a bare #anchor) is null and the link is shown as its text only.
 */
function safeHref(raw, base) {
  if (typeof raw !== 'string') return null;
  const target = raw.trim().replace(/^<|>$/g, '');
  if (target === '' || target.length > 2000 || /\s/.test(target) || target.startsWith('#')) return null;
  let url;
  try {
    if (SCHEME.test(target)) url = new URL(target);
    else if (target.startsWith('//') || typeof base !== 'string') return null;
    else url = new URL(target, base);
  } catch { return null; }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
  if (!SCHEME.test(target)) {
    // A relative link stays inside this repository on github.com.
    const home = new URL(base);
    const repo = home.pathname.split('/').slice(0, 3).join('/');
    if (url.host !== home.host || !(url.pathname === repo || url.pathname.startsWith(`${repo}/`))) return null;
  }
  return url.toString();
}

/**
 * @param {unknown} text Markdown from GitHub
 * @param {{ base?: string, links?: string[], maxChars?: number }} [options] `base` is the page's own address on github.com (for
 *   relative links); `links` collects the checked addresses (shared by every body of one page, so an index names one address)
 * @returns {{ blocks: object[], truncated: boolean, links: string[] }}
 */
function parseMarkdown(text, options = {}) {
  const links = Array.isArray(options.links) ? options.links : [];
  const maxChars = Number.isSafeInteger(options.maxChars) && options.maxChars > 0 ? options.maxChars : DEFAULT_MAX_CHARS;
  let source = typeof text === 'string' ? text : '';
  let truncated = false;
  if (source.length > maxChars) { source = source.slice(0, maxChars); truncated = true; }
  source = source.replace(/\r\n?/g, '\n').replace(UNSAFE, '').replace(/\t/g, '    ');
  const state = { nodes: 0, links, base: typeof options.base === 'string' ? options.base : null, truncated };
  const blocks = parseBlocks(source.split('\n'), state, 0);
  return { blocks, truncated: state.truncated, links };
}

function count(state) {
  state.nodes += 1;
  if (state.nodes > MAX_NODES) { state.truncated = true; return false; }
  return true;
}

function linkIndex(state, href) {
  const safe = safeHref(href, state.base);
  if (safe === null) return null;
  const known = state.links.indexOf(safe);
  if (known >= 0) return known;
  if (state.links.length >= MAX_LINKS) return null;
  state.links.push(safe);
  return state.links.length - 1;
}

const isBlank = (line) => line.trim() === '';
const indentOf = (line) => line.length - line.trimStart().length;

// A line that starts another block, so it ends a paragraph.
function startsBlock(line) {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || BULLET.test(line) || /^ {0,3}1[.)][ \t]+/.test(line);
}

function parseBlocks(lines, state, depth) {
  const blocks = [];
  if (depth > MAX_DEPTH) { state.truncated = true; return blocks; }
  let i = 0;
  while (i < lines.length) {
    if (!count(state)) break;
    const line = lines[i];
    if (isBlank(line)) { i += 1; continue; }
    let match;
    if ((match = FENCE.exec(line))) {
      const fence = match[2];
      const body = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`).test(lines[i])) {
        body.push(lines[i].slice(Math.min(match[1].length, indentOf(lines[i]))));
        i += 1;
      }
      i += 1;
      blocks.push({ t: 'code', lang: match[3].slice(0, 30), text: body.join('\n') });
      continue;
    }
    if (indentOf(line) >= 4) {
      const body = [];
      while (i < lines.length && (indentOf(lines[i]) >= 4 || isBlank(lines[i]))) { body.push(lines[i].slice(4)); i += 1; }
      while (body.length && isBlank(body[body.length - 1])) body.pop();
      blocks.push({ t: 'code', lang: '', text: body.join('\n') });
      continue;
    }
    if ((match = HEADING.exec(line))) {
      blocks.push({ t: 'heading', level: match[1].length, inline: parseInline(match[2] ?? '', state, depth) });
      i += 1;
      continue;
    }
    if (RULE.test(line)) { blocks.push({ t: 'rule' }); i += 1; continue; }
    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && !isBlank(lines[i]) && (match = QUOTE.exec(lines[i]) ?? (body.length && !startsBlock(lines[i]) ? [null, lines[i]] : null))) { body.push(match[1]); i += 1; }
      blocks.push({ t: 'quote', blocks: parseBlocks(body, state, depth + 1) });
      continue;
    }
    if (BULLET.test(line) || ORDERED.test(line)) {
      const list = parseList(lines, i, state, depth);
      blocks.push(list.block);
      i = list.next;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && DELIMITER_ROW.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const header = cells(line);
      const align = cells(lines[i + 1]).map((cell) => (/^:-+:$/.test(cell) ? 'center' : /-:$/.test(cell) ? 'right' : /^:-/.test(cell) ? 'left' : null));
      if (align.length === header.length) {
        i += 2;
        const rows = [];
        while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|') && rows.length < 500) {
          const row = cells(lines[i]).slice(0, header.length);
          while (row.length < header.length) row.push('');
          rows.push(row.map((cell) => parseInline(cell, state, depth)));
          i += 1;
        }
        blocks.push({ t: 'table', align, head: header.map((cell) => parseInline(cell, state, depth)), rows });
        continue;
      }
    }
    // A paragraph: up to a blank line or another block; a line of = or - under it makes it a heading.
    const body = [line.trim()];
    i += 1;
    let level = 0;
    while (i < lines.length && !isBlank(lines[i])) {
      const setext = SETEXT.exec(lines[i]);
      if (setext) { level = setext[1][0] === '=' ? 1 : 2; i += 1; break; }
      if (startsBlock(lines[i])) break;
      body.push(lines[i].replace(/^ {0,3}/, ''));
      i += 1;
    }
    const inline = parseInline(body.join('\n'), state, depth);
    blocks.push(level ? { t: 'heading', level, inline } : { t: 'paragraph', inline });
  }
  return blocks;
}

function cells(line) {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const out = [];
  let current = '';
  for (let k = 0; k < text.length; k += 1) {
    if (text[k] === '\\' && text[k + 1] === '|') { current += '|'; k += 1; continue; }
    if (text[k] === '|') { out.push(current.trim()); current = ''; continue; }
    current += text[k];
  }
  out.push(current.trim());
  return out.slice(0, 50);
}

function parseList(lines, start, state, depth) {
  const first = BULLET.exec(lines[start]) ?? ORDERED.exec(lines[start]);
  const ordered = !BULLET.test(lines[start]);
  const marker = ordered ? first[3] : first[2];
  const items = [];
  let i = start;
  while (i < lines.length) {
    const match = ordered ? ORDERED.exec(lines[i]) : BULLET.exec(lines[i]);
    if (!match || (ordered ? match[3] : match[2]) !== marker) break;
    const contentIndent = ordered ? match[1].length + match[2].length + 1 + match[4].length : match[1].length + 1 + match[3].length;
    const body = [ordered ? match[5] : match[4]];
    i += 1;
    while (i < lines.length) {
      const next = lines[i];
      if (isBlank(next)) {
        // A blank line keeps the item open only when what follows is indented under it.
        let k = i;
        while (k < lines.length && isBlank(lines[k])) k += 1;
        if (k < lines.length && indentOf(lines[k]) >= contentIndent) { for (; i < k; i += 1) body.push(''); continue; }
        break;
      }
      if (indentOf(next) >= contentIndent) { body.push(next.slice(contentIndent)); i += 1; continue; }
      if (BULLET.test(next) || ORDERED.test(next) || startsBlock(next)) break;
      body.push(next.trim());
      i += 1;
    }
    let checked = null;
    const task = TASK.exec(body[0]);
    if (task) { checked = task[1] !== ' '; body[0] = body[0].slice(task[0].length); }
    items.push({ checked, blocks: parseBlocks(body, state, depth + 1) });
    // A blank line between items: the next item must follow straight after the blanks.
    let k = i;
    while (k < lines.length && isBlank(lines[k])) k += 1;
    if (k > i && k < lines.length && (ordered ? ORDERED : BULLET).test(lines[k])) i = k;
  }
  const startNumber = ordered ? Math.min(Number(first[2]), 1e9) : null;
  return { block: { t: 'list', ordered, start: startNumber, items }, next: i };
}

/** Inline Markdown into text, code, strong, em, del, link, image and break nodes. */
function parseInline(text, state, depth) {
  const out = [];
  if (depth > MAX_DEPTH) { state.truncated = true; out.push({ t: 'text', v: text }); return out; }
  let buffer = '';
  const flush = () => { if (buffer) { out.push({ t: 'text', v: buffer }); buffer = ''; } };
  // Where each [ closes and where each delimiter can close, worked out once for this text, so a hostile run of [ or * costs a
  // lookup per character instead of a search to the end each time.
  const index = { brackets: null, closers: new Map() };
  let i = 0;
  while (i < text.length) {
    if (!count(state)) { buffer += text.slice(i); break; }
    const char = text[i];
    const rest = text.slice(i);
    if (char === '\\' && i + 1 < text.length && PUNCTUATION.test(text[i + 1])) { buffer += text[i + 1]; i += 2; continue; }
    if (char === '\\' && text[i + 1] === '\n') { flush(); out.push({ t: 'break' }); i += 2; continue; }
    if (char === '\n') {
      if (/ {2,}$/.test(buffer)) { buffer = buffer.replace(/ +$/, ''); flush(); out.push({ t: 'break' }); } else buffer += ' ';
      i += 1;
      continue;
    }
    if (char === '`') {
      const run = /^`+/.exec(rest)[0];
      const close = text.indexOf(run, i + run.length);
      // The closing run must be exactly as long.
      let end = close;
      while (end >= 0 && text[end + run.length] === '`') end = text.indexOf(run, end + run.length + 1);
      if (end >= 0) {
        flush();
        const code = text.slice(i + run.length, end).replace(/\n/g, ' ');
        out.push({ t: 'code', v: code.length > 2 && code.startsWith(' ') && code.endsWith(' ') ? code.slice(1, -1) : code });
        i = end + run.length;
        continue;
      }
      buffer += run;
      i += run.length;
      continue;
    }
    if (char === '<') {
      const auto = /^<(https?:\/\/[^\s<>]{1,2000})>/.exec(rest);
      if (auto) {
        flush();
        const link = linkIndex(state, auto[1]);
        out.push(link === null ? { t: 'text', v: auto[1] } : { t: 'link', link, c: [{ t: 'text', v: auto[1] }] });
        i += auto[0].length;
        continue;
      }
    }
    if (char === '!' && text[i + 1] === '[') {
      const found = bracketLink(text, i + 1, index);
      if (found) {
        flush();
        out.push({ t: 'image', alt: plain(found.label).slice(0, 200), link: linkIndex(state, found.href) });
        i = found.end;
        continue;
      }
    }
    if (char === '[') {
      const found = bracketLink(text, i, index);
      if (found) {
        flush();
        const link = linkIndex(state, found.href);
        const inner = parseInline(found.label, state, depth + 1);
        out.push(link === null ? { t: 'span', c: inner } : { t: 'link', link, c: inner });
        i = found.end;
        continue;
      }
    }
    if (char === 'h' && /^https:\/\//.test(rest) && (i === 0 || /[\s(]/.test(text[i - 1]))) {
      const bare = /^https:\/\/[^\s<>]+/.exec(rest)[0].replace(/[.,:;!?)'"]+$/, '');
      flush();
      const link = linkIndex(state, bare);
      out.push(link === null ? { t: 'text', v: bare } : { t: 'link', link, c: [{ t: 'text', v: bare }] });
      i += bare.length;
      continue;
    }
    const emphasis = delimited(text, i, index);
    if (emphasis) {
      flush();
      out.push({ t: emphasis.type, c: parseInline(emphasis.inner, state, depth + 1) });
      i = emphasis.end;
      continue;
    }
    buffer += char;
    i += 1;
  }
  flush();
  return out;
}

// **strong**, __strong__, *em*, _em_, ~~del~~: the closing delimiter is the next one that is not preceded by a space; _ only at word
// edges, as GitHub does.
const MARKS = [['**', 'strong'], ['__', 'strong'], ['~~', 'del'], ['*', 'em'], ['_', 'em']];
const WORD = /[\p{L}\p{N}]/u;

// Every position in `text` where `mark` can close, in order (whether it does depends only on the characters around it).
function closersOf(text, mark, index) {
  if (index.closers.has(mark)) return index.closers.get(mark);
  const found = [];
  for (let close = text.indexOf(mark, 1); close >= 0; close = text.indexOf(mark, close + 1)) {
    const before = text[close - 1];
    const next = text[close + mark.length];
    if (/\s/.test(before)) continue;
    if (mark.length === 1 && (next === mark || before === mark)) continue;
    if (mark[0] === '_' && next !== undefined && WORD.test(next)) continue;
    found.push(close);
  }
  index.closers.set(mark, found);
  return found;
}

function delimited(text, i, index) {
  for (const [mark, type] of MARKS) {
    if (!text.startsWith(mark, i)) continue;
    const after = text[i + mark.length];
    if (after === undefined || /\s/.test(after)) return null;
    if (mark[0] === '_' && i > 0 && WORD.test(text[i - 1])) return null;
    // The first closer after the opener and at least one character of content.
    const closers = closersOf(text, mark, index);
    const from = i + mark.length + 1;
    let low = 0;
    let high = closers.length;
    while (low < high) { const mid = (low + high) >> 1; if (closers[mid] < from) low = mid + 1; else high = mid; }
    if (low === closers.length) return null;
    const close = closers[low];
    return { type, inner: text.slice(i + mark.length, close), end: close + mark.length };
  }
  return null;
}

// Where each [ closes (its matching ]), for the whole text in one pass; -1 when it does not close.
function bracketsOf(text, index) {
  if (index.brackets) return index.brackets;
  const match = new Int32Array(text.length).fill(-1);
  const open = [];
  for (let k = 0; k < text.length; k += 1) {
    if (text[k] === '\\') { k += 1; continue; }
    if (text[k] === '[') open.push(k);
    else if (text[k] === ']' && open.length) match[open.pop()] = k;
  }
  index.brackets = match;
  return match;
}

// [label](href "title") starting at the [ at `i`, with nested brackets in the label; null when it is not a link.
function bracketLink(text, i, index) {
  const k = bracketsOf(text, index)[i];
  if (k < 0 || text[k + 1] !== '(') return null;
  const target = /^\(\s*(<[^<>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+("[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/.exec(text.slice(k + 1, k + 2200));
  if (!target) return null;
  return { label: text.slice(i + 1, k), href: target[1], end: k + 1 + target[0].length };
}

const plain = (text) => text.replace(/[*_~`[\]\\]/g, '').trim();

/** The text of a tree, without any markup: what a screen reader or a search would use. */
function textOf(nodes) {
  if (!Array.isArray(nodes)) return '';
  return nodes.map((node) => {
    if (!node || typeof node !== 'object') return '';
    if (node.t === 'text' || node.t === 'code' && typeof node.v === 'string') return node.v;
    if (node.t === 'code') return node.text;
    if (node.t === 'break') return '\n';
    if (node.t === 'image') return node.alt;
    if (node.t === 'list') return node.items.map((item) => textOf(item.blocks)).join('\n');
    if (node.t === 'table') return [node.head, ...node.rows].map((row) => row.map(textOf).join(' | ')).join('\n');
    return textOf(node.c ?? node.inline ?? node.blocks);
  }).join(node0Separator(nodes));
}
const node0Separator = (nodes) => (nodes.some((node) => node && ['paragraph', 'heading', 'code', 'quote', 'list', 'table', 'rule'].includes(node.t)) ? '\n' : '');

module.exports = { parseMarkdown, safeHref, textOf, MAX_DEPTH, MAX_NODES, DEFAULT_MAX_CHARS };
