'use strict';

/**
 * The private values the privacy scan looks for in what the owner publishes (#183, #389): every free-form string the extension keeps
 * in its private store (account e-mail addresses and names, folders, notes, broadcasts, rules, skills, prompts), each under an id that
 * names its collection and field (`profiles:<hash>:email`), never its value. Fields that only ever hold a fixed word or a fixed format
 * written by the code (a state, a provider, a time, a hash) are left out: they are not private, and as ordinary words ("active",
 * "owner", "claude") they would stop ordinary sentences. Pure: the store is given; nothing is written or logged.
 */

// Keys whose value is always a fixed word or format written by the code, never something a person typed or the machine revealed.
// Each is listed with where that set comes from in the issue (#389); a key here is skipped wherever it appears in a record.
const STRUCTURAL_KEYS = Object.freeze([
  // Already left out before #389.
  'kind', 'targetKind', 'provider', 'role', 'state', 'status', 'scope', 'type', 'mode', 'decision', 'unknownQuota', 'repository',
  'headSha', 'version', 'requestedModel', 'createdAt', 'updatedAt', 'configuredAt', 'expiresAt', 'revokedAt', 'savedAt',
  // Ids the code makes (random uuids, `acct-<hex>`, `role-<uuid>`, `instruction-<uuid>`, `team:<n>`, `feedback_<hex>` and the like)
  // and references to them.
  'id', 'requestId', 'sessionId', 'broadcastId', 'agentId', 'profileId', 'accountProfileId', 'defaultAccountProfileId', 'roleGroupId',
  'roles', 'serverId', 'actorId', 'secretRef', 'subject', 'previous', 'switchLeases',
  // Digests and fingerprints (sha256 hex, `sha256:<hex>`).
  'instructionDigest', 'print', 'fingerprint', 'sha256', 'integrity',
  // Fixed sets written by the code: how instructions were given, where a reading came from (`claude auth status --json`, a skill's
  // `owner/starter/repository/agent`), a reason or outcome code, a measurement kind, a confidence, an audit stage, a broker operation,
  // the permissions of a research tool, and who consented (`user`).
  'instructionMethod', 'source', 'reason', 'outcome', 'measurement', 'confidence', 'field', 'unit', 'anomalies', 'stage', 'operation',
  'permissions', 'consentedBy', 'license', 'expectedAuthMethod',
  // Times (ISO, also caught by their format).
  'at', 'checkedAt', 'verifiedAt', 'since', 'consentedAt', 'observedAt'
]);
// Fields that are fixed only in one place: an account check's plan name and subject hash, and the kind of sign-in the CLI reports
// (`claude.ai`, `oauth`), which say what kind of account it is, not whose.
const STRUCTURAL_PATHS = Object.freeze({ accountChecks: Object.freeze(['identity.plan.value', 'identity.subject.value', 'identity.authMethod', 'identity.apiProvider']) });
// The collections whose writers were read field by field for the list above (#389). A collection added to the private store must be
// read the same way and added here; a test fails until it is, so a key skipped everywhere cannot hide a new free-form field.
const REVIEWED_COLLECTIONS = Object.freeze(['profiles', 'roleGroups', 'sessions', 'policies', 'quotaReservations', 'reportFeedback', 'broadcasts', 'broadcastDeliveries', 'teamRules', 'taskDispatches', 'usageLog', 'researchConsents', 'codenames', 'ownerPosts', 'accountChecks', 'skills']);
// Words the code writes as values under other keys; never private.
const PUBLIC_VALUES = Object.freeze(['unassigned', 'allow', 'deny', 'ask', 'unknown', 'claude', 'codex', 'agy', 'issue', 'pullRequest', 'worker', 'researcher', 'pm', 'human', 'approve', 'request_changes', 'comment', 'merged']);
// A time or a hash the code wrote: an ISO time, or 40 or more hexadecimal digits (a commit or a sha256 of a text).
const FIXED_FORMAT = /^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})|[a-f0-9]{40,128})$/i;
const MAX_PRIVATE_REFS = 5000;

/**
 * @param {{ list(collection: string): { ok: boolean, items?: Array<{ id: string, value: unknown }> } }} store
 * @param {readonly string[]} collections
 * @param {{ skip?: (collection: string, id: string) => boolean, hash: (text: string) => string }} options
 * @returns {{ knownValues: Array<{ id: string, value: string }>, rules: Array<{ id: string, text: string }> } | null} null when any
 *   part cannot be read (the caller then refuses to publish)
 */
function collectPrivateReferences(store, collections, { skip = () => false, hash }) {
  const structural = new Set(STRUCTURAL_KEYS);
  const fixedWords = new Set(PUBLIC_VALUES);
  const knownValues = [];
  const rules = [];
  let unreadable = false;
  const visit = (value, collection, itemHash, path, keyName) => {
    if (unreadable) return;
    const id = `${collection}:${itemHash}:${path.join('.')}`;
    if (typeof value === 'string') {
      if (fixedWords.has(value) || FIXED_FORMAT.test(value)) return;
      if (knownValues.length >= MAX_PRIVATE_REFS) { unreadable = true; return; }
      knownValues.push({ id, value });
      if (keyName === 'note' || keyName === 'text') rules.push({ id, text: value });
      return;
    }
    if (Array.isArray(value)) { value.forEach((entry, index) => visit(entry, collection, itemHash, [...path, String(index)], keyName)); return; }
    if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        if (structural.has(key) || (STRUCTURAL_PATHS[collection] ?? []).includes([...path, key].join('.'))) continue;
        visit(entry, collection, itemHash, [...path, key], key);
      }
    }
  };
  for (const collection of collections) {
    const listed = store.list(collection);
    if (!listed || !listed.ok || !Array.isArray(listed.items)) return null;
    for (const item of listed.items) {
      if (!item || typeof item.id !== 'string' || !item.value || typeof item.value !== 'object' || Array.isArray(item.value)) return null;
      if (skip(collection, item.id)) continue;
      if (collection === 'reportFeedback' && (typeof item.value.note !== 'string' || item.value.note.trim() === '')) return null;
      if (collection === 'broadcasts' && (typeof item.value.text !== 'string' || item.value.text.trim() === '')) return null;
      visit(item.value, collection, hash(item.id).slice(0, 12), [], undefined);
      if (unreadable) return null;
    }
  }
  return { knownValues, rules };
}

module.exports = { collectPrivateReferences, REVIEWED_COLLECTIONS, STRUCTURAL_KEYS, STRUCTURAL_PATHS, PUBLIC_VALUES, FIXED_FORMAT, MAX_PRIVATE_REFS };
