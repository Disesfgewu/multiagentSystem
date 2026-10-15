'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { PROVIDERS, validateProfile, findConfigDirConflicts, normalizeProfileConfigDir } = require('./profile');
const { REF_PATTERN } = require('../storage/secrets');

// AccountProfile records live in the private store's `profiles` collection. A record holds
// the user's label, the provider, the CLI configuration directory, the expected login
// method and an opaque `secretRef`. It never holds a credential, and it never holds what
// the service says about the account (identity, plan, quota): that is observed live and
// shown with its source, see profile-view.js.
//
// Record field names are fixed by this program. A masked export prints top-level field
// names as written, so an account name or label must never become a key.
const COLLECTION = 'profiles';
const MAX_PROFILES = 50;
const MAX_LABEL = 80;
const AUTH_METHOD = /^[A-Za-z0-9._:-]{1,40}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

// What a caller may change on an existing profile. Changing the directory or the secret
// changes which account a session started from this profile runs as, so those two are
// refused while any session still refers to the profile.
const EDITABLE = Object.freeze(['label', 'configDir', 'expectedAuthMethod', 'secretRef']);
const IDENTITY_FIELDS = Object.freeze(['configDir', 'secretRef']);

const MESSAGES = Object.freeze({
  'invalid-provider': 'Choose a supported provider.',
  'invalid-label': 'Enter a label of 1 to 80 characters without control characters.',
  'invalid-auth-method': 'The expected login method is not valid.',
  'invalid-secret-ref': 'The secret reference is not valid.',
  'invalid-config-dir': 'The configuration folder cannot be used. See the listed problems.',
  'duplicate-label': 'Another profile for this provider already has that label. Labels must be distinct so accounts are not mixed up.',
  'config-dir-conflict': 'Another profile uses this folder, or a folder inside or around it. Give every account its own separate folder.',
  'too-many-profiles': 'The maximum number of profiles was reached.',
  'config-dir-rejected': 'The configuration folder no longer passes the checks (it moved, was replaced by a link, or now overlaps another profile). It was not used.',
  'secret-ref-locked': 'The secret reference cannot be replaced or removed here, because the old secret would be left behind. Create a new profile instead.',
  'profile-not-found': 'That profile no longer exists.',
  'provider-immutable': 'The provider cannot be changed. Create a new profile instead.',
  'unknown-field': 'That field cannot be edited.',
  'nothing-to-change': 'Nothing was changed.',
  'stale-revision': 'The profile changed since it was loaded. Reload it and try again.',
  'profile-in-use': 'A session is still using this profile, so its account cannot be changed. Stop the session first, or create another profile.',
  'profile-referenced': 'Earlier sessions refer to this profile. Deleting it cannot be undone and they could not be reopened. Confirm to delete anyway.',
  'secret-in-record': 'The value looks like a credential and was not saved. Credentials are never stored in profiles.',
  'no-account-assigned': 'No account is assigned: choose one for this session, or set a default for the role group.',
  'override-profile-missing': 'The profile chosen for this session no longer exists. Choose another account.',
  'default-profile-missing': 'The role group default profile no longer exists. Choose another default.',
  'provider-mismatch': 'The assigned profile belongs to a different provider than the session.',
  'store-unavailable': 'The private store cannot be used right now.',
  'store-locked': 'The private store is being written by another process. Try again shortly.'
});

function messageFor(code) {
  return MESSAGES[code] || 'The request could not be completed.';
}

const fail = (code, extra = {}) => ({ ok: false, code, message: messageFor(code), ...extra });

// The store reports why it could not read or write. Only the reason is passed on,
// never the detail, which can name a field path or a system error.
function storeFailure(outcome) {
  const reason = outcome && outcome.reason;
  if (reason === 'secret-detected') return fail('secret-in-record');
  if (reason === 'locked') return fail('store-locked');
  return fail('store-unavailable', { reason: typeof reason === 'string' ? reason : 'unknown' });
}

function normalizeLabel(value) {
  if (typeof value !== 'string') return null;
  const label = value.trim();
  if (label === '' || label.length > MAX_LABEL || CONTROL.test(label)) return null;
  return label;
}

const labelKey = (label) => label.normalize('NFKC').toLowerCase();

class AccountProfileService {
  /**
   * @param {object} options
   * @param {import('../storage/private-store').PrivateStore} options.store must declare a `profiles` collection
   * @param {{ remove(ref: string): Promise<unknown> }} [options.vault] SecretVault; only used to delete a secret
   * @param {() => Array<{ accountProfileId: string, terminalOpen: boolean }>} [options.sessions] current sessions
   * @param {object} [options.context] overrides for path checks (platform, homeDir, realpath, ...)
   */
  constructor({ store, vault, sessions = () => [], context, now = () => new Date(), newId } = {}) {
    if (!store || typeof store.transact !== 'function' || !store.names.includes(COLLECTION)) {
      throw new TypeError('store must be a PrivateStore with a "profiles" collection');
    }
    this.store = store;
    this.vault = vault;
    this.sessions = sessions;
    this.context = { ...(store.context || {}), ...context, repoRoot: store.repoRoot };
    this.now = now;
    this.newId = newId || (() => `acct-${crypto.randomBytes(6).toString('hex')}`);
  }

  #usage(id) {
    let live = 0;
    let historical = 0;
    for (const session of this.sessions()) {
      if (session.accountProfileId !== id) continue;
      if (session.terminalOpen) live += 1;
      else historical += 1;
    }
    return { live, historical };
  }

  #stamp() {
    return new Date(this.now()).toISOString();
  }

  // Checks everything that does not need the other profiles. Returns { value } or a failure.
  #checkFields(fields) {
    const out = {};
    if ('label' in fields) {
      const label = normalizeLabel(fields.label);
      if (!label) return fail('invalid-label');
      out.label = label;
    }
    if ('expectedAuthMethod' in fields) {
      const method = fields.expectedAuthMethod;
      if (method !== null && !(typeof method === 'string' && AUTH_METHOD.test(method))) return fail('invalid-auth-method');
      out.expectedAuthMethod = method;
    }
    if ('secretRef' in fields) {
      const ref = fields.secretRef;
      if (ref !== null && !(typeof ref === 'string' && REF_PATTERN.test(ref))) return fail('invalid-secret-ref');
      out.secretRef = ref;
    }
    if ('configDir' in fields) {
      if (typeof fields.configDir !== 'string') return fail('invalid-config-dir', { problems: ['config-dir-not-absolute'] });
      out.configDir = fields.configDir;
    }
    return { value: out };
  }

  // Path and uniqueness checks against the other profiles. Runs inside the transaction so
  // the answer matches the data that is about to be written. `only` limits the checks to
  // what changed: editing a label must not fail because the folder cannot be resolved right
  // now, and editing the folder must not fail on an unchanged label.
  #checkAgainstOthers(candidate, others, only = { path: true, label: true }) {
    if (only.path) {
      const validation = validateProfile(candidate, this.context);
      if (!validation.ok) return fail('invalid-config-dir', { problems: validation.problems });
      try {
        candidate.configDir = normalizeProfileConfigDir(candidate.configDir, this.context);
      } catch {
        return fail('invalid-config-dir', { problems: ['config-dir-unresolvable'] });
      }
    } else if (typeof candidate.configDir === 'string' && candidate.configDir.split((this.context.platform || process.platform) === 'win32' ? /[\\/]/ : '/').includes('..')) {
      return fail('invalid-config-dir', { problems: ['config-dir-unresolvable'] });
    }
    if (only.label) {
      const wanted = labelKey(candidate.label);
      const twin = others.find((other) => other.provider === candidate.provider && labelKey(other.label) === wanted);
      if (twin) return fail('duplicate-label', { conflictsWith: twin.id });
    }
    if (only.path) {
      const conflicts = findConfigDirConflicts([...others, candidate], this.context).filter(
        (entry) => entry.a === candidate.id || entry.b === candidate.id
      );
      if (conflicts.length > 0) {
        const first = conflicts[0];
        return fail('config-dir-conflict', {
          kind: first.kind,
          conflictsWith: first.a === candidate.id ? first.b : first.a
        });
      }
    }
    return null;
  }

  list() {
    const loaded = this.store.list(COLLECTION);
    if (!loaded.ok) return storeFailure(loaded);
    return { ok: true, profiles: loaded.items.map((item) => ({ id: item.id, ...item.value })) };
  }

  get(id) {
    const loaded = this.store.get(COLLECTION, id);
    if (!loaded.ok) return storeFailure(loaded);
    if (!loaded.found) return fail('profile-not-found');
    return { ok: true, profile: { id, ...loaded.value } };
  }

  /**
   * The gate before a session starts under a profile. The profile must exist now AND its folder
   * must still pass every check: the checks made when it was created can be undone later (the folder
   * replaced by a link into the repository or into another profile's folder, deleted, or replaced by
   * a file). Any problem refuses with `config-dir-rejected` and the problems named; the profile is
   * not returned. The caller fixes the returned id in the session.
   */
  resolveForLaunch(id) {
    const loaded = this.get(id);
    if (!loaded.ok) return loaded;
    const all = this.list();
    if (!all.ok) return all;
    const profile = loaded.profile;
    const problems = [];
    const validation = validateProfile(profile, this.context);
    if (!validation.ok) problems.push(...validation.problems);
    // A folder that does not exist yet is fine (the login creates it); one that exists must be a directory.
    const isDirectory = this.context.isDirectory || ((target) => fs.statSync(target).isDirectory());
    if (validation.ok || validation.problems.includes('config-dir-not-directory')) {
      try {
        if (!isDirectory(profile.configDir)) problems.push('config-dir-not-a-directory');
      } catch (error) {
        if (!error || error.code !== 'ENOENT') problems.push('config-dir-unreadable');
      }
    }
    const conflicts = findConfigDirConflicts(all.profiles, this.context).filter((entry) => entry.a === id || entry.b === id);
    for (const entry of conflicts) problems.push(`config-dir-conflict:${entry.kind}`);
    if (problems.length > 0) {
      const other = conflicts.map((entry) => (entry.a === id ? entry.b : entry.a)).find((value) => value);
      return fail('config-dir-rejected', { problems, ...(other ? { conflictsWith: other } : {}) });
    }
    return loaded;
  }

  create({ provider, label, configDir, expectedAuthMethod = null, secretRef = null } = {}) {
    if (typeof provider !== 'string' || !Object.hasOwn(PROVIDERS, provider)) return fail('invalid-provider');
    const checked = this.#checkFields({ label, configDir, expectedAuthMethod, secretRef });
    if (checked.ok === false) return checked;
    const fields = checked.value;

    const outcome = this.store.transact((tx) => {
      const existing = tx.list(COLLECTION);
      if (existing.length >= MAX_PROFILES) return { rejected: fail('too-many-profiles') };
      let id = this.newId();
      while (tx.get(COLLECTION, id) !== null) id = this.newId();
      const candidate = { id, provider, label: fields.label, configDir: fields.configDir };
      const rejected = this.#checkAgainstOthers(
        candidate,
        existing.map((item) => ({ id: item.id, ...item.value }))
      );
      if (rejected) return { rejected };
      const stamp = this.#stamp();
      const record = {
        provider,
        label: fields.label,
        configDir: candidate.configDir,
        expectedAuthMethod: fields.expectedAuthMethod,
        secretRef: fields.secretRef,
        revision: 1,
        createdAt: stamp,
        updatedAt: stamp
      };
      tx.put(COLLECTION, id, record);
      return { created: { id, ...record } };
    });
    if (!outcome.ok) return storeFailure(outcome);
    if (outcome.value.rejected) return outcome.value.rejected;
    return { ok: true, profile: outcome.value.created };
  }

  /**
   * Edits label, configDir, expectedAuthMethod or secretRef. The provider never changes.
   * A change to the directory or the secret is refused while a session refers to the profile,
   * so no running (or reopenable) session silently ends up on another account.
   */
  update(id, changes, { expectedRevision } = {}) {
    if (!changes || typeof changes !== 'object') return fail('nothing-to-change');
    for (const key of Object.keys(changes)) {
      if (key === 'provider') return fail('provider-immutable');
      if (!EDITABLE.includes(key)) return fail('unknown-field', { field: key });
    }
    const keys = Object.keys(changes);
    if (keys.length === 0) return fail('nothing-to-change');
    const checked = this.#checkFields(changes);
    if (checked.ok === false) return checked;
    const fields = checked.value;

    if (keys.some((key) => IDENTITY_FIELDS.includes(key))) {
      const usage = this.#usage(id);
      if (usage.live + usage.historical > 0) return fail('profile-in-use', { live: usage.live, historical: usage.historical });
    }

    const outcome = this.store.transact((tx) => {
      const current = tx.get(COLLECTION, id);
      if (current === null) return { rejected: fail('profile-not-found') };
      if (expectedRevision !== undefined && expectedRevision !== current.revision) return { rejected: fail('stale-revision') };
      // A secret that was set stays tied to this profile: replacing or clearing the reference would
      // leave the old secret behind in the secret store with nothing pointing at it.
      if ('secretRef' in fields && current.secretRef !== null && fields.secretRef !== current.secretRef) {
        return { rejected: fail('secret-ref-locked') };
      }
      const next = { ...current, ...fields };
      const unchanged = keys.every((key) => next[key] === current[key]);
      if (unchanged) return { rejected: fail('nothing-to-change') };
      const others = tx.list(COLLECTION).filter((item) => item.id !== id).map((item) => ({ id: item.id, ...item.value }));
      const candidate = { id, provider: current.provider, label: next.label, configDir: next.configDir };
      const rejected = this.#checkAgainstOthers(
        candidate,
        others,
        { path: next.configDir !== current.configDir, label: next.label !== current.label }
      );
      if (rejected) return { rejected };
      next.configDir = candidate.configDir;
      next.revision = current.revision + 1;
      next.updatedAt = this.#stamp();
      tx.put(COLLECTION, id, next);
      return { updated: { id, ...next } };
    });
    if (!outcome.ok) return storeFailure(outcome);
    if (outcome.value.rejected) return outcome.value.rejected;
    return { ok: true, profile: outcome.value.updated };
  }

  /**
   * Deletes a profile record. Refused while a session with an open terminal uses it. Earlier
   * (closed or unknown) sessions that refer to it also refuse unless the caller confirms with
   * `allowHistoricalReferences`. The CLI's own configuration folder and login files are NOT touched.
   */
  async remove(id, { allowHistoricalReferences = false } = {}) {
    const usage = this.#usage(id);
    if (usage.live > 0) return fail('profile-in-use', { live: usage.live, historical: usage.historical });
    if (usage.historical > 0 && allowHistoricalReferences !== true) {
      return fail('profile-referenced', { historical: usage.historical });
    }
    const outcome = this.store.transact((tx) => {
      const current = tx.get(COLLECTION, id);
      if (current === null) return { rejected: fail('profile-not-found') };
      tx.delete(COLLECTION, id);
      return { removed: current };
    });
    if (!outcome.ok) return storeFailure(outcome);
    if (outcome.value.rejected) return outcome.value.rejected;

    const result = { ok: true, configDirKept: true, secretRemoved: false, secretCleanupFailed: false };
    const ref = outcome.value.removed.secretRef;
    if (ref && this.vault) {
      try {
        const removed = await this.vault.remove(ref);
        if (removed && removed.ok === true) result.secretRemoved = true;
        else result.secretCleanupFailed = true;
      } catch {
        // The record is already gone; report that the secret may remain, without details.
        result.secretCleanupFailed = true;
      }
    }
    return result;
  }

  /**
   * Which profile a session runs under: the session's own choice beats the role group default.
   * The profile must exist now and belong to the session's provider. Nothing is guessed:
   * with neither choice the answer is `no-account-assigned`.
   */
  assign({ provider, sessionOverride, roleGroupDefault } = {}) {
    // An empty or null choice means "no choice" everywhere, so the default is used.
    const given = (value) => (value === undefined || value === null || value === '' ? undefined : value);
    const override = given(sessionOverride);
    const chosen = override ?? given(roleGroupDefault);
    if (chosen === undefined) return fail('no-account-assigned');
    const source = override !== undefined ? 'session-override' : 'role-group-default';
    // Same gate as resolveForLaunch: an id is only handed out for a profile that passes the folder checks now.
    const loaded = this.resolveForLaunch(chosen);
    if (!loaded.ok) {
      if (loaded.code === 'profile-not-found') {
        return fail(source === 'session-override' ? 'override-profile-missing' : 'default-profile-missing', { source });
      }
      return { ...loaded, source };
    }
    if (loaded.profile.provider !== provider) return fail('provider-mismatch', { source });
    return { ok: true, accountProfileId: loaded.profile.id, source };
  }
}

module.exports = { AccountProfileService, COLLECTION, MAX_PROFILES, EDITABLE, MESSAGES, messageFor };
