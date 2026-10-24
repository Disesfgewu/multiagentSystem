'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMarkdown, safeHref, MAX_NODES, MAX_DEPTH } = require('../../src/reports/markdown');

const BASE = 'https://github.com/owner/repo/issues/5';
const parse = (text) => parseMarkdown(text, { base: BASE, links: [] });
// Every node type and key the page draws from; anything else would be a way for content to reach the page unchecked.
const BLOCKS = new Set(['heading', 'paragraph', 'code', 'quote', 'list', 'table', 'rule']);
const INLINE = new Set(['text', 'code', 'strong', 'em', 'del', 'link', 'image', 'break', 'span']);

function walk(nodes, visit) {
  for (const node of nodes) {
    visit(node);
    for (const key of ['inline', 'c', 'blocks']) if (Array.isArray(node[key])) walk(node[key], visit);
    if (node.t === 'list') for (const item of node.items) walk(item.blocks, visit);
    if (node.t === 'table') for (const row of [node.head, ...node.rows]) for (const cell of row) walk(cell, visit);
  }
}

test('GitHub Markdown becomes a tree: headings, lists, task lists, code, tables, quotes, emphasis and links (#353)', () => {
  const { blocks, links } = parse('# Title\n\nSome **bold**, _em_, ~~gone~~ and `code`.\n\n- one\n- [x] done\n  - nested\n\n3. three\n4. four\n\n| a | b |\n|:--|--:|\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\n\n> quoted\n\n---\n\nSee [docs](https://example.test/docs).');
  assert.deepEqual(blocks.map((block) => block.t), ['heading', 'paragraph', 'list', 'list', 'table', 'code', 'quote', 'rule', 'paragraph']);
  assert.deepEqual(blocks[1].inline.map((node) => node.t), ['text', 'strong', 'text', 'em', 'text', 'del', 'text', 'code', 'text']);
  assert.equal(blocks[2].items[1].checked, true);
  assert.equal(blocks[2].items[1].blocks[1].t, 'list', 'a nested list stays inside its item');
  assert.deepEqual([blocks[3].ordered, blocks[3].start], [true, 3]);
  assert.deepEqual(blocks[4].align, ['left', 'right']);
  assert.deepEqual([blocks[5].lang, blocks[5].text], ['js', 'const x = 1;']);
  assert.deepEqual(links, ['https://example.test/docs']);
  for (const block of blocks) assert.ok(BLOCKS.has(block.t));
  walk(blocks, (node) => assert.ok(BLOCKS.has(node.t) || INLINE.has(node.t), node.t));
});

test('raw HTML, script and fake controls stay text: nothing in the tree is markup (#353)', () => {
  const hostile = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<span class="author author-owner">管理者</span>',
    '<button>Approve</button> <b>Pass</b>',
    '<a href="javascript:alert(1)">click</a>',
    '<details><summary>x</summary>y</details>'
  ].join('\n\n');
  const { blocks } = parse(hostile);
  const texts = [];
  walk(blocks, (node) => {
    assert.ok(INLINE.has(node.t) || BLOCKS.has(node.t), node.t);
    assert.notEqual(node.t, 'link', 'no link was made from HTML');
    if (node.t === 'text') texts.push(node.v);
  });
  for (const part of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<span class="author author-owner">管理者</span>', '<button>Approve</button>']) assert.ok(texts.join('\n').includes(part), `shown as text: ${part}`);
});

test('only https addresses and this repository are links; anything else is its text only (#353)', () => {
  assert.equal(safeHref('https://example.test/a?b=1#c', BASE), 'https://example.test/a?b=1#c');
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>', 'http://example.test', 'file:///etc/passwd', 'vscode://command/x', 'command:workbench.action.terminal.sendSequence', '//evil.test/x', 'https://user:pass@example.test', '#anchor', '', 'https://exa mple.test']) {
    assert.equal(safeHref(bad, BASE), null, bad);
  }
  assert.equal(safeHref('../pull/3', BASE), 'https://github.com/owner/repo/pull/3', 'a relative link stays in this repository');
  assert.equal(safeHref('/owner/repo/blob/main/README.md', BASE), 'https://github.com/owner/repo/blob/main/README.md');
  assert.equal(safeHref('/other/repo/issues/1', BASE), null, 'another repository by a relative path is not followed');
  assert.equal(safeHref('../../../../evil', BASE), null);
  const { blocks, links } = parse('[a](javascript:alert(1)) [b](https://ok.test) <https://auto.test> https://bare.test/x. ![pic](https://tracker.test/p.png)');
  const kinds = blocks[0].inline.filter((node) => node.t !== 'text').map((node) => node.t);
  assert.deepEqual(kinds, ['span', 'link', 'link', 'link', 'image']);
  assert.deepEqual(links, ['https://ok.test/', 'https://auto.test/', 'https://bare.test/x', 'https://tracker.test/p.png'], 'the image is a link to open, never a source to load');
  assert.equal(blocks[0].inline.at(-1).alt, 'pic');
});

test('invisible and bidirectional characters are removed, and the same address is one link (#353)', () => {
  const rlo = String.fromCodePoint(0x202e);
  const zwsp = String.fromCodePoint(0x200b);
  const zwj = String.fromCodePoint(0x200d);
  const { blocks } = parse(`Pa${zwsp}ss ${rlo}evil${String.fromCodePoint(0x7)} 👩${zwj}💻`);
  const text = blocks[0].inline.map((node) => node.v).join('');
  assert.equal(text, `Pass evil 👩${zwj}💻`);
  const shared = [];
  parseMarkdown('[a](https://x.test) [b](https://x.test)', { base: BASE, links: shared });
  parseMarkdown('[c](https://x.test)', { base: BASE, links: shared });
  assert.deepEqual(shared, ['https://x.test/']);
});

test('a huge or deeply nested comment is cut and says so, without taking long (#353)', () => {
  const started = Date.now();
  const long = parseMarkdown('word '.repeat(50000), { maxChars: 1000 });
  assert.equal(long.truncated, true);
  assert.ok(long.blocks[0].inline[0].v.length <= 1000);
  const deep = parse(`${'> '.repeat(40)}deep`);
  assert.equal(deep.truncated, true, 'nesting beyond the limit is cut');
  let levels = 0;
  for (let node = deep.blocks[0]; node && node.t === 'quote'; node = node.blocks[0]) levels += 1;
  assert.ok(levels <= MAX_DEPTH + 1, `quotes are nested at most ${MAX_DEPTH + 1} deep (saw ${levels})`);
  const lists = parse(`${Array.from({ length: 40 }, (_, depth) => `${'  '.repeat(depth)}- level`).join('\n')}`);
  let listLevels = 0;
  for (let node = lists.blocks[0]; node && node.t === 'list'; node = node.items[0].blocks.find((block) => block.t === 'list')) listLevels += 1;
  assert.ok(listLevels <= MAX_DEPTH + 1, `lists are nested at most ${MAX_DEPTH + 1} deep (saw ${listLevels})`);
  const many = parse('*a* '.repeat(MAX_NODES + 100));
  assert.equal(many.truncated, true, 'more nodes than the limit are cut');
  const stars = parse(`${'*'.repeat(20000)}x`);
  assert.ok(stars.blocks.length > 0);
  assert.ok(Date.now() - started < 5000, `parsing hostile input took ${Date.now() - started} ms`);
  // Runs that would make a search to the end at every character: each must stay far below a quadratic cost.
  for (const [name, text] of [['[', '['.repeat(60000)], ['[]', `${'['.repeat(30000)}${']'.repeat(30000)}`], ['_a', '_a '.repeat(20000)], ['**a', '**a '.repeat(15000)], ['~~a', '~~a '.repeat(15000)], ['`a', '`a '.repeat(20000)]]) {
    const at = Date.now();
    assert.ok(parseMarkdown(text).blocks.length > 0);
    assert.ok(Date.now() - at < 200, `${name} × many took ${Date.now() - at} ms`);
  }
});
