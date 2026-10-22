'use strict';

const { scanPublication } = require('../publish/scan');

/**
 * The meeting minutes as Markdown (issue #308). Pure. It records WHO was asked, whether the topic was typed into their terminal, and
 * the reply the person pasted for each, labelled as pasted by them from that agent's terminal. An agent with no pasted reply is "no
 * reply recorded": nothing is ever written in an agent's name that the person did not paste. All text is shown as plain text (control
 * and direction characters removed, Markdown characters escaped, bounded) and scanned like text about to be published; a field that
 * looks private is withheld in place; a scan that cannot be completed gives no minutes.
 */

const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const MAX_PARTICIPANTS = 30;
const OUTCOME_TEXT = Object.freeze({
  sent: 'the topic was typed into its terminal',
  'sent-unknown-state': 'the topic was typed into its terminal (its state was unknown; you chose to)',
  skipped: 'the topic was NOT typed into its terminal'
});
const REASON_TEXT = Object.freeze({
  'terminal-not-open': 'its terminal is not open', 'cli-not-running': 'the CLI was not running', 'cli-busy': 'the CLI was busy', 'cli-not-waiting': 'the CLI had finished',
  'state-unknown': 'its state was unknown and you did not choose to send', 'send-failed': 'the terminal could not be written to', 'task-changed': 'the topic changed'
});

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const escapeMd = (value) => value.replace(/[\\`*_{}[\]<>()#+\-.!|~&:=]/g, (char) => `\\${char}`);

/** One block of plain text: line breaks kept as separate lines, each line escaped; or a single flat line. */
function plain(value, { limit, multiline }) {
  if (typeof value !== 'string') return '';
  const cleaned = value.replace(/\r\n?/g, '\n').replace(UNSAFE, (char) => (char === '\n' ? '\n' : ' '));
  const rows = (multiline ? cleaned.split('\n') : [cleaned.replace(/\s+/g, ' ')]).map((row) => row.replace(/[ \t]+/g, ' ').trim());
  const text = rows.join('\n').trim();
  const chars = Array.from(text);
  return chars.length > limit ? `${chars.slice(0, limit - 1).join('')}…` : text;
}

/**
 * @param {{ topic: string, at: Date|string, participants: Array<{ name: string, provider: string, outcome: string, reason?: string, reply?: string|null }> }} input
 * @param {{ scan?: Function }} [options] `scan`: only tests pass another scanner
 * @returns {{ ok: true, markdown: string, withheld: number, replied: number, total: number } | { ok: false, reason: string }}
 */
function buildMinutes(input, { scan = scanPublication } = {}) {
  if (!isPlain(input) || !Array.isArray(input.participants)) return { ok: false, reason: 'invalid-input' };
  const at = new Date(input.at ?? Date.now());
  if (!Number.isFinite(at.getTime())) return { ok: false, reason: 'invalid-time' };
  const texts = [];
  const quotedIds = new Set();
  const field = (value, options) => { texts.push(plain(value, options)); if (options.multiline) quotedIds.add(texts.length - 1); return `\u0001${texts.length - 1}\u0002`; };
  const people = input.participants.filter(isPlain).slice(0, MAX_PARTICIPANTS);
  const topic = field(input.topic, { limit: 600, multiline: false });
  const sections = [];
  let replied = 0;
  people.forEach((person, index) => {
    const label = `${index + 1}. ${field(person.name, { limit: 80, multiline: false }) || 'Agent'} (${field(person.provider, { limit: 40, multiline: false })})`;
    const outcome = Object.hasOwn(OUTCOME_TEXT, person.outcome) ? OUTCOME_TEXT[person.outcome] : 'unknown whether the topic was typed';
    const reason = typeof person.reason === 'string' && Object.hasOwn(REASON_TEXT, person.reason) ? ` (${REASON_TEXT[person.reason]})` : '';
    const reply = typeof person.reply === 'string' && person.reply.trim() !== '' ? person.reply : null;
    const sentToIt = person.outcome === 'sent' || person.outcome === 'sent-unknown-state';
    const rows = [`### ${label}`, '', `- Asked: ${outcome}${person.outcome === 'skipped' ? reason : ''}`];
    if (reply !== null && sentToIt) {
      replied += 1;
      rows.push('- Reply: pasted by you from this agent\'s terminal (not written by this extension):', '', `> ${field(reply, { limit: 4000, multiline: true })}`);
    } else {
      rows.push(`- Reply: ${sentToIt ? 'no reply recorded (none was pasted)' : 'none (it was not asked)'}`);
    }
    sections.push(rows.join('\n'), '');
  });
  const skeleton = [
    '# Meeting minutes', '',
    `Held ${at.toISOString()}.`, '',
    '> Private to this computer, in an unsaved editor. Replies are exactly what you pasted; an agent with no pasted reply is marked as having none. Nothing was written for an agent.', '',
    '## Topic', '', `> ${topic}`, '',
    '## Participants and replies', '',
    `${replied} of ${people.length} participant${people.length === 1 ? '' : 's'} have a recorded reply.`, '',
    ...(people.length === 0 ? ['No participants.', ''] : sections),
    input.participants.length > MAX_PARTICIPANTS ? `${input.participants.length - MAX_PARTICIPANTS} more participants are not shown.\n` : ''
  ].join('\n');

  const withheld = new Set();
  for (let start = 0; start < texts.length; start += 100) {
    const batch = texts.slice(start, start + 100).map((text) => ({ kind: 'comment', text }));
    let verdict;
    try { verdict = scan(batch); } catch { return { ok: false, reason: 'scan-failed' }; }
    if (!verdict || !Array.isArray(verdict.findings)) return { ok: false, reason: 'scan-failed' };
    if (verdict.truncated === true || (Array.isArray(verdict.unscanned) && verdict.unscanned.length > 0) || (Array.isArray(verdict.unmatchable) && verdict.unmatchable.length > 0) || (verdict.status !== 'clear' && verdict.findings.length === 0)) return { ok: false, reason: 'scan-incomplete' };
    for (const finding of verdict.findings) {
      if (!Number.isSafeInteger(finding.unit) || finding.unit < 0 || finding.unit >= batch.length) return { ok: false, reason: 'scan-incomplete' };
      withheld.add(start + finding.unit);
    }
  }
  const markdown = skeleton.replace(/\u0001(\d+)\u0002/g, (_m, index) => {
    const id = Number(index);
    if (withheld.has(id)) return '(withheld: looked private)';
    const text = texts[id];
    // A pasted reply is a block quote: every line starts with the quote mark, so no line of it can start anything else.
    return text === '' ? 'unknown' : text.split('\n').map(escapeMd).join(quotedIds.has(id) ? '\n> ' : '\n');
  });
  let whole;
  try { whole = scan([{ kind: 'comment', text: markdown }]); } catch { return { ok: false, reason: 'scan-failed' }; }
  if (!whole || whole.status !== 'clear') return { ok: false, reason: 'scan-rejected' };
  return { ok: true, markdown, withheld: withheld.size, replied, total: people.length };
}

module.exports = { buildMinutes, MAX_PARTICIPANTS };
