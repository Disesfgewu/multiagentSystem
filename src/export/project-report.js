'use strict';

const { scanPublication } = require('../publish/scan');
const { broadcastStatus } = require('../broadcast/model');
const { summarizeDeliveries } = require('../broadcast/deliver');

/**
 * The project report as one Markdown text (issue #307). Pure: it is given what the command already read and returns text; it reads
 * nothing, writes nothing and sends nothing. The command opens the text in an UNSAVED editor, so by default nothing reaches the
 * workspace or the repository.
 *
 * Three rules shape every line:
 *  - Anything that could not be read is said to be unknown, with the reason. A missing section is never silently left out.
 *  - Text from GitHub, from a session name or from a broadcast is a plain-text FIELD: control, bidirectional and invisible
 *    characters are removed, it is cut to a short length, and Markdown characters are escaped, so it cannot become a heading, a
 *    link, a table, a code fence or HTML. Every heading in the report is generated here and starts a line by itself.
 *  - Before anything is returned, every field is scanned like text about to be published. A field that looks private (a credential,
 *    a local path, an email address) is replaced by "withheld" in place; if the scan cannot be completed, no report is produced.
 */

const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const LIMITS = Object.freeze({ issues: 100, pullRequests: 100, agents: 60, accounts: 20, broadcasts: 10 });
const SCAN_BATCH = 100;
const FIELD_OPEN = '\u0001';
const FIELD_CLOSE = '\u0002';
const FIELD_TOKEN = /\u0001(\d+)\u0002/g;

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const complete = (result) => isPlain(result) && (result.kind === 'empty' || (result.kind === 'ok' && Array.isArray(result.data)));
const itemsOf = (result) => (!complete(result) ? null : result.kind === 'empty' ? [] : result.data);

/** The place an external piece of text is registered; its final form is decided after the scan. */
function createFields() {
  const texts = [];
  const escape = (value) => value.replace(/[\\`*_{}[\]<>()#+\-.!|~&]/g, (char) => `\\${char}`);
  return {
    texts,
    /** One line of plain text, cut to `limit` characters and Markdown-escaped. Returns a token the final pass replaces. */
    field(value, limit = 160) {
      const flat = typeof value === 'string' ? value.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim() : '';
      const chars = Array.from(flat);
      const text = chars.length > limit ? `${chars.slice(0, limit - 1).join('')}…` : flat;
      texts.push(text);
      return `${FIELD_OPEN}${texts.length - 1}${FIELD_CLOSE}`;
    },
    escape
  };
}

const unknownText = (what, reason) => `${what}: unknown${reason ? ` (${reason})` : ''}`;

/** The acceptance list of an Issue: `{ total, done }` from the checkboxes under the 驗收 / Acceptance heading, or null if there is none. */
function acceptanceProgress(body) {
  if (typeof body !== 'string') return null;
  const rows = body.split(/\r?\n/);
  const start = rows.findIndex((row) => /^#{1,6}\s*(驗收|acceptance)/i.test(row.trim()));
  if (start < 0) return null;
  let total = 0;
  let done = 0;
  let boxes = 0;
  for (const row of rows.slice(start + 1)) {
    if (/^#{1,6}\s/.test(row.trim())) break;
    const item = /^\s*(?:[-*]|\d+[.)])\s+(\[[ xX]\])?/.exec(row);
    if (!item) continue;
    total += 1;
    if (item[1]) { boxes += 1; if (item[1] !== '[ ]') done += 1; }
  }
  return total === 0 ? null : { total, done, tracked: boxes === total };
}

/** The first paragraph of the body that is not a heading, as one line. */
function firstParagraph(body) {
  if (typeof body !== 'string') return '';
  for (const paragraph of body.split(/\r?\n\s*\r?\n/)) {
    const text = paragraph.split(/\r?\n/).filter((row) => !/^\s*#{1,6}\s/.test(row)).join(' ').trim();
    if (text !== '') return text;
  }
  return '';
}

function agentLabel(target) {
  if (!isPlain(target)) return 'unknown target';
  if (target.scope === 'all') return 'every agent';
  if (target.scope === 'roleGroup') return 'one role group';
  if (target.scope === 'provider') return 'one provider';
  if (target.scope === 'agent') return 'one session';
  return 'unknown target';
}

const PM_TEXT = Object.freeze({ current: 'current for this head', stale: 'STALE (its evidence is for another head)', missing: 'none yet', unknown: 'unknown' });
const CATEGORY_TEXT = Object.freeze({ pending: 'waiting for a decision or more evidence', changes: 'changes requested', passed: 'passed on this head', processed: 'processed' });

function issueSection(f, issues, prs) {
  const out = ['## Open Issues', ''];
  const list = itemsOf(issues);
  if (list === null) return [...out, `- ${unknownText('Open Issues', isPlain(issues) && typeof issues.kind === 'string' ? `the list could not be read completely: ${issues.kind}` : 'not read')}`, ''];
  const open = list.filter((issue) => isPlain(issue) && Number.isSafeInteger(issue.number) && issue.state !== 'closed').sort((a, b) => a.number - b.number);
  if (open.length === 0) return [...out, 'No open Issues.', ''];
  const related = (number) => (prs === null ? null : prs.filter((pr) => isPlain(pr) && Array.isArray(pr.referencedIssues) && pr.referencedIssues.some((ref) => isPlain(ref) && ref.number === number)).map((pr) => pr.number));
  for (const issue of open.slice(0, LIMITS.issues)) {
    out.push(`### Issue #${issue.number}: ${f.field(issue.title, 140)}`, '');
    const summary = firstParagraph(issue.body);
    out.push(`- Requirement: ${summary ? f.field(summary, 280) : 'none written'}`);
    const progress = acceptanceProgress(issue.body);
    out.push(`- Acceptance: ${progress === null ? 'no acceptance list found in the Issue' : progress.tracked ? `${progress.done} of ${progress.total} items ticked in the Issue` : `${progress.total} items (the Issue has no checkboxes, so progress is not tracked there)`}`);
    const linked = related(issue.number);
    out.push(`- Pull requests: ${linked === null ? 'unknown (the pull request list could not be read)' : linked.length === 0 ? 'none open' : linked.map((number) => `#${number}`).join(', ')}`, '');
  }
  if (open.length > LIMITS.issues) out.push(`${open.length - LIMITS.issues} more open Issues are not shown.`, '');
  return out;
}

function pullRequestSection(f, pullRequests, details) {
  const out = ['## Open Pull Requests', ''];
  const list = itemsOf(pullRequests);
  if (list === null) return [...out, `- ${unknownText('Open pull requests', isPlain(pullRequests) && typeof pullRequests.kind === 'string' ? `the list could not be read completely: ${pullRequests.kind}` : 'not read')}`, ''];
  const open = list.filter((pr) => isPlain(pr) && Number.isSafeInteger(pr.number) && pr.state !== 'closed' && pr.state !== 'merged').sort((a, b) => a.number - b.number);
  if (open.length === 0) return [...out, 'No open pull requests.', ''];
  for (const pr of open.slice(0, LIMITS.pullRequests)) {
    const detail = isPlain(details) && isPlain(details[String(pr.number)]) ? details[String(pr.number)] : null;
    const summary = detail && isPlain(detail.summary) ? detail.summary : null;
    const head = typeof pr.headSha === 'string' && /^[0-9a-f]{7,64}$/i.test(pr.headSha) ? pr.headSha.slice(0, 12).toLowerCase() : null;
    out.push(`### Pull request #${pr.number}: ${f.field(pr.title, 140)}`, '');
    out.push(`- Head: ${head ?? 'unknown'}${pr.draft ? ' (draft)' : ''}`);
    if (!summary) {
      out.push('- Review and CI: unknown (this pull request\'s report could not be read)', '');
      continue;
    }
    out.push(`- PM report: ${Object.hasOwn(PM_TEXT, summary.pm) ? PM_TEXT[summary.pm] : PM_TEXT.unknown}`);
    if (typeof summary.userCan === 'string' && summary.userCan !== '') out.push(`- What you can do: ${f.field(summary.userCan, 200)}`);
    if (typeof summary.next === 'string' && summary.next !== '') out.push(`- Next: ${f.field(summary.next, 200)}`);
    const approval = typeof summary.approval === 'string' ? summary.approval : 'unknown';
    out.push(`- Formal review on the latest head: ${f.field(approval, 40)}`);
    out.push(`- CI for the latest head: ${f.field(typeof summary.ci === 'string' ? summary.ci : 'unknown', 20)}`);
    out.push(`- Unresolved threads: ${Number.isSafeInteger(summary.unresolved) && summary.unresolved >= 0 ? summary.unresolved : 'unknown'}`);
    out.push(`- Where it stands: ${detail && Object.hasOwn(CATEGORY_TEXT, detail.category) ? CATEGORY_TEXT[detail.category] : 'unknown'}`, '');
  }
  if (open.length > LIMITS.pullRequests) out.push(`${open.length - LIMITS.pullRequests} more open pull requests are not shown.`, '');
  return out;
}

function decisionSection(f, pullRequests, details, decisions) {
  const out = ['## Waiting for a decision', ''];
  const list = itemsOf(pullRequests);
  if (list === null) out.push('- Pull requests: unknown (the list could not be read)');
  else {
    const waiting = list.filter((pr) => isPlain(pr) && pr.state !== 'closed' && pr.state !== 'merged' && isPlain(details) && isPlain(details[String(pr.number)]) && details[String(pr.number)].category === 'pending').map((pr) => pr.number).sort((a, b) => a - b);
    const unknown = list.filter((pr) => isPlain(pr) && pr.state !== 'closed' && pr.state !== 'merged' && !(isPlain(details) && isPlain(details[String(pr.number)]) && typeof details[String(pr.number)].category === 'string')).length;
    out.push(`- Pull requests waiting for a decision or more evidence: ${waiting.length === 0 ? 'none' : waiting.map((number) => `#${number}`).join(', ')}${unknown > 0 ? `; ${unknown} could not be classified (unknown)` : ''}`);
  }
  if (isPlain(decisions) && isPlain(decisions.issues) && typeof decisions.issues.text === 'string') out.push(`- Issues: ${f.field(decisions.issues.text, 200)}`);
  else out.push('- Issues: unknown');
  out.push('');
  return out;
}

function agentSection(f, team) {
  const out = ['## Agents', ''];
  if (!isPlain(team)) return [...out, '- Agents: unknown (the Command Center data could not be read)', ''];
  const cards = [...(Array.isArray(team.pm) ? team.pm : []), ...(Array.isArray(team.agents) ? team.agents : [])].filter(isPlain);
  if (cards.length === 0) out.push('No managed sessions.', '');
  for (const card of cards.slice(0, LIMITS.agents)) {
    out.push(`### ${f.field(card.name, 80)}`, '');
    out.push(`- Role: ${f.field(card.roleName, 60)} · Provider: ${f.field(card.provider, 60)}`);
    const status = isPlain(card.status) ? card.status : {};
    out.push(`- State: ${f.field(status.text, 60) || 'unknown'} (${f.field(status.source, 120)})`);
    out.push(`- Task: ${f.field(isPlain(card.task) ? card.task.text : '', 160)}`);
    if (typeof card.assigned === 'string' && card.assigned !== '') out.push(`- Handed: ${f.field(card.assigned, 200)}`);
    out.push(`- Working folder: ${f.field(card.worktree, 200)}`);
    const quota = isPlain(card.quota) && Array.isArray(card.quota.lines) ? card.quota.lines.slice(0, 2) : [];
    out.push(`- Quota: ${quota.length === 0 ? 'unknown (no reading for this agent\'s account)' : quota.map((row) => f.field(row, 160)).join('; ')}`);
    if (typeof card.alert === 'string' && card.alert !== '') out.push(`- Alert: ${f.field(card.alert, 160)}`);
    out.push('');
  }
  if (cards.length > LIMITS.agents) out.push(`${cards.length - LIMITS.agents} more sessions are not shown.`, '');
  const accounts = Array.isArray(team.accounts) ? team.accounts.filter(isPlain) : [];
  if (accounts.length > 0) {
    out.push('### Accounts', '');
    // Accounts are numbered, not named: a label can be a person's own name or email address.
    accounts.slice(0, LIMITS.accounts).forEach((account, index) => {
      const windows = Array.isArray(account.windows) ? account.windows.slice(0, 3).map((win) => (isPlain(win) ? `${f.field(win.label, 30)} ${f.field(win.text, 40)} (${f.field(win.trust, 60)})` : '')).filter((text) => text !== '') : [];
      const reason = isPlain(account.reason) ? f.field(account.reason.short, 120) : null;
      out.push(`- Account ${index + 1} (${f.field(account.provider, 40)}): ${windows.length > 0 ? windows.join('; ') : `usage unknown${reason ? ` (${reason})` : ''}`}`);
    });
    out.push('');
  }
  return out;
}

function broadcastSection(f, broadcasts, now) {
  const out = ['## Recent broadcasts', ''];
  if (!isPlain(broadcasts) || !Array.isArray(broadcasts.items)) return [...out, '- Broadcasts: unknown (the local notices could not be read)', ''];
  const items = [...broadcasts.items].filter(isPlain).sort((a, b) => (String(a.createdAt) < String(b.createdAt) ? 1 : -1)).slice(0, LIMITS.broadcasts);
  if (items.length === 0) return [...out, 'No broadcasts.', ''];
  const records = Array.isArray(broadcasts.deliveries) ? broadcasts.deliveries : null;
  for (const item of items) {
    const delivery = records === null ? 'unknown (the delivery log could not be read)' : summarizeDeliveries(records, item.id);
    out.push(`- ${f.field(item.text, 200)} — to ${agentLabel(item.target)}; ${broadcastStatus(item, now)}; delivery: ${f.field(delivery, 120)}`);
  }
  out.push('');
  return out;
}

/**
 * @param {{ generatedAt?: Date|string, repository?: string|null, mainHead?: object, issues?: object, pullRequests?: object, details?: object, decisions?: object, team?: object, broadcasts?: object }} input
 * `scan` (second argument) is the publish scanner; only tests pass another.
 * @returns {{ ok: true, markdown: string, withheld: number } | { ok: false, reason: string }}
 */
function buildProjectReport(input, { scan = scanPublication } = {}) {
  const source = isPlain(input) ? input : {};
  const at = new Date(source.generatedAt ?? Date.now());
  if (!Number.isFinite(at.getTime())) return { ok: false, reason: 'invalid-time' };
  const f = createFields();
  const issueList = itemsOf(source.issues);
  const prList = itemsOf(source.pullRequests);
  const main = isPlain(source.mainHead) && source.mainHead.state === 'known' && /^[0-9a-f]{7,64}$/.test(String(source.mainHead.head)) ? `${source.mainHead.head} (local origin/main as last fetched; not checked against GitHub now)` : `unknown${isPlain(source.mainHead) && typeof source.mainHead.reason === 'string' ? ` (${f.field(source.mainHead.reason, 40)})` : ' (not read)'}`;
  const count = (list, what) => (list === null ? `unknown (${what} could not be read completely)` : String(list.filter((entry) => isPlain(entry) && entry.state !== 'closed' && entry.state !== 'merged').length));
  const lines = [
    '# Project report',
    '',
    `Generated ${at.toISOString()}${typeof source.repository === 'string' && source.repository !== '' ? ` for ${f.field(source.repository, 100)}` : ''}.`,
    '',
    '> Private to this computer. This report is open in an unsaved editor; nothing was written to your workspace. Text copied from GitHub, session names and notices is shown as plain text, and anything that looked private was withheld.',
    '',
    '## Summary',
    '',
    `- Main head: ${main}`,
    `- Open Issues: ${count(issueList, 'the Issue list')}`,
    `- Open pull requests: ${count(prList, 'the pull request list')}`,
    '',
    ...issueSection(f, source.issues, prList),
    ...pullRequestSection(f, source.pullRequests, source.details),
    ...decisionSection(f, source.pullRequests, source.details, source.decisions),
    ...agentSection(f, source.team),
    ...broadcastSection(f, source.broadcasts, at),
    '## What this report does not know',
    '',
    '- Everything marked unknown could not be read when this report was made; it is not zero and it is not fine.',
    '- A review or CI result is only as current as the moment it was read, and counts only for the head named beside it.',
    '- Nothing here was approved, merged or changed by this report.',
    ''
  ];
  const skeleton = lines.join('\n');

  // Scan every external field. A field with a finding is withheld; a scan that could not look at everything produces no report at all.
  // The scanner takes a bounded number of units at a time, so the fields go through in batches.
  const withheld = new Set();
  for (let start = 0; start < f.texts.length; start += SCAN_BATCH) {
    const batch = f.texts.slice(start, start + SCAN_BATCH).map((text) => ({ kind: 'comment', text }));
    let verdict;
    try { verdict = scan(batch); } catch { return { ok: false, reason: 'scan-failed' }; }
    if (!verdict || !Array.isArray(verdict.findings)) return { ok: false, reason: 'scan-failed' };
    if (verdict.truncated === true || (Array.isArray(verdict.unscanned) && verdict.unscanned.length > 0) || (Array.isArray(verdict.unmatchable) && verdict.unmatchable.length > 0) || (verdict.status !== 'clear' && verdict.findings.length === 0)) return { ok: false, reason: 'scan-incomplete' };
    for (const finding of verdict.findings) {
      if (!Number.isSafeInteger(finding.unit) || finding.unit < 0 || finding.unit >= batch.length) return { ok: false, reason: 'scan-incomplete' };
      withheld.add(start + finding.unit);
    }
  }
  const markdown = skeleton.replace(FIELD_TOKEN, (_match, index) => {
    const id = Number(index);
    if (withheld.has(id)) return '(withheld: looked private)';
    const text = f.texts[id];
    return text === '' ? 'unknown' : f.escape(text);
  });
  // The assembled report is scanned once more as a whole; the pieces were each clear, so a finding here means a join created one.
  let whole;
  try { whole = scan([{ kind: 'comment', text: markdown }]); } catch { return { ok: false, reason: 'scan-failed' }; }
  if (!whole || whole.status !== 'clear') return { ok: false, reason: 'scan-rejected' };
  return { ok: true, markdown, withheld: withheld.size };
}

module.exports = { buildProjectReport, acceptanceProgress, firstParagraph, LIMITS };
