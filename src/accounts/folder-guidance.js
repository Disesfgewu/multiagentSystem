'use strict';

const fs = require('node:fs');
const { pathFor, canonicalize, isSameOrInside } = require('../shared/paths');
const { validateProfile, findConfigDirConflicts, PROVIDERS } = require('./profile');
const { byCodeUnit } = require('../memory/order');

// Plain-language help for the account configuration folder. A folder can be refused for many
// reasons, and a code alone tells a person nothing. Every reason the checks can give has a
// message and a way to fix it, a safe place is suggested instead of the home folder, and the
// folder can be checked as soon as it is chosen.
//
// Messages never contain a path: they are shown in notifications that can be copied, and the
// account folder is private. A folder is only ever named by what the person typed (the label).

const EXPLANATIONS = Object.freeze({
  'config-dir-inside-repo': {
    message: 'This folder is inside your current project, so the account\'s sign-in data could end up in your repository.',
    fix: 'Choose a new folder outside the project, or use the recommended folder.'
  },
  'config-dir-contains-repo': {
    message: 'This folder contains your current project. An account folder must not hold your code.',
    fix: 'Choose a new, empty folder that does not contain the project, or use the recommended folder.'
  },
  'config-dir-is-provider-default': {
    message: 'This is the folder the command-line tool already uses for its own sign-in. Using it would mix this account with the one you use outside this extension.',
    fix: 'Choose a different, new folder, or use the recommended folder.'
  },
  'config-dir-is-home': {
    message: 'This is your home folder. It holds everything you own, so it cannot be an account folder.',
    fix: 'Choose a new folder inside it, or use the recommended folder.'
  },
  'config-dir-is-recommended-root': {
    message: 'This folder holds the account folders this extension creates. Each account needs its own folder inside it, not the folder itself.',
    fix: 'Use the recommended folder, or choose a new folder inside it.'
  },
  'recommended-root-unsafe': {
    message: 'The folder where recommended account folders go already exists but is not private to you (it belongs to someone else, other users can change it, or it is a link).',
    fix: 'Remove or rename that folder yourself, or choose a different folder instead.'
  },
  'config-dir-rejected': {
    message: 'This account\'s folder no longer passes the safety checks (it moved, was replaced by a link, or now overlaps another account).',
    fix: 'Edit the account and choose its folder again.'
  },
  'config-dir-not-directory': {
    message: 'The chosen path is a file, not a folder.',
    fix: 'Choose a folder, or use the recommended folder.'
  },
  'config-dir-owner-mismatch': {
    message: 'This folder belongs to another user on this computer, so it is not private to you.',
    fix: 'Choose a folder you own, or use the recommended folder.'
  },
  'config-dir-unresolvable': {
    message: 'This folder cannot be checked safely (for example, it is a broken link or cannot be read).',
    fix: 'Choose another folder, or use the recommended folder.'
  },
  'config-dir-unreadable': {
    message: 'This folder cannot be read.',
    fix: 'Choose a folder you can read and write, or use the recommended folder.'
  },
  'config-dir-not-a-directory': {
    message: 'The chosen path is not a folder.',
    fix: 'Choose a folder, or use the recommended folder.'
  },
  'config-dir-not-absolute': {
    message: 'The folder must be a full path on this computer.',
    fix: 'Pick the folder with the folder chooser instead of typing it.'
  },
  'repo-root-unresolvable': {
    message: 'The current project folder cannot be checked, so the extension cannot tell whether this folder is safe.',
    fix: 'Open a project folder again and retry.'
  },
  'provider-default-unresolvable': {
    message: 'The command-line tool\'s own folder cannot be checked, so the extension cannot tell whether this folder is safe.',
    fix: 'Check that your home folder is readable, then retry.'
  },
  'config-dir-conflict:same': {
    message: 'Another account already uses this folder. Two accounts in one folder would share one sign-in.',
    fix: 'Give each account its own folder, or use the recommended folder.'
  },
  'config-dir-conflict:nested': {
    message: 'This folder is inside, or around, the folder of another account. Accounts must not overlap.',
    fix: 'Choose a separate folder for this account, or use the recommended folder.'
  },
  'config-dir-conflict:unresolvable': {
    message: 'The folder of another account cannot be checked, so overlap cannot be ruled out.',
    fix: 'Open the account list, check the other account, then retry.'
  },
  'duplicate-label': {
    message: 'Another account for this provider already has this label. Labels must differ so accounts are not mixed up.',
    fix: 'Choose a different label.'
  },
  'label-missing': { message: 'The account needs a label.', fix: 'Enter a short label such as Work or Personal.' },
  'profile-id-missing': { message: 'The account has no internal id.', fix: 'Retry creating the account.' },
  'provider-unsupported': { message: 'This provider is not supported for accounts.', fix: 'Choose one of the providers in the list.' },
  'too-many-profiles': { message: 'The maximum number of accounts was reached.', fix: 'Remove an account you no longer use.' }
});

const GENERIC = Object.freeze({
  message: 'This folder cannot be used for an account.',
  fix: 'Choose a different folder, or use the recommended folder.'
});

/** Every code the checks can give, with its explanation. Unknown codes still get a usable, honest message. */
function explainProblem(code) {
  const entry = typeof code === 'string' && Object.hasOwn(EXPLANATIONS, code) ? EXPLANATIONS[code] : undefined;
  return entry ? { code, known: true, ...entry } : { code: typeof code === 'string' ? code : 'unknown', known: false, ...GENERIC };
}

function explainFailure(result) {
  const codes = [];
  if (result && Array.isArray(result.problems)) codes.push(...result.problems);
  if (result && result.code === 'config-dir-conflict') codes.push(`config-dir-conflict:${result.kind || 'same'}`);
  if (result && result.code === 'duplicate-label') codes.push('duplicate-label');
  if (result && result.code === 'config-dir-rejected') codes.push('config-dir-rejected');
  if (result && result.code === 'too-many-profiles') codes.push('too-many-profiles');
  const items = [...new Set(codes)].map(explainProblem);
  return items;
}

const slug = (label) => {
  const cleaned = String(label || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  return cleaned || 'account';
};

const PARENT_NAME = 'multiagent-accounts';

/**
 * A recommended place for an account's folder: a dedicated, visible folder under the home folder,
 * one sub-folder per account (`<provider>-<label>`), never one that already exists.
 */
function suggestFolder({ homeDir, provider, label, platform = process.platform, exists = (target) => fs.existsSync(target) }) {
  if (typeof homeDir !== 'string' || !Object.hasOwn(PROVIDERS, provider)) throw new TypeError('homeDir and a supported provider are required');
  const p = pathFor(platform);
  const parent = p.join(homeDir, PARENT_NAME);
  const base = `${provider}-${slug(label)}`;
  let name = base;
  for (let n = 2; exists(p.join(parent, name)); n += 1) {
    if (n > 99) throw new Error('no free recommended folder');
    name = `${base}-${n}`;
  }
  return { parent, dir: p.join(parent, name), name };
}

/**
 * Checks a folder before anything is saved, the same way saving will: the safety checks, the other
 * accounts' folders, and the label. `profiles` are the existing profiles.
 */
function checkFolder({ provider, label, configDir, profiles = [], context }) {
  const candidate = { id: 'candidate-profile', provider, label: typeof label === 'string' && label.trim() ? label : 'candidate', configDir };
  const validation = validateProfile(candidate, context);
  const problems = [...validation.problems];
  if (validation.ok) {
    const conflicts = findConfigDirConflicts([...profiles, candidate], context).filter((entry) => entry.a === candidate.id || entry.b === candidate.id);
    for (const entry of conflicts) problems.push(`config-dir-conflict:${entry.kind}`);
  }
  if (validation.ok) {
    const p = pathFor((context && context.platform) || process.platform);
    const home = context && context.homeDir;
    if (typeof home === 'string') {
      try {
        const real = (value) => canonicalize(value, p, (target) => fs.realpathSync.native(target), (target) => fs.statSync(target).isDirectory(), (target) => fs.lstatSync(target));
        const dir = real(configDir);
        const root = real(p.join(home, PARENT_NAME));
        if (isSameOrInside(p, (context && context.platform) || process.platform, dir, root) && isSameOrInside(p, (context && context.platform) || process.platform, root, dir)) problems.push('config-dir-is-recommended-root');
      } catch { /* a path that cannot be resolved was already reported by the checks above */ }
    }
  }
  const twin = profiles.find((other) => other.provider === provider && typeof other.label === 'string' && typeof label === 'string' && other.label.trim().toLowerCase() === label.trim().toLowerCase());
  if (twin) problems.push('duplicate-label');
  return { ok: problems.length === 0, problems, items: [...new Set(problems)].sort(byCodeUnit).map(explainProblem) };
}

// A recommended root that already exists must be a real folder (not a link), owned by this user
// and not writable by anyone else, or another user could swap an account folder for their own.
function existingRootProblem(parent, io) {
  let stat;
  try {
    stat = (io.lstatSync || fs.lstatSync)(parent);
  } catch (error) {
    return error && error.code === 'ENOENT' ? null : 'recommended-root-unsafe';
  }
  if (typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink()) return 'recommended-root-unsafe';
  if (typeof stat.isDirectory === 'function' && !stat.isDirectory()) return 'recommended-root-unsafe';
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return 'recommended-root-unsafe';
    if ((stat.mode & 0o022) !== 0) return 'recommended-root-unsafe';
  }
  return null;
}

/**
 * Removes folders a failed save left behind: only the ones listed (made by this extension a moment
 * ago), only while empty, deepest first. Anything that has content, or was not listed, stays.
 */
function discardCreated(folders, io = fs) {
  const removed = [];
  for (const target of [...(Array.isArray(folders) ? folders : [])].reverse()) {
    try {
      io.rmdirSync(target);
      removed.push(target);
    } catch { /* not empty, or already gone: leave it */ }
  }
  return removed;
}

/**
 * Creates the recommended folder after checking it, with owner-only permissions. Only folders this
 * call created are ever removed, and only if the folder fails the check after it was created (for
 * example a link in the way). Nothing is created inside the project.
 */
function createRecommendedFolder({ provider, label, suggestion, profiles = [], context, io = fs }) {
  const before = checkFolder({ provider, label, configDir: suggestion.dir, profiles, context });
  if (!before.ok) return { ok: false, created: false, items: before.items };
  const unsafeRoot = existingRootProblem(suggestion.parent, io);
  if (unsafeRoot) return { ok: false, created: false, items: [explainProblem(unsafeRoot)] };
  const made = [];
  try {
    for (const target of [suggestion.parent, suggestion.dir]) {
      try {
        io.mkdirSync(target, { mode: 0o700 });
        made.push(target);
      } catch (error) {
        if (!error || error.code !== 'EEXIST') throw error;
        if (target === suggestion.dir) throw error;
      }
    }
    const after = checkFolder({ provider, label, configDir: suggestion.dir, profiles, context });
    if (!after.ok) throw Object.assign(new Error('recheck-failed'), { items: after.items });
    return { ok: true, created: true, dir: suggestion.dir, madeFolders: [...made] };
  } catch (error) {
    for (const target of made.reverse()) {
      try { io.rmdirSync(target); } catch { /* only an empty folder we made is removed; anything else stays */ }
    }
    const items = error && error.items ? error.items : [explainProblem('config-dir-unresolvable')];
    return { ok: false, created: false, items };
  }
}

module.exports = { explainProblem, explainFailure, suggestFolder, checkFolder, createRecommendedFolder, discardCreated, EXPLANATIONS, PARENT_NAME };
