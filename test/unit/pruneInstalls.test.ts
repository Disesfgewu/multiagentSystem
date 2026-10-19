import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { pruneInstalls } from '../../src/setup/pruneInstalls';

const OLD = Date.now() - 24 * 60 * 60_000;
const sandbox = (t: { after(fn: () => void): void }): { root: string; installs: string; pointer: string } => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-installs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'installs'));
  return { root, installs: path.join(root, 'installs'), pointer: path.join(root, 'current.json') };
};
const age = (dir: string, when = OLD): void => { fs.utimesSync(dir, new Date(when), new Date(when)); };

// A complete install: its own pointer, a retained archive that hashes to what the pointer says, and the executable.
function writeInstall(installs: string, id: string, { archive = 'archive bytes', corruptArchive = false, executable = 'tool', noExecutable = false, noPointer = false }: { archive?: string; corruptArchive?: boolean; executable?: string; noExecutable?: boolean; noPointer?: boolean } = {}): string {
  const dir = path.join(installs, id);
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  if (!noPointer) fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ installId: id, archiveSha256: createHash('sha256').update(archive).digest('hex'), executable }));
  fs.writeFileSync(path.join(dir, 'asset.bin'), corruptArchive ? `${archive} tampered` : archive);
  if (!noExecutable) fs.writeFileSync(path.join(dir, 'bin', executable), 'binary');
  age(dir);
  return dir;
}

test('only provably useless installs are removed: broken, incomplete or altered ones that are old enough', async (t) => {
  const { installs, pointer } = sandbox(t);
  writeInstall(installs, 'keep');
  writeInstall(installs, 'bad-archive', { corruptArchive: true });
  writeInstall(installs, 'no-exe', { noExecutable: true });
  writeInstall(installs, 'no-pointer', { noPointer: true });
  fs.mkdirSync(path.join(installs, 'empty-leftover'));
  age(path.join(installs, 'empty-leftover'));
  fs.writeFileSync(path.join(installs, 'stray.txt'), 'x');
  assert.equal(await pruneInstalls(installs, 'keep', { pointerFile: pointer }), 5);
  assert.deepEqual(fs.readdirSync(installs), ['keep']);
});

test('a valid install is never removed, even an older one that is neither new nor current: a running terminal may still use it', async (t) => {
  const { installs, pointer } = sandbox(t);
  writeInstall(installs, 'keep');
  writeInstall(installs, 'older-but-working', { archive: 'an older release' });
  assert.equal(await pruneInstalls(installs, 'keep', { pointerFile: pointer }), 0);
  assert.deepEqual(fs.readdirSync(installs).sort(), ['keep', 'older-but-working']);
});

test('the install the pointer names right now is kept even when it looks broken, and a young folder is never touched (it may be another window mid-install)', async (t) => {
  const { installs, pointer } = sandbox(t);
  writeInstall(installs, 'mine');
  writeInstall(installs, 'someone-elses-current', { corruptArchive: true });
  fs.writeFileSync(pointer, JSON.stringify({ installId: 'someone-elses-current' }));
  const young = writeInstall(installs, 'in-progress', { noPointer: true });
  age(young, Date.now() - 60_000);
  assert.equal(await pruneInstalls(installs, 'mine', { pointerFile: pointer }), 0);
  assert.deepEqual(fs.readdirSync(installs).sort(), ['in-progress', 'mine', 'someone-elses-current']);
  assert.equal(await pruneInstalls(installs, 'mine', { pointerFile: pointer, graceMs: 30_000 }), 1, 'once it is older than the grace period and still unusable it goes');
});

test('nothing is followed: a link is removed as a link and its target survives; a linked installs folder is left alone', { skip: process.platform === 'win32' }, async (t) => {
  const { root, installs, pointer } = sandbox(t);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'precious'), 'must survive');
  fs.symlinkSync(outside, path.join(installs, 'link-to-outside'));
  writeInstall(installs, 'keep');
  assert.equal(await pruneInstalls(installs, 'keep', { pointerFile: pointer }), 1);
  assert.equal(fs.readFileSync(path.join(outside, 'precious'), 'utf8'), 'must survive');

  const elsewhere = path.join(root, 'elsewhere');
  fs.mkdirSync(path.join(elsewhere, 'victim'), { recursive: true });
  const linked = path.join(root, 'linked-installs');
  fs.symlinkSync(elsewhere, linked);
  assert.equal(await pruneInstalls(linked, 'keep', { pointerFile: pointer }), 0);
  assert.equal(fs.existsSync(path.join(elsewhere, 'victim')), true);
  assert.equal(await pruneInstalls(path.join(root, 'missing'), 'keep', { pointerFile: pointer }), 0);
});

test('a missing, linked or oversized root pointer protects nothing extra and breaks nothing', async (t) => {
  const { installs, pointer } = sandbox(t);
  writeInstall(installs, 'keep');
  writeInstall(installs, 'bad', { corruptArchive: true });
  fs.writeFileSync(pointer, 'x'.repeat(5000));
  assert.equal(await pruneInstalls(installs, 'keep', { pointerFile: pointer }), 1);
});
