'use strict';

// Shape-based detectors. They only ever return codes, never the matched text, so
// a finding can be logged or shown without repeating the secret.
const VALUE_PATTERNS = Object.freeze([
  ['private-key-block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{8,}/],
  ['api-key', /\bsk-[A-Za-z0-9]{20,}/],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ['cloud-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['bearer-token', /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i]
]);

// Field names that mean "this holds a credential". Such fields never belong in
// the file store; they go to SecretStorage and are referenced by `secretRef`.
// Names are split into lower-case words first so accessToken, access_token,
// ACCESS-TOKEN and Access.Token are all caught, while "tokenizer" is not.
const SECRET_WORDS = new Set([
  'token', 'tokens', 'secret', 'secrets', 'password', 'passwords', 'passwd', 'passphrase',
  'credential', 'credentials', 'authorization', 'cookie', 'cookies', 'apikey', 'jwt', 'bearer'
]);
const ALLOWED_KEYS = new Set(['secretRef']);

function words(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isSecretFieldName(name) {
  const parts = words(name);
  if (parts.some((word) => SECRET_WORDS.has(word))) return true;
  // "api key", "private key", "access key", "secret key" as two words.
  for (let i = 0; i + 1 < parts.length; i += 1) {
    if (parts[i + 1] === 'key' && ['api', 'private', 'access', 'secret', 'signing', 'encryption'].includes(parts[i])) {
      return true;
    }
  }
  return false;
}

function scanValue(text) {
  const codes = [];
  for (const [code, pattern] of VALUE_PATTERNS) if (pattern.test(text)) codes.push(code);
  return codes;
}

// A credential is text. Counts such as `tokensUsed: 120` or `{ input: 10 }` under a
// name that contains "token" are usage data, not secrets.
function hasStringLeaf(value) {
  if (typeof value === 'string') return value !== '';
  if (Array.isArray(value)) return value.some(hasStringLeaf);
  if (value && typeof value === 'object') return Object.values(value).some(hasStringLeaf);
  return false;
}

// Walks a JSON-like value and reports where a credential would be stored:
// paths are field names only, never values.
function findSecrets(value, trail = []) {
  const found = [];
  if (typeof value === 'string') {
    for (const code of scanValue(value)) found.push({ code, path: trail.join('.') });
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => found.push(...findSecrets(item, [...trail, String(index)])));
  } else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      if (!ALLOWED_KEYS.has(key) && isSecretFieldName(key) && hasStringLeaf(inner)) {
        found.push({ code: 'secret-field-name', path: [...trail, key].join('.') });
      }
      found.push(...findSecrets(inner, [...trail, key]));
    }
  }
  return found;
}

module.exports = { findSecrets, scanValue };
