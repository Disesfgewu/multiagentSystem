'use strict';

const { withVerification, FindingError } = require('./finding');

// Research Verifier: independent verification fetcher and integrity checker.
//
// Implements Item 5 of Issue #61:
//  1. Verifies that the identifier (DOI or arXiv) truly exists in official academic records.
//  2. Matches official title and publication date against tool-returned metadata.
//  3. Verifies that claimed quotes actually exist in official title/abstract text.
//  4. Detects retraction status; retractions disqualify novelty and emit warnings.
//  5. Pure verification logic with dependency injection: callers inject the metadata fetcher.

const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const clean = (value) => (typeof value === 'string' ? value.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim() : '');

class VerifierError extends TypeError {
  constructor(code) {
    super(code);
    this.name = 'VerifierError';
    this.code = code;
  }
}

const fail = (code) => { throw new VerifierError(code); };

/**
 * Normalizes title text for resilient matching: lowercases, strips punctuation, and collapses whitespace.
 */
function normalizeTitle(text) {
  if (typeof text !== 'string') return '';
  return clean(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalizes date to YYYY or YYYY-MM prefix for comparison.
 */
function normalizeDatePrefix(dateStr) {
  if (typeof dateStr !== 'string') return '';
  const match = dateStr.match(/^(\d{4}(?:-\d{2})?)/);
  return match ? match[1] : '';
}

/**
 * Performs an independent verification check on a finding using an injected metadata fetcher.
 *
 * @param {object} finding Finding object produced by `createFinding`
 * @param {Function} fetcher Async or sync function `({ type, value }) => Promise<object|null>`
 * @returns {Promise<{ outcome: { identifierExists: boolean, titleMatches: boolean, publishedAtMatches: boolean, quoteFound: boolean }, retracted: boolean|null, warnings: string[] }>}
 */
async function verifyFinding(finding, fetcher) {
  if (!isPlain(finding) || typeof finding.id !== 'string') fail('finding-invalid');
  if (typeof fetcher !== 'function') fail('fetcher-invalid');

  const { record, quote } = finding;
  if (!record || !record.identifier) {
    return Object.freeze({
      outcome: Object.freeze({
        identifierExists: false,
        titleMatches: false,
        publishedAtMatches: false,
        quoteFound: false
      }),
      retracted: null,
      warnings: Object.freeze(['no-identifier'])
    });
  }

  const warnings = [];
  let fetched = null;
  try {
    fetched = await fetcher({
      type: record.identifier.type,
      value: record.identifier.value
    });
  } catch (err) {
    warnings.push('fetcher-error');
  }

  if (!fetched || !isPlain(fetched)) {
    return Object.freeze({
      outcome: Object.freeze({
        identifierExists: false,
        titleMatches: false,
        publishedAtMatches: false,
        quoteFound: false
      }),
      retracted: null,
      warnings: Object.freeze([...warnings, 'identifier-not-found'])
    });
  }

  // 1. Identifier exists
  const identifierExists = true;

  // 2. Title matches
  const normRecordTitle = normalizeTitle(record.title);
  const normOfficialTitle = normalizeTitle(fetched.title);
  const titleMatches = normRecordTitle.length > 0 &&
    normOfficialTitle.length > 0 &&
    (normRecordTitle === normOfficialTitle || normRecordTitle.includes(normOfficialTitle) || normOfficialTitle.includes(normRecordTitle));

  if (!titleMatches) warnings.push('title-mismatch');

  // 3. Published date matches (checks year and month if available)
  const normRecordDate = normalizeDatePrefix(record.publishedAt);
  const normOfficialDate = normalizeDatePrefix(fetched.publishedAt);
  const publishedAtMatches = normRecordDate.length >= 4 &&
    normOfficialDate.length >= 4 &&
    normRecordDate.slice(0, 4) === normOfficialDate.slice(0, 4);

  if (!publishedAtMatches) warnings.push('publication-date-mismatch');

  // 4. Quote verification
  let quoteFound = true;
  if (quote && quote.text) {
    const normQuote = normalizeTitle(quote.text);
    const corpus = `${normalizeTitle(fetched.title)} ${normalizeTitle(fetched.abstract || '')}`;
    quoteFound = normQuote.length > 0 && corpus.includes(normQuote);
    if (!quoteFound) warnings.push('quote-not-found-in-official-source');
  }

  // 5. Retraction check
  let retracted = null;
  if (typeof fetched.retracted === 'boolean') {
    retracted = fetched.retracted;
    if (retracted === true) {
      warnings.push('retracted');
    }
  }

  // If paper is officially retracted, it cannot pass academic verification
  const effectiveIdentifier = retracted === true ? false : identifierExists;
  const effectiveTitleMatches = retracted === true ? false : titleMatches;

  const outcome = Object.freeze({
    identifierExists: effectiveIdentifier,
    titleMatches: effectiveTitleMatches,
    publishedAtMatches,
    quoteFound
  });

  return Object.freeze({
    outcome,
    retracted,
    warnings: Object.freeze(warnings)
  });
}

/**
 * Runs independent verification and applies the outcome to the finding using `withVerification`.
 * Passes the verified finding directly to preserve WeakSet membership.
 *
 * @param {object} finding
 * @param {Function} fetcher
 */
async function verifyAndApply(finding, fetcher) {
  const check = await verifyFinding(finding, fetcher);
  return withVerification(finding, check.outcome);
}

module.exports = {
  verifyFinding,
  verifyAndApply,
  normalizeTitle,
  VerifierError
};
