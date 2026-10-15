'use strict';

// A fake GitHub for the work-state tests: a reader shaped like the read-only adapter's result
// and a writer shaped like the broker. Everything is synthetic.

const REPO = { owner: 'example-org', name: 'example-repo' };
const SHA = (char) => char.repeat(40);

function issue(overrides = {}) {
  return {
    number: 7, state: 'open', title: 'Synthetic issue', labels: ['ready'], assignees: [], isPullRequest: false,
    updatedAt: '2026-10-14T12:00:00.000Z', ...overrides
  };
}

function createRemote(initial = {}) {
  const issues = new Map();
  for (const [number, value] of Object.entries(initial)) issues.set(Number(number), issue({ number: Number(number), ...value }));
  let clock = Date.parse('2026-10-14T12:00:00.000Z');
  const bump = () => { clock += 1000; return new Date(clock).toISOString(); };

  const remote = {
    issues,
    reads: [],
    writes: [],
    // Scripts: return a value to replace the default behaviour, or undefined to keep it.
    onRead: null,
    onClaim: null,
    onSetLabel: null,
    touch(number, change = {}) { Object.assign(issues.get(number), change, { updatedAt: bump() }); },

    reader: {
      async getIssue(number, options) {
        remote.reads.push({ number, options: options ? { forceRefresh: options.forceRefresh === true } : null });
        const scripted = remote.onRead ? await remote.onRead(number, remote.reads.length) : undefined;
        if (scripted !== undefined) return scripted;
        const found = issues.get(number);
        if (!found) return { kind: 'not_found', possiblyHidden: true };
        return { kind: 'ok', data: structuredClone(found) };
      }
    },

    writer: {
      async claim(payload) {
        remote.writes.push({ op: 'claim', payload: structuredClone(payload) });
        const scripted = remote.onClaim ? await remote.onClaim(payload, remote.writes.length) : undefined;
        if (scripted !== undefined) return scripted;
        const found = issues.get(payload.issueNumber);
        if (!found || found.updatedAt !== payload.expectedUpdatedAt) return { ok: false, reason: 'conflict' };
        found.labels = found.labels.filter((name) => name !== 'ready').concat(payload.label);
        found.assignees = ['shared-account'];
        found.updatedAt = bump();
        return { ok: true };
      },
      async setLabel(payload) {
        remote.writes.push({ op: 'setLabel', payload: structuredClone(payload) });
        const scripted = remote.onSetLabel ? await remote.onSetLabel(payload, remote.writes.length) : undefined;
        if (scripted !== undefined) return scripted;
        const found = issues.get(payload.issueNumber);
        if (!found || found.updatedAt !== payload.expectedUpdatedAt) return { ok: false, reason: 'conflict' };
        const status = new Set(['ready', 'in-progress', 'blocked']);
        found.labels = found.labels.filter((name) => !status.has(name)).concat(payload.label);
        if (payload.label === 'ready') found.assignees = [];
        found.updatedAt = bump();
        return { ok: true };
      }
    }
  };
  return remote;
}

const PRIVATE = Object.freeze({
  sessionId: 'session-synthetic-0001',
  worktree: '/synthetic/worktrees/issue-7-private-directory',
  branch: 'feat/synthetic-private-branch'
});

module.exports = { REPO, SHA, PRIVATE, issue, createRemote };
