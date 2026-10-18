import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { pruneInstalls } from '../../src/setup/pruneInstalls';

const sandbox = (t: { after(fn: () => void): void }): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-installs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};

test('keeps the named install and removes older folders, stray files and links without following them', { skip: process.platform === 'win32' }, async (t) => {
  const root = sandbox(t);
  const installs = path.join(root, 'installs');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(installs, 'keep', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(installs, 'old-1', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(installs, 'old-1', 'bin', 'tool'), 'old');
  fs.writeFileSync(path.join(installs, 'stray.txt'), 'x');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'precious'), 'must survive');
  fs.symlinkSync(outside, path.join(installs, 'link-to-outside'));
  assert.equal(await pruneInstalls(installs, 'keep'), 3);
  assert.deepEqual(fs.readdirSync(installs), ['keep']);
  assert.equal(fs.readFileSync(path.join(outside, 'precious'), 'utf8'), 'must survive', 'a link is removed as a link, its target is never entered');
});

test('does nothing when installs is a symlink or missing', { skip: process.platform === 'win32' }, async (t) => {
  const root = sandbox(t);
  const elsewhere = path.join(root, 'elsewhere');
  fs.mkdirSync(path.join(elsewhere, 'victim'), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(root, 'installs'));
  assert.equal(await pruneInstalls(path.join(root, 'installs'), 'keep'), 0);
  assert.equal(fs.existsSync(path.join(elsewhere, 'victim')), true);
  assert.equal(await pruneInstalls(path.join(root, 'missing'), 'keep'), 0);
});
