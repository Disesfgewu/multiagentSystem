'use strict';

/**
 * The instructions a person already confirmed (#362): for each provider and role group, the digest of the effective instructions
 * they last agreed to start an agent with. Starting another agent of the same role group with exactly the same instructions (same
 * digest: same role rules, team rules, notices and shared notes) does not ask again; when anything in them changes, the digest
 * changes and the person is asked again. Only a confirmation the person gave in the dialog is remembered; a caller's argument never
 * counts as one (#183). Pure: the caller keeps the map (VS Code's globalState).
 */

const MAX_ENTRIES = 200;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const PART = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,100}$/;
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The key of one provider and role group, or null when either cannot be a key. */
function confirmationKey(provider, roleGroupId) {
  const role = typeof roleGroupId === 'string' && roleGroupId !== '' ? roleGroupId : 'unassigned';
  return typeof provider === 'string' && PART.test(provider) && PART.test(role) ? `${provider}|${role}` : null;
}

/** True only when this exact digest was confirmed for this provider and role group. */
function alreadyConfirmed(map, key, digest) {
  return key !== null && typeof digest === 'string' && DIGEST.test(digest) && isPlain(map) && Object.hasOwn(map, key) && map[key] === digest;
}

/** The map with this confirmation in it (the newest last), keeping at most MAX_ENTRIES; the map given is not changed. */
function remember(map, key, digest) {
  if (key === null || typeof digest !== 'string' || !DIGEST.test(digest)) return isPlain(map) ? { ...map } : {};
  const kept = Object.entries(isPlain(map) ? map : {}).filter(([entry, value]) => entry !== key && typeof value === 'string' && DIGEST.test(value));
  return Object.fromEntries([...kept, [key, digest]].slice(-MAX_ENTRIES));
}

module.exports = { confirmationKey, alreadyConfirmed, remember, MAX_ENTRIES };
