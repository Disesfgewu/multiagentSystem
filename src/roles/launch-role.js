'use strict';

const { validateRoleGroup } = require('./role-group');
const { validRecord } = require('./role-store');

// Whether a role group may be assigned to a session that is about to start. The assignment is a fact
// about a new session: it names the group and nothing else. It does not change a running session
// (a session keeps the group id it was started with), and it does not claim the rules reached the
// CLI; the preview says what happened to them.

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const UNASSIGNED = 'unassigned';

const REASONS = Object.freeze({
  'invalid-role-group': 'The role group is not a valid choice.',
  'role-group-not-found': 'That role group no longer exists. Choose another one.',
  'role-group-unreadable': 'That role group could not be read or is not valid. Open it in the Role Groups list and fix it first.',
  'role-group-provider-mismatch': 'That role group is for a different CLI than the one you are starting. Choose a role group for this CLI.'
});

/**
 * @param {{ id: unknown, provider: string, record: unknown }} input `record` is the stored role group record
 *   read from private storage (or null/undefined when it was not found)
 */
function checkRoleForLaunch({ id, provider, record }) {
  if (typeof id !== 'string' || !ID.test(id) || id === UNASSIGNED) return { ok: false, code: 'invalid-role-group', message: REASONS['invalid-role-group'] };
  if (record === null || record === undefined) return { ok: false, code: 'role-group-not-found', message: REASONS['role-group-not-found'] };
  const checked = validateRoleGroup(record && typeof record === 'object' ? record.group : undefined);
  if (!checked.ok || checked.group.id !== id || !validRecord(record, id)) {
    return { ok: false, code: 'role-group-unreadable', message: REASONS['role-group-unreadable'] };
  }
  if (checked.group.provider !== provider) return { ok: false, code: 'role-group-provider-mismatch', message: REASONS['role-group-provider-mismatch'] };
  return { ok: true, group: checked.group };
}

/** The role groups that can be chosen for a provider, sorted by name then id (by code unit). Unreadable ones are left out and counted. */
function roleChoices(items, provider) {
  const choices = [];
  let skipped = 0;
  for (const entry of Array.isArray(items) ? items : []) {
    const checked = entry && typeof entry.id === 'string' ? checkRoleForLaunch({ id: entry.id, provider, record: entry.value }) : { ok: false, code: 'invalid-role-group' };
    if (checked.ok) choices.push({ id: checked.group.id, name: checked.group.name, role: checked.group.role, version: checked.group.version, defaultAccountProfileId: checked.group.defaultAccountProfileId });
    else if (checked.code !== 'role-group-provider-mismatch') skipped += 1;
  }
  const byUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  choices.sort((a, b) => byUnit(a.name, b.name) || byUnit(a.id, b.id));
  return { choices, skipped };
}

module.exports = { checkRoleForLaunch, roleChoices, REASONS, UNASSIGNED };
