'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const nodePath = require('node:path');
const { LAYERS } = require('./rules');
const { byCodeUnit } = require('./order');
const { checkPrivateRoot, resolvers, isSameOrInside } = require('./paths');
const { builtIn } = require('../providers/registry');

const TOKEN = /^[A-Za-z0-9_-]{8,64}$/;
const PROFILE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * The parts of an agent's instructions, each as text: the heading, the rules, the reviewed project notes and the list of skills
 * (#359). An agent is given only each skill's name, one line and file: it reads a skill's file when it needs it, which is what
 * saves tokens. The parts are kept apart so the Workbench can show how much of each an agent was given.
 * @param {{ roleGroup?: any, rules?: any, memories?: any[], omitted?: any, skills?: Array<{ name: string, description: string, file: string }> }} [input]
 */
const TITLE_CHARS = 80;
// Not a skill name (those start with a letter or digit), so it can share the skills folder without meeting one.
const LEFT_OUT_FILE = '_left-out-notes.md';
/** A note's first line, as its title: at most 80 characters, cut at a character, with "…" when it was cut. */
function noteTitle(content) {
  const first = String(content ?? '').split('\n').map((text) => text.replace(/\s+/g, ' ').trim()).find((text) => text !== '') ?? '(empty note)';
  const chars = Array.from(first);
  return chars.length > TITLE_CHARS ? `${chars.slice(0, TITLE_CHARS - 1).join('')}…` : first;
}

/** The notes the size limit left out, in full, as the file the agent may read (#359). */
function leftOutNotesFile(items) {
  const blocks = [...items].sort((a, b) => byCodeUnit(a.id, b.id)).map((item) => `## ${noteTitle(item.content)}\n\n${item.content}\n\n(source: ${item.source.ref}; verified: ${item.verifiedAt.slice(0, 10)})`);
  return `# Project notes left out of your instructions\n\nReviewed notes of this project for your role group that did not fit in the size limit. Read one only when it fits what you are about to do.\n\n${blocks.join('\n\n')}\n`;
}

function renderSections({ roleGroup, rules, memories = [], omitted, skills = [] } = {}) {
  const lines = [roleGroup && typeof roleGroup.name === 'string' && roleGroup.name.trim() !== '' ? `# Role: ${roleGroup.name.trim()}` : '# Instructions'];
  const instructions = rules && Array.isArray(rules.instructions) ? rules.instructions : [];
  const forbids = rules && Array.isArray(rules.forbids) ? rules.forbids : [];
  const requires = rules && Array.isArray(rules.requires) ? rules.requires : [];
  const ruleLines = [...instructions]
    .sort((a, b) => LAYERS.indexOf(a.layer) - LAYERS.indexOf(b.layer) || byCodeUnit(a.id, b.id))
    .map((rule) => `- ${rule.text}`);
  if (forbids.length > 0) {
    ruleLines.push(`- Do not: ${forbids.map((rule) => rule.key).sort().join(', ')}`);
  }
  if (requires.length > 0) {
    ruleLines.push(`- Always: ${requires.map((rule) => rule.key).sort().join(', ')}`);
  }
  const head = lines.join('\n');
  // Each part starts with a blank line, exactly as the instructions were laid out before they had parts.
  const ruleText = ruleLines.length > 0 ? ['', '', '## Rules', ...ruleLines].join('\n') : '';

  // Stable ordering keeps the injected prefix identical between launches so the
  // provider's prompt cache can be reused.
  const memoryLines = [...(Array.isArray(memories) ? memories : [])]
    .sort((a, b) => byCodeUnit(a.id, b.id))
    .map((item) => `- ${item.content} (source: ${item.source.ref}; verified: ${item.verifiedAt.slice(0, 10)})`);
  // What the size limit left out is said, not dropped silently, so the model knows the list is partial. When the notes were written
  // to a file it may read (#359), each is listed by its first line, and the file is named: it reads one only when it fits its task.
  const left = omitted && Number.isInteger(omitted.count) && omitted.count > 0 ? omitted.count : 0;
  const listed = left > 0 && typeof omitted.file === 'string' && Array.isArray(omitted.items) ? omitted.items : null;
  if (listed) {
    memoryLines.push(`- (${left} more reviewed ${left === 1 ? 'note was' : 'notes were'} left out to stay within the size limit. Their full text is in ${omitted.file}; read it only when one of these fits what you are about to do:)`);
    for (const item of [...listed].sort((a, b) => byCodeUnit(a.id, b.id))) memoryLines.push(`  - ${noteTitle(item.content)}`);
  } else if (left > 0) memoryLines.push(`- (${left} more reviewed ${left === 1 ? 'note was' : 'notes were'} left out to stay within the size limit.)`);
  const memoryText = memoryLines.length > 0 ? ['', '', '## Project notes (reviewed, role-scoped)', ...memoryLines].join('\n') : '';
  // Sorted by name, like the notes, so the same skills give the same text at every start.
  const skillLines = [...(Array.isArray(skills) ? skills : [])]
    .sort((a, b) => byCodeUnit(a.name, b.name))
    .map((skill) => `- ${skill.name}: ${skill.description} (file: ${skill.file})`);
  const skillText = skillLines.length > 0
    ? ['', '', '## Skills', 'Step-by-step procedures you can use. Read a skill\'s file only when its line fits what you are about to do; do not read them all.', ...skillLines].join('\n')
    : '';
  return { head, rules: ruleText, memories: memoryText, skills: skillText };
}

function renderContext(input = {}) {
  const parts = renderSections(input);
  return `${parts.head}${parts.rules}${parts.memories}${parts.skills}\n`;
}

/** A rough count of tokens for what an agent is given (#359), labelled an estimate wherever it is shown: one per CJK character, one per four other characters. */
function estimateTokens(text) {
  if (typeof text !== 'string' || text === '') return 0;
  const wide = (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).length;
  return wide + Math.ceil((Array.from(text).length - wide) / 4);
}

/** How much of each part an agent was given: characters, and the estimate of tokens. */
function measureSections(parts) {
  const size = (text) => ({ chars: Array.from(text).length, tokens: estimateTokens(text) });
  const total = `${parts.head}${parts.rules}${parts.memories}${parts.skills}`;
  return { rules: size(parts.rules), memories: size(parts.memories), skills: size(parts.skills), total: size(total) };
}

function tomlString(text) {
  return JSON.stringify(text).replace(/\u007f/g, '\\u007f');
}

// The folder the Ask tab's answers are written to (#357), inside the folder the agent may use. Not a skill name (those begin with a letter
// or digit), so a skill can never be called the same.
const ANSWERS_DIR = '_answers';

// Builds a launch plan. The context text only ever goes into files under a
// private directory; argv carries a file path or a profile name, never content.
// `shown` is exactly the text the CLI is given, with the skill files where they are written, for the person to confirm.
function planInjection(options) {
  const { provider, roleGroup, rules, memories, omitted, privateDir, repoRoot, sessionToken,
    codexHome, capabilities = {}, context, skills = [] } = options;
  const descriptor = builtIn.get(provider);
  if (!descriptor) throw new Error('unsupported provider');
  if (!TOKEN.test(sessionToken || '')) throw new Error('invalid session token');

  const privateCheck = checkPrivateRoot(privateDir, repoRoot, context);
  if (!privateCheck.ok) throw new Error(`private directory rejected: ${privateCheck.problems.join(', ')}`);

  const sessionDir = nodePath.join(privateDir, 'sessions', sessionToken);
  // The skills given to this agent, each written as its own SKILL.md in a folder of this session (or, for Codex, next to its
  // profile in CODEX_HOME), never into the repository: the instructions list them by name, one line and that file.
  const skillFiles = (folder) => (Array.isArray(skills) ? skills : []).filter((skill) => SKILL_NAME.test(skill.name) && typeof skill.content === 'string')
    .map((skill) => ({ name: skill.name, description: skill.description, file: nodePath.join(folder, skill.name, 'SKILL.md'), content: skill.content }));
  // The notes the size limit left out go into the same readable folder as the skills, as one file (#359): no other folder is opened.
  const leftOut = omitted && Array.isArray(omitted.items) ? omitted.items.filter((item) => item && typeof item.content === 'string' && item.source && typeof item.source.ref === 'string' && typeof item.verifiedAt === 'string') : [];
  const notesIn = (folder) => (leftOut.length > 0 ? { path: nodePath.join(folder, LEFT_OUT_FILE), content: leftOutNotesFile(leftOut) } : null);
  const textWith = (listed, notes) => renderContext({ roleGroup, rules, memories, omitted: notes && omitted ? { ...omitted, file: notes.path, items: leftOut } : omitted, skills: listed });
  const text = textWith(skillFiles(nodePath.join(sessionDir, 'skills')), notesIn(nodePath.join(sessionDir, 'skills')));
  const scope = { root: privateDir, repoRoot, exclusiveDir: sessionDir };
  const manual = () => ({
    provider,
    method: 'manual',
    files: [{ path: nodePath.join(sessionDir, 'context.md'), content: text }, ...skillFiles(nodePath.join(sessionDir, 'skills')).map((skill) => ({ path: skill.file, content: skill.content })), ...[notesIn(nodePath.join(sessionDir, 'skills'))].filter(Boolean)],
    argv: [],
    shown: { text, skills: skillFiles(nodePath.join(sessionDir, 'skills')).map(({ name, description, file }) => ({ name, description, file })) },
    ...scope,
    note: 'Open the file and paste it into the terminal as the first message.'
  });

  if (descriptor.id === 'claude') {
    if (!capabilities.appendSystemPromptFile) return manual();
    const file = nodePath.join(sessionDir, 'claude-context.md');
    const skillsDir = nodePath.join(sessionDir, 'skills');
    const listed = skillFiles(skillsDir);
    const notes = notesIn(skillsDir);
    return {
      provider,
      method: 'append-system-prompt-file',
      files: [{ path: file, content: text }, ...listed.map((skill) => ({ path: skill.file, content: skill.content })), ...(notes ? [notes] : [])],
      // Claude Code may use the skills folder of this session (the skills, the notes left out and the answers it is asked to write,
      // #357 Ask), and nothing else of it. It is opened even without skills: questions from the Ask tab are answered in it.
      argv: ['--append-system-prompt-file', file, '--add-dir', skillsDir],
      answersDir: nodePath.join(skillsDir, ANSWERS_DIR),
      shown: { text, skills: listed.map(({ name, description, file: path }) => ({ name, description, file: path })) },
      ...scope
    };
  }

  if (descriptor.id === 'codex') {
    const profileName = `mas-${sessionToken}`;
    if (!capabilities.profileFlag || !codexHome || !PROFILE_NAME.test(profileName)) return manual();
    const homeCheck = checkPrivateRoot(codexHome, repoRoot, context);
    if (!homeCheck.ok) throw new Error(`CODEX_HOME rejected: ${homeCheck.problems.join(', ')}`);
    const file = nodePath.join(codexHome, `${profileName}.config.toml`);
    const listed = skillFiles(nodePath.join(codexHome, `${profileName}-skills`));
    const notes = notesIn(nodePath.join(codexHome, `${profileName}-skills`));
    return {
      provider,
      method: 'profile-developer-instructions',
      files: [{ path: file, content: `developer_instructions = ${tomlString(textWith(listed, notes))}\n` }, ...listed.map((skill) => ({ path: skill.file, content: skill.content })), ...(notes ? [notes] : [])],
      argv: ['-p', profileName],
      // Where Codex is asked to write the answers of the Ask tab (#357): next to its skills, in CODEX_HOME.
      answersDir: nodePath.join(codexHome, `${profileName}-skills`, ANSWERS_DIR),
      // What Codex is given lists its skills where they are written, next to its profile (#359): the confirmation shows this text.
      shown: { text: textWith(listed, notes), skills: listed.map(({ name, description, file: path }) => ({ name, description, file: path })) },
      root: codexHome,
      repoRoot,
      exclusiveDir: null
    };
  }

  // A registered provider with no dedicated injection path receives the same explicit
  // paste-by-hand plan used when a dedicated CLI flag is unavailable.
  return manual();
}

const lstatOrNull = (target) => {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

// What a created file or directory was at creation time. Removal later requires
// the same object to still be at that path, so a name that was replaced by
// someone else's file or directory is never deleted because it shares a path.
// `ino` of 0 means the file system does not report a usable identity.
const identityOf = (stat) => ({ dev: stat.dev, ino: stat.ino });
const sameIdentity = (stat, identity) => identity.ino !== 0n && stat.dev === identity.dev && stat.ino === identity.ino;
const digestOf = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const lstatBig = (target) => fs.lstatSync(target, { bigint: true });

// Directories we use must belong to the current user. Windows has no uid; its
// access control is the user profile's default and is not verified here.
function assertOwned(stat) {
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('private-path-not-owned');
  }
}

function assertOutsideRepo(target, plan, context) {
  const check = checkPrivateRoot(target, plan.repoRoot, context);
  if (!check.ok) throw new Error(`private-path-rejected: ${check.problems.join(', ')}`);
}

// Walks from the root down to `dir`, creating missing directories one at a time
// and recording exactly the ones this call created. Anything below the root that
// is a link, junction, file or someone else's directory is refused, and the
// final resolved location is checked against the repository again.
function ensureDirectory(plan, dir, created, context) {
  const { platform, realpath } = resolvers(context);
  const root = nodePath.resolve(plan.root);
  const target = nodePath.resolve(dir);
  const rel = nodePath.relative(root, target);
  if (rel === '..' || rel.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(rel)) {
    throw new Error('private-path-outside-root');
  }

  if (!lstatOrNull(root)) {
    const missing = [];
    for (let current = root; !lstatOrNull(current); current = nodePath.dirname(current)) missing.unshift(current);
    for (const directory of missing) {
      fs.mkdirSync(directory, { mode: 0o700 });
      created.push({ path: directory, kind: 'dir', identity: identityOf(lstatBig(directory)) });
    }
  }
  const rootStat = fs.statSync(root);
  if (!rootStat.isDirectory()) throw new Error('private-path-not-a-directory');
  assertOwned(rootStat);

  let current = root;
  const parts = rel === '' ? [] : rel.split(nodePath.sep);
  parts.forEach((part, index) => {
    current = nodePath.join(current, part);
    const entry = lstatOrNull(current);
    if (!entry) {
      fs.mkdirSync(current, { mode: 0o700 });
      created.push({ path: current, kind: 'dir', identity: identityOf(lstatBig(current)) });
      return;
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('private-path-not-a-directory');
    if (plan.exclusiveDir && index === parts.length - 1 && nodePath.resolve(plan.exclusiveDir) === current) {
      throw new Error('private-path-exists');
    }
    assertOwned(entry);
  });

  const realTarget = realpath(target);
  assertOutsideRepo(realTarget, plan, context);
  if (!isSameOrInside(nodePath, platform, realTarget, realpath(root))) {
    throw new Error('private-path-escapes-root');
  }
}

// Removes only what this plan created, and only if it is still the same object:
// a file must have the identity and the exact content that was written, a
// directory the identity it was created with. Anything else is left alone and
// reported by kind and reason (never by path).
function removeCreated(created) {
  const result = { removed: 0, skipped: [] };
  for (const item of [...created].reverse()) {
    const skip = (reason) => result.skipped.push({ kind: item.kind, reason });
    let entry;
    try {
      entry = lstatBig(item.path);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      skip(error.code || 'unreadable');
      continue;
    }
    if (entry.isSymbolicLink()) { skip('replaced-by-link'); continue; }
    if (!sameIdentity(entry, item.identity)) { skip(item.identity.ino === 0n ? 'identity-unavailable' : 'replaced'); continue; }
    try {
      if (item.kind === 'file') {
        if (!entry.isFile()) { skip('replaced'); continue; }
        if (entry.size !== BigInt(item.size) || digestOf(fs.readFileSync(item.path)) !== item.digest) {
          skip('content-changed');
          continue;
        }
        fs.unlinkSync(item.path);
      } else {
        if (!entry.isDirectory()) { skip('replaced'); continue; }
        fs.rmdirSync(item.path);
      }
      result.removed += 1;
    } catch (error) {
      // A directory that is no longer empty belongs to someone else now.
      if (['ENOTEMPTY', 'EEXIST'].includes(error.code)) skip('not-empty');
      else if (error.code !== 'ENOENT') throw error;
    }
  }
  created.length = 0;
  return result;
}

// Files are created exclusively (never over an existing file, so permissions on
// an existing file are never trusted) with owner-only mode. If anything fails,
// only what this call created is removed.
function writePlan(plan, context) {
  if (plan.created && plan.created.length > 0) throw new Error('plan-already-written');
  const created = [];
  try {
    for (const file of plan.files) {
      ensureDirectory(plan, nodePath.dirname(file.path), created, context);
      const descriptor = fs.openSync(file.path, 'wx', 0o600);
      const entry = { path: file.path, kind: 'file', identity: null, size: 0, digest: null };
      created.push(entry);
      try {
        const bytes = Buffer.from(file.content);
        fs.writeFileSync(descriptor, bytes);
        entry.identity = identityOf(fs.fstatSync(descriptor, { bigint: true }));
        entry.size = bytes.length;
        entry.digest = digestOf(bytes);
      } finally {
        fs.closeSync(descriptor);
      }
      assertOutsideRepo(resolvers(context).realpath(nodePath.dirname(file.path)), plan, context);
    }
    // The folder an agent writes its answers to exists from the start, under the same rules as every other folder of the plan.
    if (typeof plan.answersDir === 'string') {
      ensureDirectory(plan, plan.answersDir, created, context);
      assertOutsideRepo(resolvers(context).realpath(plan.answersDir), plan, context);
    }
  } catch (error) {
    // Whatever was created before the failure is removed by the same rules; an
    // entry whose identity was not recorded yet is left alone rather than guessed.
    for (const item of created) if (item.kind === 'file' && !item.identity) item.identity = { dev: 0n, ino: 0n };
    removeCreated(created);
    throw error;
  }
  plan.created = created;
}

// Removes only what writePlan created for this plan. It never deletes
// recursively, so unrelated files that appeared later are left alone.
function cleanupPlan(plan) {
  return plan.created ? removeCreated(plan.created) : { removed: 0, skipped: [] };
}

module.exports = { renderContext, renderSections, measureSections, estimateTokens, planInjection, writePlan, cleanupPlan, ANSWERS_DIR };
