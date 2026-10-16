'use strict';

// A read-only report for one Issue or pull request, built from what the GitHub read adapter returned.
// It is plain text for a person to read in the editor. Nothing here writes to GitHub, decides anything
// or claims that something was verified that was not: a read that failed or came back incomplete is
// said to be unknown, a review verdict is tied to the head commit it was written for, and a list of
// what has not been verified is always part of the report.

const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const HEAD = /head\s*[`'"]?([0-9a-f]{7,40})[`'"]?/i;
const VERDICT = /(?:結論[：:]\s*|verdict[：:]\s*)?(Needs changes|Pass)\b/i;

// Text that came from GitHub is shown as plain lines: control, bidirectional and separator characters are
// removed (newlines inside a body are kept by `block`), and every field has a length limit.
const line = (value, limit = 200) => {
  const text = typeof value === 'string' ? value.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim() : '';
  return Array.from(text).slice(0, limit).join('');
};
const block = (value, limit) => {
  if (typeof value !== 'string' || value.trim() === '') return '(none)';
  const cleaned = value.replace(/\r\n?/g, '\n').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (char) => (char === '\n' ? '\n' : ' '));
  const chars = Array.from(cleaned);
  return chars.length > limit ? `${chars.slice(0, limit).join('')}\n… (${chars.length - limit} more characters not shown)` : cleaned;
};

const WHAT_IS_NOT_VERIFIED = Object.freeze([
  'This report is read-only. Nothing in it was approved, merged or changed by you or by this extension.',
  'A PM report written for this item is not generated here yet; the comments below are shown as they are on GitHub.',
  'GitHub comments from the same GitHub account as the author are technical comments, not a formal approval.',
  'The look and usability of this screen have not been confirmed on a real macOS or Windows machine.'
]);

const complete = (result) => Boolean(result) && (result.kind === 'ok' || result.kind === 'empty');
const dataOf = (result) => (complete(result) && Array.isArray(result.data) ? result.data : null);
const readNote = (what, result) => {
  if (complete(result)) return null;
  const kind = result && typeof result.kind === 'string' ? result.kind : 'not read';
  return `${what}: unknown (${line(kind, 30)}). It could not be read completely, so nothing is concluded from it.`;
};

/** A review verdict written in a comment, tied to the head commit it names. */
function parseConclusion(body, currentHead) {
  if (typeof body !== 'string') return null;
  const first = body.slice(0, 600);
  const verdict = VERDICT.exec(first);
  if (!verdict) return null;
  const head = HEAD.exec(first);
  let applies = 'head-not-stated';
  if (head && typeof currentHead === 'string' && currentHead !== '') applies = currentHead.toLowerCase().startsWith(head[1].toLowerCase()) ? 'current-head' : 'older-head';
  return { verdict: /^needs/i.test(verdict[1]) ? 'Needs changes' : 'Pass', head: head ? head[1].toLowerCase() : null, applies };
}

const APPLIES = Object.freeze({
  'current-head': 'applies to the current head',
  'older-head': 'was written for an OLDER head: it does not cover the current one',
  'head-not-stated': 'does not say which head it covers'
});

function commentLines(comments, currentHead, { max = 8, limit = 1200 } = {}) {
  const items = dataOf(comments);
  if (items === null) return [];
  const lines = [];
  const shown = items.slice(-max);
  if (items.length > shown.length) lines.push(`(${items.length - shown.length} earlier comments are not shown)`);
  for (const item of shown) {
    if (!item || typeof item !== 'object') continue;
    const conclusion = currentHead ? parseConclusion(item.body, currentHead) : null;
    lines.push(`- ${line(item.author ?? 'unknown', 60)}${item.createdAt ? ` · ${line(item.createdAt, 30)}` : ''}${conclusion ? ` · verdict "${conclusion.verdict}" ${APPLIES[conclusion.applies]}` : ''}`);
    lines.push(`  ${block(item.body, limit).split('\n').join('\n  ')}`);
  }
  return lines;
}

function header(kind, repository, item) {
  return [
    `${kind} #${item.number}: ${line(item.title, 300) || '(no title)'}`,
    `Repository: ${line(repository, 120)} · State: ${line(item.state, 30)}${item.merged ? ' (merged)' : ''}${item.draft ? ' (draft)' : ''}`,
    `Author: ${line(item.author ?? 'unknown', 80)} · Updated: ${line(item.updatedAt ?? 'unknown', 40)}`
  ];
}

/**
 * @param {{ repository: string, issue: object, comments?: object, pullRequests?: object }} input
 *   `comments` and `pullRequests` are adapter results; `pullRequests` is the list of open pull requests
 */
function buildIssueReport({ repository, issue, comments, pullRequests }) {
  const lines = [...header('Issue', repository, issue)];
  lines.push(`Labels: ${(Array.isArray(issue.labels) ? issue.labels : []).map((name) => line(name, 60)).join(', ') || '(none)'}`);
  lines.push(`Assigned to: ${(Array.isArray(issue.assignees) ? issue.assignees : []).map((name) => line(name, 60)).join(', ') || '(nobody)'}`);
  lines.push('', 'REQUIREMENT AND SCOPE', block(issue.body, 20000));
  lines.push('', 'RELATED PULL REQUESTS');
  const prs = dataOf(pullRequests);
  if (prs === null) lines.push(readNote('Pull request list', pullRequests) ?? 'unknown');
  else {
    const related = prs.filter((pr) => Array.isArray(pr.referencedIssues) && pr.referencedIssues.some((ref) => ref && ref.number === issue.number));
    if (related.length === 0) lines.push('No open pull request refers to this Issue.');
    for (const pr of related) lines.push(`- #${pr.number} ${line(pr.title, 160)} (${pr.draft ? 'draft' : 'open'}, branch ${line(pr.headRef ?? 'unknown', 80)})`);
  }
  lines.push('', 'DISCUSSION AND PM COMMENTS');
  const notes = readNote('Comments', comments);
  if (notes) lines.push(notes);
  else if ((dataOf(comments) ?? []).length === 0) lines.push('No comments.');
  else lines.push(...commentLines(comments, null));
  lines.push('', 'DECISIONS', 'None can be made here yet. This slice only reads.');
  lines.push('', 'NOT VERIFIED', ...WHAT_IS_NOT_VERIFIED.map((text) => `- ${text}`));
  return { title: `Issue #${issue.number}`, lines };
}

/**
 * @param {{ repository: string, pullRequest: object, snapshot?: object, reviews?: object, comments?: object }} input
 */
function buildPullRequestReport({ repository, pullRequest, snapshot, reviews, comments }) {
  const pr = pullRequest;
  const head = typeof pr.headSha === 'string' ? pr.headSha : null;
  const lines = [...header('Pull request', repository, pr)];
  lines.push(`Branch: ${line(pr.headRef ?? 'unknown', 100)} → ${line(pr.baseRef ?? 'unknown', 60)}`);
  lines.push(`Latest head: ${head ? head.slice(0, 12) : 'unknown'}`);
  const referenced = Array.isArray(pr.referencedIssues) ? pr.referencedIssues.filter((ref) => ref && Number.isSafeInteger(ref.number)) : [];
  lines.push(`Refers to: ${referenced.length ? referenced.map((ref) => `Issue #${ref.number}`).join(', ') : '(no Issue reference found)'}`);
  lines.push('', 'WHAT THIS CHANGES (author\'s description)', block(pr.body, 20000));

  lines.push('', 'REVIEW AND CI (for the latest head)');
  if (!snapshot || snapshot.status !== 'complete') lines.push(`Review and CI: unknown (${line(snapshot && snapshot.status ? snapshot.status : 'not read', 30)}). The read was not complete, so nothing is concluded.`);
  else {
    const approval = snapshot.approval;
    lines.push(`Formal approval on the latest head: ${approval && typeof approval.status === 'string' ? line(approval.status, 40) : 'unknown'}${approval && approval.reason ? ` (${line(approval.reason, 60)})` : ''}`);
    const checks = snapshot.checksSummary;
    if (checks && typeof checks.state === 'string' && checks.headSha && head && String(checks.headSha).toLowerCase() === head.toLowerCase()) {
      lines.push(`CI for this head: ${line(checks.state, 20)} (required: ${line(checks.requiredState ?? 'unknown', 30)})`);
      const failing = Array.isArray(checks.failing) ? checks.failing.slice(0, 10).map((name) => line(name, 60)) : [];
      if (failing.length > 0) lines.push(`Failing: ${failing.join(', ')}`);
    } else lines.push('CI for this head: unknown (the checks read do not belong to the latest head, or could not be read).');
    lines.push(`Unresolved review threads: ${Number.isSafeInteger(snapshot.unresolvedThreads) ? snapshot.unresolvedThreads : 'unknown'}`);
  }
  lines.push('', 'REVIEWS ON GITHUB');
  const reviewNote = readNote('Reviews', reviews);
  const reviewItems = dataOf(reviews);
  if (reviewNote) lines.push(reviewNote);
  else if (reviewItems.length === 0) lines.push('No formal reviews.');
  else for (const review of reviewItems.slice(-8)) {
    const sameHead = head && typeof review.commitId === 'string' ? (review.commitId.toLowerCase() === head.toLowerCase() ? 'on the latest head' : 'on an OLDER head') : 'head unknown';
    lines.push(`- ${line(review.reviewer ?? review.author ?? 'unknown', 60)} · ${line(review.state, 30)} · ${sameHead}${review.body ? `\n  ${block(review.body, 600).split('\n').join('\n  ')}` : ''}`);
  }
  lines.push('', 'PM AND REVIEWER COMMENTS');
  const commentNote = readNote('Comments', comments);
  if (commentNote) lines.push(commentNote);
  else if ((dataOf(comments) ?? []).length === 0) lines.push('No comments.');
  else lines.push(...commentLines(comments, head));
  lines.push('', 'DECISIONS', 'None can be made here yet. This slice only reads; it cannot approve, request changes or merge.');
  lines.push('', 'NOT VERIFIED', ...WHAT_IS_NOT_VERIFIED.map((text) => `- ${text}`));
  return { title: `Pull request #${pr.number}`, lines };
}

/** The report as one text. A report for one item never mentions another. */
const render = (report) => `${report.lines.join('\n')}\n`;

/** Next and previous in a list, wrapping around; an item that is not in the list starts from the first. */
function neighbour(numbers, current, step) {
  if (!Array.isArray(numbers) || numbers.length === 0) return null;
  const at = numbers.indexOf(current);
  if (at < 0) return numbers[step > 0 ? 0 : numbers.length - 1];
  return numbers[(at + step + numbers.length) % numbers.length];
}

module.exports = { buildIssueReport, buildPullRequestReport, parseConclusion, neighbour, render, line, WHAT_IS_NOT_VERIFIED, APPLIES };
