'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { explainProblem, explainFailure, suggestFolder, checkFolder, createRecommendedFolder, discardCreated, EXPLANATIONS, PARENT_NAME } = require('../../src/accounts/folder-guidance');
const { PROVIDERS } = require('../../src/accounts/profile');

// Real temporary folders: a fake home with a project inside it, as on a real machine.
function world(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'multiagent-folder-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homeDir = path.join(root, 'home');
  const repoRoot = path.join(homeDir, 'projects', 'app');
  fs.mkdirSync(repoRoot, { recursive: true });
  const context = { repoRoot, homeDir };
  const check = (configDir, extra = {}) => checkFolder({ provider: 'claude', label: 'Work', configDir, context, ...extra });
  return { root, homeDir, repoRoot, context, check };
}
const snapshot = (dir) => {
  const out = [];
  const walk = (current) => { for (const entry of fs.readdirSync(current, { withFileTypes: true })) { const full = path.join(current, entry.name); out.push(path.relative(dir, full)); if (entry.isDirectory()) walk(full); } };
  walk(dir);
  return out.sort();
};

test('every reason a folder can be refused has a plain-language message and a fix, and none shows a code to the person', () => {
  // the codes come from the source of the checks themselves, so a new code without a message fails here
  const sources = ['../../src/accounts/profile.js', '../../src/accounts/profile-service.js'].map((file) => fs.readFileSync(path.join(__dirname, file), 'utf8')).join('\n');
  const codes = new Set();
  for (const match of sources.matchAll(/'((?:config-dir|repo-root|provider-default|label|profile-id|provider|duplicate|too-many)[a-z-]*(?::[a-z]+)?)'/g)) if (match[1].includes('-')) codes.add(match[1]);
  for (const kind of ['same', 'nested', 'unresolvable']) codes.add(`config-dir-conflict:${kind}`);
  // codes that name a different kind of failure (not about the folder or label) are not the subject here
  for (const code of ['config-dir-rejected', 'config-dir-conflict', 'invalid-config-dir', 'provider-unsupported-x', 'provider-immutable', 'provider-mismatch', 'default-profile-missing']) codes.delete(code);
  assert.ok(codes.size >= 12, `found ${codes.size} codes`);
  for (const code of codes) {
    const explained = explainProblem(code);
    assert.equal(explained.known, true, `${code} has no message`);
    assert.ok(explained.message.length > 20 && explained.fix.length > 10, code);
    assert.equal(explained.message.includes(code) || explained.fix.includes(code), false, `${code} is shown as a code`);
    assert.equal(/[\\/]/.test(explained.message + explained.fix), false, `${code} message holds a path`);
    assert.equal(/\b[a-z]+-[a-z]+-[a-z-]+\b/.test(explained.message + explained.fix), false, `${code} message holds a code-like word`);
  }
});

test('an unknown code still gets an honest, usable message and is marked unknown', () => {
  for (const code of ['something-new', '', undefined, null, 7, '__proto__']) {
    const explained = explainProblem(code);
    assert.equal(explained.known, false);
    assert.match(explained.message, /cannot be used/);
    assert.ok(explained.fix.length > 10);
  }
  assert.equal(explainProblem('constructor').known, false);
});

test('explainFailure turns a service result into explanations, once each', () => {
  assert.deepEqual(explainFailure({ code: 'invalid-config-dir', problems: ['config-dir-inside-repo', 'config-dir-inside-repo', 'config-dir-owner-mismatch'] }).map((item) => item.code), ['config-dir-inside-repo', 'config-dir-owner-mismatch']);
  assert.deepEqual(explainFailure({ code: 'config-dir-conflict', kind: 'nested' }).map((item) => item.code), ['config-dir-conflict:nested']);
  assert.deepEqual(explainFailure({ code: 'config-dir-conflict' }).map((item) => item.code), ['config-dir-conflict:same']);
  assert.deepEqual(explainFailure({ code: 'duplicate-label' }).map((item) => item.code), ['duplicate-label']);
  assert.deepEqual(explainFailure({ code: 'too-many-profiles' }).map((item) => item.code), ['too-many-profiles']);
  assert.deepEqual(explainFailure({ code: 'store-locked' }), []);
  assert.deepEqual(explainFailure(null), []);
});

test('real checks: inside the project, around the project, the tool\'s own folder, a file, and a good folder', (t) => {
  const w = world(t);
  const outside = path.join(w.homeDir, 'multiagent-accounts', 'claude-work');
  assert.deepEqual(w.check(outside).problems, []);
  assert.deepEqual(w.check(path.join(w.repoRoot, 'sub')).problems, ['config-dir-inside-repo']);
  assert.deepEqual(w.check(w.repoRoot).problems, ['config-dir-inside-repo', 'config-dir-contains-repo']);
  assert.deepEqual(w.check(w.homeDir).problems, ['config-dir-contains-repo', 'config-dir-is-home']);
  assert.deepEqual(w.check(path.join(w.homeDir, '.claude')).problems, ['config-dir-is-provider-default']);
  const file = path.join(w.homeDir, 'a-file');
  fs.writeFileSync(file, 'x');
  assert.ok(w.check(file).problems.includes('config-dir-not-directory'));
  assert.deepEqual(w.check('relative/folder').problems, ['config-dir-not-absolute']);
  for (const result of [w.check(w.homeDir), w.check(path.join(w.homeDir, '.claude')), w.check(file)]) {
    for (const item of result.items) assert.equal(item.known, true);
  }
});

test('real checks: another account\'s folder, the same label, and a link into the project', (t) => {
  const w = world(t);
  const first = path.join(w.homeDir, 'multiagent-accounts', 'claude-work');
  fs.mkdirSync(first, { recursive: true });
  const profiles = [{ id: 'acct-1', provider: 'claude', label: 'Work', configDir: first }];
  assert.deepEqual(w.check(first, { profiles, label: 'Other' }).problems, ['config-dir-conflict:same']);
  assert.deepEqual(w.check(path.join(first, 'inner'), { profiles, label: 'Other' }).problems, ['config-dir-conflict:nested']);
  assert.deepEqual(w.check(path.join(w.homeDir, 'multiagent-accounts'), { profiles, label: 'Other' }).problems, ['config-dir-conflict:nested', 'config-dir-is-recommended-root']);
  assert.deepEqual(w.check(path.join(w.homeDir, 'multiagent-accounts', 'claude-other'), { profiles, label: 'work ' }).problems, ['duplicate-label']);
  assert.deepEqual(w.check(path.join(w.homeDir, 'multiagent-accounts', 'claude-other'), { profiles, label: 'Other' }).problems, []);
  assert.deepEqual(w.check(path.join(w.homeDir, 'x'), { profiles: [{ ...profiles[0], provider: 'codex' }], label: 'Work' }).problems, [], 'another provider may reuse a label');
  const link = path.join(w.homeDir, 'link-into-project');
  fs.symlinkSync(w.repoRoot, link, 'dir');
  assert.deepEqual(w.check(link).problems, ['config-dir-inside-repo', 'config-dir-contains-repo']);
});

test('the suggested folder is under the home folder, outside the project, one per account, and never taken', (t) => {
  const w = world(t);
  const first = suggestFolder({ homeDir: w.homeDir, provider: 'claude', label: 'Work' });
  assert.equal(first.parent, path.join(w.homeDir, PARENT_NAME));
  assert.equal(first.dir, path.join(w.homeDir, PARENT_NAME, 'claude-work'));
  assert.equal(w.check(first.dir).ok, true);
  assert.equal(suggestFolder({ homeDir: w.homeDir, provider: 'codex', label: 'Work' }).name, 'codex-work');
  fs.mkdirSync(first.dir, { recursive: true });
  assert.equal(suggestFolder({ homeDir: w.homeDir, provider: 'claude', label: 'Work' }).name, 'claude-work-2');
  fs.mkdirSync(path.join(first.parent, 'claude-work-2'));
  assert.equal(suggestFolder({ homeDir: w.homeDir, provider: 'claude', label: 'Work' }).name, 'claude-work-3');
  for (const [label, name] of [['', 'claude-account'], ['  ', 'claude-account'], ['../../etc', 'claude-etc'], ['A/B\\C', 'claude-a-b-c'], ['Ünï çödé', 'claude-uni-code'], ['x'.repeat(100), `claude-${'x'.repeat(30)}`], ['日本語', 'claude-account'], [`bad${String.fromCodePoint(0x202e)}label`, 'claude-bad-label']]) {
    const suggestion = suggestFolder({ homeDir: w.homeDir, provider: 'claude', label });
    assert.equal(suggestion.name, name, JSON.stringify(label));
    assert.equal(path.dirname(suggestion.dir), suggestion.parent);
  }
  assert.throws(() => suggestFolder({ homeDir: w.homeDir, provider: 'unknown', label: 'x' }), TypeError);
  assert.throws(() => suggestFolder({ homeDir: 5, provider: 'claude', label: 'x' }), TypeError);
  assert.equal(Object.keys(PROVIDERS).length >= 2, true);
});

test('creating the recommended folder makes only the account folder, owner-only, and nothing inside the project', (t) => {
  const w = world(t);
  const before = snapshot(w.repoRoot);
  const suggestion = suggestFolder({ homeDir: w.homeDir, provider: 'claude', label: 'Work' });
  const result = createRecommendedFolder({ provider: 'claude', label: 'Work', suggestion, context: w.context });
  assert.deepEqual([result.ok, result.created, result.dir], [true, true, suggestion.dir]);
  assert.ok(fs.statSync(suggestion.dir).isDirectory());
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(suggestion.dir).mode & 0o077, 0, 'no access for group or others');
    assert.equal(fs.statSync(suggestion.parent).mode & 0o077, 0);
  }
  assert.deepEqual(snapshot(w.repoRoot), before, 'nothing was created in the project');
  assert.deepEqual(fs.readdirSync(suggestion.dir), []);
  // a second account gets its own sub-folder next to the first
  const second = suggestFolder({ homeDir: w.homeDir, provider: 'claude', label: 'Personal' });
  const profiles = [{ id: 'acct-1', provider: 'claude', label: 'Work', configDir: suggestion.dir }];
  assert.equal(createRecommendedFolder({ provider: 'claude', label: 'Personal', suggestion: second, profiles, context: w.context }).ok, true);
  assert.deepEqual(fs.readdirSync(suggestion.parent).sort(), ['claude-personal', 'claude-work']);
});

test('creating refuses an unsafe suggestion before making anything, and says why in plain words', (t) => {
  const w = world(t);
  const inside = { parent: path.join(w.repoRoot, 'accounts'), dir: path.join(w.repoRoot, 'accounts', 'claude-work'), name: 'claude-work' };
  const before = snapshot(w.repoRoot);
  const result = createRecommendedFolder({ provider: 'claude', label: 'Work', suggestion: inside, context: w.context });
  assert.deepEqual([result.ok, result.created], [false, false]);
  assert.deepEqual(result.items.map((item) => item.code), ['config-dir-inside-repo']);
  assert.deepEqual(snapshot(w.repoRoot), before, 'nothing was made in the project');
  assert.equal(fs.existsSync(inside.parent), false);
  const taken = { parent: path.join(w.homeDir, PARENT_NAME), dir: path.join(w.homeDir, PARENT_NAME, 'claude-work'), name: 'claude-work' };
  const profiles = [{ id: 'acct-1', provider: 'claude', label: 'Other', configDir: taken.dir }];
  assert.deepEqual(createRecommendedFolder({ provider: 'claude', label: 'Work', suggestion: taken, profiles, context: w.context }).items.map((i) => i.code), ['config-dir-conflict:same']);
});

test('a link planted in the way is caught after creation and what was made is removed', (t) => {
  const w = world(t);
  const suggestion = suggestFolder({ homeDir: w.homeDir, provider: 'claude', label: 'Work' });
  // the folder chain looks fine before, and the second step lands inside the project
  const io = {
    mkdirSync(target, options) {
      fs.mkdirSync(target, options);
      if (target === suggestion.parent) { fs.rmdirSync(target); fs.symlinkSync(w.repoRoot, target, 'dir'); }
    },
    rmdirSync: (target) => fs.rmdirSync(target)
  };
  const before = snapshot(w.repoRoot);
  const result = createRecommendedFolder({ provider: 'claude', label: 'Work', suggestion, context: w.context, io });
  assert.equal(result.ok, false);
  assert.ok(result.items.every((item) => item.known));
  assert.deepEqual(snapshot(w.repoRoot).filter((entry) => !before.includes(entry)), [], 'nothing is left in the project');
});

test('a folder that already exists is never reused or removed by creation', (t) => {
  const w = world(t);
  const suggestion = suggestFolder({ homeDir: w.homeDir, provider: 'claude', label: 'Work' });
  fs.mkdirSync(suggestion.dir, { recursive: true });
  fs.writeFileSync(path.join(suggestion.dir, 'keep.txt'), 'x');
  const result = createRecommendedFolder({ provider: 'claude', label: 'Work', suggestion, context: w.context });
  assert.equal(result.ok, false);
  assert.equal(fs.existsSync(path.join(suggestion.dir, 'keep.txt')), true);
});

test('messages hold no paths, no labels from the person and no account data', (t) => {
  const w = world(t);
  const secretFolder = path.join(w.repoRoot, 'secret-folder-name');
  const result = w.check(secretFolder, { label: 'Private Person Label' });
  const text = JSON.stringify(result.items);
  assert.equal(text.includes('secret-folder-name'), false);
  assert.equal(text.includes(w.repoRoot), false);
  assert.equal(text.includes('Private Person'), false);
  for (const entry of Object.values(EXPLANATIONS)) assert.equal(/[\\/]/.test(entry.message + entry.fix), false);
});

test('when every recommended name is taken the suggestion gives up instead of looping', () => {
  assert.throws(() => suggestFolder({ homeDir: '/home/x', provider: 'claude', label: 'Work', platform: 'linux', exists: () => true }), /no free recommended folder/);
  let asked = 0;
  const name = suggestFolder({ homeDir: '/home/x', provider: 'claude', label: 'Work', platform: 'linux', exists: () => { asked += 1; return asked <= 98; } }).name;
  assert.equal(name, 'claude-work-99');
});

test('an unsafe folder is refused before any folder is made, not made and then removed', (t) => {
  const w = world(t);
  const calls = [];
  const io = { mkdirSync: (...args) => { calls.push(args); }, rmdirSync: () => {} };
  const inside = { parent: path.join(w.repoRoot, 'accounts'), dir: path.join(w.repoRoot, 'accounts', 'claude-work'), name: 'claude-work' };
  assert.equal(createRecommendedFolder({ provider: 'claude', label: 'Work', suggestion: inside, context: w.context, io }).ok, false);
  assert.deepEqual(calls, []);
});

test('a folder that fails the safety checks is not also reported as overlapping another account', (t) => {
  const w = world(t);
  const profiles = [{ id: 'acct-1', provider: 'claude', label: 'Other', configDir: path.join(w.repoRoot, 'x') }];
  assert.deepEqual(w.check(path.join(w.repoRoot, 'x'), { profiles }).problems, ['config-dir-inside-repo']);
});

test('the home folder and the recommended root are never account folders; a folder inside either is fine', (t) => {
  const w = world(t);
  assert.ok(w.check(w.homeDir).problems.includes('config-dir-is-home'));
  const root = path.join(w.homeDir, PARENT_NAME);
  assert.deepEqual(w.check(root).problems, ['config-dir-is-recommended-root']);
  fs.mkdirSync(root);
  assert.deepEqual(w.check(root).problems, ['config-dir-is-recommended-root'], 'also when it exists');
  assert.deepEqual(w.check(path.join(root, 'claude-work')).problems, []);
  assert.deepEqual(w.check(path.join(w.homeDir, 'other-place')).problems, []);
  const link = path.join(w.root, 'home-link');
  fs.symlinkSync(w.homeDir, link, 'dir');
  assert.ok(w.check(link).problems.includes('config-dir-is-home'), 'a link to the home folder is the home folder');
  for (const code of ['config-dir-is-home', 'config-dir-is-recommended-root']) assert.equal(explainProblem(code).known, true);
});

test('an existing recommended root must be a real, private folder owned by this user', { skip: process.platform === 'win32' }, (t) => {
  const w = world(t);
  const suggestion = suggestFolder({ homeDir: w.homeDir, provider: 'claude', label: 'Work' });
  const attempt = () => createRecommendedFolder({ provider: 'claude', label: 'Work', suggestion, context: w.context });
  // a link, even one that points outside the project
  const elsewhere = path.join(w.root, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, suggestion.parent, 'dir');
  let result = attempt();
  assert.deepEqual([result.ok, result.items.map((item) => item.code)], [false, ['recommended-root-unsafe']]);
  assert.deepEqual(fs.readdirSync(elsewhere), [], 'nothing was made behind the link');
  fs.unlinkSync(suggestion.parent);
  // a file
  fs.writeFileSync(suggestion.parent, 'x');
  const onFile = attempt();
  assert.equal(onFile.ok, false);
  assert.equal(onFile.items[0].known, true, 'a file in the way is explained');
  fs.unlinkSync(suggestion.parent);
  // writable by others, or by the group
  for (const mode of [0o777, 0o770, 0o722, 0o702, 0o755 | 0o020]) {
    fs.mkdirSync(suggestion.parent);
    fs.chmodSync(suggestion.parent, mode);
    result = attempt();
    assert.deepEqual([result.ok, result.items[0].code], [false, 'recommended-root-unsafe'], mode.toString(8));
    assert.deepEqual(fs.readdirSync(suggestion.parent), []);
    fs.rmdirSync(suggestion.parent);
  }
  // readable by others is not writable by others, and is accepted
  fs.mkdirSync(suggestion.parent);
  fs.chmodSync(suggestion.parent, 0o755);
  assert.equal(attempt().ok, true);
  assert.ok(explainProblem('recommended-root-unsafe').known);
});

test('a root this call created is private, so the next call accepts it', { skip: process.platform === 'win32' }, (t) => {
  const w = world(t);
  const first = suggestFolder({ homeDir: w.homeDir, provider: 'claude', label: 'Work' });
  assert.equal(createRecommendedFolder({ provider: 'claude', label: 'Work', suggestion: first, context: w.context }).ok, true);
  const second = suggestFolder({ homeDir: w.homeDir, provider: 'claude', label: 'Personal' });
  assert.equal(createRecommendedFolder({ provider: 'claude', label: 'Personal', suggestion: second, context: w.context }).ok, true);
});

test('creation reports exactly the folders it made, and a failed save can discard them while empty', (t) => {
  const w = world(t);
  const suggestion = suggestFolder({ homeDir: w.homeDir, provider: 'claude', label: 'Work' });
  const made = createRecommendedFolder({ provider: 'claude', label: 'Work', suggestion, context: w.context });
  assert.deepEqual(made.madeFolders, [suggestion.parent, suggestion.dir]);
  assert.deepEqual(discardCreated(made.madeFolders), [suggestion.dir, suggestion.parent]);
  assert.equal(fs.existsSync(suggestion.parent), false);
  // the root already existed (made earlier for another account): only the new account folder is reported and removed
  const other = suggestFolder({ homeDir: w.homeDir, provider: 'claude', label: 'Other' });
  const first = createRecommendedFolder({ provider: 'claude', label: 'Other', suggestion: other, context: w.context });
  const again = suggestFolder({ homeDir: w.homeDir, provider: 'claude', label: 'Work' });
  const second = createRecommendedFolder({ provider: 'claude', label: 'Work', suggestion: again, profiles: [{ id: 'a', provider: 'claude', label: 'Other', configDir: first.dir }], context: w.context });
  assert.deepEqual(second.madeFolders, [again.dir]);
  assert.deepEqual(discardCreated(second.madeFolders), [again.dir]);
  assert.equal(fs.existsSync(other.dir), true, 'the other account folder is untouched');
});

test('discarding never removes a folder that has content, one that was not listed, or a non-list', (t) => {
  const w = world(t);
  const keep = path.join(w.root, 'keep');
  const used = path.join(w.root, 'used');
  fs.mkdirSync(keep);
  fs.mkdirSync(used);
  fs.writeFileSync(path.join(used, 'login.json'), 'x');
  assert.deepEqual(discardCreated([used]), []);
  assert.equal(fs.existsSync(path.join(used, 'login.json')), true);
  assert.deepEqual(discardCreated([path.join(w.root, 'missing')]), []);
  for (const bad of [undefined, null, 'x', {}, 5]) assert.deepEqual(discardCreated(bad), []);
  assert.equal(fs.existsSync(keep), true, 'not listed, not removed');
});

test('a saved account folder that fails later checks, and an unsupported provider, are explained without names or codes', () => {
  assert.deepEqual(explainFailure({ code: 'config-dir-rejected', problems: [] }).map((item) => item.code), ['config-dir-rejected']);
  assert.deepEqual(explainFailure({ code: 'config-dir-rejected', problems: ['config-dir-conflict:nested'] }).map((item) => item.code), ['config-dir-conflict:nested', 'config-dir-rejected']);
  const unsupported = explainProblem('provider-unsupported');
  assert.equal(unsupported.known, true);
  assert.equal(/Claude|Codex|agy/.test(unsupported.message + unsupported.fix), false, 'no provider is named in text; the list is the registry\'s');
  assert.equal(/config-dir-rejected/.test(explainProblem('config-dir-rejected').message), false);
});

test('an existing recommended root is judged from what the file system reports: errors, links, non-folders and another owner are all unsafe', { skip: process.platform === 'win32' }, (t) => {
  const w = world(t);
  const suggestion = suggestFolder({ homeDir: w.homeDir, provider: 'claude', label: 'Work' });
  const mkdirs = [];
  const base = { mkdirSync: (target) => mkdirs.push(target), rmdirSync: () => {} };
  const stat = (over = {}) => ({ isSymbolicLink: () => false, isDirectory: () => true, uid: process.getuid(), mode: 0o40700, ...over });
  const attempt = (lstatSync) => createRecommendedFolder({ provider: 'claude', label: 'Work', suggestion, context: w.context, io: { ...base, lstatSync } });
  const codes = (result) => (result.items || []).map((item) => item.code);
  assert.deepEqual(codes(attempt(() => { throw Object.assign(new Error('x'), { code: 'EACCES' }); })), ['recommended-root-unsafe'], 'cannot be read: unsafe, not "missing"');
  assert.deepEqual(codes(attempt(() => stat({ isSymbolicLink: () => true }))), ['recommended-root-unsafe']);
  assert.deepEqual(codes(attempt(() => stat({ isDirectory: () => false }))), ['recommended-root-unsafe']);
  assert.deepEqual(codes(attempt(() => stat({ uid: process.getuid() + 1 }))), ['recommended-root-unsafe'], 'another owner');
  assert.deepEqual(codes(attempt(() => stat({ mode: 0o40777 }))), ['recommended-root-unsafe']);
  assert.deepEqual(mkdirs, [], 'nothing was made while the root was judged unsafe');
  const missing = attempt(() => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); });
  assert.notEqual(codes(missing)[0], 'recommended-root-unsafe', 'a missing root is simply created');
});
