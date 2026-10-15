'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { DirectoryLock, CONFIRM_RECOVER, pidAlive } = require('../../src/shared/lock');
const { PrivateStore } = require('../../src/storage/private-store');
const { sandbox, COLLECTIONS } = require('./helpers');

const holder = path.join(__dirname, 'fixtures', 'lock-holder.js');
const quick = { retries: 2, waitMs: 1, staleMs: 100 };
const open = (s, lock) => new PrivateStore({ dir: s.dir, repoRoot: s.repoRoot, collections: COLLECTIONS, lock });
const lockPath = (s) => path.join(s.dir, 'store.lock');

function writeLock(s, owner, ageMs = 0) {
  fs.mkdirSync(s.dir, { recursive: true });
  fs.writeFileSync(lockPath(s), typeof owner === 'string' ? owner : JSON.stringify(owner));
  if (ageMs > 0) {
    const past = new Date(Date.now() - ageMs);
    fs.utimesSync(lockPath(s), past, past);
  }
}

function deadPid() {
  const child = spawnSync(process.execPath, ['-e', '0']);
  assert.equal(child.status, 0);
  return child.pid;
}

const mine = (extra) => ({ token: 'someone-elses-token', pid: process.pid, host: os.hostname(), createdAt: 'x', ...extra });

test('a lock held by a live process is never taken, however old it is', (t) => {
  const s = sandbox(t);
  writeLock(s, mine(), 10 * 60 * 1000);
  const store = open(s, quick);
  assert.deepEqual(store.put('profiles', 'p1', { provider: 'claude' }), { ok: false, reason: 'locked', detail: 'owner-alive' });
  assert.equal(store.inspectLock().stale, true, 'it is old, and still not taken');
  assert.equal(fs.existsSync(lockPath(s)), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(lockPath(s), 'utf8')).token, 'someone-elses-token');
  assert.equal(store.get('profiles', 'p1').found, false, 'nothing was written');
});

test('a live holder in another process keeps the lock through the stale age; writes resume when it releases', async (t) => {
  const s = sandbox(t);
  fs.mkdirSync(s.dir);
  const child = spawn(process.execPath, [holder, lockPath(s), 'hold', '2500'], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => child.kill());
  await new Promise((resolve) => child.stdout.once('data', resolve));

  const store = open(s, { retries: 3, waitMs: 5, staleMs: 50 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(store.inspectLock().stale, true);
  assert.deepEqual(store.put('profiles', 'p1', { provider: 'claude' }),
    { ok: false, reason: 'locked', detail: 'owner-alive' });

  await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(store.put('profiles', 'p1', { provider: 'claude' }).ok, true);
});

test('a crashed holder is reported as dead and cleared only on request', async (t) => {
  const s = sandbox(t);
  fs.mkdirSync(s.dir);
  const child = spawn(process.execPath, [holder, lockPath(s), 'crash'], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(fs.existsSync(lockPath(s)), true, 'the crashed holder left its lock behind');

  const store = open(s, quick);
  assert.deepEqual(store.put('profiles', 'p1', { provider: 'claude' }), { ok: false, reason: 'locked', detail: 'owner-dead' });
  assert.equal(fs.existsSync(lockPath(s)), true, 'writing does not clear it automatically');
  const { ageMs, ...inspected } = store.inspectLock();
  assert.deepEqual(inspected, { ok: true, held: true, detail: 'owner-dead', stale: inspected.stale });
  assert.equal(typeof ageMs, 'number');
  assert.equal(typeof inspected.stale, 'boolean');

  assert.equal(store.recoverLock().reason, 'confirmation-required');
  assert.equal(store.recoverLock({ confirm: 'yes' }).reason, 'confirmation-required');
  assert.deepEqual(store.recoverLock({ confirm: CONFIRM_RECOVER }), { ok: true, recovered: true, detail: 'owner-dead' });
  assert.equal(store.put('profiles', 'p1', { provider: 'claude' }).ok, true);
});

test('recovery refuses a live owner unless forced, and forcing needs a stale lock', (t) => {
  const s = sandbox(t);
  const store = open(s, quick);

  writeLock(s, mine());
  const refused = store.recoverLock({ confirm: CONFIRM_RECOVER });
  assert.deepEqual([refused.ok, refused.reason, refused.detail], [false, 'owner-not-confirmed-gone', 'owner-alive']);
  assert.equal(typeof refused.ageMs, 'number');
  assert.equal(store.recoverLock({ confirm: CONFIRM_RECOVER, force: true }).reason, 'not-stale', 'fresh lock, even forced');
  assert.equal(fs.existsSync(lockPath(s)), true);

  writeLock(s, mine(), 5000);
  assert.equal(store.recoverLock({ confirm: CONFIRM_RECOVER }).ok, false, 'old but not forced');
  const forced = store.recoverLock({ confirm: CONFIRM_RECOVER, force: true });
  assert.deepEqual([forced.ok, forced.recovered], [true, true], 'a person decided, for example after a pid was reused');
  assert.equal(fs.existsSync(lockPath(s)), false);
});

test('another host and an unreadable lock are never assumed dead', (t) => {
  const s = sandbox(t);
  const store = open(s, quick);
  const cases = {
    'owner-other-host': mine({ host: 'some-other-machine', pid: deadPid() }),
    'owner-unreadable': '{ half written',
    'owner-unreadable ': JSON.stringify({ token: 1 })
  };
  for (const [detail, owner] of Object.entries(cases)) {
    writeLock(s, owner, 5000);
    const outcome = store.put('profiles', 'p1', { provider: 'claude' });
    assert.deepEqual([outcome.reason, outcome.detail], ['locked', detail.trim()]);
    assert.equal(store.recoverLock({ confirm: CONFIRM_RECOVER }).reason, 'owner-not-confirmed-gone');
    assert.equal(store.recoverLock({ confirm: CONFIRM_RECOVER, force: true }).recovered, true);
  }
});

test('release removes only the lock this holder took', (t) => {
  const s = sandbox(t);
  fs.mkdirSync(s.dir);
  const lock = new DirectoryLock(lockPath(s), { retries: 0 });
  const first = lock.acquire();
  assert.equal(first.ok, true);
  fs.rmSync(lockPath(s));
  writeLock(s, mine({ token: 'second' }));
  lock.release(first.token);
  assert.equal(JSON.parse(fs.readFileSync(lockPath(s), 'utf8')).token, 'second', 'someone else\'s lock survives');
  lock.release('second');
  assert.equal(fs.existsSync(lockPath(s)), false);
});

test('inspecting and recovering an absent lock is harmless', (t) => {
  const s = sandbox(t);
  const store = open(s, quick);
  assert.deepEqual(store.inspectLock(), { ok: true, held: false });
  assert.deepEqual(store.recoverLock({ confirm: CONFIRM_RECOVER }), { ok: true, recovered: false });
});

test('process liveness probe', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(deadPid()), false);
  for (const bad of [0, -1, 1.5, NaN, null, '12']) assert.equal(pidAlive(bad), false);
});

// A synthetic file-system error while creating this store's lock file, for the first `count`
// attempts (or always, when `count` is Infinity). Other files are never touched.
function failLockCreate(t, s, code, count) {
  const original = fs.openSync;
  const target = lockPath(s);
  let attempts = 0;
  t.mock.method(fs, 'openSync', function patched(...args) {
    if (args[0] !== target) return original.apply(this, args);
    attempts += 1;
    if (attempts <= count) throw Object.assign(new Error(`synthetic ${code}`), { code });
    return original.apply(this, args);
  });
  return () => attempts;
}

test('on Windows a transient lock error is waited out by the store; one that never clears is reported with its code', (t) => {
  const waited = sandbox(t);
  const attempts = failLockCreate(t, waited, 'EPERM', 3);
  assert.equal(open(waited, { retries: 10, waitMs: 1, platform: 'win32' }).put('profiles', 'p1', { provider: 'claude' }).ok, true);
  assert.equal(attempts(), 4);
  t.mock.restoreAll();

  const stuck = sandbox(t);
  const tries = failLockCreate(t, stuck, 'EBUSY', Infinity);
  const outcome = open(stuck, { retries: 4, waitMs: 1, platform: 'win32' }).put('profiles', 'p1', { provider: 'claude' });
  assert.deepEqual(outcome, { ok: false, reason: 'lock-failed', detail: 'EBUSY' });
  assert.equal(tries(), 5, 'the retry budget and no more');
  assert.equal(fs.existsSync(lockPath(stuck)), false);
  assert.equal(open(stuck, { retries: 4, waitMs: 1, platform: 'win32' }).clear({ confirm: 'delete-private-data' }).reason, 'lock-failed');
  t.mock.restoreAll();

  const elsewhere = sandbox(t);
  const once = failLockCreate(t, elsewhere, 'EPERM', Infinity);
  assert.deepEqual(open(elsewhere, { retries: 4, waitMs: 1, platform: 'darwin' }).put('profiles', 'p1', { provider: 'claude' }),
    { ok: false, reason: 'lock-failed', detail: 'EPERM' });
  assert.equal(once(), 1, 'other platforms do not retry');
});

// Failing to write the lock content (the disk is full, say) must not leave an empty lock that blocks every later write.
function failLockWrite(t, s, code) {
  const open = fs.openSync;
  const write = fs.writeSync;
  const target = lockPath(s);
  const lockDescriptors = new Set();
  let failing = true;
  t.mock.method(fs, 'openSync', function patched(...args) {
    const descriptor = open.apply(this, args);
    if (args[0] === target) lockDescriptors.add(descriptor);
    return descriptor;
  });
  t.mock.method(fs, 'writeSync', function patched(descriptor, ...rest) {
    if (failing && lockDescriptors.has(descriptor)) {
      lockDescriptors.delete(descriptor);
      throw Object.assign(new Error(`synthetic ${code}`), { code });
    }
    return write.call(this, descriptor, ...rest);
  });
  return { stop() { failing = false; } };
}

test('a failed write of the lock does not leave a lock behind that blocks the next write', (t) => {
  const s = sandbox(t);
  const failure = failLockWrite(t, s, 'ENOSPC');
  const store = open(s, { retries: 2, waitMs: 1 });
  const refused = store.put('profiles', 'p1', { provider: 'claude' });
  assert.deepEqual(refused, { ok: false, reason: 'lock-failed', detail: 'ENOSPC' });
  assert.equal(fs.existsSync(lockPath(s)), false, 'no empty lock file');
  failure.stop();
  assert.equal(store.put('profiles', 'p1', { provider: 'claude' }).ok, true, 'and the next write goes through');
  assert.deepEqual(store.inspectLock(), { ok: true, held: false });
});
