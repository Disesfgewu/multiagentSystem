'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { worktreeInProject } = require('../../src/sessions/reopenScope');

function world(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reopen-scope-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const folder = path.join(base, 'project');
  const sibling = path.join(base, 'other');
  const outside = path.join(base, 'outside');
  for (const dir of [path.join(folder, 'sub'), sibling, outside]) fs.mkdirSync(dir, { recursive: true });
  return { base, folder, sibling, outside };
}

test('the project folder, or a folder inside it, is in the project', async (t) => {
  const { folder } = world(t);
  assert.equal(await worktreeInProject(folder, [folder]), true);
  assert.equal(await worktreeInProject(path.join(folder, 'sub'), [folder]), true);
});

test('an unrelated folder, a sibling with the same prefix, a relative path or a missing folder is refused', async (t) => {
  const { base, folder, sibling } = world(t);
  const lookalike = `${folder}-copy`;
  fs.mkdirSync(lookalike);
  assert.equal(await worktreeInProject(sibling, [folder]), false);
  assert.equal(await worktreeInProject(lookalike, [folder]), false, 'a name that merely starts the same is not inside');
  assert.equal(await worktreeInProject('project/sub', [folder]), false, 'relative paths are never accepted');
  assert.equal(await worktreeInProject(path.join(base, 'missing'), [folder]), false);
  assert.equal(await worktreeInProject(folder, []), false, 'no workspace folder, no project');
  assert.equal(await worktreeInProject(undefined, [folder]), false);
});

test('a link inside the project that points elsewhere is judged by where it really leads', { skip: process.platform === 'win32' }, async (t) => {
  const { folder, outside } = world(t);
  const link = path.join(folder, 'escape');
  fs.symlinkSync(outside, link);
  assert.equal(await worktreeInProject(link, [folder]), false);
  assert.equal(await worktreeInProject(path.join(folder, 'sub'), [folder]), true);
});

test('a worktree of the same git repository outside the folder is accepted; one of another repository is not', async (t) => {
  const { folder, sibling, outside } = world(t);
  const commonDir = async (dir) => (dir === folder || dir === sibling ? '/synthetic/repo-a/.git' : dir === outside ? '/synthetic/repo-b/.git' : null);
  assert.equal(await worktreeInProject(sibling, [folder], { commonDir }), true);
  assert.equal(await worktreeInProject(outside, [folder], { commonDir }), false);
  assert.equal(await worktreeInProject(sibling, [folder], { commonDir: async () => { throw new Error('git unavailable'); } }), false, 'a failed lookup fails closed');
  assert.equal(await worktreeInProject(sibling, [folder]), false, 'without a lookup only containment counts');
});
