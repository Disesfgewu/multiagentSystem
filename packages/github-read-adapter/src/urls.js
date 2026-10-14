'use strict';

/**
 * Builds github.com page URLs for navigation. Links returned by the API (`html_url`)
 * are only trusted when they are https URLs on the expected web origin; otherwise the
 * deterministic URL built here is used, so a crafted payload cannot redirect the UI
 * to another site.
 *
 * @param {string} webBaseUrl e.g. https://github.com
 */
function createUrlBuilder(webBaseUrl) {
  const base = new URL(webBaseUrl);
  if (base.protocol !== 'https:') throw new TypeError('webBaseUrl must use https');
  const origin = base.origin;

  const repoPath = (repo) => `${origin}/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;

  return {
    origin,
    repository: (repo) => repoPath(repo),
    issues: (repo) => `${repoPath(repo)}/issues`,
    issue: (repo, number) => `${repoPath(repo)}/issues/${number}`,
    pullRequests: (repo) => `${repoPath(repo)}/pulls`,
    pullRequest: (repo, number) => `${repoPath(repo)}/pull/${number}`,
    pullRequestChecks: (repo, number) => `${repoPath(repo)}/pull/${number}/checks`,
    pullRequestFiles: (repo, number) => `${repoPath(repo)}/pull/${number}/files`,
    commit: (repo, sha) => `${repoPath(repo)}/commit/${sha}`,
    /** Returns `candidate` when it is a safe https URL on the web origin, else `fallback`. */
    safe(candidate, fallback) {
      if (typeof candidate !== 'string') return fallback;
      try {
        const url = new URL(candidate);
        if (url.protocol === 'https:' && url.origin === origin && !url.username && !url.password) return url.href;
      } catch {
        // fall through
      }
      return fallback;
    }
  };
}

module.exports = { createUrlBuilder };
