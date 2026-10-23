'use strict';

const { validateRuleList, safeText } = require('../roles/rule-input');
const { locateSensitive } = require('../memory/sensitive');

/**
 * Team rules (issue #306): ONE list of instructions that every agent started from now on is given, ahead of its role group's own
 * rules. They are rules of the `user` layer, which the resolver (`memory/rules.js`) puts before the `roleGroup` layer; inside the
 * `user` layer the resolver orders by rule id, not by position in a list. Pure logic: validation and edits. The list lives in the private store (`store.js`); how it reaches a CLI is the same path
 * as any other instruction (`managedInstructions.ts`), so a rule here is text the CLI is TOLD, never something this extension
 * enforces. Only instructions are kept: a ban on a tool is the role group's tool permission, not a sentence in this list.
 */

const MAX_RULES = 50;
// A rule the extension suggests (#362): agents stopped to ask about routine choices although auto mode was on. It is only offered
// in Edit Team Rules; it applies once the person adds it there (and can be edited or removed like any other rule).
const SUGGESTED_RULES = Object.freeze([
  Object.freeze({
    key: 'decide-routine',
    label: 'Decide routine matters yourself',
    text: '例行決定自行判斷並繼續，不要停下來詢問；只有在無法繼續、會刪除資料、或會對外發佈時才詢問管理者。'
  })
]);
const MAX_TEXT_CHARS = 1000;
const ID_PREFIX = 'team:';
const ID = /^team:[1-9][0-9]{0,5}$/;

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (reason) => ({ ok: false, reason });

/** An empty list at version 0: what an agent is given when nobody has written team rules. */
const emptyTeamRules = () => ({ version: 0, updatedAt: null, rules: [] });

/**
 * Whatever was stored becomes a valid list or an error; an unreadable record is never treated as an empty list.
 * @returns {{ ok: true, doc: { version: number, updatedAt: string|null, rules: Array<{ id: string, type: 'instruction', text: string }> } } | { ok: false, reason: string }}
 */
function validateTeamRules(raw) {
  if (!isPlain(raw)) return fail('invalid-team-rules');
  const keys = Object.keys(raw).sort().join();
  if (keys !== 'rules,updatedAt,version') return fail('invalid-team-rules');
  if (!Number.isSafeInteger(raw.version) || raw.version < 0) return fail('invalid-team-rules');
  if (raw.updatedAt !== null && !(typeof raw.updatedAt === 'string' && Number.isFinite(Date.parse(raw.updatedAt)))) return fail('invalid-team-rules');
  if (!Array.isArray(raw.rules) || raw.rules.length > MAX_RULES) return fail('invalid-team-rules');
  const seen = new Set();
  for (const rule of raw.rules) {
    if (!isPlain(rule) || Object.keys(rule).sort().join() !== 'id,text,type' || rule.type !== 'instruction' || typeof rule.id !== 'string' || !ID.test(rule.id) || seen.has(rule.id)) return fail('invalid-team-rules');
    if (!safeText(rule.text, MAX_TEXT_CHARS)) return fail('invalid-team-rules');
    seen.add(rule.id);
  }
  // The same check every role-group rule gets, so what is stored can always be composed.
  const checked = validateRuleList(raw.rules, { layer: 'user', path: 'teamRules' });
  if (!checked.ok) return fail('invalid-team-rules');
  return { ok: true, doc: Object.freeze({ version: raw.version, updatedAt: raw.updatedAt === null ? null : new Date(raw.updatedAt).toISOString(), rules: Object.freeze(raw.rules.map((rule) => Object.freeze({ id: rule.id, type: 'instruction', text: rule.text }))) }) };
}

const nextId = (rules) => `${ID_PREFIX}${rules.reduce((highest, rule) => Math.max(highest, Number(rule.id.slice(ID_PREFIX.length))), 0) + 1}`;

/**
 * The list after one edit, with the next version, or why not. `change`: `{ kind: 'add', text }`, `{ kind: 'edit', id, text }` or
 * `{ kind: 'remove', id }`. Text is one line of plain words; it is checked for the same hidden characters as any rule.
 */
function applyEdit(doc, change, now) {
  const checked = validateTeamRules(doc);
  if (!checked.ok) return checked;
  if (!isPlain(change)) return fail('invalid-change');
  const stamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const rules = checked.doc.rules.map((rule) => ({ ...rule }));
  if (change.kind === 'add') {
    if (rules.length >= MAX_RULES) return fail('too-many-rules');
    if (!safeText(change.text, MAX_TEXT_CHARS)) return fail('invalid-text');
    if (looksPrivate(change.text)) return fail('sensitive-text');
    rules.push({ id: nextId(rules), type: 'instruction', text: change.text });
  } else if (change.kind === 'edit') {
    const target = rules.find((rule) => rule.id === change.id);
    if (!target) return fail('rule-not-found');
    if (!safeText(change.text, MAX_TEXT_CHARS)) return fail('invalid-text');
    if (looksPrivate(change.text)) return fail('sensitive-text');
    target.text = change.text;
  } else if (change.kind === 'remove') {
    const index = rules.findIndex((rule) => rule.id === change.id);
    if (index < 0) return fail('rule-not-found');
    rules.splice(index, 1);
  } else return fail('invalid-change');
  return validateTeamRules({ version: checked.doc.version + 1, updatedAt: stamp, rules });
}

/** Whether text looks like a credential, an email address or a local path: a rule is typed into every agent's instructions, so it must not carry one. */
const looksPrivate = (text) => { try { return locateSensitive(text).length > 0; } catch { return true; } };

/** The rules as the `user` layer takes them, ahead of everything the role group adds there. */
const teamRuleLayer = (doc) => (validateTeamRules(doc).ok ? doc.rules.map((rule) => ({ id: rule.id, type: 'instruction', text: rule.text })) : []);

/** The suggested rules not in the list yet (compared by their exact text), so each is offered until it has been added. */
function suggestionsFor(doc) {
  const checked = validateTeamRules(doc);
  if (!checked.ok) return [];
  const texts = new Set(checked.doc.rules.map((rule) => rule.text.trim()));
  return SUGGESTED_RULES.filter((rule) => !texts.has(rule.text));
}

/** A line for previews and cards: what applies to every agent, and from which version. */
function describeTeamRules(doc) {
  const checked = validateTeamRules(doc);
  if (!checked.ok) return 'Team rules: unknown (the stored list could not be read); NOT reflected below.';
  if (checked.doc.rules.length === 0) return 'Team rules: none. Every agent starts with only its own role group\'s rules.';
  return `Team rules (v${checked.doc.version}): ${checked.doc.rules.length} instruction${checked.doc.rules.length === 1 ? '' : 's'} given to every agent started after this version, ahead of its role group's rules. The CLI is told; nothing here enforces them.`;
}

module.exports = { validateTeamRules, applyEdit, teamRuleLayer, describeTeamRules, emptyTeamRules, suggestionsFor, SUGGESTED_RULES, MAX_RULES, MAX_TEXT_CHARS, ID_PREFIX };
