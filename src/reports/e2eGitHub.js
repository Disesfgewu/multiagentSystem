'use strict';

/**
 * A synthetic GitHub for the end-to-end run (#361, #353): the run has no network, so the Issue and pull request pages read a fixed
 * file instead. It is used only when VS Code runs this folder as a development extension AND MULTIAGENT_E2E_GITHUB names the file,
 * as the end-to-end run does. An installed extension runs in Production mode, where nothing (no setting, no argument, no environment
 * variable) makes it read anything but GitHub. It only reads: the reader has the same read calls as the real one and nothing else.
 */

const { DEVELOPMENT } = require('../setup/firstUse');

// owner/name, neither part only dots.
const REPOSITORY = /^(?!\.+\/)[A-Za-z0-9_.-]{1,100}\/(?!\.+$)[A-Za-z0-9_.-]{1,100}$/;
const MAX_BYTES = 1024 * 1024;

/** The fixture to read, or null: only in development mode, only from the named file, only when it has the expected shape. */
function e2eGitHubFixture(mode, env, fs = require('node:fs')) {
  if (mode !== DEVELOPMENT || !env || typeof env.MULTIAGENT_E2E_GITHUB !== 'string' || env.MULTIAGENT_E2E_GITHUB === '') return null;
  try {
    if (fs.statSync(env.MULTIAGENT_E2E_GITHUB).size > MAX_BYTES) return null;
    const fixture = JSON.parse(fs.readFileSync(env.MULTIAGENT_E2E_GITHUB, 'utf8'));
    if (!fixture || typeof fixture.repository !== 'string' || !REPOSITORY.test(fixture.repository) || !Array.isArray(fixture.issues) || !Array.isArray(fixture.pullRequests)) return null;
    return fixture;
  } catch { return null; }
}

const ok = (data) => ({ kind: 'ok', data });
const missing = { kind: 'not_found' };
const byNumber = (list, number) => list.find((entry) => entry && entry.number === number);

/** A read-only reader over the fixture, with the calls the report lists and pages make. */
function fixtureReader(fixture) {
  const comments = fixture.comments ?? {};
  const reviews = fixture.reviews ?? {};
  const reviewComments = fixture.reviewComments ?? {};
  const files = fixture.files ?? {};
  return {
    listIssues: async ({ state }) => ok(fixture.issues.filter((entry) => entry.state === state)),
    getIssue: async (number) => { const found = byNumber(fixture.issues, number); return found ? ok(found) : missing; },
    getIssueComments: async (number) => ok(comments[String(number)] ?? []),
    listPullRequests: async ({ state }) => ok(fixture.pullRequests.filter((entry) => entry.state === state)),
    getPullRequest: async (number) => { const found = byNumber(fixture.pullRequests, number); return found ? ok(found) : missing; },
    getPullRequestFiles: async (number) => ok(files[String(number)] ?? []),
    getPullRequestSnapshot: async (number) => { const found = byNumber(fixture.pullRequests, number); return found && found.snapshot ? found.snapshot : { status: 'unavailable' }; },
    getReviews: async (number) => ok(reviews[String(number)] ?? []),
    getReviewComments: async (number) => ok(reviewComments[String(number)] ?? [])
  };
}

module.exports = { e2eGitHubFixture, fixtureReader };
