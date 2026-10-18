'use strict';

// A write to GitHub (a comment or a review) can end three ways, and only one of them is safe to
// retry. 'refused': GitHub definitely rejected it before creating anything. 'done': it replied that
// it was created and the reply matches what was sent. 'unknown': it may have been created (a server
// error, a timeout, or a success reply that does not match). Treating 'unknown' as 'refused' would
// clear the guard against sending the same text again and could post it twice.
const DEFINITE_REFUSALS = new Set([400, 401, 403, 404, 409, 410, 422, 429]);

/** @param {{ ok: boolean, status: number }} response  @param {boolean} verified the success reply matched what was sent */
function classifyWrite(response, verified) {
  if (response.ok) return verified ? 'done' : 'unknown';
  return DEFINITE_REFUSALS.has(response.status) ? 'refused' : 'unknown';
}

module.exports = { classifyWrite };
