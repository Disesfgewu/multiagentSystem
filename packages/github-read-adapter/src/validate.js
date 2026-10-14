'use strict';

const NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function assertName(value, label) {
  if (typeof value !== 'string' || !NAME_PATTERN.test(value) || value === '.' || value === '..') {
    throw new TypeError(`${label} is not a valid GitHub name`);
  }
  return value;
}

/** Returns a normalized copy; throws TypeError for programmer errors. */
function assertRepository(repo) {
  if (!repo || typeof repo !== 'object') throw new TypeError('repository must be { owner, name }');
  return { owner: assertName(repo.owner, 'owner'), name: assertName(repo.name, 'name') };
}

/** GitHub treats owner and repository names case-insensitively. */
function repositoryKey(repo) {
  return `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`;
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`);
  return value;
}

function assertSha(value, label = 'sha') {
  const sha = typeof value === 'string' ? value.toLowerCase() : value;
  if (typeof sha !== 'string' || !SHA_PATTERN.test(sha)) throw new TypeError(`${label} must be a full commit SHA`);
  return sha;
}

function assertBranchName(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255 || CONTROL_CHARS.test(value)) {
    throw new TypeError('branch must be a non-empty name without control characters');
  }
  return value;
}

function isSha(value) {
  return typeof value === 'string' && SHA_PATTERN.test(value.toLowerCase());
}

module.exports = {
  assertRepository,
  repositoryKey,
  assertPositiveInteger,
  assertSha,
  assertBranchName,
  isSha
};
