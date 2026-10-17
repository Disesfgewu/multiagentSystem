'use strict';

const { scanPublication } = require('../publish/scan');

// A "broadcast" is the local-machine administrator's instruction to some or all agents. This
// module only validates its shape and turns a live one into a rule at the existing `user` layer
// (src/memory/rules.js already orders `platform > user > project > roleGroup > task`; nothing new
// is added to that resolver). It never decides WHO may create, change or revoke a broadcast: that
// boundary belongs entirely to whatever command calls this, which must be reachable only through
// an explicit, interactive action in the local VS Code window, never from workspace content, a
// role/task field, an MCP tool result, or any other value an agent could cause to be set. This
// module deliberately takes no "sender" field at all, because accepting one would just move the
// self-declared-role problem here instead of solving it.

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ROLE = /^[a-z][a-z0-9-]{0,31}$/;
const AGENT_ID = /^[A-Za-z0-9_-]{1,100}$/;
const PROVIDER = /^[a-z][a-z0-9-]{0,31}$/;
// Matches rule-input.js's MAX_TEXT_CHARS exactly: a broadcast turns into an instruction rule
// (broadcastRule below), and that rule is validated by the same limit when it is composed into an
// agent's effective rules. A longer broadcast could be stored here but would then always fail to
// compose, which would be a confusing way to find out; the limit is enforced at the one point where
// it can still be rejected with a clear reason, before anything is written.
const TEXT_LIMIT = 2000;
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

const SCOPES = Object.freeze(['all', 'roleGroup', 'agent', 'provider']);

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const clean = (value) => (typeof value === 'string' ? value.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim() : '');

function validTarget(target) {
  if (!isPlain(target) || !SCOPES.includes(target.scope)) return false;
  const keys = Object.keys(target);
  if (target.scope === 'all') return keys.length === 1;
  if (target.scope === 'roleGroup') return keys.length === 2 && typeof target.role === 'string' && ROLE.test(target.role);
  if (target.scope === 'agent') return keys.length === 2 && typeof target.agentId === 'string' && AGENT_ID.test(target.agentId);
  if (target.scope === 'provider') return keys.length === 2 && typeof target.provider === 'string' && PROVIDER.test(target.provider);
  return false;
}

function parsedTime(value, { optional = false } = {}) {
  if (value === undefined || value === null) return optional ? { ok: true, ms: null } : { ok: false };
  if (typeof value !== 'string') return { ok: false };
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? { ok: true, ms } : { ok: false };
}

/**
 * Validates one broadcast record. `raw.target` must name exactly one scope: every agent, a role
 * group (by role id), one specific agent (by its session/agent id) or one provider. `expiresAt`
 * must be after `createdAt` when given; a broadcast with no `expiresAt` holds until revoked.
 *
 * @returns {{ ok: true, broadcast: object } | { ok: false, problems: string[] }}
 */
function validateBroadcast(raw) {
  if (!isPlain(raw)) return { ok: false, problems: ['invalid-broadcast'] };
  const problems = [];
  if (typeof raw.id !== 'string' || !ID.test(raw.id)) problems.push('invalid-id');
  if (!Number.isSafeInteger(raw.version) || raw.version < 1) problems.push('invalid-version');
  if (!validTarget(raw.target)) problems.push('invalid-target');
  const text = clean(raw.text);
  if (text === '' || Array.from(text).length > TEXT_LIMIT) problems.push('invalid-text');
  const created = parsedTime(raw.createdAt);
  if (!created.ok) problems.push('invalid-created-at');
  const expires = parsedTime(raw.expiresAt, { optional: true });
  if (!expires.ok) problems.push('invalid-expires-at');
  else if (expires.ms !== null && created.ok && expires.ms <= created.ms) problems.push('expires-before-created');
  const revoked = parsedTime(raw.revokedAt, { optional: true });
  if (!revoked.ok) problems.push('invalid-revoked-at');
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    broadcast: Object.freeze({
      id: raw.id,
      version: raw.version,
      target: Object.freeze({ ...raw.target }),
      text,
      createdAt: new Date(created.ms).toISOString(),
      expiresAt: expires.ms === null ? null : new Date(expires.ms).toISOString(),
      revokedAt: revoked.ms === null ? null : new Date(revoked.ms).toISOString()
    })
  };
}

/**
 * Scans broadcast text the same way publishable GitHub content is scanned, so an administrator
 * cannot (even by accident) put a credential, local path or other private fragment into text that
 * every matching agent's effective instructions will then carry.
 */
function scanBroadcastText(text, options = {}) {
  return scanPublication([{ kind: 'comment', text }], options);
}

/** A revoked or expired broadcast no longer applies to anything new; it is kept for the record. */
function isLive(broadcast, now) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowMs)) return false;
  if (broadcast.revokedAt !== null && Date.parse(broadcast.revokedAt) <= nowMs) return false;
  if (broadcast.expiresAt !== null && Date.parse(broadcast.expiresAt) <= nowMs) return false;
  return true;
}

/** Whether a broadcast's target names this concrete agent, independent of whether it is live. */
function appliesTo(broadcast, context = {}) {
  const target = broadcast.target;
  if (target.scope === 'all') return true;
  if (target.scope === 'roleGroup') return context.role === target.role;
  if (target.scope === 'agent') return context.agentId === target.agentId;
  if (target.scope === 'provider') return context.provider === target.provider;
  return false;
}

/**
 * A live, applicable broadcast as a rule at the `user` layer, ready to add to the `layers.user`
 * array `previewEffectiveRules` (src/roles/preview.js) already accepts: stronger than project,
 * role group and task rules, weaker than the platform layer, exactly as the existing resolver in
 * src/memory/rules.js already enforces for every rule at that layer, without any change there.
 */
function broadcastRule(broadcast) {
  return Object.freeze({ id: `broadcast:${broadcast.id}`, layer: 'user', type: 'instruction', text: broadcast.text, version: broadcast.version });
}

/**
 * The `user`-layer rules a concrete agent's effective-rules preview should carry right now: only
 * broadcasts that are both live (not expired or revoked) and targeted at this agent, each exactly
 * once even if somehow duplicated in storage. Order does not matter: `resolveRules` sorts by layer
 * and id itself.
 */
function liveBroadcastRules(broadcasts, context, now) {
  const seen = new Set();
  const rules = [];
  for (const entry of Array.isArray(broadcasts) ? broadcasts : []) {
    if (!entry || typeof entry !== 'object' || seen.has(entry.id)) continue;
    if (!isLive(entry, now) || !appliesTo(entry, context)) continue;
    seen.add(entry.id);
    rules.push(broadcastRule(entry));
  }
  return rules;
}

module.exports = { validateBroadcast, scanBroadcastText, isLive, appliesTo, broadcastRule, liveBroadcastRules, SCOPES };
