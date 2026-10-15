'use strict';

const nodePath = require('node:path');
const { isPlainObject, label, safeText, validateRuleList } = require('./rule-input');

const { builtIn } = require('../providers/registry');
const PROVIDERS = Object.freeze(builtIn.ids());
// The tools a role group can grant or withhold. A tool that is not listed in a
// group is denied, so a new tool never becomes available by omission.
const TOOLS = Object.freeze(['shell', 'fileWrite', 'network', 'githubRead', 'githubWrite', 'merge']);
const LEVELS = Object.freeze(['deny', 'ask', 'allow']);
const MEMORY_MODES = Object.freeze(['role-group', 'off']);

const FIELDS = Object.freeze([
  'id', 'name', 'role', 'provider', 'defaultAccountProfileId', 'allowedScope', 'toolPermissions',
  'memoryScope', 'rules', 'version'
]);

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ROLE = /^[a-z][a-z0-9-]{0,31}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const MAX_NAME_CHARS = 80;
const MAX_SCOPE_ENTRIES = 100;
const MAX_PATH_CHARS = 200;
// Names Windows treats as devices, with or without an extension.
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// `.git`, and the short name Windows may give it (GIT~1), in any letter case.
const GIT_DIRECTORY = /^(?:\.git|git~\d+)$/i;

// A path prefix inside a repository, written with forward slashes and already in its
// simplest form. Anything that could be read as a pattern, point elsewhere, be shown
// differently from what it is, or that Windows would treat differently from macOS, is
// refused instead of being cleaned up. The allowed scope is data that a later component
// enforces, so it must not be open to interpretation.
//
//   * glob and Windows-reserved characters: * ? < > | " : and backslash
//   * control and Unicode format characters (\p{Cc}, \p{Cf}): bidirectional overrides,
//     zero-width characters and the like
//   * anything that is not already in NFC, so one name has one spelling
//   * any `.git` segment (and its Windows short name), whose hooks are executable
function validRelativePath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_PATH_CHARS) return false;
  if (/[\\*?<>|":\p{Cc}\p{Cf}]/u.test(value)) return false;
  if (value.normalize('NFC') !== value) return false;
  if (value.startsWith('/') || value.startsWith('~') || value.endsWith('/')) return false;
  if (nodePath.posix.normalize(value) !== value) return false;
  return value.split('/').every((part) => part !== '..' && !/[. ]$/.test(part === '.' ? 'x' : part) &&
    !WINDOWS_DEVICE.test(part) && !GIT_DIRECTORY.test(part));
}

function validRepository(value) {
  return typeof value === 'string' && REPOSITORY.test(value) &&
    value.split('/').every((part) => part !== '.' && part !== '..');
}

// Case-insensitive on both platforms we support, so two spellings of one name
// are one entry.
function uniqueList(list, valid, max, problems, path, code, fold = (value) => value.toLowerCase()) {
  if (!Array.isArray(list) || list.length > max) {
    problems.push({ code: 'invalid-scope', path });
    return null;
  }
  const seen = new Set();
  const out = [];
  list.forEach((value, index) => {
    if (!valid(value)) {
      problems.push({ code, path: `${path}[${index}]` });
      return;
    }
    const folded = fold(value);
    if (seen.has(folded)) {
      problems.push({ code: 'duplicate-entry', path: `${path}[${index}]` });
      return;
    }
    seen.add(folded);
    out.push(value);
  });
  return out;
}

// Checks a role group definition. Unknown fields, wrong types and unsafe values
// are all refused; nothing is repaired silently. On success returns a complete,
// normalised copy (every tool listed, memory scope filled in).
function validateRoleGroup(input) {
  const problems = [];
  const add = (code, path) => problems.push({ code, path });

  if (!isPlainObject(input)) return { ok: false, problems: [{ code: 'not-an-object', path: '' }] };
  for (const name of Object.keys(input)) {
    if (!FIELDS.includes(name)) add('unknown-field', label(name));
  }

  if (typeof input.id !== 'string' || !ID.test(input.id)) add('invalid-id', 'id');
  if (!safeText(input.name, MAX_NAME_CHARS) || /[\r\n]/.test(input.name)) add('invalid-name', 'name');
  if (typeof input.role !== 'string' || !ROLE.test(input.role)) add('invalid-role', 'role');
  if (!PROVIDERS.includes(input.provider)) add('invalid-provider', 'provider');
  if (!(Number.isInteger(input.version) && input.version >= 1 && input.version <= 1e9)) add('invalid-version', 'version');

  let defaultAccountProfileId = null;
  if (input.defaultAccountProfileId !== undefined && input.defaultAccountProfileId !== null) {
    if (typeof input.defaultAccountProfileId === 'string' && ID.test(input.defaultAccountProfileId)) {
      defaultAccountProfileId = input.defaultAccountProfileId;
    } else {
      add('invalid-account-profile-id', 'defaultAccountProfileId');
    }
  }

  // An empty list means nothing is allowed, never "everything".
  let allowedScope = null;
  if (!isPlainObject(input.allowedScope)) {
    add('invalid-scope', 'allowedScope');
  } else {
    for (const name of Object.keys(input.allowedScope)) {
      if (name !== 'repositories' && name !== 'paths') add('unknown-field', `allowedScope.${label(name)}`);
    }
    const repositories = uniqueList(input.allowedScope.repositories, validRepository, MAX_SCOPE_ENTRIES, problems,
      'allowedScope.repositories', 'invalid-repository');
    // Valid paths are already NFC, so folding the case is enough to find two spellings of one name.
    const paths = uniqueList(input.allowedScope.paths, validRelativePath, MAX_SCOPE_ENTRIES, problems,
      'allowedScope.paths', 'invalid-path', (value) => value.normalize('NFC').toLowerCase());
    if (repositories && paths) allowedScope = { repositories, paths };
  }

  const toolPermissions = Object.fromEntries(TOOLS.map((tool) => [tool, 'deny']));
  if (input.toolPermissions !== undefined) {
    if (!isPlainObject(input.toolPermissions)) {
      add('invalid-tool-permissions', 'toolPermissions');
    } else {
      for (const [tool, level] of Object.entries(input.toolPermissions)) {
        if (!TOOLS.includes(tool)) add('unknown-tool', `toolPermissions.${label(tool)}`);
        else if (!LEVELS.includes(level)) add('invalid-level', `toolPermissions.${tool}`);
        else toolPermissions[tool] = level;
      }
    }
  }

  let memoryScope = { mode: 'off' };
  if (input.memoryScope !== undefined) {
    const ok = isPlainObject(input.memoryScope) && Object.keys(input.memoryScope).length === 1 &&
      MEMORY_MODES.includes(input.memoryScope.mode);
    if (ok) memoryScope = { mode: input.memoryScope.mode };
    else add('invalid-memory-scope', 'memoryScope');
  }

  const ruleList = validateRuleList(input.rules, { layer: 'roleGroup', path: 'rules' });
  for (const problem of ruleList.problems) problems.push({ code: problem.code, path: problem.path });

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    problems,
    group: {
      id: input.id,
      name: input.name,
      role: input.role,
      provider: input.provider,
      version: input.version,
      defaultAccountProfileId,
      allowedScope,
      toolPermissions,
      memoryScope,
      rules: ruleList.rules
    }
  };
}

module.exports = { PROVIDERS, TOOLS, LEVELS, MEMORY_MODES, validateRoleGroup, validRelativePath, validRepository };
