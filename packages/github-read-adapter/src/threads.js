'use strict';

const { MalformedPayloadError } = require('./models');

/**
 * Review thread resolution exists only in the GraphQL API. The document is a fixed
 * constant (never built from input) and contains no mutation.
 */
const REVIEW_THREADS_QUERY = `query ReviewThreads($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      reviewDecision
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: 1) {
            totalCount
            nodes { author { login } body createdAt url }
          }
        }
      }
    }
  }
}`;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeThread(raw, urls) {
  if (!isObject(raw) || typeof raw.id !== 'string' || typeof raw.isResolved !== 'boolean') {
    throw new MalformedPayloadError('reviewThread');
  }
  const comments = isObject(raw.comments) ? raw.comments : {};
  const first = Array.isArray(comments.nodes) && isObject(comments.nodes[0]) ? comments.nodes[0] : null;
  return {
    id: raw.id,
    isResolved: raw.isResolved,
    isOutdated: raw.isOutdated === true,
    path: typeof raw.path === 'string' ? raw.path : null,
    line: Number.isSafeInteger(raw.line) ? raw.line : null,
    commentCount: Number.isSafeInteger(comments.totalCount) ? comments.totalCount : 0,
    firstComment: first
      ? {
          author: isObject(first.author) && typeof first.author.login === 'string' ? first.author.login : null,
          body: typeof first.body === 'string' ? first.body : '',
          createdAt: typeof first.createdAt === 'string' ? first.createdAt : null,
          url: urls.safe(first.url, null)
        }
      : null
  };
}

/** @returns {{ pullRequest: object }} the pullRequest node, or throws MalformedPayloadError */
function readPullRequestNode(data) {
  if (!isObject(data) || !isObject(data.repository)) throw new MalformedPayloadError('repository');
  const node = data.repository.pullRequest;
  if (node === null) return null;
  if (!isObject(node) || !isObject(node.reviewThreads) || !Array.isArray(node.reviewThreads.nodes)) {
    throw new MalformedPayloadError('pullRequest.reviewThreads');
  }
  return node;
}

module.exports = { REVIEW_THREADS_QUERY, normalizeThread, readPullRequestNode };
