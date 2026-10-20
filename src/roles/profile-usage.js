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

const BUTTON_CLEAR = 'Remove and Clear Defaults';
const BUTTON_PLAIN = 'Remove Profile';

/**
 * The whole "remove an account profile" interaction, with the dialogs injected so it can be tested without the editor.
 * `ui.confirmRemove(detailText, button)` and `ui.confirmHistorical()` answer true or false; `service.remove` is the
 * profile service's. Order: read who uses the profile (unreadable means nothing is removed), ask, remove, then
 * look again and clear every group that names the profile now, so a group changed in another window between the first
 * read and the removal is cleared too. A removal that cannot clear everything says so; the group's launch is
 * refused later because the profile no longer exists.
 * @returns {Promise<{ outcome: 'roles-unreadable' | 'cancelled' | 'error', code?: string } | { outcome: 'removed', cleared: number, failed: number, rolesUnknown: boolean }>}
 */
async function removeProfileFlow({ service, roleStore, profileId, ui }) {
  const usage = roleGroupsUsingProfile(roleStore, profileId);
  if (!usage.ok) return { outcome: 'roles-unreadable' };
  const button = usage.groups.length > 0 ? BUTTON_CLEAR : BUTTON_PLAIN;
  const answered = await ui.confirmRemove(usage.groups, button);
  if (answered !== true) return { outcome: 'cancelled' };
  let removed = await service.remove(profileId);
  if (!removed.ok && removed.code === 'profile-referenced') {
    if ((await ui.confirmHistorical()) !== true) return { outcome: 'cancelled' };
    removed = await service.remove(profileId, { allowHistoricalReferences: true });
  }
  if (!removed.ok) return { outcome: 'error', code: removed.code };
  const after = roleGroupsUsingProfile(roleStore, profileId);
  // Unreadable now: the profile is gone and nobody can say what still names it.
  if (!after.ok) return { outcome: 'removed', cleared: 0, failed: 0, rolesUnknown: true };
  if (after.groups.length === 0) return { outcome: 'removed', cleared: 0, failed: 0, rolesUnknown: false };
  const tidy = clearRoleDefaults(roleStore, after.groups, profileId);
  return { outcome: 'removed', cleared: tidy.cleared.length, failed: tidy.failed.length, rolesUnknown: false };
}

module.exports = { roleGroupsUsingProfile, describeGroups, clearRoleDefaults, removeProfileFlow, BUTTON_CLEAR, BUTTON_PLAIN, MAX_SHOWN };
