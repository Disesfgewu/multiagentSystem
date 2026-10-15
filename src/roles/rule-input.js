'use strict';

const { TYPES } = require('../memory/rules');

const MAX_RULES_PER_LAYER = 200;
const MAX_TEXT_CHARS = 2000;

const RULE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const RULE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
// Ids that start with this are generated from a role group's tool permissions, so
// a rule that is typed in cannot collide with or imitate one.
const RESERVED_ID_PREFIX = 'rg:';
const ALLOWED_FIELDS = Object.freeze(['id', 'type', 'key', 'text', 'version', 'replaces', 'layer']);

// Characters that make text look different from how it is stored, or that cannot be seen:
// control characters other than newline and tab, the bidirectional overrides and isolates,
// zero-width and invisible formatting characters, and line or paragraph separators. The
// joiners U+200C and U+200D are allowed because scripts such as Persian and Indic need them.
// Written as code points so no invisible character has to appear in this file.
function isUnsafeCode(code) {
  return (code < 0x20 && code !== 0x0a && code !== 0x09) || code === 0x7f || (code >= 0x80 && code <= 0x9f) ||
    code === 0xad || code === 0x61c || code === 0x200b || code === 0x200e || code === 0x200f ||
    code === 0x2028 || code === 0x2029 || (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2064) || (code >= 0x2066 && code <= 0x2069) || code === 0xfeff;
}

const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

// An unexpected field name is reported only when it looks like a setting name
// (a short identifier, which helps fix a typo). Anything else, such as text that
// someone used as a key, is shown as `field` so it is never repeated back.
const SETTING_NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const label = (name) => (SETTING_NAME.test(String(name)) ? String(name) : 'field');

const safeText = (value, max) => typeof value === 'string' && value.length >= 1 && value.length <= max &&
  ![...value].some((char) => isUnsafeCode(char.codePointAt(0)));

// Checks one rule written by a person. Returns the problems found (codes and
// paths only, never the rule's text) and, when there are none, a clean copy.
// `layer` is the layer of the list the rule came from: a rule may restate it but
// can never claim a different one, so a project file cannot pose as a platform rule.
function validateRule(rule, { layer, path }) {
  const problems = [];
  const add = (code, field) => problems.push({ code, layer, path: field ? `${path}.${field}` : path });

  if (!isPlainObject(rule)) {
    add('rule-not-an-object');
    return { ok: false, problems };
  }
  for (const name of Object.keys(rule)) {
    if (!ALLOWED_FIELDS.includes(name)) add('unknown-field', label(name));
  }
  if (rule.layer !== undefined && rule.layer !== layer) add('layer-mismatch', 'layer');

  if (typeof rule.id !== 'string' || !RULE_ID.test(rule.id)) add('invalid-id', 'id');
  else if (rule.id.startsWith(RESERVED_ID_PREFIX)) add('reserved-id', 'id');

  if (!TYPES.includes(rule.type)) {
    add('invalid-type', 'type');
  } else if (rule.type === 'instruction') {
    if (!safeText(rule.text, MAX_TEXT_CHARS)) add('invalid-text', 'text');
    if (rule.key !== undefined) add('unexpected-key', 'key');
  } else {
    if (typeof rule.key !== 'string' || !RULE_KEY.test(rule.key)) add('invalid-key', 'key');
    if (rule.text !== undefined) add('unexpected-text', 'text');
  }

  if (rule.version !== undefined && !(Number.isInteger(rule.version) && rule.version >= 1 && rule.version <= 1e9)) {
    add('invalid-version', 'version');
  }
  if (rule.replaces !== undefined && (typeof rule.replaces !== 'string' || !RULE_ID.test(rule.replaces))) {
    add('invalid-replaces', 'replaces');
  }

  if (problems.length > 0) return { ok: false, problems };
  const clean = { id: rule.id, type: rule.type };
  if (rule.type === 'instruction') clean.text = rule.text;
  else clean.key = rule.key;
  if (rule.version !== undefined) clean.version = rule.version;
  if (rule.replaces !== undefined) clean.replaces = rule.replaces;
  return { ok: true, rule: clean, problems };
}

// A list of rules from one layer, with a size limit so a runaway file cannot
// make the preview unbounded.
function validateRuleList(list, { layer, path }) {
  if (list === undefined) return { ok: true, rules: [], problems: [] };
  if (!Array.isArray(list)) return { ok: false, rules: [], problems: [{ code: 'rules-not-a-list', layer, path }] };
  if (list.length > MAX_RULES_PER_LAYER) return { ok: false, rules: [], problems: [{ code: 'too-many-rules', layer, path }] };
  const rules = [];
  const problems = [];
  list.forEach((rule, index) => {
    const result = validateRule(rule, { layer, path: `${path}[${index}]` });
    if (result.ok) rules.push(result.rule);
    else problems.push(...result.problems);
  });
  return { ok: problems.length === 0, rules, problems };
}

module.exports = {
  MAX_RULES_PER_LAYER,
  MAX_TEXT_CHARS,
  RESERVED_ID_PREFIX,
  isPlainObject,
  isUnsafeCode,
  label,
  safeText,
  validateRule,
  validateRuleList
};
