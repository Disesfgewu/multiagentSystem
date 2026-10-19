'use strict';

// The PM publisher and the merge-authority policy are saved for ONE repository (the confirmation
// dialog names it). The repository a later action targets comes from the open workspace's git
// remote, which a repository can rewrite. So a saved policy only counts for the repository it was
// saved for; for any other repository it is as if nothing were configured (publisher) or as if the
// safe default applied (merge authority: human).

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/** `found` is a private-store read result. Returns the publisher, 'unreadable', or null when not configured for `repository`. */
function publisherFor(found, repository) {
  if (!found || found.ok !== true) return 'unreadable';
  if (!found.found) return null;
  const value = found.value;
  const valid = value && value.kind === 'public-feedback-publisher-v1'
    && typeof value.actorId === 'string' && /^\d+$/.test(value.actorId)
    && typeof value.login === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(value.login);
  if (!valid) return 'unreadable';
  if (repository !== undefined && !same(value.repository, repository)) return null;
  return value;
}

/** Returns 'human' | 'pm' | 'unreadable'. A 'pm' policy saved for another repository is the default, 'human'. */
function mergeModeFor(found, repository) {
  if (!found || found.ok !== true) return 'unreadable';
  if (!found.found) return 'human';
  const value = found.value;
  if (!value || value.kind !== 'merge-authority-policy-v1' || (value.mode !== 'human' && value.mode !== 'pm')) return 'unreadable';
  if (value.mode === 'pm' && repository !== undefined && !same(value.repository, repository)) return 'human';
  return value.mode;
}

module.exports = { publisherFor, mergeModeFor };
