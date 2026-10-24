'use strict';

/**
 * The accounts offered when an agent is started (#352): the role group's default account first, marked as such, then the others
 * in the order they were added; each says which real account it is (the e-mail address this window's sign-in check read, and the
 * plan) so the person can tell two accounts apart. `exclude` leaves out the account an agent already uses (switching accounts).
 * Pure: the caller gives the profiles, the default and what the checks read.
 * @returns {Array<{ id: string, label: string, description: string, isDefault: boolean }>}
 */
function orderAccountChoices(profiles, { defaultId = null, emails = {}, plans = {}, exclude = null } = {}) {
  const list = (Array.isArray(profiles) ? profiles : []).filter((profile) => profile && typeof profile.id === 'string' && profile.id !== exclude);
  const known = (map, id) => (map && typeof map === 'object' && Object.hasOwn(map, id) && typeof map[id] === 'string' ? map[id] : null);
  const describe = (profile, isDefault) => {
    const who = [known(emails, profile.id), known(plans, profile.id) ? `${known(plans, profile.id)} plan` : null].filter(Boolean).join(' · ');
    return [isDefault ? "this role group's default account" : null, who || 'sign-in not checked in this window'].filter(Boolean).join(' · ');
  };
  const first = list.filter((profile) => profile.id === defaultId);
  const rest = list.filter((profile) => profile.id !== defaultId);
  return [...first, ...rest].map((profile) => ({ id: profile.id, label: String(profile.label ?? profile.id), description: describe(profile, profile.id === defaultId), isDefault: profile.id === defaultId }));
}

module.exports = { orderAccountChoices };
