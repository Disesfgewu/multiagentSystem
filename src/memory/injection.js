'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const nodePath = require('node:path');
const { LAYERS } = require('./rules');
const { checkPrivateRoot, resolvers, isSameOrInside } = require('./paths');

const TOKEN = /^[A-Za-z0-9_-]{8,64}$/;
const PROFILE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

function renderContext({ roleGroup, rules, memories }) {
  const lines = [`# Role: ${roleGroup.name}`];
  const ruleLines = [...rules.instructions]
    .sort((a, b) => LAYERS.indexOf(a.layer) - LAYERS.indexOf(b.layer) || a.id.localeCompare(b.id))
    .map((rule) => `- ${rule.text}`);
  if (rules.forbids.length > 0) {
    ruleLines.push(`- Do not: ${rules.forbids.map((rule) => rule.key).sort().join(', ')}`);
  }
  if (rules.requires.length > 0) {
    ruleLines.push(`- Always: ${rules.requires.map((rule) => rule.key).sort().join(', ')}`);
  }
  if (ruleLines.length > 0) lines.push('', '## Rules', ...ruleLines);

  // Stable ordering keeps the injected prefix identical between launches so the
  // provider's prompt cache can be reused.
  const memoryLines = [...memories]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((item) => `- ${item.content} (source: ${item.source.ref}; verified: ${item.verifiedAt.slice(0, 10)})`);
  if (memoryLines.length > 0) lines.push('', '## Project notes (reviewed, role-scoped)', ...memoryLines);
  return `${lines.join('\n')}\n`;
}

function tomlString(text) {
  return JSON.stringify(text).replace(/\u007f/g, '\\u007f');
}

// Builds a launch plan. The context text only ever goes into files under a
// private directory; argv carries a file path or a profile name, never content.
function planInjection(options) {
  const { provider, roleGroup, rules, memories, privateDir, repoRoot, sessionToken,
    codexHome, capabilities = {}, context } = options;
  if (!TOKEN.test(sessionToken || '')) throw new Error('invalid session token');

  const privateCheck = checkPrivateRoot(privateDir, repoRoot, context);
  if (!privateCheck.ok) throw new Error(`private directory rejected: ${privateCheck.problems.join(', ')}`);

  const text = renderContext({ roleGroup, rules, memories });
  const sessionDir = nodePath.join(privateDir, 'sessions', sessionToken);
  const scope = { root: privateDir, repoRoot, exclusiveDir: sessionDir };
  const manual = () => ({
    provider,
    method: 'manual',
    files: [{ path: nodePath.join(sessionDir, 'context.md'), content: text }],
    argv: [],
    ...scope,
    note: 'Open the file and paste it into the terminal as the first message.'
  });

  if (provider === 'claude') {
    if (!capabilities.appendSystemPromptFile) return manual();
    const file = nodePath.join(sessionDir, 'claude-context.md');
    return {
      provider,
      method: 'append-system-prompt-file',
      files: [{ path: file, content: text }],
      argv: ['--append-system-prompt-file', file],
      ...scope
    };
  }

  if (provider === 'codex') {
    const profileName = `mas-${sessionToken}`;
    if (!capabilities.profileFlag || !codexHome || !PROFILE_NAME.test(profileName)) return manual();
    const homeCheck = checkPrivateRoot(codexHome, repoRoot, context);
    if (!homeCheck.ok) throw new Error(`CODEX_HOME rejected: ${homeCheck.problems.join(', ')}`);
    const file = nodePath.join(codexHome, `${profileName}.config.toml`);
    return {
      provider,
      method: 'profile-developer-instructions',
      files: [{ path: file, content: `developer_instructions = ${tomlString(text)}\n` }],
      argv: ['-p', profileName],
      root: codexHome,
      repoRoot,
      exclusiveDir: null
    };
  }

  throw new Error(`unsupported provider: ${provider}`);
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

module.exports = { renderContext, planInjection, writePlan, cleanupPlan };
