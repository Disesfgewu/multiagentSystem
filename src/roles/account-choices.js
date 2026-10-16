'use strict';

const { builtIn } = require('../providers/registry');

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function selectRoleProfiles(profiles, provider) {
  if (!builtIn.has(provider) || !Array.isArray(profiles) || profiles.length > 50) return { ok: false, reason: 'invalid-account-list' };
  const seen = new Set();
  for (const profile of profiles) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile) ||
      typeof profile.id !== 'string' || !ID.test(profile.id) || seen.has(profile.id) ||
      !builtIn.has(profile.provider) || typeof profile.label !== 'string' ||
      !profile.label.trim() || profile.label.length > 80 || UNSAFE.test(profile.label)) {
      return { ok: false, reason: 'invalid-account-list' };
    }
    seen.add(profile.id);
  }
  return { ok: true, profiles: profiles.filter((profile) => profile.provider === provider)
    .map((profile) => ({ id: profile.id, label: profile.label })) };
}

module.exports = { selectRoleProfiles };
