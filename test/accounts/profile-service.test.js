'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PrivateStore } = require('../../src/storage/private-store');
const { AccountProfileService, MAX_PROFILES } = require('../../src/accounts/profile-service');
const { buildLaunchEnv } = require('../../src/accounts/profile');
const { sandbox, COLLECTIONS, watchRawPathIo } = require('../storage/helpers');

// Real private store and real temporary folders; synthetic data only.
function setup(t, options = {}) {
  const box = sandbox(t);
  const store = new PrivateStore({ dir: box.dir, repoRoot: box.repoRoot, collections: COLLECTIONS });
  let sessions = [];
  const vault = options.vault;
  const service = new AccountProfileService({
    store,
    vault,
    sessions: () => sessions,
    now: () => new Date('2026-10-15T00:00:00.000Z')
  });
  const dir = (name) => {
    const target = path.join(box.root, 'accounts', name);
    fs.mkdirSync(target, { recursive: true });
    return target;
  };
  return { ...box, dataDir: box.dir, store, service, dir, file: path.join(box.dir, 'store.json'), setSessions: (next) => { sessions = next; } };
}

const claude = (s, name, extra = {}) => s.service.create({ provider: 'claude', label: name, configDir: s.dir(name), ...extra });

test('creates two profiles of the same provider with separate folders and fixed field names', (t) => {
  const s = setup(t);
  const a = claude(s, 'Personal');
  const b = claude(s, 'Work', { expectedAuthMethod: 'claude.ai' });
  assert.ok(a.ok && b.ok);
  assert.notEqual(a.profile.id, b.profile.id);
  assert.match(a.profile.id, /^acct-[0-9a-f]{12}$/);
  assert.deepEqual(Object.keys(a.profile).sort(), ['configDir', 'createdAt', 'expectedAuthMethod', 'id', 'label', 'provider', 'revision', 'secretRef', 'updatedAt']);
  assert.equal(a.profile.revision, 1);
  assert.equal(b.profile.expectedAuthMethod, 'claude.ai');
  assert.equal(s.service.list().profiles.length, 2);

  const again = new AccountProfileService({ store: new PrivateStore({ dir: s.dataDir, repoRoot: s.repoRoot, collections: COLLECTIONS }) });
  assert.deepEqual(again.list().profiles.map((p) => p.label).sort(), ['Personal', 'Work']);
});

test('input is validated with an actionable code and nothing is stored', (t) => {
  const s = setup(t);
  const good = { provider: 'claude', label: 'X', configDir: s.dir('x') };
  const cases = [
    [{ ...good, provider: 'gemini' }, 'invalid-provider'],
    [{ ...good, label: '   ' }, 'invalid-label'],
    [{ ...good, label: 'a'.repeat(81) }, 'invalid-label'],
    [{ ...good, label: 'bad\nlabel' }, 'invalid-label'],
    [{ ...good, label: 42 }, 'invalid-label'],
    [{ ...good, expectedAuthMethod: 'has space' }, 'invalid-auth-method'],
    [{ ...good, secretRef: 'not-a-ref' }, 'invalid-secret-ref'],
    [{ ...good, configDir: 'relative/dir' }, 'invalid-config-dir']
  ];
  for (const [input, code] of cases) {
    const result = s.service.create(input);
    assert.equal(result.ok, false, code);
    assert.equal(result.code, code);
    assert.ok(result.message.length > 10);
  }
  assert.deepEqual(s.service.list().profiles, []);
});

test('a folder inside the repository or equal to the provider default is rejected with the problem named', (t) => {
  const s = setup(t);
  const inside = s.service.create({ provider: 'claude', label: 'In repo', configDir: path.join(s.repoRoot, 'cfg') });
  assert.equal(inside.code, 'invalid-config-dir');
  assert.ok(inside.problems.includes('config-dir-inside-repo'));
  const defaults = s.service.create({ provider: 'claude', label: 'Default', configDir: path.join(os.homedir(), '.claude') });
  assert.ok(defaults.problems.includes('config-dir-is-provider-default'));
  assert.deepEqual(s.service.list().profiles, []);
});

test('labels must be distinct per provider, ignoring case and width; another provider may reuse one', (t) => {
  const s = setup(t);
  const first = claude(s, 'Personal');
  const twin = s.service.create({ provider: 'claude', label: ' ＰＥＲＳＯＮＡＬ ', configDir: s.dir('other') });
  assert.equal(twin.code, 'duplicate-label');
  assert.equal(twin.conflictsWith, first.profile.id);
  const codex = s.service.create({ provider: 'codex', label: 'Personal', configDir: s.dir('codex-personal') });
  assert.ok(codex.ok);
});

test('two profiles can never share or nest configuration folders', (t) => {
  const s = setup(t);
  const base = claude(s, 'Base');
  const same = s.service.create({ provider: 'codex', label: 'Same', configDir: base.profile.configDir });
  assert.equal(same.code, 'config-dir-conflict');
  assert.equal(same.kind, 'same');
  assert.equal(same.conflictsWith, base.profile.id);
  const child = s.service.create({ provider: 'codex', label: 'Child', configDir: path.join(base.profile.configDir, 'nested') });
  assert.equal(child.kind, 'nested');
  const parent = s.service.create({ provider: 'codex', label: 'Parent', configDir: path.dirname(base.profile.configDir) });
  assert.equal(parent.code, 'config-dir-conflict');
  assert.equal(s.service.list().profiles.length, 1);
});

test('a link that points at an existing profile folder is a conflict, not a second account', (t) => {
  const s = setup(t);
  const base = claude(s, 'Base');
  const link = path.join(s.root, 'accounts', 'alias');
  try {
    fs.symlinkSync(base.profile.configDir, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`links cannot be created here: ${error.code}`);
    return;
  }
  const result = s.service.create({ provider: 'codex', label: 'Alias', configDir: link });
  assert.equal(result.code, 'config-dir-conflict');
});

test('anything that looks like a credential is refused and never stored', (t) => {
  const s = setup(t);
  const result = s.service.create({ provider: 'claude', label: 'sk-ant-api03-' + 'A1b2C3d4E5'.repeat(5), configDir: s.dir('leaky') });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'secret-in-record');
  assert.doesNotMatch(JSON.stringify(result), /sk-ant/);
  assert.deepEqual(s.service.list().profiles, []);
  assert.equal(fs.existsSync(s.file), false, 'nothing was written at all');
});

test('only a secret reference is kept, never a value, and the masked export reveals nothing about accounts', (t) => {
  const s = setup(t);
  const created = claude(s, 'With key', { secretRef: 'secret:accounts/key-1' });
  assert.equal(created.profile.secretRef, 'secret:accounts/key-1');
  const exported = JSON.stringify(s.store.exportMasked());
  for (const hidden of ['With key', created.profile.id, 'secret:accounts', created.profile.configDir, 'accounts']) {
    assert.ok(!exported.includes(hidden), `export leaks ${hidden}`);
  }
  assert.match(exported, /"provider":"claude"/);
  assert.match(exported, /"configDir":"<string>"/);
});

test('update changes the label and bumps the revision; optimistic revisions are enforced', (t) => {
  const s = setup(t);
  const { profile } = claude(s, 'Old');
  const renamed = s.service.update(profile.id, { label: 'New' }, { expectedRevision: 1 });
  assert.ok(renamed.ok);
  assert.equal(renamed.profile.revision, 2);
  assert.equal(renamed.profile.createdAt, profile.createdAt);
  assert.equal(s.service.update(profile.id, { label: 'Newer' }, { expectedRevision: 1 }).code, 'stale-revision');
  assert.equal(s.service.get(profile.id).profile.label, 'New');
  assert.equal(s.service.update(profile.id, { label: 'New' }).code, 'nothing-to-change');
  assert.equal(s.service.update(profile.id, {}).code, 'nothing-to-change');
  assert.equal(s.service.update('missing', { label: 'x' }).code, 'profile-not-found');
});

test('the provider is immutable and unknown fields are refused', (t) => {
  const s = setup(t);
  const { profile } = claude(s, 'A');
  assert.equal(s.service.update(profile.id, { provider: 'codex' }).code, 'provider-immutable');
  assert.equal(s.service.update(profile.id, { revision: 99 }).code, 'unknown-field');
  assert.equal(s.service.update(profile.id, { id: 'other' }).code, 'unknown-field');
  assert.equal(s.service.get(profile.id).profile.revision, 1);
});

test('editing keeps the same rules: duplicate labels and folder conflicts are refused', (t) => {
  const s = setup(t);
  const a = claude(s, 'A');
  const b = claude(s, 'B');
  assert.equal(s.service.update(b.profile.id, { label: 'a' }).code, 'duplicate-label');
  assert.equal(s.service.update(b.profile.id, { configDir: a.profile.configDir }).code, 'config-dir-conflict');
  assert.equal(s.service.update(b.profile.id, { configDir: path.join(s.repoRoot, 'x') }).code, 'invalid-config-dir');
  const moved = s.service.update(b.profile.id, { configDir: s.dir('B-moved') });
  assert.ok(moved.ok);
});

test('a profile in use cannot change which account it points to; its label may still change', (t) => {
  const s = setup(t);
  const { profile } = claude(s, 'Busy');
  const other = s.dir('elsewhere');
  s.setSessions([{ accountProfileId: profile.id, terminalOpen: true }]);

  const move = s.service.update(profile.id, { configDir: other });
  assert.equal(move.code, 'profile-in-use');
  assert.equal(move.live, 1);
  assert.equal(s.service.update(profile.id, { secretRef: 'secret:accounts/new' }).code, 'profile-in-use');
  assert.equal(s.service.get(profile.id).profile.configDir, profile.configDir, 'unchanged');

  assert.ok(s.service.update(profile.id, { label: 'Busy (renamed)' }).ok);
  assert.ok(s.service.update(profile.id, { expectedAuthMethod: 'claude.ai' }).ok);

  // A closed session that could be reopened also pins the profile.
  s.setSessions([{ accountProfileId: profile.id, terminalOpen: false }]);
  assert.equal(s.service.update(profile.id, { configDir: other }).code, 'profile-in-use');
  s.setSessions([]);
  assert.ok(s.service.update(profile.id, { configDir: other }).ok);
});

test('editing the label of a profile whose folder cannot be resolved right now still works, but moving it is checked', (t) => {
  const s = setup(t);
  const parent = path.join(s.root, 'accounts', 'vanishing');
  const created = s.service.create({ provider: 'claude', label: 'Moved away', configDir: (fs.mkdirSync(path.join(parent, 'cfg'), { recursive: true }), path.join(parent, 'cfg')) });
  assert.ok(created.ok);
  // The folder's parent becomes a regular file: the path can no longer be verified.
  fs.rmSync(parent, { recursive: true, force: true });
  fs.writeFileSync(parent, 'a file now');
  const result = s.service.update(created.profile.id, { label: 'Renamed' });
  assert.ok(result.ok, result.code);
  const again = s.service.update(created.profile.id, { configDir: path.join(parent, 'cfg') });
  assert.equal(again.code, 'nothing-to-change');
  const other = path.join(parent, 'other');
  assert.equal(s.service.update(created.profile.id, { configDir: other }).code, 'invalid-config-dir');
});

test('removing an unused profile keeps the CLI folder and everything in it', async (t) => {
  const s = setup(t);
  const { profile } = claude(s, 'Gone');
  fs.writeFileSync(path.join(profile.configDir, 'login-state.synthetic'), 'not ours to delete');
  const result = await s.service.remove(profile.id);
  assert.deepEqual(result, { ok: true, configDirKept: true, secretRemoved: false, secretCleanupFailed: false });
  assert.equal(s.service.get(profile.id).code, 'profile-not-found');
  assert.equal(fs.readFileSync(path.join(profile.configDir, 'login-state.synthetic'), 'utf8'), 'not ours to delete');
  assert.equal((await s.service.remove(profile.id)).code, 'profile-not-found');
});

test('removing a profile in use is refused; earlier sessions need explicit confirmation', async (t) => {
  const s = setup(t);
  const { profile } = claude(s, 'Used');
  s.setSessions([{ accountProfileId: profile.id, terminalOpen: true }, { accountProfileId: profile.id, terminalOpen: false }]);
  const live = await s.service.remove(profile.id, { allowHistoricalReferences: true });
  assert.equal(live.code, 'profile-in-use');
  assert.equal(s.service.get(profile.id).ok, true, 'the record is untouched');

  s.setSessions([{ accountProfileId: profile.id, terminalOpen: false }]);
  const referenced = await s.service.remove(profile.id);
  assert.equal(referenced.code, 'profile-referenced');
  assert.equal(referenced.historical, 1);
  assert.equal(s.service.get(profile.id).ok, true);
  assert.equal((await s.service.remove(profile.id, { allowHistoricalReferences: true })).ok, true);
  assert.equal(s.service.resolveForLaunch(profile.id).code, 'profile-not-found', 'a reopen can no longer start under the deleted profile');
});

test('removal deletes the secret too; a failing vault is reported without hiding that the record is gone', async (t) => {
  const removed = [];
  const vault = { remove: async (ref) => { removed.push(ref); return { ok: true }; } };
  const s = setup(t, { vault });
  const { profile } = claude(s, 'Keyed', { secretRef: 'secret:accounts/key-1' });
  const ok = await s.service.remove(profile.id);
  assert.equal(ok.secretRemoved, true);
  assert.deepEqual(removed, ['secret:accounts/key-1']);

  const broken = setup(t, { vault: { remove: async () => { throw new Error('keychain locked at /private/synthetic'); } } });
  const second = claude(broken, 'Keyed2', { secretRef: 'secret:accounts/key-2' });
  const result = await broken.service.remove(second.profile.id);
  assert.equal(result.ok, true);
  assert.equal(result.secretCleanupFailed, true);
  assert.doesNotMatch(JSON.stringify(result), /keychain|private/);
  assert.equal(broken.service.get(second.profile.id).code, 'profile-not-found');

  const unconfirmed = setup(t, { vault: { remove: async () => ({ ok: false, reason: 'remove-unconfirmed' }) } });
  const third = claude(unconfirmed, 'Keyed3', { secretRef: 'secret:accounts/key-3' });
  const uncertain = await unconfirmed.service.remove(third.profile.id);
  assert.deepEqual([uncertain.secretRemoved, uncertain.secretCleanupFailed], [false, true]);
  assert.doesNotMatch(JSON.stringify(uncertain), /remove-unconfirmed/, 'the public result does not expose backend details');
});

test('assignment: the session choice beats the role group default; nothing is guessed', (t) => {
  const s = setup(t);
  const a = claude(s, 'A').profile;
  const b = claude(s, 'B').profile;
  assert.deepEqual(s.service.assign({ provider: 'claude', sessionOverride: b.id, roleGroupDefault: a.id }), { ok: true, accountProfileId: b.id, source: 'session-override' });
  assert.deepEqual(s.service.assign({ provider: 'claude', roleGroupDefault: a.id }), { ok: true, accountProfileId: a.id, source: 'role-group-default' });
  assert.deepEqual(s.service.assign({ provider: 'claude', sessionOverride: null, roleGroupDefault: a.id }).source, 'role-group-default');
  assert.equal(s.service.assign({ provider: 'claude' }).code, 'no-account-assigned');
  assert.equal(s.service.assign({ provider: 'claude', sessionOverride: '' }).code, 'no-account-assigned');
});

test('assignment problems are specific and actionable', async (t) => {
  const s = setup(t);
  const a = claude(s, 'A').profile;
  const codex = s.service.create({ provider: 'codex', label: 'C', configDir: s.dir('c') }).profile;
  assert.equal(s.service.assign({ provider: 'claude', sessionOverride: codex.id }).code, 'provider-mismatch');
  assert.equal(s.service.assign({ provider: 'claude', roleGroupDefault: codex.id }).source, 'role-group-default');
  assert.equal(s.service.assign({ provider: 'claude', sessionOverride: 'acct-missing', roleGroupDefault: a.id }).code, 'override-profile-missing', 'a stale override is not silently replaced by the default');
  assert.equal(s.service.assign({ provider: 'claude', roleGroupDefault: 'acct-missing' }).code, 'default-profile-missing');
  await s.service.remove(a.id);
  assert.equal(s.service.assign({ provider: 'claude', sessionOverride: a.id }).code, 'override-profile-missing');
});

test('editing a profile never changes the account of a session that already has one', (t) => {
  const s = setup(t);
  const a = claude(s, 'A').profile;
  const session = { id: 's1', accountProfileId: a.id, terminalOpen: true };
  s.setSessions([session]);
  s.service.update(a.id, { label: 'Renamed' });
  s.service.update(a.id, { configDir: s.dir('nowhere') });
  assert.equal(session.accountProfileId, a.id);
  assert.equal(s.service.get(a.id).profile.configDir, a.configDir);
});

test('at most 50 profiles; an unreadable store is reported, not treated as empty', (t) => {
  const s = setup(t);
  for (let index = 0; index < MAX_PROFILES; index += 1) {
    const created = s.service.create({ provider: index % 2 ? 'claude' : 'codex', label: `P${index}`, configDir: s.dir(`p${index}`) });
    assert.ok(created.ok, created.code);
  }
  assert.equal(s.service.create({ provider: 'claude', label: 'One more', configDir: s.dir('more') }).code, 'too-many-profiles');

  const broken = setup(t);
  claude(broken, 'A');
  fs.writeFileSync(broken.file, '{ not json');
  const listed = broken.service.list();
  assert.equal(listed.ok, false);
  assert.equal(listed.code, 'store-unavailable');
  assert.equal(claude(broken, 'B').code, 'store-unavailable');
  assert.equal(fs.readFileSync(broken.file, 'utf8'), '{ not json', 'the damaged file is left as it was');
});

test('the service needs a store with a profiles collection', (t) => {
  const s = setup(t);
  assert.throws(() => new AccountProfileService({}), TypeError);
  const other = new PrivateStore({ dir: path.join(s.root, 'other'), repoRoot: s.repoRoot, collections: ['sessions'] });
  assert.throws(() => new AccountProfileService({ store: other }), TypeError);
});

// ---- review: the launch gate re-validates the folder every time -----------------------------

function link(t, target, at) {
  try {
    fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (error) {
    t.skip(`links cannot be created here: ${error.code}`);
    return false;
  }
}

function replaceWithLink(t, folder, target) {
  fs.rmSync(folder, { recursive: true, force: true });
  return link(t, target, folder);
}

test('resolveForLaunch returns a healthy profile and refuses an unknown one', (t) => {
  const s = setup(t);
  const { profile } = claude(s, 'Healthy');
  const resolved = s.service.resolveForLaunch(profile.id);
  assert.ok(resolved.ok);
  assert.equal(resolved.profile.id, profile.id);
  assert.equal(s.service.resolveForLaunch('acct-missing').code, 'profile-not-found');
});

test('resolveForLaunch refuses a folder that was later replaced by a link into the repository', (t) => {
  const s = setup(t);
  const { profile } = claude(s, 'A');
  claude(s, 'B');
  assert.ok(s.service.resolveForLaunch(profile.id).ok, 'it was fine when created');
  if (!replaceWithLink(t, profile.configDir, s.repoRoot)) return;
  const result = s.service.resolveForLaunch(profile.id);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'config-dir-rejected');
  assert.ok(result.problems.includes('config-dir-inside-repo') || result.problems.includes('config-dir-contains-repo'), JSON.stringify(result.problems));
  assert.equal(result.profile, undefined, 'the profile is not handed out');
});

test('account create, update and launch reject raw link/.. config paths without storing or using them', (t) => {
  const s = setup(t);
  const sub = path.join(s.repoRoot, 'sub');
  fs.mkdirSync(sub);
  const link = path.join(s.root, 'repo-sub-link');
  if (process.platform !== 'win32') {
    try { fs.symlinkSync(sub, link, 'dir'); } catch (error) { t.skip(`cannot create a directory link here: ${error.code}`); return; }
  }
  const raw = `${link}${path.sep}..${path.sep}account-data`;
  const calls = watchRawPathIo(t, fs);

  const created = s.service.create({ provider: 'claude', label: 'Unsafe', configDir: raw });
  assert.equal(created.code, 'invalid-config-dir');
  assert.ok(created.problems.includes('config-dir-unresolvable'));
  assert.equal(s.service.list().profiles.length, 0);

  const { profile } = claude(s, 'Safe');
  const moved = s.service.update(profile.id, { configDir: raw });
  assert.equal(moved.code, 'invalid-config-dir');
  assert.equal(s.service.get(profile.id).profile.configDir, profile.configDir);

  const record = { ...profile };
  delete record.id;
  record.configDir = raw;
  assert.equal(s.store.put('profiles', profile.id, record).ok, true, 'simulate an older or hand-edited record');
  const resolved = s.service.resolveForLaunch(profile.id);
  assert.equal(resolved.code, 'config-dir-rejected');
  assert.equal(resolved.profile, undefined);
  const launch = buildLaunchEnv({ ...profile, configDir: raw }, {}, { platform: process.platform, homeDir: os.homedir(), repoRoot: s.repoRoot });
  assert.deepEqual(launch.blockers, [{ code: 'config-dir-rejected' }]);
  assert.equal('CLAUDE_CONFIG_DIR' in launch.env, false);
  assert.deepEqual(calls, [], 'no file operation receives the raw link/.. path');
  assert.equal(fs.existsSync(path.join(s.repoRoot, 'account-data')), false, 'the repository remains untouched');
});

test('saved account paths are normalized before persistence', (t) => {
  const s = setup(t);
  const target = s.dir('canonical-target');
  const link = path.join(s.root, 'accounts', 'canonical-link');
  try { fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { t.skip(`cannot create a directory link here: ${error.code}`); return; }
  const result = s.service.create({ provider: 'claude', label: 'Canonical', configDir: link });
  assert.equal(result.ok, true, result.code);
  assert.equal(result.profile.configDir, path.resolve(link));
  assert.equal(s.service.get(result.profile.id).profile.configDir, path.resolve(link));
});

test('resolveForLaunch refuses a folder that was later replaced by a link to another profile\'s folder', (t) => {
  const s = setup(t);
  const a = claude(s, 'A').profile;
  const b = claude(s, 'B').profile;
  if (!replaceWithLink(t, a.configDir, b.configDir)) return;
  const forA = s.service.resolveForLaunch(a.id);
  assert.equal(forA.code, 'config-dir-rejected');
  assert.ok(forA.problems.includes('config-dir-conflict:same'));
  assert.equal(forA.conflictsWith, b.id);
  // The other side of the conflict is refused too: neither may start while they share a login folder.
  const forB = s.service.resolveForLaunch(b.id);
  assert.equal(forB.code, 'config-dir-rejected');
  assert.equal(forB.conflictsWith, a.id);
});

test('resolveForLaunch refuses a folder replaced by a file or whose parent became a file; a deleted folder is allowed', (t) => {
  const s = setup(t);
  const a = claude(s, 'A').profile;
  fs.rmSync(a.configDir, { recursive: true, force: true });
  assert.ok(s.service.resolveForLaunch(a.id).ok, 'not created yet is fine: the login creates it');
  fs.writeFileSync(a.configDir, 'a file now');
  const isFile = s.service.resolveForLaunch(a.id);
  assert.equal(isFile.code, 'config-dir-rejected');
  assert.ok(isFile.problems.includes('config-dir-not-a-directory'));

  const parent = path.join(s.root, 'accounts', 'shaky');
  const b = s.service.create({ provider: 'claude', label: 'B', configDir: (fs.mkdirSync(path.join(parent, 'cfg'), { recursive: true }), path.join(parent, 'cfg')) }).profile;
  fs.rmSync(parent, { recursive: true, force: true });
  fs.writeFileSync(parent, 'a file now');
  assert.equal(s.service.resolveForLaunch(b.id).code, 'config-dir-rejected');
});

test('one profile\'s unresolvable folder does not block another profile from launching', (t) => {
  const s = setup(t);
  const a = claude(s, 'A').profile;
  const parent = path.join(s.root, 'accounts', 'broken');
  const b = s.service.create({ provider: 'claude', label: 'B', configDir: (fs.mkdirSync(path.join(parent, 'cfg'), { recursive: true }), path.join(parent, 'cfg')) }).profile;
  fs.rmSync(parent, { recursive: true, force: true });
  fs.writeFileSync(parent, 'a file now');
  assert.ok(s.service.resolveForLaunch(a.id).ok);
  assert.equal(s.service.resolveForLaunch(b.id).code, 'config-dir-rejected');
});

test('assign is gated by the same re-validation and keeps its source in the failure', (t) => {
  const s = setup(t);
  const a = claude(s, 'A').profile;
  const b = claude(s, 'B').profile;
  assert.ok(s.service.assign({ provider: 'claude', sessionOverride: a.id }).ok);
  if (!replaceWithLink(t, a.configDir, s.repoRoot)) return;
  const viaOverride = s.service.assign({ provider: 'claude', sessionOverride: a.id, roleGroupDefault: b.id });
  assert.equal(viaOverride.code, 'config-dir-rejected');
  assert.equal(viaOverride.source, 'session-override');
  assert.equal(s.service.assign({ provider: 'claude', roleGroupDefault: a.id }).source, 'role-group-default');
  assert.equal(s.service.assign({ provider: 'claude', roleGroupDefault: a.id }).code, 'config-dir-rejected');
  assert.ok(s.service.assign({ provider: 'claude', sessionOverride: b.id }).ok, 'a healthy profile is unaffected');
});

test('an empty or null session choice means no choice: the role group default is used', (t) => {
  const s = setup(t);
  const a = claude(s, 'A').profile;
  for (const empty of ['', null, undefined]) {
    assert.deepEqual(s.service.assign({ provider: 'claude', sessionOverride: empty, roleGroupDefault: a.id }), { ok: true, accountProfileId: a.id, source: 'role-group-default' });
    assert.equal(s.service.assign({ provider: 'claude', sessionOverride: empty, roleGroupDefault: empty }).code, 'no-account-assigned');
  }
});

test('a secret reference that was set cannot be replaced or cleared (the old secret would be orphaned)', (t) => {
  const s = setup(t);
  const { profile } = claude(s, 'Keyed');
  assert.equal(profile.secretRef, null);
  const first = s.service.update(profile.id, { secretRef: 'secret:accounts/key-1' });
  assert.ok(first.ok, 'setting it for the first time is allowed');
  assert.equal(s.service.update(profile.id, { secretRef: 'secret:accounts/key-2' }).code, 'secret-ref-locked');
  assert.equal(s.service.update(profile.id, { secretRef: null }).code, 'secret-ref-locked');
  assert.equal(s.service.update(profile.id, { secretRef: 'secret:accounts/key-1' }).code, 'nothing-to-change');
  assert.equal(s.service.get(profile.id).profile.secretRef, 'secret:accounts/key-1');
});

test('a folder whose type cannot be read (permission error) is refused, not assumed fine', (t) => {
  const s = setup(t);
  const { profile } = claude(s, 'Locked');
  // Only this profile's folder fails; every other path is checked for real, so the result does not
  // depend on what exists on the machine (for example the provider's default folder).
  const failing = (code) => ({
    isDirectory: (target) => {
      if (target === profile.configDir) throw Object.assign(new Error('synthetic'), { code });
      return fs.statSync(target).isDirectory();
    }
  });
  const denied = new AccountProfileService({ store: s.store, context: failing('EACCES') });
  const result = denied.resolveForLaunch(profile.id);
  assert.equal(result.code, 'config-dir-rejected');
  assert.deepEqual(result.problems, ['config-dir-unreadable']);
  const missing = new AccountProfileService({ store: s.store, context: failing('ENOENT') });
  assert.ok(missing.resolveForLaunch(profile.id).ok, 'ENOENT means not created yet');
});
