'use strict';

/**
 * What the Issue and pull request page shows (#353), built from what the GitHub read adapter returned. Pure: no VS Code, no network.
 * Every text from GitHub is either a short single line (`line`) or a Markdown tree (`markdown.js`); who wrote each post is the
 * extension's own badge (`authorOf`, #342/#346), kept apart from the post's content so the content cannot make one. Links are indexes
 * into `links`, the addresses this module checked; the page opens one only by asking the extension with its index.
 */

const { parseMarkdown } = require('./markdown');
const { authorOf } = require('./authorship');
const { line } = require('./report');

const MAX_POSTS = 300;
const MAX_FILES = 300;
const ID = (value) => Number.isSafeInteger(value) && value > 0;
const complete = (result) => Boolean(result) && (result.kind === 'empty' || (result.kind === 'ok' && Array.isArray(result.data)));
const listOf = (result) => (complete(result) ? (result.kind === 'empty' ? [] : result.data) : null);
const when = (value) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null);
const unread = (what, result) => `${what}: unknown (${line(result && result.kind ? result.kind : 'not read', 30)}). It could not be read completely, so it is not shown.`;

const REVIEW_STATES = Object.freeze({ APPROVED: 'approved', CHANGES_REQUESTED: 'requested changes', COMMENTED: 'commented', DISMISSED: 'dismissed' });

function badge(item, kind, ownerPosts) {
  const author = authorOf(item, kind, ownerPosts);
  return { who: author.who, text: author.text };
}

/**
 * @param {{ repository: string, kind: 'issue' | 'pullRequest', item: object, comments?: object, reviews?: object,
 *   reviewComments?: object, files?: object, shownFiles?: Array<{ filename: string, path: string | null, status: string, additions?: number | null, deletions?: number | null }>,
 *   summary?: { ci: string, approval: string } | null,
 *   ownerPosts?: { comments: Map<number, string>, reviews: Map<number, string> } | null }} input
 */
function buildPageModel(input) {
  const { repository, kind, item } = input;
  const links = [];
  const base = `https://github.com/${repository}/${kind === 'issue' ? 'issues' : 'pull'}/${item.number}`;
  const markdown = (text) => parseMarkdown(text, { base, links });
  const ownerPosts = input.ownerPosts === undefined ? null : input.ownerPosts;
  const notes = [];

  const posts = [];
  const comments = listOf(input.comments);
  if (comments === null) notes.push(unread('Comments', input.comments));
  for (const comment of comments ?? []) {
    if (!comment || !ID(comment.id)) continue;
    posts.push({ id: comment.id, kind: 'comment', badge: badge(comment, 'comment', ownerPosts), login: line(comment.author ?? 'unknown', 60), at: when(comment.createdAt), review: null, body: markdown(comment.body) });
  }
  let pr = null;
  if (kind === 'pullRequest') {
    const reviews = listOf(input.reviews);
    if (reviews === null) notes.push(unread('Reviews', input.reviews));
    for (const review of reviews ?? []) {
      if (!review || !ID(review.id) || review.state === 'PENDING') continue;
      // A review with no text is still shown: its state is what it says.
      posts.push({ id: review.id, kind: 'review', badge: badge(review, 'review', ownerPosts), login: line(review.reviewer ?? 'unknown', 60), at: when(review.submittedAt), review: REVIEW_STATES[review.state] ?? 'unknown', commit: typeof review.commitId === 'string' ? review.commitId.slice(0, 12) : null, body: markdown(review.body ?? '') });
    }
    // The files are the ones the text report lists (`shownFiles`): only for a head that was verified, each with a name of its own,
    // which is how the file's diff is found.
    const filesRead = listOf(input.files);
    const shown = Array.isArray(input.shownFiles) ? input.shownFiles : [];
    const files = shown.slice(0, MAX_FILES).map((file) => ({
      filename: line(file.filename, 300), path: typeof file.path === 'string' ? file.path : null, status: line(file.status, 20),
      additions: Number.isSafeInteger(file.additions) ? file.additions : null, deletions: Number.isSafeInteger(file.deletions) ? file.deletions : null
    }));
    if (filesRead === null) notes.push(unread('Changed files', input.files));
    else if (filesRead.length > 0 && shown.length === 0) notes.push('Changed files: unknown for this head (the head changed while they were read, or its version could not be verified). Refresh to read them again.');
    if (shown.length > MAX_FILES) notes.push(`Changed files: ${shown.length - MAX_FILES} more are not listed.`);
    const names = new Map(files.flatMap((file, index) => (file.path !== null ? [[file.path, index]] : [])));
    const inline = [];
    const reviewComments = listOf(input.reviewComments);
    if (reviewComments === null) notes.push(unread('Review comments on lines', input.reviewComments));
    for (const comment of reviewComments ?? []) {
      if (!comment || !ID(comment.id)) continue;
      const path = typeof comment.path === 'string' ? line(comment.path, 300) : null;
      inline.push({
        id: comment.id, badge: badge(comment, 'inline', ownerPosts), login: line(comment.author ?? 'unknown', 60), at: when(comment.createdAt),
        path, line: Number.isSafeInteger(comment.line) && comment.line > 0 ? comment.line : null,
        // A comment can be opened at its line only when its file is one of the files listed here.
        file: path !== null && names.has(path) ? names.get(path) : null,
        body: markdown(comment.body)
      });
    }
    pr = {
      headSha: typeof item.headSha === 'string' ? item.headSha.slice(0, 40) : null,
      headRef: line(item.headRef ?? '', 120) || null,
      baseRef: line(item.baseRef ?? '', 120) || null,
      ci: line(input.summary && input.summary.ci ? input.summary.ci : 'unknown', 20),
      approval: line(input.summary && input.summary.approval ? input.summary.approval : 'unknown', 40),
      files,
      inline: inline.slice(0, MAX_POSTS)
    };
  }
  posts.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '') || a.id - b.id);
  if (posts.length > MAX_POSTS) notes.push(`${posts.length - MAX_POSTS} older posts are not shown.`);

  const state = kind === 'pullRequest' && item.merged ? 'merged' : kind === 'pullRequest' && item.draft && item.state === 'open' ? 'draft' : item.state === 'closed' ? 'closed' : 'open';
  return {
    kind,
    number: item.number,
    title: line(item.title, 300) || '(no title)',
    state,
    stateReason: kind === 'issue' && typeof item.stateReason === 'string' ? line(item.stateReason, 30) : null,
    labels: Array.isArray(item.labels) ? item.labels.filter((label) => typeof label === 'string').slice(0, 30).map((label) => line(label, 60)) : [],
    author: { badge: badge(item, 'inline', ownerPosts), login: line(item.author ?? 'unknown', 60), at: when(item.createdAt) },
    body: markdown(item.body),
    posts: posts.slice(-MAX_POSTS),
    pr,
    notes,
    // How the comments were read ('ok', 'rate_limited', …): when to read again depends on it.
    commentsRead: input.comments && typeof input.comments.kind === 'string' ? line(input.comments.kind, 30) : 'not read',
    links
  };
}

module.exports = { buildPageModel, MAX_POSTS, MAX_FILES };
