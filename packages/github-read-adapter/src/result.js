'use strict';

/**
 * Every read returns a plain object with a `kind`. Callers must branch on it;
 * there is no thrown error for expected remote conditions.
 *
 * Success kinds
 *   ok         data was read completely.
 *   empty      the server confirmed there is nothing (e.g. 200 with []).
 *
 * Kinds that carry data but are NOT a complete answer
 *   partial    some independent sources were unavailable (see `unavailable`).
 *   truncated  pagination stopped at the page limit; `partialData` holds what was read.
 *
 * Failure kinds (no authoritative data)
 *   not_found     404/410. GitHub also answers 404 for resources the credential cannot see.
 *   denied        401/403 without a rate limit signal (bad credentials, SSO, missing permission).
 *   rate_limited  primary or secondary rate limit; `resetAt` / `retryAfterMs` when known.
 *   transient     5xx, timeout or other retryable failure that survived the retry budget.
 *   offline       the transport could not reach the server at all.
 *   cancelled     the caller aborted, or the active repository changed.
 *   invalid       the response or request could not be interpreted (bad JSON, bad link, ...).
 *
 * Failures may carry `lastKnown` ({ data, fetchedAt }) from the in-memory cache. It is for
 * display only ("offline, last synced at ...") and must never be treated as current evidence.
 */
const SUCCESS_KINDS = Object.freeze(['ok', 'empty']);
const FAILURE_KINDS = Object.freeze([
  'not_found',
  'denied',
  'rate_limited',
  'transient',
  'offline',
  'cancelled',
  'invalid'
]);

const INCOMPLETE_KINDS = Object.freeze(['partial', 'truncated']);

/** True only when the answer is complete and authoritative (ok or empty). */
function isSuccess(result) {
  return Boolean(result) && SUCCESS_KINDS.includes(result.kind);
}

function isFailure(result) {
  return Boolean(result) && FAILURE_KINDS.includes(result.kind);
}

// When several reads are combined, report the failure that most needs the user's attention.
const SEVERITY = ['cancelled', 'rate_limited', 'offline', 'denied', 'transient', 'not_found', 'invalid'];

/** @returns the most severe failure among `results`, or undefined when none of them failed. */
function mostSevereFailure(results) {
  let worst;
  for (const result of results) {
    if (!isFailure(result)) continue;
    if (!worst || SEVERITY.indexOf(result.kind) < SEVERITY.indexOf(worst.kind)) worst = result;
  }
  return worst;
}

module.exports = { SUCCESS_KINDS, FAILURE_KINDS, INCOMPLETE_KINDS, isSuccess, isFailure, mostSevereFailure };
