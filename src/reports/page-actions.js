'use strict';

/**
 * Which decisions the Issue and pull request page (#383) offers, and why one is off. Pure: no VS Code, no network.
 *
 * The page shows Approve, Request changes, Merge and Delete branch on a pull request, and Close as completed and Close as not planned
 * on an Issue. Each is on only when the existing checks say it can be done now: the workspace is trusted, a publisher is set for the
 * repository, no earlier attempt has an unknown outcome, and for a pull request the publication policy (review) or the merge
 * assessment (merge) of the snapshot the page was read from allows it. Every input that could not be read turns the button off with
 * "unknown"; nothing is guessed. Clicking still goes through the extension's own function with its confirmation and every check again.
 */

const ACTIONS = Object.freeze({
  pullRequest: Object.freeze(['approve', 'requestChanges', 'merge', 'deleteBranch']),
  issue: Object.freeze(['closeCompleted', 'closeNotPlanned'])
});

// The reason codes of the existing checks, in plain words. A code not listed here is shown as it is, after "Not available".
const WORDS = Object.freeze({
  'no-writer': 'Writing to GitHub is not available in this window.',
  untrusted: 'Trust this workspace first; until then this page only reads.',
  unknown: 'unknown: what this needs could not be read, so it stays off. Refresh to read it again.',
  'publisher-not-configured': 'No GitHub account is set to publish for this repository yet (command: Configure PM Publisher).',
  'outcome-unknown': 'The result of the last attempt is unknown. Open the text report and check GitHub before trying again.',
  'github-sign-in-required': 'Sign in to GitHub in VS Code first.',
  'version-unknown': 'unknown: the head this page shows could not be verified. Refresh to read it again.',
  'human-merge-required': 'Merge authority is "Human only": merge it on GitHub yourself, or change it (command: Configure Merge Authority).',
  'merge-authority-invalid': 'unknown: the merge authority setting could not be read.',
  'pr-not-open': 'The pull request is already merged or closed.',
  'pr-draft': 'The pull request is a draft.',
  'pr-not-merged': 'Only the branch of a merged pull request can be deleted.',
  'issue-not-open': 'The Issue is already closed.',
  'self-review-forbidden': 'The publishing account opened this pull request; it cannot review or merge its own.',
  'github-identities-not-separated': 'The publishing account opened this pull request; it cannot review or merge its own.',
  'pm-identity-mismatch': 'The publishing account is not the PM account set for this repository.',
  'pm-github-identity-unverified': 'unknown: the publishing account could not be verified.',
  'identity-unverified': 'unknown: the publishing account could not be verified.',
  'merge-conflict': 'The pull request has merge conflicts.',
  'mergeability-unknown': 'unknown: GitHub has not said yet whether it can be merged. Refresh in a moment.',
  'approval-required': 'It needs your approval on this head first.',
  'current-pm-approval-required': 'It needs your approval on this head first.',
  'approval-stale': 'The approval is for an older head; approve this head first.',
  'approval-unknown': 'unknown: the reviews could not be read.',
  'changes-requested': 'Changes were requested and not yet approved again.',
  'self-approval-forbidden': 'Only the author approved it; it needs an approval from someone else.',
  'ci-failing': 'Checks failed on this head.',
  'ci-pending': 'Checks are still running on this head.',
  'ci-missing': 'No checks reported on this head.',
  'ci-stale': 'The checks are for an older head.',
  'ci-unknown': 'unknown: the checks could not be read.',
  'threads-unresolved': 'There are unresolved review threads.',
  'threads-stale': 'unknown: the review threads were read for an older head.',
  'threads-unknown': 'unknown: the review threads could not be read.',
  'branch-rules-unsupported': 'The base branch has rules that cannot be checked from here; merge it on GitHub.',
  'branch-rules-unknown': 'unknown: the branch rules could not be read.',
  'head-unverified': 'unknown: the head could not be verified.',
  'snapshot-incomplete': 'unknown: the pull request could not be read completely.',
  'snapshot-inconsistent': 'unknown: the pull request changed while it was read. Refresh.',
  'pr-unverified': 'unknown: the pull request could not be verified.',
  'pr-mismatch': 'unknown: the pull request could not be verified.'
});
const CODE = /^[a-z][a-z0-9-]{0,60}$/;

function reasonText(code) {
  if (typeof code === 'string' && Object.hasOwn(WORDS, code)) return WORDS[code];
  return `Not available (${typeof code === 'string' && CODE.test(code) ? code : 'unknown'}).`;
}

const on = () => ({ ok: true, reason: null });
const off = (code) => ({ ok: false, code, reason: reasonText(code) });
// A check result is { ok, reason }; anything else is unknown.
const verdict = (value) => (value && typeof value === 'object' && typeof value.ok === 'boolean' ? value : null);

/**
 * @param {{ kind: 'issue' | 'pullRequest', writer: boolean, trusted: boolean, version: boolean,
 *   facts: null | { publisher: 'configured' | 'none' | 'unreadable', pending: Record<string, 'clear' | 'unknown' | 'unreadable'>,
 *     state: string, authority?: 'human' | 'pm' | 'unreadable', review?: { ok: boolean, reason?: string } | null,
 *     merge?: { ok: boolean, reason?: string } | null } }} input
 * @returns {Record<string, { ok: boolean, code?: string, reason: string | null }>}
 */
function abilitiesFor(input) {
  const kind = input && input.kind === 'issue' ? 'issue' : 'pullRequest';
  const result = {};
  for (const action of ACTIONS[kind]) result[action] = decide(action, input || {});
  return result;
}

function decide(action, input) {
  if (input.writer !== true) return off('no-writer');
  if (input.trusted !== true) return off('untrusted');
  const facts = input.facts && typeof input.facts === 'object' ? input.facts : null;
  if (!facts) return off('unknown');
  if (facts.publisher === 'none') return off('publisher-not-configured');
  if (facts.publisher !== 'configured') return off('unknown');
  // Each action has its own record of earlier attempts: an unknown outcome blocks only that action.
  const record = { approve: 'review', requestChanges: 'review', merge: 'merge', deleteBranch: 'branch', closeCompleted: 'close', closeNotPlanned: 'close' }[action];
  const pending = facts.pending && typeof facts.pending === 'object' ? facts.pending[record] : undefined;
  if (pending === 'unknown') return off('outcome-unknown');
  if (pending !== 'clear') return off('unknown');
  if (input.version !== true) return off('version-unknown');
  if (action === 'closeCompleted' || action === 'closeNotPlanned') return facts.state === 'open' ? on() : facts.state === 'closed' ? off('issue-not-open') : off('unknown');
  if (action === 'deleteBranch') return facts.state === 'merged' ? on() : ['open', 'draft', 'closed'].includes(facts.state) ? off('pr-not-merged') : off('unknown');
  if (facts.state === 'merged' || facts.state === 'closed') return off('pr-not-open');
  if (facts.state !== 'open' && facts.state !== 'draft') return off('unknown');
  if (action === 'merge') {
    if (facts.authority === 'human') return off('human-merge-required');
    if (facts.authority !== 'pm') return off('unknown');
    const merge = verdict(facts.merge);
    return !merge ? off('unknown') : merge.ok ? on() : off(merge.reason);
  }
  const review = verdict(facts.review);
  return !review ? off('unknown') : review.ok ? on() : off(review.reason);
}

module.exports = { ACTIONS, WORDS, abilitiesFor, reasonText };
