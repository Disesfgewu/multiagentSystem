'use strict';

const { isReadable } = require('./store');

/**
 * What the Shared Memory panel shows (issue #306). Pure: it turns stored notes into short lines and groups. It reads and writes nothing.
 * The text of a note is private to this computer; it is shown only in the panel's own tooltips and windows, never put into GitHub.
 */

const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const oneLine = (value, limit) => {
  const text = typeof value === 'string' ? value.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim() : '';
  const chars = Array.from(text);
  return chars.length > limit ? `${chars.slice(0, limit - 1).join('')}…` : text;
};

/** The state of a note in plain words, and whether an agent started now would be given it. */
function stateOf(item, now) {
  if (!isPlain(item)) return { key: 'unknown', text: 'unknown', injected: false };
  if (item.status === 'candidate') return { key: 'candidate', text: 'suggested, waiting for your review', injected: false };
  if (item.status === 'rejected') return { key: 'rejected', text: 'rejected', injected: false };
  if (item.status === 'quarantined') return { key: 'quarantined', text: 'set aside (no longer passes the checks)', injected: false };
  if (item.status === 'stale') return { key: 'stale', text: 'needs review (its source changed)', injected: false };
  if (item.status === 'adopted') {
    if (item.disabled === true) return { key: 'disabled', text: 'switched off', injected: false };
    return isReadable(item, now) ? { key: 'active', text: 'active', injected: true } : { key: 'expired', text: 'expired', injected: false };
  }
  return { key: 'unknown', text: 'unknown', injected: false };
}

/**
 * Notes grouped by role group, then privacy domain, each with a short label, its state and what applies to it. `roleNames` maps a role
 * group id to its name; a note whose role group no longer exists is still listed (under its id) so it can be removed.
 * @returns {Array<{ roleGroupId: string, roleName: string, domains: Array<{ domain: string, items: object[] }> }>}
 */
function groupNotes(items, roleNames, now) {
  const names = isPlain(roleNames) ? roleNames : {};
  const byRole = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!isPlain(item) || typeof item.id !== 'string' || typeof item.roleGroupId !== 'string' || typeof item.privacyDomain !== 'string') continue;
    const state = stateOf(item, now);
    const row = {
      id: item.id,
      label: oneLine(item.content, 70) || '(empty)',
      state: state.key,
      stateText: state.text,
      injected: state.injected,
      scope: `repository ${oneLine(item.repoId, 60)}`,
      source: `${oneLine(item.source && item.source.kind, 30) || 'unknown'}: ${oneLine(item.source && item.source.ref, 80) || 'unknown'}`,
      expires: expiryText(item, now),
      full: oneLine(item.content, 2000)
    };
    if (!byRole.has(item.roleGroupId)) byRole.set(item.roleGroupId, new Map());
    const domains = byRole.get(item.roleGroupId);
    if (!domains.has(item.privacyDomain)) domains.set(item.privacyDomain, []);
    domains.get(item.privacyDomain).push(row);
  }
  return [...byRole.keys()].sort().map((roleGroupId) => ({
    roleGroupId,
    roleName: oneLine(names[roleGroupId], 60) || `${oneLine(roleGroupId, 40)} (role group not found)`,
    domains: [...byRole.get(roleGroupId).keys()].sort().map((domain) => ({ domain: oneLine(domain, 70), items: byRole.get(roleGroupId).get(domain).sort((a, b) => (a.id < b.id ? -1 : 1)) }))
  }));
}

function expiryText(item, now) {
  if (item.status !== 'adopted') return 'no expiry until adopted';
  const verified = Date.parse(item.verifiedAt);
  if (!Number.isFinite(verified) || !Number.isFinite(item.ttlMs) || item.ttlMs < 0) return 'expiry unknown (treated as expired)';
  const at = new Date(verified + item.ttlMs);
  return `${at.getTime() <= now ? 'expired' : 'expires'} ${at.toISOString().slice(0, 10)}`;
}

/** The suggestions waiting for review, newest last. */
const candidates = (items) => (Array.isArray(items) ? items : []).filter((item) => isPlain(item) && item.status === 'candidate');

module.exports = { stateOf, groupNotes, candidates, oneLine };
