'use strict';

function rollUp(items) {
  if (items.some((item) => item.state === 'failing')) return 'failing';
  if (items.some((item) => item.state === 'pending')) return 'pending';
  return 'passing';
}

/**
 * Rolls check runs and commit statuses up into one verdict for one head commit.
 *
 * `state` covers every reported check: failing > pending > passing, or `none` when the
 * commit reports no checks at all (not the same as passing).
 * `requiredState` covers only the required contexts: `unknown` when the requirements could
 * not be read, `not_required` when none are required, and `pending` while a required
 * context has not reported yet.
 *
 * @param {{ headSha: string, checkRuns: object[], statuses: object[] }} report
 * @param {string[]|null} [requiredContexts] null when the requirements are unknown
 */
function summarizeChecks(report, requiredContexts = null) {
  const items = [...report.checkRuns, ...report.statuses];
  const counts = { passing: 0, failing: 0, pending: 0 };
  for (const item of items) counts[item.state] += 1;

  const state = items.length === 0 ? 'none' : rollUp(items);

  let requiredState;
  let missingRequired = [];
  if (requiredContexts === null) {
    requiredState = 'unknown';
  } else if (requiredContexts.length === 0) {
    requiredState = 'not_required';
  } else {
    const matched = [];
    for (const context of requiredContexts) {
      const reported = items.filter((item) => item.name === context);
      if (reported.length === 0) missingRequired.push(context);
      matched.push(...reported);
    }
    if (matched.some((item) => item.state === 'failing')) requiredState = 'failing';
    else if (missingRequired.length > 0 || matched.some((item) => item.state === 'pending')) requiredState = 'pending';
    else requiredState = 'passing';
  }
  missingRequired = [...new Set(missingRequired)];

  return {
    headSha: report.headSha,
    state,
    requiredState,
    counts,
    failing: items.filter((item) => item.state === 'failing').map((item) => item.name),
    pending: items.filter((item) => item.state === 'pending').map((item) => item.name),
    missingRequired
  };
}

module.exports = { summarizeChecks };
