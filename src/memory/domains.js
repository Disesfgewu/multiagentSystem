'use strict';

const { byCodeUnit } = require('./order');

// Privacy domains. A memory belongs to exactly one domain, and a reader sees memory only from
// its own domain, plus any domain that has been explicitly shared with it.
//
//   * By default every account has a domain of its own, so two accounts never share memory.
//   * A person may put accounts that share one trust boundary into the same domain.
//   * Sharing across domains is a grant, written down explicitly, and it is directional:
//     `{ reader: 'b', source: 'a' }` lets domain b read domain a's memory, and nothing else.
//     It is not symmetric and not transitive, and there is no grant unless one is written.
//
// This module only decides which domains a reader may read. It stores nothing, and a domain
// id is a local label: it must not look like an account name, an address or a path.

// Lower case, no '@' and no '/', so an email address or a path cannot be used as a domain.
const DOMAIN = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_GRANTS = 100;
const MAX_ACCOUNTS = 200;

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validDomain = (value) => typeof value === 'string' && DOMAIN.test(value);

/** The domain an account has when nothing says otherwise: its own. */
function defaultDomainFor(accountProfileId) {
  if (typeof accountProfileId !== 'string' || !ACCOUNT.test(accountProfileId)) throw new TypeError('invalid account profile id');
  return `account:${accountProfileId.toLowerCase()}`;
}

/**
 * Builds a policy from a configuration, or throws a TypeError that names the field and never the
 * value. A configuration that cannot be understood gives no policy at all, which means no
 * sharing: it never degrades into "share more".
 *
 * @param {{ accountDomains?: Record<string, string>, grants?: Array<{ reader: string, source: string }> }} [config]
 */
function createDomainPolicy(config = {}) {
  if (!isPlain(config)) throw new TypeError('domain configuration must be an object');
  for (const key of Object.keys(config)) {
    if (key !== 'accountDomains' && key !== 'grants') throw new TypeError('domain configuration has an unknown field');
  }

  const accountDomains = new Map();
  if (config.accountDomains !== undefined) {
    if (!isPlain(config.accountDomains)) throw new TypeError('accountDomains must be an object');
    const entries = Object.entries(config.accountDomains);
    if (entries.length > MAX_ACCOUNTS) throw new TypeError('too many accountDomains');
    for (const [account, domain] of entries) {
      if (!ACCOUNT.test(account)) throw new TypeError('accountDomains has an invalid account profile id');
      if (!validDomain(domain)) throw new TypeError('accountDomains has an invalid domain');
      accountDomains.set(account.toLowerCase(), domain);
    }
    if (accountDomains.size !== entries.length) throw new TypeError('accountDomains lists one account twice');
  }

  // reader domain -> the domains whose memory it may read
  const sources = new Map();
  if (config.grants !== undefined) {
    if (!Array.isArray(config.grants)) throw new TypeError('grants must be a list');
    if (config.grants.length > MAX_GRANTS) throw new TypeError('too many grants');
    for (const grant of config.grants) {
      if (!isPlain(grant) || Object.keys(grant).some((key) => key !== 'reader' && key !== 'source')) throw new TypeError('a grant is { reader, source }');
      if (!validDomain(grant.reader) || !validDomain(grant.source)) throw new TypeError('a grant names an invalid domain');
      if (grant.reader === grant.source) throw new TypeError('a grant to a domain itself says nothing');
      if (!sources.has(grant.reader)) sources.set(grant.reader, new Set());
      if (sources.get(grant.reader).has(grant.source)) throw new TypeError('a grant is listed twice');
      sources.get(grant.reader).add(grant.source);
    }
  }

  const policy = {
    /** The domain of an account: the one it was assigned to, else its own. */
    domainFor(accountProfileId) {
      const key = defaultDomainFor(accountProfileId).slice('account:'.length);
      return accountDomains.get(key) ?? defaultDomainFor(accountProfileId);
    },
    /** The domains a reader in `domain` may read: its own, then those granted to it, in a fixed order. */
    readableDomains(domain) {
      if (!validDomain(domain)) throw new TypeError('invalid domain');
      return [domain, ...[...(sources.get(domain) ?? [])].sort(byCodeUnit)];
    },
    /** A short description for diagnostics: counts only, no domain names. */
    describe() {
      return { accountAssignments: accountDomains.size, grants: [...sources.values()].reduce((total, set) => total + set.size, 0) };
    }
  };
  return Object.freeze(policy);
}

module.exports = { createDomainPolicy, defaultDomainFor, validDomain, DOMAIN, MAX_GRANTS };
