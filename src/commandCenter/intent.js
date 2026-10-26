'use strict';

/**
 * The Workbench's "say it" box (#357, #360 guideline 3). One line the administrator typed is turned into one of the existing actions,
 * by plain rules and nothing else: no model reads it and nothing is guessed from what an agent or GitHub wrote. The result is only a
 * plan to preview; the action itself still goes through its own confirmation (#183).
 *
 * - A question (ends with a question mark, or asks with what / how / why / 什麼 / 怎麼 / 嗎 …) is asked of the one agent it names, or of
 *   the PM agent when it names none (the Ask tab's flow).
 * - Anything else is a task: typed into the one agent it names, or broadcast to the role group, the agents or everyone it names
 *   (the Broadcast tab's flow).
 * - When it names nobody, or a question names a group, nothing is done and the reason says what to write instead.
 */

const MAX_SAY_TEXT = 500;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const QUESTION_END = /[?？]\s*$/;
const QUESTION_WORDS = /^(?:what|how|why|which|who|where|when|is|are|does|do|did|can|could|should|would|will)\b/i;
const QUESTION_ZH = /什麼|甚麼|怎麼|為什麼|為何|如何|哪[個些裡]|是否|嗎\s*$/;
const EVERYONE = /所有人|大家|全部的?\s*agents?|所有的?\s*agents?|\beveryone\b|\ball agents\b|\bevery agent\b/i;
const SELECTION = /這段|選取|選起來|selected code|\bthis (?:code|function|snippet)\b|\bthe selection\b/i;

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A name counts only as a whole word: "Worker-01" is not found in "Worker-012", and "PM" not in "PMs" or "PM-01".
const mentions = (text, name) => typeof name === 'string' && name.trim().length >= 2 && new RegExp(`(?<![A-Za-z0-9_-])${escape(name.trim())}(?![A-Za-z0-9_]|-\\d)`, 'i').test(text);

/**
 * @param {string} text what the administrator typed
 * @param {{ cards: Array<{ id: string, codename?: string|null, name?: string, roleGroupId?: string|null, roleName?: string, pm?: boolean }> }} context the agents on the screen
 * @returns {{ ok: true, kind: 'ask', id: string, question: string, withSelection: boolean }
 *   | { ok: true, kind: 'task' | 'broadcast', ids: string[], text: string, to: string }
 *   | { ok: false, reason: string }}
 */
function interpret(text, context) {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, reason: 'Write what should be done first.' };
  if (text.length > MAX_SAY_TEXT) return { ok: false, reason: `Keep it to one line of at most ${MAX_SAY_TEXT} characters; use the Broadcast or Ask tab for more.` };
  if (CONTROL.test(text)) return { ok: false, reason: 'Write it on one line.' };
  const said = text.trim();
  const cards = Array.isArray(context && context.cards) ? context.cards.filter((card) => card && typeof card.id === 'string') : [];
  if (cards.length === 0) return { ok: false, reason: 'No agent is running. Start one on the Agents tab first.' };

  const named = cards.filter((card) => mentions(said, card.codename) || mentions(said, card.name));
  const pmNamed = /(?<![A-Za-z0-9_-])PM(?![A-Za-z0-9_]|-\d)/.test(said) ? cards.filter((card) => card.pm) : [];
  const agents = [...new Map([...named, ...pmNamed].map((card) => [card.id, card])).values()];
  const groups = [...new Set(cards.filter((card) => typeof card.roleGroupId === 'string' && mentions(said, card.roleName)).map((card) => card.roleGroupId))];
  const everyone = EVERYONE.test(said);
  const question = QUESTION_END.test(said) || QUESTION_WORDS.test(said) || QUESTION_ZH.test(said);

  if (question) {
    if (everyone || groups.length > 0) return { ok: false, reason: 'A question is asked of one agent. To tell a whole group something, write it without a question, or use the Broadcast tab.' };
    if (agents.length > 1) return { ok: false, reason: 'A question is asked of one agent at a time. Name only one, for example its codename.' };
    const target = agents[0] || cards.find((card) => card.pm);
    if (!target) return { ok: false, reason: 'No PM agent is running to ask. Name the agent to ask, for example its codename.' };
    return { ok: true, kind: 'ask', id: target.id, question: said, withSelection: SELECTION.test(said) };
  }
  if (everyone) return { ok: true, kind: 'broadcast', ids: cards.map((card) => card.id), text: said, to: 'everyone' };
  if (agents.length === 1 && groups.length === 0) return { ok: true, kind: 'task', ids: [agents[0].id], text: said, to: 'agent' };
  if (agents.length > 0 || groups.length > 0) {
    const ids = [...new Set([...agents.map((card) => card.id), ...cards.filter((card) => groups.includes(card.roleGroupId)).map((card) => card.id)])];
    return { ok: true, kind: 'broadcast', ids, text: said, to: groups.length > 0 && agents.length === 0 ? 'group' : 'agents' };
  }
  return { ok: false, reason: 'Say who should do it: an agent\'s codename (for example Worker-01), a role group\'s name, or "everyone". To ask a question, end it with a question mark.' };
}

module.exports = { interpret, MAX_SAY_TEXT };
