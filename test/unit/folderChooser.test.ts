import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { chooseConfigFolder, ChooserUi } from '../../src/accounts/folderChooser';

// Real temporary folders and a scripted person: the chooser runs the real checks and the real
// folder creation, and only the three questions are answered by the test.
function world(t: { after(fn: () => void): void }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'multiagent-chooser-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homeDir = path.join(root, 'home');
  const repoRoot = path.join(homeDir, 'projects', 'app');
  fs.mkdirSync(repoRoot, { recursive: true });
  return { root, homeDir, repoRoot };
}

type Script = { actions?: Array<'create' | 'choose' | undefined>; folders?: Array<string | undefined>; answers?: Array<'recommended' | 'another' | undefined> };
function ui(script: Script) {
  const log = { openDefaults: [] as string[], problems: [] as Array<{ summary: string; detail: string; offer: boolean }>, suggestionNames: [] as string[] };
  const actions = [...(script.actions ?? [])];
  const folders = [...(script.folders ?? [])];
  const answers = [...(script.answers ?? [])];
  const fake: ChooserUi = {
    async pickAction(name) { log.suggestionNames.push(name); return actions.length ? actions.shift() : undefined; },
    async openFolder(defaultPath) { log.openDefaults.push(defaultPath); return folders.length ? folders.shift() : undefined; },
    async showProblems(summary, detail, offer) { log.problems.push({ summary, detail, offer }); return answers.length ? answers.shift() : undefined; }
  };
  return { fake, log };
}
const base = (w: ReturnType<typeof world>, fake: ChooserUi, extra: Record<string, unknown> = {}) => ({ provider: 'claude', label: 'Work', profiles: [] as unknown[], repoRoot: w.repoRoot, homeDir: w.homeDir, ui: fake, ...extra });
const tree = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).sort() : []);

test('choosing the recommended folder creates it outside the project and returns it', async (t) => {
  const w = world(t);
  const { fake } = ui({ actions: ['create'] });
  const before = tree(w.repoRoot);
  const chosen = await chooseConfigFolder(base(w, fake));
  assert.deepEqual(chosen, { ok: true, dir: path.join(w.homeDir, 'multiagent-accounts', 'claude-work'), created: true });
  assert.ok(fs.statSync((chosen as { dir: string }).dir).isDirectory());
  assert.deepEqual(tree(w.repoRoot), before, 'nothing was made inside the project');
});

test('a folder inside the project is explained in plain words with no path, and the recommended folder can be used instead', async (t) => {
  const w = world(t);
  const inside = path.join(w.repoRoot, 'my-secret-folder');
  fs.mkdirSync(inside);
  const { fake, log } = ui({ actions: ['choose'], folders: [inside], answers: ['recommended'] });
  const chosen = await chooseConfigFolder(base(w, fake));
  assert.equal(chosen.ok, true);
  assert.equal((chosen as { created: boolean }).created, true);
  assert.equal(log.problems.length, 1);
  const [problem] = log.problems;
  assert.match(problem.detail, /inside your current project/);
  assert.match(problem.detail, /outside the project|recommended folder/);
  assert.equal(problem.offer, true);
  for (const text of [problem.summary, problem.detail]) {
    assert.equal(text.includes(w.repoRoot) || text.includes(w.homeDir) || text.includes('my-secret-folder'), false, 'no path in the message');
    assert.equal(/config-dir|inside-repo/.test(text), false, 'no code in the message');
  }
});

test('the dialog starts in the recommended parent once it exists, and in the home folder before', async (t) => {
  const w = world(t);
  const good = path.join(w.root, 'elsewhere', 'new-account');
  fs.mkdirSync(good, { recursive: true });
  const first = ui({ actions: ['choose'], folders: [good] });
  assert.equal((await chooseConfigFolder(base(w, first.fake))).ok, true);
  assert.deepEqual(first.log.openDefaults, [w.homeDir]);
  fs.mkdirSync(path.join(w.homeDir, 'multiagent-accounts'));
  const second = ui({ actions: ['choose'], folders: [good] });
  await chooseConfigFolder(base(w, second.fake));
  assert.deepEqual(second.log.openDefaults, [path.join(w.homeDir, 'multiagent-accounts')]);
});

test('the person is told at the moment of choosing: each refusal explains itself, then another folder can be tried', async (t) => {
  const w = world(t);
  const providerDefault = path.join(w.homeDir, '.claude');
  fs.mkdirSync(providerDefault);
  const file = path.join(w.homeDir, 'a-file');
  fs.writeFileSync(file, 'x');
  const good = path.join(w.root, 'good');
  fs.mkdirSync(good);
  const { fake, log } = ui({ actions: ['choose', 'choose', 'choose', 'choose'], folders: [w.repoRoot, providerDefault, file, good], answers: ['another', 'another', 'another'] });
  const chosen = await chooseConfigFolder(base(w, fake));
  assert.deepEqual(chosen, { ok: true, dir: good, created: false });
  assert.equal(log.problems.length, 3);
  assert.match(log.problems[0].detail, /contains your current project|inside your current project/);
  assert.match(log.problems[1].detail, /already uses for its own sign-in/);
  assert.match(log.problems[2].detail, /not a folder|is a file/);
});

test('an account folder that overlaps another account is explained', async (t) => {
  const w = world(t);
  const first = path.join(w.homeDir, 'multiagent-accounts', 'claude-work');
  fs.mkdirSync(first, { recursive: true });
  const profiles = [{ id: 'acct-1', provider: 'claude', label: 'Work', configDir: first }];
  const { fake, log } = ui({ actions: ['choose'], folders: [first], answers: [undefined] });
  const chosen = await chooseConfigFolder(base(w, fake, { profiles, label: 'Personal' }));
  assert.deepEqual(chosen, { ok: false });
  assert.match(log.problems[0].detail, /Another account already uses this folder/);
});

test('cancelling at any step ends without a folder and creates nothing', async (t) => {
  const w = world(t);
  const before = tree(w.homeDir);
  assert.deepEqual(await chooseConfigFolder(base(w, ui({ actions: [undefined] }).fake)), { ok: false });
  const closed = ui({ actions: ['choose', undefined], folders: [undefined] });
  assert.deepEqual(await chooseConfigFolder(base(w, closed.fake)), { ok: false }, 'closing the dialog goes back to the question');
  assert.deepEqual(closed.log.openDefaults.length, 1);
  assert.deepEqual(tree(w.homeDir), before);
});

test('a recommended folder that cannot be made says why and offers to try again, never silently', async (t) => {
  const w = world(t);
  const parent = path.join(w.homeDir, 'multiagent-accounts');
  fs.mkdirSync(parent);
  const profiles = [{ id: 'acct-1', provider: 'claude', label: 'Existing', configDir: parent }];
  const { fake, log } = ui({ actions: ['create'], answers: [undefined] });
  const chosen = await chooseConfigFolder(base(w, fake, { profiles }));
  assert.deepEqual(chosen, { ok: false });
  assert.equal(log.problems.length, 1);
  assert.equal(log.problems[0].offer, false);
  assert.match(log.problems[0].detail, /inside, or around, the folder of another account/);
  assert.deepEqual(fs.readdirSync(parent), []);
});

test('a person who keeps choosing bad folders cannot loop forever', async (t) => {
  const w = world(t);
  const { fake, log } = ui({ actions: Array(100).fill('choose'), folders: Array(100).fill(w.repoRoot), answers: Array(100).fill('another') });
  assert.deepEqual(await chooseConfigFolder(base(w, fake)), { ok: false });
  assert.equal(log.problems.length, 20);
});

test('a second account is suggested next to the first, not on top of it', async (t) => {
  const w = world(t);
  const first = await chooseConfigFolder(base(w, ui({ actions: ['create'] }).fake));
  const second = ui({ actions: ['create'] });
  const chosen = await chooseConfigFolder(base(w, second.fake, { label: 'Work', profiles: [{ id: 'acct-1', provider: 'codex', label: 'Work', configDir: (first as { dir: string }).dir }] }));
  assert.equal(second.log.suggestionNames[0], 'claude-work-2');
  assert.equal((chosen as { dir: string }).dir, path.join(w.homeDir, 'multiagent-accounts', 'claude-work-2'));
});

test('closing the folder dialog returns to the question, and dismissing the problem notice ends the choice', async (t) => {
  const w = world(t);
  const good = path.join(w.root, 'good');
  fs.mkdirSync(good);
  const closed = ui({ actions: ['choose', 'choose'], folders: [undefined, good] });
  assert.deepEqual(await chooseConfigFolder(base(w, closed.fake)), { ok: true, dir: good, created: false }, 'closing the dialog asks again');
  assert.equal(closed.log.openDefaults.length, 2);

  const dismissed = ui({ actions: ['choose', 'choose'], folders: [w.repoRoot, good], answers: [undefined] });
  assert.deepEqual(await chooseConfigFolder(base(w, dismissed.fake)), { ok: false }, 'dismissing the notice cancels');
  assert.equal(dismissed.log.openDefaults.length, 1);

  const parent = path.join(w.homeDir, 'multiagent-accounts');
  fs.mkdirSync(parent);
  const nested = [{ id: 'acct-1', provider: 'claude', label: 'Existing', configDir: parent }];
  const failedCreate = ui({ actions: ['create', 'choose'], folders: [good], answers: [undefined] });
  assert.deepEqual(await chooseConfigFolder(base(w, failedCreate.fake, { profiles: nested })), { ok: false }, 'dismissing the create failure cancels');
  assert.equal(failedCreate.log.openDefaults.length, 0);
  const retry = ui({ actions: ['create', 'choose'], folders: [good], answers: ['another'] });
  assert.equal((await chooseConfigFolder(base(w, retry.fake, { profiles: nested }))).ok, true, 'Try again returns to the question');
});
