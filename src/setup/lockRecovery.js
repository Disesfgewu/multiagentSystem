'use strict';

// What the person must be told, and what recovery may do, for each state a held storage lock can be in.
// `stale` only means the lock file is older than the stale age: the file is not refreshed while a window
// holds it, so a live window that has held the lock for a while is "stale" too. Age alone must therefore
// never be enough to remove a lock whose owner is still running.
//
// detail: 'owner-dead' (provably gone), 'owner-alive' (a process with that id is running here),
//         'owner-other-host' / 'owner-unreadable' (a program cannot judge).
function lockRecoveryPlan(inspected) {
  const detail = inspected && typeof inspected.detail === 'string' ? inspected.detail : 'owner-unreadable';
  const stale = Boolean(inspected && inspected.stale === true);
  if (detail === 'owner-alive') {
    return {
      blocked: true,
      force: false,
      ownerLine: 'The process that holds this lock is still running on this computer.',
      refusal: 'The private storage lock belongs to a process that is still running here (probably another VS Code window). It was not removed. Close that window, or wait for it to finish, then try again.'
    };
  }
  if (detail === 'owner-dead') {
    return { blocked: false, force: false, ownerLine: 'The process that held this lock is no longer running.', refusal: null };
  }
  const why = detail === 'owner-other-host' ? 'It was taken on another computer' : 'Its owner could not be read';
  return {
    blocked: false,
    force: stale,
    ownerLine: `${why}, so a program cannot tell whether it is still in use.${stale ? ' It is old enough to recover.' : ' It is not old enough to recover yet.'}`,
    refusal: null
  };
}

module.exports = { lockRecoveryPlan };
