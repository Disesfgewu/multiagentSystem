'use strict';

// Consent-gated installer for the bundled agent skills (resources/agent-skills) and the
// optional GitHub issue/PR templates (resources/agent-templates). It only ever creates new
// files: an existing file or skill directory is a conflict that is listed and skipped, a
// symlinked or non-directory path component refuses the whole operation, and removal deletes
// only files this installer recorded and whose content is byte-identical to what it wrote.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RECORD_VERSION = 1;
const RECORD_KEY_PREFIX = 'multiagentSystem.agentSkills.installed:';
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_SOURCE_BYTES = 64 * 1024;
const TEMPLATE_FILES = Object.freeze([
  { source: ['ISSUE_TEMPLATE', 'standard.md'], rel: '.github/ISSUE_TEMPLATE/standard.md' },
  { source: ['pull_request_template.md'], rel: '.github/pull_request_template.md' }
]);

// Claude Code reads project skills from .claude/skills/<name>/SKILL.md. No official, verified
// skill mechanism is known for the other providers, so nothing is written for them.
const PROVIDER_SUPPORT = Object.freeze({
  claude: Object.freeze({ label: 'Claude Code', supported: true, note: 'Writes .claude/skills/<name>/SKILL.md in this workspace.' }),
  codex: Object.freeze({ label: 'Codex', supported: false, note: 'Not supported: no verified official skill mechanism. Nothing is written for Codex.' }),
  agy: Object.freeze({ label: 'agy', supported: false, note: 'Not supported: no verified official skill mechanism. Nothing is written for agy.' })
});

class SkillsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// Only the Extension Test mode may skip the confirmation dialog. Any caller-supplied
// interactive:false/consent flag is ignored everywhere else.
function resolveInteractive(isTestMode, arg) {
  if (isTestMode !== true) return true;
  return !(arg && arg.interactive === false);
}

function readSourceFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) throw new SkillsError('source-invalid', `Bundled file is not a regular file: ${path.basename(file)}`);
  if (stat.size > MAX_SOURCE_BYTES) throw new SkillsError('source-invalid', `Bundled file is too large: ${path.basename(file)}`);
  return fs.readFileSync(file);
}

// Returns [{ rel, conflictRel, content, sha256 }] for every bundled skill, sorted by name.
// conflictRel is the skill directory: an existing directory with the same name is treated as
// a user's own skill and skipped as a whole.
function loadBundledSkills(skillsRoot) {
  let names;
  try {
    const rootStat = fs.lstatSync(skillsRoot);
    if (!rootStat.isDirectory()) throw new Error('not a directory');
    names = fs.readdirSync(skillsRoot, { withFileTypes: true });
  } catch (error) {
    if (error instanceof SkillsError) throw error;
    throw new SkillsError('source-missing', 'Bundled agent skills are missing from the extension.');
  }
  const entries = [];
  for (const entry of names) {
    if (!entry.isDirectory()) continue;
    if (!SKILL_NAME.test(entry.name)) throw new SkillsError('source-invalid', `Bundled skill has an invalid name: ${entry.name}`);
    const content = readSourceFile(path.join(skillsRoot, entry.name, 'SKILL.md'));
    entries.push({ rel: `.claude/skills/${entry.name}/SKILL.md`, conflictRel: `.claude/skills/${entry.name}`, content, sha256: sha256(content) });
  }
  if (entries.length === 0) throw new SkillsError('source-missing', 'Bundled agent skills are missing from the extension.');
  return entries.sort((a, b) => a.rel.localeCompare(b.rel));
}

function loadBundledTemplates(templatesRoot) {
  return TEMPLATE_FILES.map(({ source, rel }) => {
    let content;
    try { content = readSourceFile(path.join(templatesRoot, ...source)); } catch (error) {
      if (error instanceof SkillsError) throw error;
      throw new SkillsError('source-missing', `Bundled template is missing: ${rel}`);
    }
    return { rel, conflictRel: rel, content, sha256: sha256(content) };
  });
}

function lstatOrNull(target) {
  try { return fs.lstatSync(target); } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function assertWorkspaceRoot(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new SkillsError('workspace-invalid', 'The workspace folder path is not absolute.');
  let stat;
  try { stat = fs.statSync(root); } catch { throw new SkillsError('workspace-invalid', 'The workspace folder does not exist.'); }
  if (!stat.isDirectory()) throw new SkillsError('workspace-invalid', 'The workspace folder is not a directory.');
}

// Resolves a workspace-relative POSIX path. Absolute paths, drive letters, backslashes, empty
// or dot segments and anything that resolves outside the workspace are refused.
function resolveInside(root, rel) {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 512 || rel.includes('\\') || rel.includes('\0') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) {
    throw new SkillsError('path-escape', `Refused path outside the workspace: ${String(rel)}`);
  }
  const parts = rel.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) throw new SkillsError('path-escape', `Refused path outside the workspace: ${rel}`);
  const resolved = path.resolve(root, ...parts);
  const relative = path.relative(root, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) throw new SkillsError('path-escape', `Refused path outside the workspace: ${rel}`);
  return { resolved, parts };
}

// Every existing parent directory between the workspace and the target must be a real
// directory (lstat, so a symlink is refused rather than followed).
function assertParentsSafe(root, parts) {
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const stat = lstatOrNull(current);
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new SkillsError('symlink-refused', `Refused symlinked folder: ${path.relative(root, current).split(path.sep).join('/')}`);
    if (!stat.isDirectory()) throw new SkillsError('not-directory', `Refused because this path is not a folder: ${path.relative(root, current).split(path.sep).join('/')}`);
  }
}

// 'write' | 'conflict'; throws SkillsError for a refused path.
function classify(root, entry) {
  const target = resolveInside(root, entry.rel);
  const guard = resolveInside(root, entry.conflictRel || entry.rel);
  assertParentsSafe(root, target.parts);
  if (lstatOrNull(guard.resolved)) return 'conflict';
  if (lstatOrNull(target.resolved)) return 'conflict';
  return 'write';
}

// Read-only. Never creates anything; used to build the confirmation dialog.
function planInstall(root, entries) {
  assertWorkspaceRoot(root);
  const writes = [];
  const conflicts = [];
  for (const entry of entries) {
    if (classify(root, entry) === 'write') writes.push(entry); else conflicts.push(entry.rel);
  }
  return { writes, conflicts };
}

function ensureParents(root, parts, createdDirs) {
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const stat = lstatOrNull(current);
    if (stat) {
      if (stat.isSymbolicLink()) throw new SkillsError('symlink-refused', `Refused symlinked folder: ${path.relative(root, current).split(path.sep).join('/')}`);
      if (!stat.isDirectory()) throw new SkillsError('not-directory', `Refused because this path is not a folder: ${path.relative(root, current).split(path.sep).join('/')}`);
      continue;
    }
    fs.mkdirSync(current); // Non-recursive: fails if something appeared in the meantime.
    createdDirs.push(path.relative(root, current).split(path.sep).join('/'));
  }
}

// Writes to a temporary file in the target folder, then publishes it without ever replacing an
// existing file: a hard link fails with EEXIST if the target appeared after planning. On file
// systems without hard links it falls back to a rename after a fresh lstat check.
function writeNewFileAtomic(target, content, io = fs) {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const fd = io.openSync(temp, 'wx', 0o644);
  let open = true;
  // One finally covers write, fsync, close and publish: the temporary file never survives.
  try {
    io.writeSync(fd, content);
    io.fsyncSync(fd);
    open = false;
    io.closeSync(fd);
    try {
      io.linkSync(temp, target);
    } catch (error) {
      if (error && error.code === 'EEXIST') return false;
      if (!error || !['EPERM', 'ENOTSUP', 'ENOSYS', 'EXDEV', 'EACCES'].includes(error.code)) throw error;
      if (lstatOrNull(target)) return false;
      io.renameSync(temp, target);
    }
    return true;
  } finally {
    if (open) { try { io.closeSync(fd); } catch { /* already failing */ } }
    try { io.unlinkSync(temp); } catch { /* already renamed or never created */ }
  }
}

// Writes only what planInstall approved, re-checking each path right before writing.
function applyInstall(root, writes) {
  assertWorkspaceRoot(root);
  const written = [];
  const conflicts = [];
  const createdDirs = [];
  let error;
  try {
    for (const entry of writes) {
      if (classify(root, entry) !== 'write') { conflicts.push(entry.rel); continue; }
      const { resolved, parts } = resolveInside(root, entry.rel);
      ensureParents(root, parts, createdDirs);
      if (writeNewFileAtomic(resolved, entry.content)) written.push({ path: entry.rel, sha256: entry.sha256 });
      else conflicts.push(entry.rel);
    }
  } catch (caught) {
    // Stop at the first refusal but still return what was written so it is recorded.
    error = caught;
  }
  return { written, conflicts, createdDirs, error };
}

const recordKey = (root) => `${RECORD_KEY_PREFIX}${root}`;

// The installer only ever writes these shapes, so a record naming anything else (an escaping,
// absolute or unrelated path) has been tampered with or corrupted.
const SKILL_FILE_PATH = /^\.claude\/skills\/[a-z0-9][a-z0-9-]{0,63}\/SKILL\.md$/;
const SKILL_DIR_PATH = /^\.claude(?:\/skills(?:\/[a-z0-9][a-z0-9-]{0,63})?)?$/;
const TEMPLATE_DIRS = new Set(['.github', '.github/ISSUE_TEMPLATE']);
const isRecordedFilePath = (value) => typeof value === 'string' && (SKILL_FILE_PATH.test(value) || TEMPLATE_FILES.some((file) => file.rel === value));
const isRecordedDirPath = (value) => typeof value === 'string' && (SKILL_DIR_PATH.test(value) || TEMPLATE_DIRS.has(value));

// Strict parse: anything unexpected makes the whole record unusable, so removal deletes nothing.
function parseRecord(value) {
  if (value === undefined || value === null) return { version: RECORD_VERSION, files: [], dirs: [] };
  if (typeof value !== 'object' || Array.isArray(value) || value.version !== RECORD_VERSION || !Array.isArray(value.files) || !Array.isArray(value.dirs)) return null;
  const files = [];
  for (const file of value.files) {
    if (!file || !isRecordedFilePath(file.path) || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) return null;
    files.push({ path: file.path, sha256: file.sha256 });
  }
  if (!value.dirs.every(isRecordedDirPath)) return null;
  return { version: RECORD_VERSION, files, dirs: [...value.dirs] };
}

function readRecord(store, root) {
  const record = parseRecord(store.get(recordKey(root)));
  if (!record) throw new SkillsError('record-invalid', 'The record of installed agent skills is unreadable, so nothing was changed.');
  return record;
}

async function saveRecord(store, root, record) {
  await store.update(recordKey(root), record.files.length || record.dirs.length ? record : undefined);
}

function mergeRecord(record, result) {
  const files = record.files.filter((file) => !result.written.some((item) => item.path === file.path)).concat(result.written);
  const dirs = record.dirs.concat(result.createdDirs.filter((dir) => !record.dirs.includes(dir)));
  return { version: RECORD_VERSION, files, dirs };
}

// Each recorded file is 'remove' (unchanged, ours), 'modified', 'missing' or 'refused'.
function planRemoval(root, record) {
  assertWorkspaceRoot(root);
  return record.files.map((file) => {
    try {
      const { resolved, parts } = resolveInside(root, file.path);
      assertParentsSafe(root, parts);
      const stat = lstatOrNull(resolved);
      if (!stat) return { ...file, status: 'missing' };
      if (!stat.isFile()) return { ...file, status: 'modified' };
      return { ...file, status: sha256(fs.readFileSync(resolved)) === file.sha256 ? 'remove' : 'modified' };
    } catch (error) {
      if (error instanceof SkillsError) return { ...file, status: 'refused', reason: error.message };
      throw error;
    }
  });
}

function applyRemoval(root, record, plan) {
  assertWorkspaceRoot(root);
  const removed = [];
  const kept = [];
  for (const item of plan) {
    if (item.status !== 'remove') { if (item.status !== 'missing') kept.push(item); continue; }
    // Re-check right before deleting: the user may have edited it after confirming.
    const [fresh] = planRemoval(root, { files: [item] });
    if (fresh.status === 'remove') { fs.unlinkSync(resolveInside(root, item.path).resolved); removed.push(item.path); } else if (fresh.status !== 'missing') kept.push(fresh);
  }
  const remainingDirs = [];
  for (const dir of [...record.dirs].sort((a, b) => b.length - a.length)) {
    try {
      const { resolved, parts } = resolveInside(root, dir);
      assertParentsSafe(root, parts);
      const stat = lstatOrNull(resolved);
      if (!stat) continue;
      if (!stat.isDirectory() || stat.isSymbolicLink()) { remainingDirs.push(dir); continue; }
      fs.rmdirSync(resolved); // Only succeeds when empty; user files keep the folder.
    } catch {
      remainingDirs.push(dir);
    }
  }
  const nextRecord = { version: RECORD_VERSION, files: kept.map(({ path: p, sha256: s }) => ({ path: p, sha256: s })), dirs: remainingDirs.reverse() };
  return { removed, kept, record: nextRecord };
}

function providerSupportLines() {
  return Object.values(PROVIDER_SUPPORT).map((provider) => `${provider.label}: ${provider.supported ? 'supported' : 'not supported'} - ${provider.note}`);
}

function listBlock(title, items) {
  return items.length ? [title, ...items.map((item) => `  ${item}`)] : [];
}

function errorResult(error) {
  if (error instanceof SkillsError) return { ok: false, code: error.code, message: error.message };
  return { ok: false, code: 'failed', message: error && error.message ? error.message : 'Agent skills operation failed.' };
}

// Command flow, independent of VS Code. ui.confirm(message, detail, button) resolves true only
// on an explicit click of `button`; ui.info/ui.error report results.
async function runInstall(deps) {
  const { isTestMode, arg, workspaceRoot, skillsRoot, templatesRoot, store, ui } = deps;
  const interactive = resolveInteractive(isTestMode, arg);
  const report = (result) => {
    if (interactive) {
      if (result.ok) ui.info(result.message); else if (result.code !== 'cancelled') ui.error(result.message);
    }
    return result;
  };
  try {
    if (!workspaceRoot) return report({ ok: false, code: 'no-workspace', message: 'Open a workspace folder before installing agent skills.' });
    let record = readRecord(store, workspaceRoot);
    const skills = loadBundledSkills(skillsRoot);
    const plan = planInstall(workspaceRoot, skills);
    let skillResult = { written: [], conflicts: plan.conflicts, createdDirs: [] };
    if (plan.writes.length > 0) {
      if (interactive) {
        const detail = [
          ...listBlock(`These ${plan.writes.length} new files will be written in this workspace:`, plan.writes.map((entry) => entry.rel)),
          ...listBlock('Already present, will NOT be overwritten (skipped):', plan.conflicts),
          '',
          ...providerSupportLines(),
          '',
          'Nothing is written until you choose Install. Existing files are never overwritten.'
        ].join('\n');
        if (!await ui.confirm('Install agent skills for Claude Code in this workspace?', detail, 'Install')) return { ok: false, code: 'cancelled', message: 'Nothing was written.' };
      }
      skillResult = applyInstall(workspaceRoot, plan.writes);
      skillResult.conflicts = plan.conflicts.concat(skillResult.conflicts);
      record = mergeRecord(record, skillResult);
      await saveRecord(store, workspaceRoot, record);
      if (skillResult.error) throw skillResult.error;
    }

    let templateResult = { written: [], conflicts: [], createdDirs: [], offered: false };
    const wantsTemplates = interactive ? true : Boolean(arg && arg.includeTemplates === true);
    if (wantsTemplates && templatesRoot) {
      const templatePlan = planInstall(workspaceRoot, loadBundledTemplates(templatesRoot));
      if (templatePlan.writes.length > 0) {
        let accepted = true;
        if (interactive) {
          const detail = [
            ...listBlock('These new files will be written:', templatePlan.writes.map((entry) => entry.rel)),
            ...listBlock('Already present, will NOT be overwritten (skipped):', templatePlan.conflicts),
            '',
            'Optional. Choose Add Templates only if this project should use these issue and pull request formats.'
          ].join('\n');
          accepted = await ui.confirm('Also add GitHub issue and pull request templates?', detail, 'Add Templates');
        }
        if (accepted) {
          templateResult = { ...applyInstall(workspaceRoot, templatePlan.writes), offered: true };
          templateResult.conflicts = templatePlan.conflicts.concat(templateResult.conflicts);
          record = mergeRecord(record, templateResult);
          await saveRecord(store, workspaceRoot, record);
          if (templateResult.error) throw templateResult.error;
        } else {
          templateResult = { written: [], conflicts: templatePlan.conflicts, createdDirs: [], offered: true };
        }
      } else {
        templateResult = { written: [], conflicts: templatePlan.conflicts, createdDirs: [], offered: false };
      }
    }

    const written = skillResult.written.concat(templateResult.written).map((file) => file.path);
    const conflicts = skillResult.conflicts.concat(templateResult.conflicts);
    const message = written.length
      ? `Wrote ${written.length} file(s) for Claude Code.${conflicts.length ? ` Skipped ${conflicts.length} existing: ${conflicts.join(', ')}.` : ''} Codex and agy are not supported.`
      : `No files written.${conflicts.length ? ` Already present and left unchanged: ${conflicts.join(', ')}.` : ''}`;
    return report({ ok: true, code: written.length ? 'installed' : 'nothing-to-write', written, conflicts, message });
  } catch (error) {
    return report(errorResult(error));
  }
}

async function runRemove(deps) {
  const { isTestMode, arg, workspaceRoot, store, ui } = deps;
  const interactive = resolveInteractive(isTestMode, arg);
  const report = (result) => {
    if (interactive) {
      if (result.ok) ui.info(result.message); else if (result.code !== 'cancelled') ui.error(result.message);
    }
    return result;
  };
  try {
    if (!workspaceRoot) return report({ ok: false, code: 'no-workspace', message: 'Open a workspace folder first.' });
    assertWorkspaceRoot(workspaceRoot);
    const record = readRecord(store, workspaceRoot);
    const plan = planRemoval(workspaceRoot, record);
    const toRemove = plan.filter((item) => item.status === 'remove').map((item) => item.path);
    const kept = plan.filter((item) => item.status === 'modified' || item.status === 'refused').map((item) => item.path);
    if (toRemove.length === 0) {
      const next = applyRemoval(workspaceRoot, record, plan);
      await saveRecord(store, workspaceRoot, next.record);
      return report({ ok: true, code: 'nothing-to-remove', removed: [], kept, message: kept.length ? `Nothing removed. Changed since install, left in place: ${kept.join(', ')}.` : 'No agent skills installed by Multiagent were found in this workspace.' });
    }
    if (interactive) {
      const detail = [
        ...listBlock(`These ${toRemove.length} files were written by Multiagent and are unchanged; they will be deleted:`, toRemove),
        ...listBlock('Changed since install, will be kept:', kept),
        '',
        'Files you created or edited are never deleted.'
      ].join('\n');
      if (!await ui.confirm('Remove agent skills installed by Multiagent?', detail, 'Remove')) return { ok: false, code: 'cancelled', message: 'Nothing was removed.' };
    }
    const next = applyRemoval(workspaceRoot, record, plan);
    await saveRecord(store, workspaceRoot, next.record);
    const keptPaths = next.kept.map((item) => item.path);
    return report({ ok: true, code: 'removed', removed: next.removed, kept: keptPaths, message: `Removed ${next.removed.length} file(s).${keptPaths.length ? ` Kept changed files: ${keptPaths.join(', ')}.` : ''}` });
  } catch (error) {
    return report(errorResult(error));
  }
}

module.exports = {
  PROVIDER_SUPPORT,
  RECORD_KEY_PREFIX,
  SkillsError,
  applyInstall,
  applyRemoval,
  loadBundledSkills,
  loadBundledTemplates,
  parseRecord,
  planInstall,
  planRemoval,
  providerSupportLines,
  recordKey,
  resolveInteractive,
  runInstall,
  runRemove,
  writeNewFileAtomic
};
