'use strict';

const { STATES, TERMINAL } = require('./states');

// The local record of which of this machine's agents holds which issue. It is private: the
// session, worktree and branch never leave the machine. GitHub holds the issue itself and the
// neutral status label; this record says only how this machine relates to them.
//
// `state` is the work state. `sync` says how sure this machine is that GitHub agrees:
//   claiming            intent written before the remote write; the outcome is not known yet
//   confirmed           the remote was read after the change and agreed
//   unverified          the remote could not be read the last time; nothing is assumed
//   conflict            the remote showed more than one claim; dispatching stops
//   needs_confirmation  the remote shows a claim this machine cannot tell is its own

const SYNC = Object.freeze(['claiming', 'confirmed', 'unverified', 'conflict', 'needs_confirmation']);
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const FIELDS = Object.freeze([
  'repoId', 'issueNumber', 'state', 'sync', 'sessionId', 'worktree', 'branch', 'headSha', 'prNumber',
  'reviewKind', 'claimedAt', 'lastSyncedAt'
]);
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function repoOf(value) {
  if (!value || typeof value !== 'object') throw new TypeError('repository must be { owner, name }');
  for (const part of [value.owner, value.name]) {
    if (typeof part !== 'string' || !NAME.test(part) || part === '.' || part === '..') throw new TypeError('invalid repository name');
  }
  return { owner: value.owner, name: value.name };
}

/** GitHub names are case-insensitive, so one repository has one key. */
const repoKey = (repo) => {
  const checked = repoOf(repo);
  return `${checked.owner}/${checked.name}`.toLowerCase();
};

function issueOf(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('issue number must be a positive integer');
  return value;
}

const linkKey = (repo, issueNumber) => `${repoKey(repo)}#${issueOf(issueNumber)}`;
const keyOfLink = (link) => `${link.repoId}#${link.issueNumber}`;

const isoOrNull = (value) => value === null || (typeof value === 'string' && !Number.isNaN(Date.parse(value)));
const text = (value, max) => typeof value === 'string' && value.length >= 1 && value.length <= max && !CONTROL.test(value);

// Checks a record read from storage or built by the caller. Returns a clean copy or a list of
// problems (field names only, never values).
function validateLink(input) {
  const problems = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, problems: ['not-an-object'] };
  for (const key of Object.keys(input)) if (!FIELDS.includes(key)) problems.push('unknown-field');

  if (typeof input.repoId !== 'string' || !/^[a-z0-9._-]{1,100}\/[a-z0-9._-]{1,100}$/.test(input.repoId)) problems.push('repoId');
  if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber < 1) problems.push('issueNumber');
  if (!STATES.includes(input.state)) problems.push('state');
  if (!SYNC.includes(input.sync)) problems.push('sync');
  if (typeof input.sessionId !== 'string' || !SESSION_ID.test(input.sessionId)) problems.push('sessionId');
  if (input.worktree !== null && input.worktree !== undefined && !text(input.worktree, 500)) problems.push('worktree');
  if (input.branch !== null && input.branch !== undefined && !text(input.branch, 255)) problems.push('branch');
  if (input.headSha !== null && input.headSha !== undefined && !SHA.test(input.headSha)) problems.push('headSha');
  if (input.prNumber !== null && input.prNumber !== undefined && !(Number.isSafeInteger(input.prNumber) && input.prNumber > 0)) problems.push('prNumber');
  if (input.reviewKind !== null && input.reviewKind !== undefined && input.reviewKind !== 'formal' && input.reviewKind !== 'informal') problems.push('reviewKind');
  if (!isoOrNull(input.claimedAt ?? null)) problems.push('claimedAt');
  if (!isoOrNull(input.lastSyncedAt ?? null)) problems.push('lastSyncedAt');
  if (TERMINAL.includes(input.state)) problems.push('terminal-state-is-not-kept');
  if (problems.length > 0) return { ok: false, problems: [...new Set(problems)] };

  return {
    ok: true,
    link: {
      repoId: input.repoId,
      issueNumber: input.issueNumber,
      state: input.state,
      sync: input.sync,
      sessionId: input.sessionId,
      worktree: input.worktree ?? null,
      branch: input.branch ?? null,
      headSha: input.headSha ?? null,
      prNumber: input.prNumber ?? null,
      reviewKind: input.reviewKind ?? null,
      claimedAt: input.claimedAt ?? null,
      lastSyncedAt: input.lastSyncedAt ?? null
    }
  };
}

/**
 * A link store held in memory, with the same shape a persistent one must have: asynchronous,
 * and it refuses anything that is not a valid link. `export()` and the optional `snapshot`
 * argument stand in for what a restart keeps, so recovery can be tested without a disk.
 */
function createMemoryLinkStore(snapshot) {
  const links = new Map();
  if (snapshot !== undefined) {
    const parsed = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot;
    if (!Array.isArray(parsed)) throw new TypeError('a snapshot is a list of links');
    for (const item of parsed) {
      const checked = validateLink(item);
      if (!checked.ok) throw new TypeError(`snapshot holds an invalid link: ${checked.problems.join(',')}`);
      links.set(keyOfLink(checked.link), checked.link);
    }
  }
  return {
    async list() { return [...links.values()].map((link) => ({ ...link })); },
    async get(repo, issueNumber) {
      const found = links.get(linkKey(repo, issueNumber));
      return found ? { ...found } : null;
    },
    async save(link) {
      const checked = validateLink(link);
      if (!checked.ok) throw new TypeError(`invalid link: ${checked.problems.join(',')}`);
      links.set(keyOfLink(checked.link), checked.link);
    },
    async remove(repo, issueNumber) { links.delete(linkKey(repo, issueNumber)); },
    export() { return JSON.stringify([...links.values()]); }
  };
}

module.exports = { SYNC, repoKey, linkKey, keyOfLink, validateLink, createMemoryLinkStore };
