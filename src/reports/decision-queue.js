'use strict';

const SHA = /^[a-f0-9]{40}$/i;
const FIELDS = Object.freeze(['operableResult', 'solution', 'alternatives', 'acceptanceGap', 'risks', 'recommendedAction', 'evidenceTime', 'evidenceVersion']);
const MARKER = 'MULTIAGENT_PM_REPORT_V1';
const clean = (value, max) => typeof value === 'string' ? Array.from(value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim()).slice(0, max).join('') : '';
const complete = (result) => result && (result.kind === 'empty' || (result.kind === 'ok' && Array.isArray(result.data)));
const sameHead = (left, right) => typeof left === 'string' && typeof right === 'string' && SHA.test(left) && SHA.test(right) && left.toLowerCase() === right.toLowerCase();

/** Only a deliberately marked, valid owner comment is a PM report. Other comments stay comments. */
function pmReport(comments, repository, expectedVersion) {
  if (!complete(comments)) return { state: 'unknown', reason: 'comments-unreadable' };
  const owner = typeof repository === 'string' ? repository.split('/')[0] : '';
  if (!owner) return { state: 'unknown', reason: 'repository-unreadable' };
  const items = comments.kind === 'empty' ? [] : comments.data;
  const candidates = items.filter((item) => item && typeof item.author === 'string' && item.author.toLowerCase() === owner.toLowerCase() && typeof item.body === 'string' && item.body.startsWith(`${MARKER}\n`));
  for (const item of candidates.reverse()) {
    let raw;
    try { raw = JSON.parse(item.body.slice(MARKER.length + 1)); } catch { continue; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some((key) => !FIELDS.includes(key)) || FIELDS.some((key) => typeof raw[key] !== 'string' || raw[key].trim() === '')) continue;
    if (!Number.isFinite(Date.parse(raw.evidenceTime)) || item.body.length > 15000) continue;
    const version = raw.evidenceVersion.trim();
    const fields = Object.fromEntries(FIELDS.map((key) => [key, clean(raw[key], key === 'evidenceTime' || key === 'evidenceVersion' ? 100 : 2000)]));
    const current = typeof expectedVersion === 'string' && expectedVersion !== '' && version.toLowerCase() === expectedVersion.toLowerCase();
    return { state: current ? 'current' : 'stale', author: owner, fields };
  }
  return { state: 'missing' };
}

const CATEGORIES = Object.freeze(['pending', 'changes', 'passed', 'processed']);
const CATEGORY_LABELS = Object.freeze({ pending: '待我決策／待補證據', changes: '要求修改', passed: '已通過', processed: '已處理' });

/** A Pass must be a formal review on this head with complete, matching, passing checks. */
function classifyPullRequest(pr, snapshot) {
  if (pr && (pr.state === 'closed' || pr.merged === true)) return 'processed';
  if (!pr || pr.state !== 'open' || !SHA.test(pr.headSha ?? '')) return 'pending';
  if (!snapshot || snapshot.status !== 'complete' || snapshot.consistent !== true || !sameHead(snapshot.headSha, pr.headSha)) return 'pending';
  const approval = snapshot.approval;
  if (approval?.status === 'changes_requested' && sameHead(approval.headSha, pr.headSha)) return 'changes';
  const checks = snapshot.checksSummary;
  if (approval?.status === 'approved' && sameHead(approval.headSha, pr.headSha) && checks?.state === 'passing' && checks.requiredState === 'passing' && sameHead(checks.headSha, pr.headSha)) return 'passed';
  return 'pending';
}

const classifyIssue = (issue) => issue && issue.state === 'closed' ? 'processed' : 'pending';

module.exports = { pmReport, classifyPullRequest, classifyIssue, CATEGORIES, CATEGORY_LABELS, MARKER, FIELDS };
