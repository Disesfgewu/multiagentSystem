'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DirectoryLock, LockIoError, WINDOWS_TRANSIENT_CODES } = require('../../src/shared/lock');

const quick = { retries: 5, waitMs: 1 };

function lockFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multiagent-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'x.lock');
}

// Makes creating `file` fail with `code` for the attempts where `fails(attempt)` is true (attempts
// count from 1) and lets every other call through to the real file system. Calls for other paths
// are never touched. Returns a function that reports how many attempts were made on `file`.
function failCreate(t, file, code, fails) {
  const original = fs.openSync;
  let attempts = 0;
  t.mock.method(fs, 'openSync', function patched(...args) {
    if (args[0] !== file) return original.apply(this, args);
    attempts += 1;
    if (fails(attempts)) throw Object.assign(new Error(`synthetic ${code}`), { code });
    return original.apply(this, args);
  });
  return () => attempts;
}

const acquireOutcome = (lock) => {
  try {
    return { result: lock.acquire() };
  } catch (error) {
    return { error };
  }
};

test('the transient Windows codes are exactly EPERM, EACCES and EBUSY', () => {
  assert.deepEqual([...WINDOWS_TRANSIENT_CODES], ['EPERM', 'EACCES', 'EBUSY']);
});

test('on Windows, a transient code while creating the lock file is waited out and the lock is taken', (t) => {
  for (const code of WINDOWS_TRANSIENT_CODES) {
    const file = lockFile(t);
    const attempts = failCreate(t, file, code, (n) => n <= 3);
    const lock = new DirectoryLock(file, { ...quick, platform: 'win32' });
    const got = lock.acquire();
    assert.equal(got.ok, true, code);
    assert.equal(attempts(), 4, `${code}: three transient failures, then the attempt that succeeded`);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, got.token);
    assert.equal(lock.inspect().detail, 'owner-alive');
    lock.release(got.token);
    assert.equal(fs.existsSync(file), false);
    t.mock.restoreAll();
  }
});

test('on Windows, a code that never clears ends in a lock-failed error after the retry budget, not a wait without end', (t) => {
  for (const code of WINDOWS_TRANSIENT_CODES) {
    const file = lockFile(t);
    const attempts = failCreate(t, file, code, () => true);
    const lock = new DirectoryLock(file, { ...quick, platform: 'win32' });
    const outcome = acquireOutcome(lock);
    assert.ok(outcome.error instanceof LockIoError, `${code} is an I/O failure`);
    assert.equal(outcome.error.code, code);
    assert.equal(attempts(), quick.retries + 1, `${code}: exactly the budget, then it stops`);
    assert.equal(fs.existsSync(file), false, 'no lock was left behind');
    t.mock.restoreAll();
  }
});

test('on other platforms the same codes fail at once: they mean what they say', (t) => {
  for (const platform of ['darwin', 'linux', 'freebsd']) {
    for (const code of WINDOWS_TRANSIENT_CODES) {
      const file = lockFile(t);
      const attempts = failCreate(t, file, code, () => true);
      const outcome = acquireOutcome(new DirectoryLock(file, { ...quick, platform }));
      assert.ok(outcome.error instanceof LockIoError, `${platform} ${code}`);
      assert.equal(outcome.error.code, code);
      assert.equal(attempts(), 1, `${platform} ${code}: no retry`);
      t.mock.restoreAll();
    }
  }
});

test('on Windows, any other failure code still fails at once', (t) => {
  for (const code of ['ENOSPC', 'EIO', 'ENOENT', 'EMFILE', 'ENOTDIR', 'EROFS']) {
    const file = lockFile(t);
    const attempts = failCreate(t, file, code, () => true);
    const outcome = acquireOutcome(new DirectoryLock(file, { ...quick, platform: 'win32' }));
    assert.ok(outcome.error instanceof LockIoError, code);
    assert.equal(outcome.error.code, code);
    assert.equal(attempts(), 1, `${code}: no retry`);
    t.mock.restoreAll();
  }
  const file = lockFile(t);
  failCreate(t, file, undefined, () => true);
  const outcome = acquireOutcome(new DirectoryLock(file, { ...quick, platform: 'win32' }));
  assert.equal(outcome.error.code, 'unknown', 'an error without a code is not mistaken for a transient one');
});

test('the platform defaults to the real one', (t) => {
  assert.equal(new DirectoryLock(lockFile(t)).platform, process.platform);
});

test('a lock that is held is still reported as locked, on every platform: waiting never takes it', (t) => {
  for (const platform of ['win32', 'darwin']) {
    const file = lockFile(t);
    const first = new DirectoryLock(file, { ...quick, platform });
    const held = first.acquire();
    assert.equal(held.ok, true);
    const second = new DirectoryLock(file, { ...quick, platform });
    assert.deepEqual(second.acquire(), { ok: false, reason: 'locked', detail: 'owner-alive' });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, held.token, 'the holder keeps its lock');
    first.release(held.token);
  }
});

test('when the budget runs out the last attempt decides: still held means locked, a failing file system means an I/O error', (t) => {
  // Held by a live owner, and the very last attempt hits a transient code.
  const file = lockFile(t);
  const holder = new DirectoryLock(file, { ...quick, platform: 'win32' });
  const held = holder.acquire();
  assert.equal(held.ok, true);
  failCreate(t, file, 'EPERM', (n) => n === quick.retries + 1);
  const ioFailure = acquireOutcome(new DirectoryLock(file, { ...quick, platform: 'win32' }));
  assert.ok(ioFailure.error instanceof LockIoError, 'the file system never settled');
  assert.equal(ioFailure.error.code, 'EPERM');
  t.mock.restoreAll();

  // Transient codes early on, then the lock turns out to be held until the end.
  const file2 = lockFile(t);
  const holder2 = new DirectoryLock(file2, { ...quick, platform: 'win32' });
  assert.equal(holder2.acquire().ok, true);
  failCreate(t, file2, 'EPERM', (n) => n <= 2);
  const locked = acquireOutcome(new DirectoryLock(file2, { ...quick, platform: 'win32' }));
  assert.deepEqual(locked.result, { ok: false, reason: 'locked', detail: 'owner-alive' });
});

test('recovery is unchanged: a live holder is never taken, only an explicit recover clears a dead one', (t) => {
  const file = lockFile(t);
  const lock = new DirectoryLock(file, { ...quick, platform: 'win32', staleMs: 1 });
  const held = lock.acquire();
  assert.equal(held.ok, true);
  const waiter = new DirectoryLock(file, { ...quick, platform: 'win32', staleMs: 1 });
  assert.equal(waiter.acquire().reason, 'locked', 'old does not mean free');
  assert.equal(waiter.recover({ confirm: 'recover-stale-lock' }).ok, false, 'a live owner is refused');
  assert.equal(fs.existsSync(file), true);
});

test('retries are spaced out: the budget is time to let the other process finish, not a spin', (t) => {
  const file = lockFile(t);
  failCreate(t, file, 'EPERM', (n) => n <= 4);
  const lock = new DirectoryLock(file, { retries: 10, waitMs: 25, platform: 'win32' });
  const started = process.hrtime.bigint();
  assert.equal(lock.acquire().ok, true);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  // Four waits of 25 ms. Only a lower bound is checked, so a slow machine cannot fail this.
  assert.ok(elapsedMs >= 80, `waited ${elapsedMs.toFixed(1)} ms for four 25 ms retries`);
});

// ---- a failure after the lock file was created -------------------------------

// Makes writing the content of the lock file at `file` fail with `code` while `fails(writes)` holds
// (writes count from 1). Writes to any other descriptor are never touched. Returns the write count.
function failWrite(t, file, code, fails, beforeThrow) {
  const open = fs.openSync;
  const write = fs.writeSync;
  const lockDescriptors = new Set();
  let writes = 0;
  t.mock.method(fs, 'openSync', function patched(...args) {
    const descriptor = open.apply(this, args);
    if (args[0] === file) lockDescriptors.add(descriptor);
    return descriptor;
  });
  t.mock.method(fs, 'writeSync', function patched(descriptor, ...rest) {
    if (lockDescriptors.has(descriptor)) {
      lockDescriptors.delete(descriptor);
      writes += 1;
      if (fails(writes)) {
        if (beforeThrow) beforeThrow();
        throw Object.assign(new Error(`synthetic ${code}`), { code });
      }
    }
    return write.call(this, descriptor, ...rest);
  });
  return () => writes;
}

test('a failed write of the lock content leaves no empty lock behind, and the next attempt can take the lock', (t) => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const file = lockFile(t);
    const writes = failWrite(t, file, 'ENOSPC', () => true);
    const closed = [];
    const close = fs.closeSync;
    t.mock.method(fs, 'closeSync', function patched(descriptor) { closed.push(descriptor); return close.call(this, descriptor); });
    const outcome = acquireOutcome(new DirectoryLock(file, { ...quick, platform }));
    assert.ok(outcome.error instanceof LockIoError, platform);
    assert.equal(outcome.error.code, 'ENOSPC');
    assert.equal(writes(), 1, `${platform}: not a transient code, so no retry`);
    assert.equal(closed.length, 1, `${platform}: the descriptor was released`);
    assert.equal(fs.existsSync(file), false, `${platform}: no empty lock file was left`);
    t.mock.restoreAll();
    const next = new DirectoryLock(file, { ...quick, platform }).acquire();
    assert.equal(next.ok, true, `${platform}: the next attempt is not blocked`);
  }
});

test('on Windows a transient failure while writing is waited out: the half-made lock is removed, then the lock is taken', (t) => {
  const file = lockFile(t);
  const writes = failWrite(t, file, 'EPERM', (n) => n === 1);
  const lock = new DirectoryLock(file, { ...quick, platform: 'win32' });
  const got = lock.acquire();
  assert.equal(got.ok, true, 'not reported as a lock held by someone else');
  assert.equal(writes(), 2);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, got.token, 'the lock on disk is complete and ours');
  assert.equal(lock.inspect().detail, 'owner-alive');
});

test('a write that keeps failing ends in an I/O error after the budget, with no lock file left over', (t) => {
  const file = lockFile(t);
  const writes = failWrite(t, file, 'EPERM', () => true);
  const outcome = acquireOutcome(new DirectoryLock(file, { ...quick, platform: 'win32' }));
  assert.ok(outcome.error instanceof LockIoError);
  assert.equal(outcome.error.code, 'EPERM');
  assert.equal(writes(), quick.retries + 1);
  assert.equal(fs.existsSync(file), false);
});

test('a file that cannot be closed is discarded too, and the descriptor is released', (t) => {
  const file = lockFile(t);
  const open = fs.openSync;
  const close = fs.closeSync;
  const lockDescriptors = new Set();
  let closes = 0;
  t.mock.method(fs, 'openSync', function patched(...args) {
    const descriptor = open.apply(this, args);
    if (args[0] === file) lockDescriptors.add(descriptor);
    return descriptor;
  });
  t.mock.method(fs, 'closeSync', function patched(descriptor) {
    const mine = lockDescriptors.has(descriptor);
    close.call(this, descriptor);
    if (mine) {
      closes += 1;
      if (closes === 1) throw Object.assign(new Error('synthetic EIO'), { code: 'EIO' });
    }
  });
  const outcome = acquireOutcome(new DirectoryLock(file, { ...quick, platform: 'linux' }));
  assert.ok(outcome.error instanceof LockIoError);
  assert.equal(outcome.error.code, 'EIO');
  assert.equal(fs.existsSync(file), false, 'the lock that could not be closed is removed');
});

test('only the file this call created is removed: if something else has taken its place, it is left alone', (t) => {
  if (process.platform === 'win32') {
    t.skip('a file that is open cannot be replaced by name on Windows, so this situation does not arise there');
    return;
  }
  const file = lockFile(t);
  failWrite(t, file, 'EIO', () => true, () => {
    // Between creating the lock and cleaning up, the file is replaced by someone else's.
    fs.unlinkSync(file);
    fs.writeFileSync(file, 'somebody else\'s file');
  });
  const outcome = acquireOutcome(new DirectoryLock(file, { ...quick, platform: 'linux' }));
  assert.equal(outcome.error.code, 'EIO');
  assert.equal(fs.readFileSync(file, 'utf8'), 'somebody else\'s file', 'removed by identity, not by name');
});

test('a lock held by someone else is never touched by an attempt that fails to take it', (t) => {
  const file = lockFile(t);
  const holder = new DirectoryLock(file, { ...quick, platform: 'win32' });
  const held = holder.acquire();
  assert.equal(held.ok, true);
  const writes = failWrite(t, file, 'EIO', () => true);
  const second = new DirectoryLock(file, { ...quick, platform: 'win32' }).acquire();
  assert.deepEqual(second, { ok: false, reason: 'locked', detail: 'owner-alive' });
  assert.equal(writes(), 0, 'it never got as far as writing');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, held.token, 'the holder\'s lock is intact');
});

test('a file that cannot be proven to be the one this call created is left in place rather than removed by guess', (t) => {
  const file = lockFile(t);
  failWrite(t, file, 'EIO', () => true);
  const stat = fs.fstatSync;
  t.mock.method(fs, 'fstatSync', function patched(descriptor) {
    // The identity of the new file cannot be read.
    if (fs.existsSync(file) && stat.call(this, descriptor).size === 0) throw Object.assign(new Error('synthetic EBADF'), { code: 'EBADF' });
    return stat.call(this, descriptor);
  });
  const outcome = acquireOutcome(new DirectoryLock(file, { ...quick, platform: 'linux' }));
  assert.equal(outcome.error.code, 'EIO');
  assert.equal(fs.existsSync(file), true, 'not removed: it was not proven to be ours');
});

test('a file with the same number on another device is not the same file', (t) => {
  const file = lockFile(t);
  failWrite(t, file, 'EIO', () => true);
  const lstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', function patched(target, ...rest) {
    const real = lstat.call(this, target, ...rest);
    if (target !== file) return real;
    return { isFile: () => true, dev: real.dev + 1, ino: real.ino };
  });
  const outcome = acquireOutcome(new DirectoryLock(file, { ...quick, platform: 'linux' }));
  assert.equal(outcome.error.code, 'EIO');
  assert.equal(fs.existsSync(file), true, 'a different device means a different file');
});
