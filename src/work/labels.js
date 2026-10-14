'use strict';

// What is shown on GitHub about an issue's state is only a neutral status label. Which local
// agent holds the issue, its session, worktree and branch stay on this machine, so nothing
// about them can be derived from here, and nothing here accepts them.

const LABEL = /^[a-z0-9][a-z0-9 _-]{0,49}$/;
const DEFAULT_LABELS = Object.freeze({ ready: 'ready', claimed: 'in-progress', blocked: 'blocked' });

// Validates the label names the repository uses, and refuses names that could carry local detail.
function normalizeLabels(input) {
  const labels = { ...DEFAULT_LABELS, ...(input || {}) };
  const names = Object.values(labels);
  for (const key of Object.keys(DEFAULT_LABELS)) {
    if (typeof labels[key] !== 'string' || !LABEL.test(labels[key])) throw new TypeError(`label for ${key} is not a plain status label`);
  }
  if (new Set(names).size !== names.length) throw new TypeError('status labels must be distinct');
  return Object.freeze(labels);
}

// The label that shows a state, or null when GitHub itself shows it (merged, closed).
function publicLabelFor(state, labels = DEFAULT_LABELS) {
  switch (state) {
    case 'ready':
      return labels.ready;
    case 'blocked':
      return labels.blocked;
    case 'claimed':
    case 'in_progress':
    case 'pr_open':
    case 'review_pending':
    case 'changes_requested':
    case 'worker_updates':
    case 'pm_passed':
    case 'ready_to_merge':
      return labels.claimed;
    default:
      return null;
  }
}

// The only fields of a link that may leave the machine.
function publicProjection(link, labels = DEFAULT_LABELS) {
  return { repo: link.repoId, issueNumber: link.issueNumber, label: publicLabelFor(link.state, labels) };
}

module.exports = { DEFAULT_LABELS, normalizeLabels, publicLabelFor, publicProjection };
