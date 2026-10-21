import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { runCustomStart, rememberKey, CustomStartUi, CustomStartState } from '../../src/providers/customStart';
import { setExtensionTestMode } from '../../src/shared/testMode';

const posix = process.platform !== 'win32';

function setup(t: { after(fn: () => void): void }) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mas-custom-start-')));
  t.after(() => { setExtensionTestMode(false); fs.rmSync(root, { recursive: true, force: true }); });
  const bin = path.join(root, 'bin');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(bin);
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(bin, 'synthetic-cli'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const seen = { picks: 0, confirms: 0, launches: [] as Array<{ label: string; shellPath: string; shellArgs: string[]; cwd: string }> };
  const remembered: string[] = [];
  const ui = (answers: { confirm?: boolean; pick?: string | undefined } = {}): CustomStartUi => ({
    pick: async (providers) => { seen.picks += 1; return 'pick' in answers ? answers.pick : providers[0].id; },
    confirm: async () => { seen.confirms += 1; return answers.confirm ?? true; },
    launch: (label, launch) => { seen.launches.push({ label, shellPath: launch.shellPath, shellArgs: launch.shellArgs, cwd: launch.cwd }); }
  });
  const state: CustomStartState = { confirmed: () => [...remembered], remember: (key) => { remembered.push(key); } };
  const base = { providers: [{ id: 'synthetic', label: 'Synthetic CLI', executable: 'synthetic-cli', args: ['--plain'] }], trusted: true, cwd: workspace, folders: [workspace], state, env: { PATH: bin } as NodeJS.ProcessEnv, platform: 'linux' };
  return { seen, remembered, ui, base, bin };
}

test('as an installed extension an argument cannot pick or confirm for the person; declining starts nothing', { skip: !posix }, async (t) => {
  const { seen, remembered, ui, base } = setup(t);
  setExtensionTestMode(false);
  const declined = await runCustomStart({ ...base, arg: { id: 'synthetic', interactive: false }, ui: ui({ confirm: false }) });
  assert.deepEqual(declined, { ok: false, code: 'cancelled' });
  assert.deepEqual([seen.picks, seen.confirms, seen.launches.length, remembered.length], [1, 1, 0, 0], 'the person picked and was asked; nothing started, nothing remembered');
  const agreed = await runCustomStart({ ...base, arg: { id: 'someone-elses', interactive: false }, ui: ui() });
  assert.equal(agreed.ok, true);
  assert.deepEqual(seen.launches.map((launch) => [launch.label, launch.shellArgs]), [['Synthetic CLI', ['--plain']]], 'what started is what the person picked, not what the argument named');
  assert.equal(remembered.length, 1, 'the confirmation is remembered');
});

test('the same confirmed program is not asked about again; a different path or different arguments are', { skip: !posix }, async (t) => {
  const { seen, ui, base, bin } = setup(t);
  setExtensionTestMode(false);
  await runCustomStart({ ...base, arg: undefined, ui: ui() });
  assert.equal(seen.confirms, 1);
  await runCustomStart({ ...base, arg: undefined, ui: ui() });
  assert.equal(seen.confirms, 1, 'confirmed once, not asked again');
  await runCustomStart({ ...base, providers: [{ ...base.providers[0], args: ['--different'] }], arg: undefined, ui: ui() });
  assert.equal(seen.confirms, 2, 'other arguments are asked about');
  const moved = path.join(path.dirname(bin), 'bin2');
  fs.mkdirSync(moved);
  fs.writeFileSync(path.join(moved, 'synthetic-cli'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await runCustomStart({ ...base, env: { PATH: moved }, arg: undefined, ui: ui() });
  assert.equal(seen.confirms, 3, 'another path is asked about');
  assert.equal(seen.launches.length, 4);
});

test('an untrusted workspace asks nothing and starts nothing; neither does a missing folder, a missing program or no providers', { skip: !posix }, async (t) => {
  const { seen, ui, base } = setup(t);
  setExtensionTestMode(false);
  assert.deepEqual(await runCustomStart({ ...base, trusted: false, arg: undefined, ui: ui() }), { ok: false, code: 'workspace-untrusted' });
  assert.equal(seen.picks, 0, 'nothing was asked');
  assert.deepEqual(await runCustomStart({ ...base, providers: [], arg: undefined, ui: ui() }), { ok: false, code: 'no-custom-providers' });
  assert.equal((await runCustomStart({ ...base, cwd: undefined, arg: undefined, ui: ui() })).code, 'folder-required');
  assert.equal((await runCustomStart({ ...base, env: { PATH: '/nonexistent-dir' }, arg: undefined, ui: ui() })).code, 'executable-not-found');
  assert.equal((await runCustomStart({ ...base, arg: undefined, ui: ui({ pick: undefined }) })).code, 'cancelled');
  assert.equal(seen.launches.length, 0);
});

test('in the extension\'s own tests the caller may answer, and only with interactive:false', { skip: !posix }, async (t) => {
  const { seen, remembered, ui, base } = setup(t);
  setExtensionTestMode(true);
  const given = await runCustomStart({ ...base, arg: { id: 'synthetic', interactive: false }, ui: ui() });
  assert.equal(given.ok, true);
  assert.deepEqual([seen.picks, seen.confirms, remembered.length], [0, 0, 0], 'no questions, nothing remembered');
  assert.equal((await runCustomStart({ ...base, arg: { id: 'synthetic', interactive: true }, ui: ui({ confirm: false }) })).code, 'cancelled', 'interactive:true still asks');
  assert.equal((await runCustomStart({ ...base, arg: { id: 'nope', interactive: false }, ui: ui() })).code, 'provider-not-found');
});

test('only the most recent confirmations are kept, without duplicates', () => {
  let list: string[] = [];
  for (let index = 0; index < 60; index += 1) list = rememberKey(list, `k${index}`);
  assert.equal(list.length, 50);
  assert.equal(list[0], 'k10');
  assert.deepEqual(rememberKey(['a', 'b'], 'a'), ['b', 'a']);
});
