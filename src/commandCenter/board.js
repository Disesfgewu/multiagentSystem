'use strict';

/**
 * The work-order board of the Workbench's Work tab (#397, #355 slice 1): every open Issue of the project in the column of its stage,
 * with the agent on it, its pull request, head, checks, the PM's last verdict and how long it has been in that column. Pure: it is
 * given what was read from GitHub (read only) and the agents' cards, and derives everything; nothing is kept or written anywhere.
 *
 * A verdict is read only from a trusted author (the #241 rule, with #342's authorship): a comment or review by the repository owner's
 * account that is either recorded as the owner's own post, or signed by a PM codename. Anyone can type "結論：Pass"; a worker, an
 * unsigned comment or another account typing it moves nothing. What could not be read is "unknown", never a guess.
 */

const { parseConclusion } = require('../reports/report');
const { authorOf } = require('../reports/authorship');

const COLUMNS = Object.freeze([
  { id: 'backlog', label: '待辦 Backlog' },
  { id: 'ready', label: '可領取 Ready' },
  { id: 'inProgress', label: '進行中 In progress' },
  { id: 'review', label: '待審查 Waiting for review' },
  { id: 'changes', label: '需修改 Needs changes' },
  { id: 'merged', label: '已合併 Merged' }
]);
const MAX_CARDS = 30;
// Which columns keep their cards first when there are more than fit: what needs the owner soonest.
const PRIORITY = Object.freeze(['changes', 'review', 'inProgress', 'ready', 'backlog', 'merged']);
const MERGED_DAYS = 14;
const PM_CODENAME = /^PM-\d{2,4}$/;
const SHA = /^[a-f0-9]{40}$/i;

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const listOf = (result) => (isPlain(result) && (result.kind === 'ok' || result.kind === 'empty') ? (Array.isArray(result.data) ? result.data : []) : null);
const timeOf = (value) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null);
const text = (value, max = 200) => {
  const chars = Array.from(typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim() : '');
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
};

/** How long, in plain words: "5m", "3h", "2d". */
function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${Math.max(minutes, 0)}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/**
 * The newest verdict on a pull request from a trusted author, with the head it names and when it was written; null when there is none.
 * @param {Array<object>} posts comments and reviews of the pull request (body, author, createdAt or submittedAt, id, kind)
 */
function trustedVerdict(posts, { owner, ownerPosts, head }) {
  let newest = null;
  for (const post of Array.isArray(posts) ? posts : []) {
    if (!isPlain(post) || typeof post.body !== 'string') continue;
    // The repository owner's account (#241): everyone else's words are comments, not results.
    if (typeof post.author !== 'string' || typeof owner !== 'string' || owner === '' || post.author.toLowerCase() !== owner.toLowerCase()) continue;
    // That account is shared with the agents (#342): only the owner's own recorded post, or one signed by a PM, is a verdict.
    const author = authorOf(post, post.kind === 'review' ? 'review' : 'comment', ownerPosts ?? null);
    const trusted = author.who === 'owner' || (author.who === 'agent' && PM_CODENAME.test(author.codename ?? ''));
    if (!trusted) continue;
    const conclusion = parseConclusion(post.body, head);
    if (!conclusion) continue;
    const at = timeOf(post.createdAt ?? post.submittedAt);
    if (newest === null || (at ?? -1) > (newest.at ?? -1)) newest = { ...conclusion, at, by: author.who === 'owner' ? '管理者' : author.codename };
  }
  return newest;
}

const CI_WORDS = Object.freeze({ passing: 'checks passed', failing: 'checks failed', pending: 'checks still running', none: 'no checks reported' });

/**
 * @param {{ repository: string, issues: object, pullRequests: object, merged?: object, details?: Record<string, { snapshot?: object, comments?: object, reviews?: object }>,
 *   agents?: Array<{ id: string, codename?: string|null, name?: string, task?: { issue: number|null, pullRequest: number|null } }>, ownerPosts?: object|null, now?: number }} input
 */
function buildBoard(input) {
  const { repository, issues, pullRequests, merged, details = {}, agents = [], ownerPosts = null } = isPlain(input) ? input : {};
  const now = Number.isFinite(input && input.now) ? input.now : Date.now();
  const owner = typeof repository === 'string' ? repository.split('/')[0] : '';
  const limited = [issues, pullRequests, merged, ...Object.values(details).flatMap((entry) => (isPlain(entry) ? [entry.snapshot && entry.snapshot.pullRequest, entry.comments, entry.reviews] : []))]
    .find((result) => isPlain(result) && result.kind === 'rate_limited');
  const issueList = listOf(issues);
  if (issueList === null) {
    const kind = isPlain(issues) && typeof issues.kind === 'string' ? issues.kind : 'not read';
    return { state: 'unavailable', reason: kind === 'rate_limited' ? rateLimitText(issues) : `The Issues could not be read from GitHub (${text(kind, 30)}), so the board is not shown.`, columns: [] };
  }
  const openPrs = listOf(pullRequests);
  const mergedPrs = listOf(merged);
  const notes = [];
  if (limited) notes.push(rateLimitText(limited));
  if (openPrs === null) notes.push('Pull requests: unknown (they could not be read), so no Issue is shown as in review or needing changes.');
  if (mergedPrs === null) notes.push('Merged pull requests: unknown (they could not be read).');

  const agentFor = (issueNumber, prNumber) => (Array.isArray(agents) ? agents : []).find((agent) => isPlain(agent) && isPlain(agent.task) && ((issueNumber !== null && agent.task.issue === issueNumber) || (prNumber !== null && agent.task.pullRequest === prNumber))) ?? null;
  const prFor = (number) => (openPrs ?? []).filter((pr) => isPlain(pr) && Array.isArray(pr.referencedIssues) && pr.referencedIssues.some((ref) => ref && ref.number === number))
    .sort((a, b) => (timeOf(b.updatedAt) ?? 0) - (timeOf(a.updatedAt) ?? 0))[0] ?? null;

  const cards = [];
  for (const issue of issueList) {
    if (!isPlain(issue) || !Number.isSafeInteger(issue.number) || issue.isPullRequest === true) continue;
    const pr = prFor(issue.number);
    const agent = agentFor(issue.number, pr ? pr.number : null);
    const card = { kind: 'issue', number: issue.number, title: text(issue.title, 160) || '(no title)', agent: agent ? { id: agent.id, label: agent.codename || text(agent.name, 60) || 'agent' } : null, pr: null, column: null, since: null, sinceWhat: '' };
    if (pr) card.pr = prFacts(pr, details[String(pr.number)], { owner, ownerPosts });
    placeIssue(card, issue, pr);
    cards.push(card);
  }
  // Merged in the last two weeks: by pull request, with the Issues it closes.
  for (const pr of mergedPrs ?? []) {
    if (!isPlain(pr) || pr.merged !== true || !Number.isSafeInteger(pr.number)) continue;
    const at = timeOf(pr.mergedAt);
    if (at === null || now - at > MERGED_DAYS * 86400000) continue;
    const refs = Array.isArray(pr.referencedIssues) ? pr.referencedIssues.filter((ref) => ref && Number.isSafeInteger(ref.number)).map((ref) => `#${ref.number}`) : [];
    cards.push({ kind: 'pullRequest', number: pr.number, title: text(pr.title, 160) || '(no title)', agent: null, pr: { number: pr.number, head: typeof pr.headSha === 'string' ? pr.headSha.slice(0, 7) : 'unknown', ci: 'merged', verdict: null }, refs, column: 'merged', since: at, sinceWhat: 'merged' });
  }

  // At most 30 cards, the columns that need the owner first; each column says how many it does not list.
  const kept = new Set();
  for (const column of PRIORITY) for (const card of cards.filter((entry) => entry.column === column).sort((a, b) => b.number - a.number)) if (kept.size < MAX_CARDS) kept.add(card);
  const columns = COLUMNS.map(({ id, label }) => {
    const all = cards.filter((card) => card.column === id).sort((a, b) => b.number - a.number);
    const shown = all.filter((card) => kept.has(card)).map((card) => ({
      kind: card.kind, number: card.number, title: card.title, agent: card.agent ? card.agent.label : 'no agent', agentId: card.agent ? card.agent.id : null,
      pr: card.pr, refs: card.refs ?? [],
      inColumn: card.since === null ? 'unknown' : `${card.sinceWhat ? `${card.sinceWhat} ` : ''}${duration(now - card.since)} ago`
    }));
    return { id, label, count: all.length, cards: shown, more: all.length - shown.length };
  });
  return { state: 'ok', columns, notes, total: cards.length };
}

function rateLimitText(result) {
  const reset = isPlain(result) && typeof result.resetAt === 'string' && Number.isFinite(Date.parse(result.resetAt)) ? ` GitHub says it can be read again at ${new Date(result.resetAt).toISOString().replace('T', ' ').slice(0, 16)} UTC.` : '';
  return `GitHub's rate limit was reached, so part of the board could not be read and is shown as unknown.${reset}`;
}

function prFacts(pr, detail, { owner, ownerPosts }) {
  const head = typeof pr.headSha === 'string' && SHA.test(pr.headSha) ? pr.headSha.toLowerCase() : null;
  const snapshot = isPlain(detail) && isPlain(detail.snapshot) ? detail.snapshot : null;
  const ci = snapshot && isPlain(snapshot.checksSummary) && snapshot.checksSummary.headSha === head && Object.hasOwn(CI_WORDS, snapshot.checksSummary.state) ? CI_WORDS[snapshot.checksSummary.state] : 'unknown';
  const comments = isPlain(detail) ? listOf(detail.comments) : null;
  const reviews = isPlain(detail) ? listOf(detail.reviews) : null;
  // Without the comments, a verdict cannot be known: it is unknown, not "none".
  const verdict = comments === null ? 'unknown' : trustedVerdict([...comments.map((item) => ({ ...item, kind: 'comment' })), ...(reviews ?? []).map((item) => ({ ...item, author: item.reviewer ?? item.author, kind: 'review' }))], { owner, ownerPosts, head });
  return { number: pr.number, draft: pr.draft === true, head: head ? head.slice(0, 7) : 'unknown', ci, verdict, createdAt: timeOf(pr.createdAt) };
}

function placeIssue(card, issue, pr) {
  const labels = Array.isArray(issue.labels) ? issue.labels : [];
  if (!pr) {
    card.column = card.agent ? 'inProgress' : labels.includes('ready') ? 'ready' : 'backlog';
    card.since = card.agent ? null : timeOf(issue.createdAt);
    card.sinceWhat = card.agent ? '' : 'opened';
    return;
  }
  const facts = card.pr;
  const verdict = facts.verdict;
  if (verdict === 'unknown') {
    // Its comments could not be read: in review at most, and the verdict is said to be unknown on the card.
    card.column = facts.draft ? 'inProgress' : 'review';
    card.since = null;
  } else if (verdict && verdict.verdict === 'Needs changes') {
    // Needs changes stays the stage until a newer verdict: a new head alone is the author's answer, not the review's.
    card.column = 'changes';
    card.since = verdict.at;
    card.sinceWhat = 'verdict';
  } else if (facts.draft) {
    card.column = 'inProgress';
    card.since = facts.createdAt;
    card.sinceWhat = 'PR opened';
  } else {
    card.column = 'review';
    // Waiting since the PR was opened when nothing was said yet; after an older verdict, the time of the new head is not read.
    card.since = verdict ? null : facts.createdAt;
    card.sinceWhat = verdict ? '' : 'PR opened';
  }
  // What the card says about the verdict: who, which head, and whether it covers the head shown.
  facts.verdict = verdict === 'unknown' ? 'unknown (the comments could not be read)'
    : verdict === null ? 'none yet'
      : `${verdict.verdict} by ${verdict.by}${verdict.head ? ` for head ${verdict.head.slice(0, 7)}` : ''}${verdict.applies === 'current-head' ? (verdict.verdict === 'Pass' ? ' · this head · waiting for merge' : ' · this head') : verdict.applies === 'older-head' ? ' · an older head' : ' · head not stated'}`;
  delete facts.createdAt;
}

module.exports = { buildBoard, trustedVerdict, duration, COLUMNS, MAX_CARDS, MERGED_DAYS };
