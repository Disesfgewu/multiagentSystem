'use strict';

const { repositoryKey } = require('./validate');

const CLOSING = new Set(['close', 'closes', 'closed', 'fix', 'fixes', 'fixed', 'resolve', 'resolves', 'resolved']);
const REFERENCE_PATTERN =
  /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?|references?)[:\s]+((?:[\w.-]+\/[\w.-]+)?)#(\d{1,9})\b/gi;

function stripCode(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
}

/**
 * Finds issue references declared in a PR description ("Refs #15", "Closes #3").
 * This is the *declared* link in text, not a link GitHub has verified, and it only
 * reports references to the same repository.
 *
 * @returns {{ number: number, closes: boolean }[]} sorted by issue number
 */
function extractIssueReferences(text, repo) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const own = repositoryKey(repo);
  const found = new Map();
  const source = stripCode(text);
  for (const match of source.matchAll(REFERENCE_PATTERN)) {
    const qualifier = match[2];
    if (qualifier && qualifier.toLowerCase() !== own) continue;
    const number = Number.parseInt(match[3], 10);
    if (number < 1) continue;
    const closes = CLOSING.has(match[1].toLowerCase());
    found.set(number, found.get(number) || closes);
  }
  return [...found.entries()].sort((a, b) => a[0] - b[0]).map(([number, closes]) => ({ number, closes }));
}

module.exports = { extractIssueReferences };
