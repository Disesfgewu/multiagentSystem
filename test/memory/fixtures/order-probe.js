'use strict';

// Run in a child process under different LC_ALL/LANG values. Prints the orders produced by the
// memory code for ids chosen so that locale-aware and code-unit ordering differ.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderContext } = require('../../../src/memory/injection');
const { MemoryStore } = require('../../../src/memory/store');

const IDS = ['B', 'a', 'a-1', 'a_1', 'A', 'a.1'];

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multiagent-order-'));
try {
  // 1. Injected text: rules in one layer and memories, all given in a scrambled order.
  const text = renderContext({
    roleGroup: { id: 'impl', name: 'Implementation' },
    rules: {
      forbids: [],
      requires: [],
      instructions: [
        ...IDS.map((id) => ({ id, layer: 'project', text: `rule-${id}` })),
        { id: 'zz', layer: 'platform', text: 'platform-first' }
      ],
      conflicts: [],
      sources: []
    },
    memories: IDS.map((id) => ({ id, content: `note-${id}`, source: { ref: 'docs/X.md' }, verifiedAt: '2026-01-02T00:00:00.000Z' }))
  });
  const injected = text.split('\n').filter((line) => line.startsWith('- ')).map((line) => line.slice(2).split(' ')[0]);

  // 2. Retrieval: equally scored memories are ordered by id.
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(repoRoot);
  const dir = path.join(root, 'private');
  const store = new MemoryStore({ dir, repoRoot, now: () => Date.parse('2026-01-03T00:00:00Z') });
  const scope = { repoId: 'repo-1', roleGroupId: 'impl', privacyDomain: 'domain-1' };
  const ids = [];
  // Distinct words: duplicates are detected after punctuation is ignored.
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
  for (const word of WORDS) {
    const proposed = store.propose({
      ...scope,
      content: `Release packaging script notes about ${word} entry.`,
      source: { kind: 'file', ref: 'docs/RELEASE.md', digest: 'd1' }
    });
    if (!proposed.ok) throw new Error(`propose failed: ${proposed.reason}`);
    store.adopt(proposed.id, { kind: 'human', id: 'reviewer' });
    ids.push(proposed.id);
  }
  const file = path.join(dir, 'memory.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.items.forEach((item, index) => { item.id = IDS[index]; item.verifiedAt = '2026-01-02T00:00:00.000Z'; });
  fs.writeFileSync(file, JSON.stringify(data));
  const selected = store.select({ ...scope, task: 'release packaging script' }).items.map((item) => item.id);

  process.stdout.write(JSON.stringify({
    injected,
    selected,
    // Evidence that the locale in this process is really different (informational only).
    localeSort: [...IDS].sort((x, y) => x.localeCompare(y)),
    collatorLocale: new Intl.Collator().resolvedOptions().locale
  }));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
