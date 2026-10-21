'use strict';

// A read-only report for one Issue or pull request, built from what the GitHub read adapter returned.
// It is plain text for a person to read in the editor. Nothing here writes to GitHub, decides anything
// or claims that something was verified that was not: a read that failed or came back incomplete is
// said to be unknown, a review verdict is tied to the head commit it was written for, and a list of
// what has not been verified is always part of the report.

const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const HEAD = /head\s*[`'"]?([0-9a-f]{7,40})[`'"]?/i;
const VERDICT = /(?:結論[：:]\s*|verdict[：:]\s*)?(Needs changes|Pass)\b/i;
const { pmReport, issueEvidenceVersion, FIELDS } = require('./decision-queue');

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

// Text that comes from GitHub is shown indented. Every heading, navigation label and file bullet this
// report generates starts at the first column, so no line of remote text can ever read as one of them
// (and the places that look for them by their exact text can only find the real ones).
const indent = (text, spaces = 2) => String(text).split('\n').map((row) => `${' '.repeat(spaces)}${row}`).join('\n');

const WHAT_IS_NOT_VERIFIED = Object.freeze([
  'This report is read-only. Nothing in it was approved, merged or changed by you or by this extension.',
  'Only an explicitly marked, complete report by the repository owner is shown as a PM report; other comments remain comments.',
  'GitHub comments from the same GitHub account as the author are technical comments, not a formal approval.',
  'The look and usability of this screen have not been confirmed on a real macOS or Windows machine.'
]);

const complete = (result) => Boolean(result) && (result.kind === 'empty' || (result.kind === 'ok' && Array.isArray(result.data)));
const dataOf = (result) => {
  if (!complete(result)) return null;
  if (result.kind === 'empty') return [];
  return Array.isArray(result.data) ? result.data : null;
};
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

function commentLines(comments, currentHead, { limit = 100000, owner = '' } = {}) {
  const items = dataOf(comments);
  if (items === null) return [];
  const lines = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const conclusion = currentHead ? parseConclusion(item.body, currentHead) : null;
    const byOwner = typeof item.author === 'string' && owner !== '' && item.author.toLowerCase() === owner.toLowerCase();
    // Anyone can type "Pass" and a commit id: only the repository owner's words are read as a verdict.
    const verdict = conclusion ? (byOwner ? ` · verdict "${conclusion.verdict}" ${APPLIES[conclusion.applies]}` : ` · says "${conclusion.verdict}" but is not the repository owner, so this is not a review result`) : '';
    lines.push(`- ${line(item.author ?? 'unknown', 60)}${item.createdAt ? ` · ${line(item.createdAt, 30)}` : ''}${verdict}`);
    lines.push(`  ${block(item.body, limit).split('\n').join('\n  ')}`);
  }
  return lines;
}

const STATE_ORDER = Object.freeze({ failing: 0, pending: 1, passing: 2 });
const MAX_CHECKS = 40;
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/;

const validCompletedAt = (value) => {
  if (value === null) return true;
  if (typeof value !== 'string') return false;
  const parts = ISO_INSTANT.exec(value);
  if (!parts) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.getUTCFullYear() === Number(parts[1]) && parsed.getUTCMonth() + 1 === Number(parts[2]) &&
    parsed.getUTCDate() === Number(parts[3]) && parsed.getUTCHours() === Number(parts[4]) && parsed.getUTCMinutes() === Number(parts[5]) &&
    parsed.getUTCSeconds() === Number(parts[6]);
};
const validCheckItem = (item, head) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  if (typeof item.name !== 'string' || item.name.trim() === '' || !Object.hasOwn(STATE_ORDER, item.state)) return false;
  if (!Object.hasOwn(item, 'completedAt') || !validCompletedAt(item.completedAt)) return false;
  if (!(item.headSha === undefined || item.headSha === null || (typeof item.headSha === 'string' && /^[a-f0-9]{40}$/i.test(item.headSha)))) return false;
  return typeof item.headSha !== 'string' || item.headSha.toLowerCase() === head.toLowerCase();
};

/** Each check on the latest head: name, state and when it finished. Missing, partial or foreign data never reads as a pass. */
function checkDetail(snapshot, head) {
  const out = ['CHECKS ON THE LATEST HEAD'];
  if (!snapshot || typeof snapshot !== 'object') return [...out, 'Check details: unknown (not read).'];
  if (snapshot.consistent !== true || typeof snapshot.headSha !== 'string' || !head || snapshot.headSha.toLowerCase() !== head.toLowerCase()) {
    return [...out, 'Check details: unknown (the snapshot was not consistently read from the latest head).'];
  }
  const checks = snapshot.checks;
  if (!checks || typeof checks !== 'object') return [...out, 'Check details: unknown (not read).'];
  if (checks.kind !== 'ok' && checks.kind !== 'empty' && checks.kind !== 'partial') return [...out, `Check details: unknown (${line(checks.kind ?? 'not read', 30)}).`];
  const data = checks.data;
  if (!data || typeof data !== 'object') return [...out, 'Check details: unknown (no data).'];
  if (typeof data.headSha !== 'string' || !head || data.headSha.toLowerCase() !== head.toLowerCase()) {
    return [...out, `Check details: they belong to ${typeof data.headSha === 'string' ? data.headSha.slice(0, 12) : 'an unknown head'}, not the latest head ${head ? head.slice(0, 12) : 'unknown'}, so they are not shown.`];
  }
  // Each source field is either absent (not fetched) or a proper list; anything else is a malformed
  // read and must say so rather than quietly becoming "no checks". Absence of a field is only
  // acceptable for a `partial` read (only one source was fetched) and only when the other one is a
  // real list; `ok`/`empty` claim both sources were read, so both must be present lists.
  const arrayOrAbsent = (value) => value === undefined || value === null || Array.isArray(value);
  if (!arrayOrAbsent(data.checkRuns) || !arrayOrAbsent(data.statuses)) {
    return [...out, 'Check details: unknown (check run or commit status data was not shaped as a list).'];
  }
  const haveRuns = Array.isArray(data.checkRuns);
  const haveStatuses = Array.isArray(data.statuses);
  if (!haveRuns && !haveStatuses) return [...out, 'Check details: unknown (neither source could be read).'];
  if (checks.kind !== 'partial' && !(haveRuns && haveStatuses)) {
    return [...out, 'Check details: unknown (one of the two sources is missing even though the read was reported complete).'];
  }
  const items = [...(haveRuns ? data.checkRuns : []), ...(haveStatuses ? data.statuses : [])];
  if (!items.every((item) => validCheckItem(item, head))) {
    return [...out, 'Check details: unknown (a check item was malformed or belonged to another head).'];
  }
  if (checks.kind === 'partial') out.push('Only one of the two sources (check runs, commit statuses) could be read, so this list may be incomplete.');
  if (items.length === 0) return [...out, checks.kind === 'partial' ? 'No checks in the part that could be read. That is not a pass.' : 'No checks were reported for this head. That is not a pass.'];
  const rank = (item) => STATE_ORDER[item.state];
  const named = items.map((item) => ({ name: line(item.name, 80), state: item.state, done: typeof item.completedAt === 'string' ? line(item.completedAt, 40) : null, rank: rank(item) }));
  named.sort((a, b) => a.rank - b.rank || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const item of named.slice(0, MAX_CHECKS)) out.push(`- ${item.name} · ${item.state} · ${item.state === 'pending' ? 'not finished' : item.done ? `finished ${item.done}` : 'finish time unknown'}`);
  if (named.length > MAX_CHECKS) out.push(`(${named.length - MAX_CHECKS} more checks are not shown)`);
  return out;
}

function header(kind, repository, item) {
  return [
    `${kind} #${item.number}: ${line(item.title, 300) || '(no title)'}`,
    `Repository: ${line(repository, 120)} · State: ${line(item.state, 30)}${item.merged ? ' (merged)' : ''}${item.draft ? ' (draft)' : ''}`,
    `Author: ${line(item.author ?? 'unknown', 80)} · Updated: ${line(item.updatedAt ?? 'unknown', 40)}`
  ];
}

const PM_LABELS = Object.freeze({ operableResult: 'User can', solution: 'Solution', alternatives: 'Alternatives', acceptanceGap: 'Acceptance gap', risks: 'Risks', recommendedAction: 'Recommended action', evidenceTime: 'Evidence time', evidenceVersion: 'Evidence version' });
function pmReportLines(comments, repository, version) {
  const result = pmReport(comments, repository, version);
  if (result.state === 'unknown') return ['PM REPORT', result.reason === 'invalid-pm-report' ? 'Unknown: the newest marked PM report has an invalid format.' : 'Unknown: comments could not be read completely.'];
  if (result.state === 'missing') return ['PM REPORT', 'Pending: no structured PM report was found. Ordinary comments are not a PM report.'];
  return ['PM REPORT', `Declared by repository owner · ${result.state === 'current' ? 'evidence version matches this report' : 'STALE: evidence version does not match this report'}`,
    ...FIELDS.map((key) => `${PM_LABELS[key]}:\n${indent(block(result.fields[key], 2000))}`)];
}

/**
 * @param {{ repository: string, issue: object, comments?: object, pullRequests?: object }} input
 *   `comments` and `pullRequests` are adapter results; `pullRequests` is the list of open pull requests
 */
function buildIssueReport({ repository, issue, comments, pullRequests }) {
  const lines = [...header('Issue', repository, issue), '', 'OPEN DISCUSSION (click to jump)'];
  lines.push(`Labels: ${(Array.isArray(issue.labels) ? issue.labels : []).map((name) => line(name, 60)).join(', ') || '(none)'}`);
  lines.push(`Assigned to: ${(Array.isArray(issue.assignees) ? issue.assignees : []).map((name) => line(name, 60)).join(', ') || '(nobody)'}`);
  lines.push('', 'REQUIREMENT AND SCOPE', indent(block(issue.body, 20000)));
  lines.push('', ...pmReportLines(comments, repository, issueEvidenceVersion(issue)));
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
  lines.push('', 'DECISIONS', 'A private note can be saved locally with Save Local Feedback. Nothing is sent to GitHub.');
  lines.push('', 'NOT VERIFIED', ...WHAT_IS_NOT_VERIFIED.map((text) => `- ${text}`));
  return { title: `Issue #${issue.number}`, lines };
}

/**
 * @param {{ repository: string, pullRequest: object, snapshot?: object, reviews?: object, comments?: object, reviewComments?: object, files?: object, filesHeadVerified?: boolean }} input
 */
function buildPullRequestReport({ repository, pullRequest, snapshot, reviews, comments, reviewComments, files, filesHeadVerified }) {
  const pr = pullRequest;
  const head = typeof pr.headSha === 'string' ? pr.headSha : null;
  const lines = [...header('Pull request', repository, pr), '', 'OPEN CODE CHANGES (click to jump)', 'OPEN DISCUSSION (click to jump)'];
  const headRepository = line(pr.headRepository, 120);
  const source = !headRepository ? 'unknown (head repository was not read)'
    : headRepository.toLowerCase() === String(repository).toLowerCase() ? 'this repository branch' : 'fork / external contributor';
  lines.push(`Source: ${source}`);
  lines.push(`Head repository: ${headRepository || 'unknown'} · Branch: ${line(pr.headRef ?? 'unknown', 100)} → ${line(pr.baseRef ?? 'unknown', 60)}`);
  lines.push(`Latest head: ${head ? line(head, 40) : 'unknown'}`);
  const referenced = Array.isArray(pr.referencedIssues) ? pr.referencedIssues.filter((ref) => ref && Number.isSafeInteger(ref.number)) : [];
  lines.push(`Refers to: ${referenced.length ? referenced.map((ref) => `Issue #${ref.number}`).join(', ') : '(no Issue reference found)'}`);
  lines.push('', 'WHAT THIS CHANGES (author\'s description)', indent(block(pr.body, 20000)));
  lines.push('', ...pmReportLines(comments, repository, head));

  lines.push('', 'CHANGED FILES AND DIFF (plain text preview)');
  const fileNote = readNote('Changed files', files);
  const fileItems = dataOf(files);
  const sameHead = filesHeadVerified === true && snapshot && snapshot.status === 'complete' && snapshot.consistent === true &&
    typeof snapshot.headSha === 'string' && head && snapshot.headSha.toLowerCase() === head.toLowerCase();
  // Exposed to the caller unchanged from what is rendered (same slice, same text), so a "open this
  // file's diff" command shows exactly the patch the reader is looking at, never a different head's.
  let shownFiles = [];
  if (!sameHead) lines.push('Diff for this head: unknown (the head changed during the read, or its version could not be verified).');
  else if (fileNote) lines.push(fileNote);
  else if (fileItems.length === 0) lines.push('No changed files were reported.');
  else {
    lines.push(`${fileItems.length} changed files. Click any filename to open all patch text returned by GitHub; inline preview is shown for the first 12 files.`);
    const displayNames = new Set();
    for (const [index, file] of fileItems.entries()) {
      const baseName = line(file && file.filename, 240) || '(filename unavailable)';
      // Two different files must never share one display name: the name is how its patch is found.
      let name = baseName;
      for (let attempt = 0; displayNames.has(name); attempt += 1) name = `${baseName} [file ${index + 1}${attempt === 0 ? '' : `.${attempt}`}]`;
      displayNames.add(name);
      const status = line(file && file.status, 30) || 'unknown';
      const additions = Number.isSafeInteger(file && file.additions) ? file.additions : 'unknown';
      const deletions = Number.isSafeInteger(file && file.deletions) ? file.deletions : 'unknown';
      lines.push(`- ${name} (${status}; +${additions}/-${deletions})`);
      const patch = file && typeof file.patch === 'string' ? file.patch : null;
      if (index < 12) lines.push(patch !== null ? indent(block(patch, 4000), 4) : '  Patch unavailable (binary file or GitHub omitted it).');
      shownFiles.push({ filename: name, status, patch });
    }
  }

  lines.push('', 'REVIEW AND CI (for the latest head)');
  // The per-check detail below reads only `snapshot.checks` and verifies its own head and shape, so it
  // is shown whenever that field is present, even when the rest of the snapshot (branch requirements,
  // threads, reviews) made the overall read `partial`. One field missing must not hide a different,
  // independently-verifiable field: the OVERALL review/merge conclusion still stays unknown below.
  if (!snapshot || typeof snapshot !== 'object') lines.push('Review and CI: unknown (not read). The read was not complete, so nothing is concluded.');
  else if (snapshot.status !== 'complete') lines.push(`Review and CI: unknown (${line(snapshot.status ?? 'not read', 30)}). The read was not complete, so the overall review/merge conclusion is unknown.`);
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
  lines.push(...checkDetail(snapshot, head));
  lines.push('', 'PR CONVERSATION', '', 'REVIEWS ON GITHUB');
  const reviewNote = readNote('Reviews', reviews);
  const reviewItems = dataOf(reviews);
  if (reviewNote) lines.push(reviewNote);
  else if (reviewItems.length === 0) lines.push('No formal reviews.');
  else for (const review of reviewItems) {
    const sameHead = head && typeof review.commitId === 'string' ? (review.commitId.toLowerCase() === head.toLowerCase() ? 'on the latest head' : 'on an OLDER head') : 'head unknown';
    lines.push(`- ${line(review.reviewer ?? review.author ?? 'unknown', 60)} · ${line(review.state, 30)} · ${sameHead}${review.body ? `\n  ${block(review.body, 100000).split('\n').join('\n  ')}` : ''}`);
  }
  lines.push('', 'PM AND REVIEWER COMMENTS');
  const commentNote = readNote('Comments', comments);
  if (commentNote) lines.push(commentNote);
  else if ((dataOf(comments) ?? []).length === 0) lines.push('No comments.');
  else lines.push(...commentLines(comments, head, { owner: String(repository).split('/')[0] }));
  lines.push('', 'INLINE REVIEW DISCUSSION');
  const inlineNote = readNote('Inline review comments', reviewComments);
  const inlineItems = dataOf(reviewComments);
  if (inlineNote) lines.push(inlineNote);
  else if (inlineItems.length === 0) lines.push('No inline review comments.');
  else for (const item of inlineItems) {
    if (!item || typeof item !== 'object') continue;
    const commit = typeof item.commitId === 'string' && head
      ? item.commitId.toLowerCase() === head.toLowerCase() ? 'on the latest head' : 'on an OLDER head'
      : 'head unknown';
    const location = `${line(item.path ?? 'file unknown', 240)}:${Number.isSafeInteger(item.line) ? item.line : 'line unknown'}`;
    const reply = Number.isSafeInteger(item.inReplyToId) ? ` · reply to #${item.inReplyToId}` : '';
    lines.push(`- ${line(item.author ?? 'unknown', 60)} · ${location} · ${commit}${reply}${item.createdAt ? ` · ${line(item.createdAt, 30)}` : ''}`);
    lines.push(`  ${block(item.body, 100000).split('\n').join('\n  ')}`);
  }
  lines.push('', 'DECISIONS', 'A private note can be saved locally. It cannot approve, request changes or merge; nothing is sent to GitHub.');
  lines.push('', 'NOT VERIFIED', ...WHAT_IS_NOT_VERIFIED.map((text) => `- ${text}`));
  return { title: `Pull request #${pr.number}`, lines, files: shownFiles };
}

/**
 * A few plain facts about one pull request's report, for a screen that shows many of them (the Command Center, issue #309): the PM
 * report's state and its first two fields, the formal approval on the latest head, CI for that head and unresolved threads. Built from
 * the same inputs and the same checks as the full report, so it can never say more than the report does; anything not read or not
 * for the latest head is "unknown".
 * @returns {{ pm: 'current'|'stale'|'missing'|'unknown', userCan: string|null, next: string|null, approval: string, ci: string, unresolved: number|null }}
 */
function summarizePullRequest({ repository, pullRequest, snapshot, comments }) {
  const head = pullRequest && typeof pullRequest.headSha === 'string' ? pullRequest.headSha : null;
  const pm = pmReport(comments, repository, head);
  const complete = snapshot && typeof snapshot === 'object' && snapshot.status === 'complete';
  const approval = complete && snapshot.approval && typeof snapshot.approval.status === 'string' ? line(snapshot.approval.status, 40) : 'unknown';
  const checks = complete ? snapshot.checksSummary : null;
  const ci = checks && typeof checks.state === 'string' && checks.headSha && head && String(checks.headSha).toLowerCase() === head.toLowerCase() ? line(checks.state, 20) : 'unknown';
  return {
    // Without a known head nothing can be called current or stale.
    pm: head && (pm.state === 'current' || pm.state === 'stale' || pm.state === 'missing') ? pm.state : 'unknown',
    userCan: pm.fields ? line(pm.fields.operableResult, 160) || null : null,
    next: pm.fields ? line(pm.fields.recommendedAction, 160) || null : null,
    approval,
    ci,
    unresolved: complete && Number.isSafeInteger(snapshot.unresolvedThreads) ? snapshot.unresolvedThreads : null
  };
}

/** The report as one text. A report for one item never mentions another. */
const render = (report) => `${report.lines.join('\n')}\n`;

// Matches only the exact "- <name> (<status>; +<a>/-<d>)" bullet this module renders for a changed
// file, never a line inside a patch body that happens to look similar (a removed source line can
// start with "- " too). A match is trusted only when its captured name is also one of the files the
// caller already knows this report rendered; anything else is ignored rather than guessed at.
const FILE_BULLET = /^- (.+) \([^()]*\)$/;
function fileBulletLines(lines, filenames) {
  const names = new Set(filenames);
  const found = [];
  lines.forEach((text, lineNumber) => {
    const match = typeof text === 'string' ? FILE_BULLET.exec(text) : null;
    if (match && names.has(match[1])) found.push({ lineNumber, filename: match[1] });
  });
  return found;
}

/** Next and previous in a list, wrapping around; an item that is not in the list starts from the first. */
function neighbour(numbers, current, step) {
  if (!Array.isArray(numbers) || numbers.length === 0) return null;
  const at = numbers.indexOf(current);
  if (at < 0) return numbers[step > 0 ? 0 : numbers.length - 1];
  return numbers[(at + step + numbers.length) % numbers.length];
}

module.exports = { buildIssueReport, buildPullRequestReport, summarizePullRequest, parseConclusion, neighbour, render, line, WHAT_IS_NOT_VERIFIED, APPLIES, fileBulletLines };
