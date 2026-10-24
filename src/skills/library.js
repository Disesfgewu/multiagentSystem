'use strict';

const { checkPromptInjection } = require('../research/ethics');
const { OWN_MARKER } = require('../shared/markers');
const { scanSensitive } = require('../memory/sensitive');

/**
 * The skills library (#359): reusable step-by-step instructions (open a PR, run the tests, rebase…) kept in the extension's private
 * store, each one a Markdown document in Claude Code's own SKILL.md shape (a front matter with `name` and `description`, then the
 * steps). An agent is later told only the list of skills given to its role group, never their text, and reads a skill's file when it
 * needs it, which is what saves tokens.
 *
 * A skill's text ends up in files agents read, so it is checked like a shared note before it is kept, and again when it is used:
 * no control, invisible or direction-changing character, no wording that tells an agent to ignore its rules, none of this package's
 * own message markers, and nothing that looks like a secret, an e-mail address or a home folder. A skill an agent suggests is only a
 * candidate until the owner approves it, and a candidate is never given to an agent.
 */

const COLLECTION = 'skills';
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ROLE_GROUP_ID = /^[A-Za-z0-9_-]{1,64}$/;
// Claude Code reads a description of up to 1024 characters.
const MAX_DESCRIPTION = 1024;
const MAX_BODY = 16 * 1024;
const MAX_SKILLS = 50;
const MAX_ROLES = 50;
const STATES = Object.freeze(['active', 'disabled', 'candidate']);
const SOURCES = Object.freeze(['owner', 'starter', 'repository', 'agent']);
// Control and invisible characters, except the line feed and tab a Markdown document needs.
const UNSAFE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB]/;
const fail = (reason) => ({ ok: false, reason });
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * What a skill's text may not contain, the first problem found, or null.
 * @returns {null | 'unsafe-characters' | 'marker-forged' | 'injection-suspected' | `sensitive:${string}`}
 */
function textProblem(text) {
  if (typeof text !== 'string' || UNSAFE.test(text)) return 'unsafe-characters';
  if (OWN_MARKER.test(text.replace(/\s+/g, ' '))) return 'marker-forged';
  try { if (checkPromptInjection(text).hasInjection) return 'injection-suspected'; } catch { return 'injection-suspected'; }
  const found = scanSensitive(text);
  return found.length > 0 ? `sensitive:${found[0].code}` : null;
}

/**
 * A skill as the library keeps it, checked: its name, one line saying when to use it, the steps, which role groups get it, whether it
 * is in use, and where it came from. Anything else is refused, with the reason.
 */
function checkSkill(raw) {
  if (!isPlain(raw)) return fail('invalid-skill');
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!NAME.test(name)) return fail('invalid-name');
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  if (description === '' || description.length > MAX_DESCRIPTION || /[\r\n]/.test(description)) return fail('invalid-description');
  const body = typeof raw.body === 'string' ? raw.body.replace(/\r\n?/g, '\n').trim() : '';
  if (body === '' || body.length > MAX_BODY) return fail('invalid-body');
  const roles = Array.isArray(raw.roles) ? [...new Set(raw.roles)] : [];
  if (roles.length > MAX_ROLES || !roles.every((id) => typeof id === 'string' && ROLE_GROUP_ID.test(id))) return fail('invalid-roles');
  const state = raw.state ?? 'active';
  if (!STATES.includes(state)) return fail('invalid-state');
  const source = raw.source ?? 'owner';
  if (!SOURCES.includes(source)) return fail('invalid-source');
  // What an agent suggests waits for the owner; nothing else may arrive as a candidate or leave that state by itself.
  if (source === 'agent' && raw.approved !== true && state !== 'candidate') return fail('candidate-not-approved');
  for (const [field, text] of [['description', description], ['body', body]]) {
    const problem = textProblem(text);
    if (problem) return fail(`${field}-${problem}`);
  }
  return { ok: true, skill: { name, description, body, roles: roles.sort(), state, source, ...(source === 'agent' && raw.approved === true ? { approved: true } : {}) } };
}

/** Reads a SKILL.md (Claude Code's shape): a front matter with name and description, then the steps. */
function parseSkillFile(text) {
  if (typeof text !== 'string' || text.length > MAX_BODY + 2048) return fail('invalid-skill-file');
  const normal = text.replace(/\r\n?/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normal);
  if (!match) return fail('no-front-matter');
  const fields = {};
  for (const line of match[1].split('\n')) {
    const field = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (!field) continue;
    let value = field[2].trim();
    if (/^"(.*)"$/.test(value) || /^'(.*)'$/.test(value)) value = value.slice(1, -1);
    fields[field[1]] = value;
  }
  return { ok: true, draft: { name: fields.name ?? '', description: fields.description ?? '', body: match[2] } };
}

/** The SKILL.md of a skill, as Claude Code reads it from `.claude/skills/<name>/SKILL.md` (and Codex from `.agents/skills`). */
function renderSkillFile(skill) {
  return `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.body}\n`;
}

/** The library in the private store: one record per skill, saved only from the revision it was read at. */
class SkillLibrary {
  constructor(store) {
    if (!store || typeof store.get !== 'function' || typeof store.list !== 'function' || typeof store.transact !== 'function') throw new TypeError('private-store-required');
    this.store = store;
  }

  /** Every skill, by name; one that no longer passes the checks is listed as unusable, with why, and is never given to an agent. */
  list() {
    const listed = this.store.list(COLLECTION);
    if (!listed.ok) return fail(listed.reason || 'storage-unavailable');
    const skills = [];
    for (const entry of listed.items) {
      const value = entry.value;
      const checked = checkSkill(value);
      const revision = Number.isSafeInteger(value && value.revision) ? value.revision : 0;
      if (checked.ok) { skills.push({ ...checked.skill, revision, usable: true }); continue; }
      // Unusable: listed with what it was meant to be (so the owner sees which role groups miss it), and given to no one.
      const roles = Array.isArray(value?.roles) ? value.roles.filter((id) => typeof id === 'string' && ROLE_GROUP_ID.test(id)) : [];
      skills.push({ name: typeof value?.name === 'string' && NAME.test(value.name) ? value.name : String(entry.id ?? '?'), description: '', revision, usable: false, problem: checked.reason, state: STATES.includes(value?.state) ? value.state : 'disabled', roles });
    }
    return { ok: true, skills: skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) };
  }

  get(name) {
    if (typeof name !== 'string' || !NAME.test(name)) return fail('invalid-name');
    const loaded = this.store.get(COLLECTION, name);
    if (!loaded.ok) return fail(loaded.reason || 'storage-unavailable');
    if (!loaded.found) return fail('not-found');
    const checked = checkSkill(loaded.value);
    if (!checked.ok) return fail(checked.reason);
    return { ok: true, skill: { ...checked.skill, revision: Number.isSafeInteger(loaded.value.revision) ? loaded.value.revision : 0 } };
  }

  /**
   * Saves a skill. `expectedRevision` is the revision it was read at (0 for a new one): a skill changed in the meantime, or a new one
   * whose name is taken, is refused rather than overwritten.
   */
  save(raw, expectedRevision) {
    const checked = checkSkill(raw);
    if (!checked.ok) return checked;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return fail('invalid-revision');
    const skill = checked.skill;
    const result = this.store.transact((tx) => {
      const current = tx.get(COLLECTION, skill.name);
      const revision = current === null ? 0 : (Number.isSafeInteger(current.revision) ? current.revision : -1);
      if (revision !== expectedRevision) return { rejected: fail(current === null ? 'not-found' : expectedRevision === 0 ? 'name-taken' : 'stale-revision') };
      if (current === null && this.count(tx) >= MAX_SKILLS) return { rejected: fail('too-many-skills') };
      const saved = { ...skill, revision: revision + 1, updatedAt: new Date().toISOString() };
      tx.put(COLLECTION, skill.name, saved);
      return { saved };
    });
    if (!result.ok) return fail(result.reason || 'storage-unavailable');
    if (result.value.rejected) return result.value.rejected;
    return { ok: true, skill: result.value.saved };
  }

  count(tx) {
    const listed = tx.list(COLLECTION);
    return Array.isArray(listed) ? listed.length : 0;
  }

  /** In use, or not; which role groups get it. Each from the skill as it is now. */
  setState(name, state) {
    if (state !== 'active' && state !== 'disabled') return fail('invalid-state');
    const found = this.get(name);
    if (!found.ok) return found;
    if (found.skill.state === 'candidate') return fail('candidate-not-approved');
    return this.save({ ...found.skill, state }, found.skill.revision);
  }

  setRoles(name, roles) {
    const found = this.get(name);
    if (!found.ok) return found;
    return this.save({ ...found.skill, roles }, found.skill.revision);
  }

  /** The owner approves an agent's suggestion: it becomes an ordinary skill, still for no role group until one is chosen. */
  approve(name) {
    const found = this.get(name);
    if (!found.ok) return found;
    if (found.skill.state !== 'candidate') return fail('not-a-candidate');
    return this.save({ ...found.skill, state: 'active', approved: true }, found.skill.revision);
  }

  remove(name) {
    if (typeof name !== 'string' || !NAME.test(name)) return fail('invalid-name');
    const result = this.store.transact((tx) => {
      if (tx.get(COLLECTION, name) === null) return { rejected: fail('not-found') };
      tx.delete(COLLECTION, name);
      return { removed: true };
    });
    if (!result.ok) return fail(result.reason || 'storage-unavailable');
    return result.value.rejected ?? { ok: true };
  }

  /**
   * The skills an agent of a role group is given: in use, approved, for that role group, and still passing every check. Sorted by
   * name, so what an agent is told is the same at every start.
   */
  forRoleGroup(roleGroupId) {
    const listed = this.list();
    if (!listed.ok) return listed;
    return { ok: true, skills: listed.skills.filter((skill) => skill.usable && skill.state === 'active' && typeof roleGroupId === 'string' && skill.roles.includes(roleGroupId)) };
  }
}

module.exports = { SkillLibrary, checkSkill, parseSkillFile, renderSkillFile, textProblem, COLLECTION, NAME, MAX_BODY, MAX_DESCRIPTION, MAX_SKILLS };
