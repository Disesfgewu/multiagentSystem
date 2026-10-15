'use strict';

const { transition } = require('./states');
const { DEFAULT_LABELS, normalizeLabels, publicLabelFor } = require('./labels');
const { linkKey, repoKey, validateLink } = require('./links');

// Decides when an issue may be claimed, and keeps the local record in step with GitHub.
//
// Nothing here talks to GitHub or the disk. The caller injects:
//   reader  getIssue(number, { signal, forceRefresh }) -> the read-only adapter's result
//           ({ kind, data: { state, labels, assignees, isPullRequest, updatedAt, ... } })
//   writer  claim / setLabel ({ repo, issueNumber, label, expectedUpdatedAt })
//           -> { ok: true } | { ok: false, reason: 'conflict' | 'denied' | 'unavailable' | ... }
//           `claim` takes the issue and must refuse when it changed since `expectedUpdatedAt`;
//           `setLabel` replaces the one neutral status label (a release sets the ready label).
//           The writer is the broker's job (a later Issue); nothing here writes to GitHub itself.
//   store   list / get / save / remove for the local links (see links.js)
//
// Principles:
//   * The remote is read again before every decision. An issue that cannot be read, or that
//     does not clearly say it is free, is never treated as claimable.
//   * What goes to the writer is the repository, the issue number, one neutral status label
//     and the version that was read. No session, worktree, branch or path ever does.
//   * When the outcome of a write is not known, nothing is retried blindly: the intent stays
//     on record and `reconcile` finds out what happened.
//   * Exclusivity across several clients cannot be guaranteed by this code alone. A conflict
//     that can be seen stops dispatching and is reported; one that cannot be seen is not
//     detected here, and a real two-client check on GitHub is still to be done.

const DEFAULT_RETRIES = 2;
const WRITE_FAILURES = Object.freeze({ conflict: 'conflict', denied: 'write-denied', rate_limited: 'cannot-write', invalid: 'cannot-write' });

const refuse = (reason, extra = {}) => ({ ok: false, reason, ...extra });

// A reader or writer that throws is treated like one that could not answer: a read that threw
// is a read that did not succeed, and a write that threw may or may not have happened.
const safeRead = async (reader, number, options) => {
  try {
    return await reader.getIssue(number, options);
  } catch {
    return { kind: 'offline' };
  }
};
const safeWrite = async (call) => {
  try {
    return await call();
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
};
const nowIso = (clock) => new Date(clock()).toISOString();

// One claim per issue and per session may be in flight in this process at a time, so two
// callers cannot both read "free" and both write before either has recorded anything.
const inFlight = new Set();

// GitHub label names are not case sensitive (a repository cannot hold both `blocked` and
// `Blocked`), so a name is compared in one folded form everywhere, on both sides. Configured
// names are already lower case (see labels.js); what GitHub reports may not be.
const fold = (text) => text.normalize('NFC').trim().toLowerCase();

/**
 * What an issue says, read once and strictly, for every decision that depends on it. If a piece
 * the decision needs is missing or of the wrong type the answer is "not ok", never a guess: a
 * missing label list is not an empty one, and a missing state is not "closed".
 */
function readFacts(issue, expectedNumber) {
  if (!issue || typeof issue !== 'object' || Array.isArray(issue)) return { ok: false };
  if (!Number.isSafeInteger(issue.number) || issue.number < 1) return { ok: false };
  if (expectedNumber !== undefined && issue.number !== expectedNumber) return { ok: false };
  if (issue.state !== 'open' && issue.state !== 'closed') return { ok: false };
  if (!Array.isArray(issue.labels) || !issue.labels.every((name) => typeof name === 'string')) return { ok: false };
  if (!Array.isArray(issue.assignees) || !issue.assignees.every((login) => typeof login === 'string')) return { ok: false };
  return {
    ok: true,
    open: issue.state === 'open',
    isPullRequest: issue.isPullRequest === true,
    labels: new Set(issue.labels.map(fold)),
    assignees: issue.assignees,
    updatedAt: issue.updatedAt
  };
}

/** Is this issue free to claim? Anything not clearly free is refused with the reason. */
function assessAvailability(issue, labels, expectedNumber) {
  const facts = readFacts(issue, expectedNumber);
  if (!facts.ok) return refuse('cannot-verify');
  if (!facts.open) return refuse('closed');
  if (facts.isPullRequest) return refuse('is-pull-request');
  if (facts.labels.has(fold(labels.blocked))) return refuse('blocked');
  if (facts.labels.has(fold(labels.claimed)) || facts.assignees.length > 0) return refuse('already-claimed');
  if (!facts.labels.has(fold(labels.ready))) return refuse('not-ready');
  if (typeof facts.updatedAt !== 'string' || Number.isNaN(Date.parse(facts.updatedAt))) return refuse('no-version');
  return { ok: true, updatedAt: facts.updatedAt };
}

/** After a claim was written: does what the remote now shows look like one claim? */
function verifyClaim(before, after, labels, expectedNumber = before && before.number) {
  const prior = readFacts(before, expectedNumber);
  const facts = readFacts(after, expectedNumber);
  if (!prior.ok || !facts.ok || !facts.open || facts.isPullRequest) return false;
  if (!facts.labels.has(fold(labels.claimed)) || facts.labels.has(fold(labels.blocked))) return false;
  if (facts.assignees.length > 1) return false;
  const beforeTime = typeof prior.updatedAt === 'string' ? Date.parse(prior.updatedAt) : Number.NaN;
  const afterTime = typeof facts.updatedAt === 'string' ? Date.parse(facts.updatedAt) : Number.NaN;
  if (Number.isNaN(beforeTime) || Number.isNaN(afterTime) || afterTime < beforeTime) return false;
  return true;
}

// Maps a failed read to a refusal. A read that did not succeed is never "available".
function readFailure(result) {
  switch (result && result.kind) {
    case 'not_found': return refuse('issue-not-found', { possiblyHidden: result.possiblyHidden === true });
    case 'denied': return refuse('access-denied');
    case 'cancelled': return refuse('cancelled');
    case 'rate_limited': case 'transient': case 'offline': case 'invalid': return refuse('cannot-verify', { kind: result.kind });
    default: return refuse('cannot-verify', { kind: 'unknown' });
  }
}

// Only these fields ever reach the writer.
const writePayload = (repo, issueNumber, label, expectedUpdatedAt) => ({
  repo: { owner: repo.owner, name: repo.name }, issueNumber, label, expectedUpdatedAt
});

function checkClaimInput({ reader, writer, store, repo, issueNumber, role, sessionId }) {
  for (const [name, value, methods] of [['reader', reader, ['getIssue']], ['writer', writer, ['claim']], ['store', store, ['list', 'save', 'remove']]]) {
    if (!value || methods.some((method) => typeof value[method] !== 'function')) throw new TypeError(`${name} must provide ${methods.join(', ')}`);
  }
  repoKey(repo);
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new TypeError('issue number must be a positive integer');
  if (typeof role !== 'string') throw new TypeError('role must be given');
  if (typeof sessionId !== 'string' || sessionId === '') throw new TypeError('sessionId must be given');
}

/**
 * Claims an issue for a session, or says why not. Never throws for something that can happen
 * (a busy issue, a failed read, a refused write); throws TypeError only for a programming mistake.
 */
async function claimIssue(options) {
  checkClaimInput(options);
  const { reader, writer, store, repo, issueNumber, role, sessionId, worktree = null, branch = null, signal } = options;
  const labels = normalizeLabels(options.labels);
  const clock = options.now || Date.now;
  const retries = options.maxSyncRetries === undefined ? DEFAULT_RETRIES : options.maxSyncRetries;

  const permitted = transition({ state: 'ready' }, 'claim', { role });
  if (!permitted.ok) return refuse('role-forbidden', { role });

  const key = linkKey(repo, issueNumber);
  const sessionKey = `session:${sessionId}`;
  if (inFlight.has(key) || inFlight.has(sessionKey)) return refuse('claim-in-progress');
  inFlight.add(key);
  inFlight.add(sessionKey);
  try {
    const known = await store.list();
    const here = known.find((link) => `${link.repoId}#${link.issueNumber}` === key);
    if (here) return refuse(here.sync === 'confirmed' ? 'already-claimed-locally' : 'needs-reconcile', { sync: here.sync });
    if (known.some((link) => link.sessionId === sessionId)) return refuse('session-busy');

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (signal && signal.aborted) return refuse('cancelled');
      const read = await safeRead(reader, issueNumber, { signal, forceRefresh: true });
      if (!read || read.kind !== 'ok') return readFailure(read);
      const available = assessAvailability(read.data, labels, issueNumber);
      if (!available.ok) return available;

      // The intent is written before the remote is changed, so a crash in between is visible later.
      const intent = {
        repoId: repoKey(repo), issueNumber, state: 'ready', sync: 'claiming', sessionId, worktree, branch,
        headSha: null, prNumber: null, reviewKind: null, claimedAt: null, lastSyncedAt: nowIso(clock)
      };
      const checked = validateLink(intent);
      if (!checked.ok) throw new TypeError(`invalid link: ${checked.problems.join(',')}`);
      await store.save(checked.link);
      if (signal && signal.aborted) {
        await store.remove(repo, issueNumber);
        return refuse('cancelled');
      }

      const written = await safeWrite(() => writer.claim(writePayload(repo, issueNumber, labels.claimed, available.updatedAt)));
      if (!written || written.ok !== true) {
        const why = written && written.reason;
        if (why === 'conflict') {
          // Someone changed the issue since it was read: forget the intent, read it again.
          await store.remove(repo, issueNumber);
          continue;
        }
        if (WRITE_FAILURES[why]) {
          await store.remove(repo, issueNumber);
          return refuse(WRITE_FAILURES[why], { detail: why });
        }
        // Timeout, lost connection, or anything else: the change may or may not have happened.
        return refuse('outcome-unknown');
      }

      const after = await safeRead(reader, issueNumber, { forceRefresh: true });
      if (!after || after.kind !== 'ok') {
        const unverified = { ...checked.link, sync: 'unverified' };
        await store.save(unverified);
        return refuse('claim-unverified', { kind: after && after.kind });
      }
      if (!verifyClaim(read.data, after.data, labels, issueNumber)) {
        await store.save({ ...checked.link, sync: 'conflict' });
        return refuse('conflict-detected');
      }
      const link = { ...checked.link, state: 'claimed', sync: 'confirmed', claimedAt: nowIso(clock), lastSyncedAt: nowIso(clock) };
      await store.save(link);
      return { ok: true, link };
    }
    return refuse('conflict', { syncRequired: true });
  } finally {
    inFlight.delete(key);
    inFlight.delete(sessionKey);
  }
}

/**
 * After a restart, or whenever the remote may have moved: reads each local link's issue and
 * brings the local record in line. It only reads GitHub and only changes the local record;
 * it never writes to GitHub.
 */
async function reconcile({ reader, store, labels: labelOptions, repo, now, signal }) {
  if (!reader || typeof reader.getIssue !== 'function') throw new TypeError('reader must provide getIssue');
  if (!store || typeof store.list !== 'function') throw new TypeError('store must provide list, save and remove');
  const labels = normalizeLabels(labelOptions);
  const clock = now || Date.now;
  const only = repo ? repoKey(repo) : null;
  const results = [];

  for (const link of await store.list()) {
    if (only && link.repoId !== only) continue;
    if (signal && signal.aborted) { results.push({ issueNumber: link.issueNumber, repoId: link.repoId, outcome: 'cancelled' }); break; }
    const [owner, name] = link.repoId.split('/');
    const where = { owner, name };
    const entry = { repoId: link.repoId, issueNumber: link.issueNumber };
    const read = await safeRead(reader, link.issueNumber, { signal, forceRefresh: true });

    if (read && read.kind === 'cancelled') { results.push({ ...entry, outcome: 'cancelled' }); break; }
    if (!read || read.kind !== 'ok') {
      // Not read, so nothing is assumed: the record is kept and marked as not verified.
      await store.save({ ...link, sync: link.sync === 'claiming' ? 'claiming' : 'unverified' });
      results.push({ ...entry, outcome: 'could-not-read', kind: read && read.kind });
      continue;
    }

    // The same strict reading as for a claim: an answer that is missing what the decision needs is
    // "could not read", and the only local record of the claim is kept. It is never taken to mean
    // "closed" or "handed back".
    const facts = readFacts(read.data, link.issueNumber);
    if (!facts.ok) {
      await store.save({ ...link, sync: link.sync === 'claiming' ? 'claiming' : 'unverified' });
      results.push({ ...entry, outcome: 'could-not-read', kind: 'incomplete' });
      continue;
    }
    const names = facts.labels;
    const assignees = facts.assignees;
    const remoteClaimed = names.has(fold(labels.claimed)) || assignees.length > 0;
    const stamp = nowIso(clock);

    if (!facts.open) {
      await store.remove(where, link.issueNumber);
      results.push({ ...entry, outcome: 'closed-remotely' });
    } else if (assignees.length > 1) {
      await store.save({ ...link, sync: 'conflict', lastSyncedAt: stamp });
      results.push({ ...entry, outcome: 'conflict-detected' });
    } else if (link.sync === 'claiming') {
      if (remoteClaimed) {
        // GitHub shows a claim, and this machine cannot tell whether it is its own.
        await store.save({ ...link, sync: 'needs_confirmation', lastSyncedAt: stamp });
        results.push({ ...entry, outcome: 'needs-confirmation' });
      } else {
        await store.remove(where, link.issueNumber);
        results.push({ ...entry, outcome: 'claim-did-not-happen' });
      }
    } else if (!remoteClaimed) {
      // The remote no longer shows a claim (released, or handed back to the PM).
      await store.remove(where, link.issueNumber);
      results.push({ ...entry, outcome: 'claim-lost' });
    } else if (names.has(fold(labels.blocked)) && link.state !== 'blocked') {
      const moved = transition(link, 'block', { role: 'pm' });
      await store.save({ ...link, state: moved.ok ? moved.state : link.state, sync: 'confirmed', lastSyncedAt: stamp });
      results.push({ ...entry, outcome: 'remote-blocked' });
    } else {
      await store.save({ ...link, sync: link.sync === 'conflict' || link.sync === 'needs_confirmation' ? link.sync : 'confirmed', lastSyncedAt: stamp });
      results.push({ ...entry, outcome: link.sync === 'conflict' || link.sync === 'needs_confirmation' ? 'still-needs-attention' : 'confirmed' });
    }
  }
  return { results };
}

/**
 * Applies one event to a link: checks it with the state machine, changes the neutral label on
 * GitHub when the shown state changes (remote first, so the record never says "released" while
 * GitHub still says "claimed"), then updates the local record.
 */
async function advance(options) {
  const { reader, writer, store, repo, issueNumber, event, role, sessionId, evidence, config = {} } = options;
  for (const [name, value, methods] of [['store', store, ['get', 'save', 'remove']], ['writer', writer, ['setLabel']], ['reader', reader, ['getIssue']]]) {
    if (!value || methods.some((method) => typeof value[method] !== 'function')) throw new TypeError(`${name} must provide ${methods.join(', ')}`);
  }
  const labels = normalizeLabels(options.labels);
  const clock = options.now || Date.now;

  const link = await store.get(repo, issueNumber);
  if (!link) return refuse('no-link');
  if (role === 'worker' && link.sessionId !== sessionId) return refuse('not-owner');
  const resolves = (event === 'close' || event === 'release') && (role === 'pm' || role === 'human');
  if (link.sync !== 'confirmed' && !resolves) return refuse('unresolved-sync', { sync: link.sync });

  const moved = transition(link, event, { role, evidence, config });
  if (!moved.ok) return moved;

  const before = publicLabelFor(link.state, labels);
  const after = publicLabelFor(moved.state, labels);
  if (after !== null && after !== before) {
    const read = await safeRead(reader, issueNumber, { forceRefresh: true });
    const facts = read && read.kind === 'ok' ? readFacts(read.data, issueNumber) : { ok: false };
    if (!read || read.kind !== 'ok' || !facts.ok || typeof facts.updatedAt !== 'string' || Number.isNaN(Date.parse(facts.updatedAt))) {
      return refuse('cannot-verify', { kind: read && read.kind });
    }
    const written = await safeWrite(() => writer.setLabel(writePayload(repo, issueNumber, after, facts.updatedAt)));
    if (!written || written.ok !== true) {
      if (written && written.reason === 'conflict') return refuse('conflict', { syncRequired: true });
      if (written && WRITE_FAILURES[written.reason]) return refuse(WRITE_FAILURES[written.reason]);
      await store.save({ ...link, sync: 'unverified' });
      return refuse('outcome-unknown');
    }
  }

  if (moved.state === 'ready' || moved.state === 'merged' || moved.state === 'closed') {
    await store.remove(repo, issueNumber);
    return { ok: true, state: moved.state, link: null };
  }
  const next = {
    ...link,
    state: moved.state,
    headSha: moved.headSha !== undefined ? moved.headSha : link.headSha,
    prNumber: moved.prNumber !== undefined ? moved.prNumber : link.prNumber,
    reviewKind: moved.reviewKind !== undefined ? moved.reviewKind : link.reviewKind,
    lastSyncedAt: nowIso(clock)
  };
  await store.save(next);
  return { ok: true, state: moved.state, link: next };
}

module.exports = { claimIssue, reconcile, advance, assessAvailability, verifyClaim, DEFAULT_LABELS };
