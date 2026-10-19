'use strict';

const { editRoleRecord } = require('./edit-role');

/**
 * Which role groups name an account profile as their default, and clearing that default when the profile goes
 * away. A role group that keeps pointing at a profile that no longer exists is only caught later, when someone
 * tries to start an agent from it; this lets removal say so first and tidy up afterwards.
 *
 * Everything is injected (`roleStore` is a RoleStore) and nothing here throws across the boundary.
 */

const MAX_SHOWN = 5;

/** @returns {{ ok: true, groups: Array<{ id: string, name: string, revision: number, record: object }> } | { ok: false, reason: string }} */
function roleGroupsUsingProfile(roleStore, profileId) {
  if (!roleStore || typeof roleStore.list !== 'function' || typeof profileId !== 'string' || profileId === '') return { ok: false, reason: 'input-invalid' };
  let listed;
  try { listed = roleStore.list(); } catch { return { ok: false, reason: 'storage-unavailable' }; }
  // Unreadable role groups are an unknown, not "none": nobody can say that no role group uses the profile.
  if (!listed || listed.ok !== true || !Array.isArray(listed.items)) return { ok: false, reason: (listed && listed.reason) || 'storage-unavailable' };
  const groups = [];
  for (const item of listed.items) {
    const group = item && item.record && item.record.group;
    if (group && group.defaultAccountProfileId === profileId) groups.push({ id: group.id, name: String(group.name), revision: item.record.revision, record: item.record });
  }
  return { ok: true, groups };
}

/** Names for a dialog: at most five, each cut short, then "and N more". */
function describeGroups(groups) {
  const shown = groups.slice(0, MAX_SHOWN).map((group) => `“${Array.from(group.name).slice(0, 40).join('')}”`);
  return `${shown.join(', ')}${groups.length > shown.length ? ` and ${groups.length - shown.length} more` : ''}`;
}

/**
 * Clears the default account of each given group through the normal edit path (so the version moves and the
 * record is validated again). A group that changed since it was read (stale revision) or cannot be saved is
 * left as it is and reported; nothing else is touched.
 * @returns {{ cleared: string[], failed: Array<{ id: string, reason: string }> }}
 */
function clearRoleDefaults(roleStore, groups, profileId) {
  const cleared = [];
  const failed = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    try {
      // Re-read: only a group that still names this profile is changed, and only at the revision that was read.
      const current = roleStore.get(group.id);
      if (!current || current.ok !== true) { failed.push({ id: group.id, reason: (current && current.reason) || 'storage-unavailable' }); continue; }
      if (current.record.group.defaultAccountProfileId !== profileId) { cleared.push(group.id); continue; }
      const edited = editRoleRecord(current.record, { kind: 'account', profileId: null });
      if (!edited.ok) { failed.push({ id: group.id, reason: edited.reason }); continue; }
      const saved = roleStore.save(edited.record, { expectedRevision: current.record.revision });
      if (saved && saved.ok === true) cleared.push(group.id);
      else failed.push({ id: group.id, reason: (saved && saved.reason) || 'storage-unavailable' });
    } catch {
      failed.push({ id: group.id, reason: 'storage-unavailable' });
    }
  }
  return { cleared, failed };
}

module.exports = { roleGroupsUsingProfile, describeGroups, clearRoleDefaults, MAX_SHOWN };
