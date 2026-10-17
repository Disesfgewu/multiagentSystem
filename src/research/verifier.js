'use strict';

const { withVerification } = require('./finding');

// Pure metadata-evidence comparison for Issue #61. This module performs no network request and
// does not claim that an injected fetcher used a real endpoint. A fetcher result counts only when
// it names the expected registry, repeats the requested identifier, records when it was fetched,
// and supplies well-shaped metadata. Unavailable or malformed evidence stays unverified.

const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?Z$/;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/;
const OFFICIAL_SOURCE = Object.freeze({ doi: 'crossref-api', arxiv: 'arxiv-api' });
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

function normalizeTitle(text) {
  if (typeof text !== 'string') return '';
  return clean(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function validInstant(value) {
  if (typeof value !== 'string') return false;
  const parts = ISO_INSTANT.exec(value);
  if (!parts) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.getUTCFullYear() === Number(parts[1]) && parsed.getUTCMonth() + 1 === Number(parts[2]) &&
    parsed.getUTCDate() === Number(parts[3]) && parsed.getUTCHours() === Number(parts[4]) && parsed.getUTCMinutes() === Number(parts[5]) &&
    parsed.getUTCSeconds() === Number(parts[6] ?? 0);
}

function calendarDate(value) {
  if (typeof value !== 'string') return null;
  const parts = CALENDAR_DATE.exec(value);
  if (!parts) return null;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const rebuilt = new Date(Date.UTC(year, month - 1, day));
  return rebuilt.getUTCFullYear() === year && rebuilt.getUTCMonth() + 1 === month && rebuilt.getUTCDate() === day ? `${parts[1]}-${parts[2]}-${parts[3]}` : null;
}

function dateEvidence(recordDate, officialDate) {
  const record = calendarDate(recordDate);
  if (!record) return { matches: false, warning: 'publication-date-invalid' };
  if (/^\d{4}$/.test(officialDate ?? '') || /^\d{4}-\d{2}$/.test(officialDate ?? '')) {
    return { matches: null, warning: 'publication-date-precision-insufficient' };
  }
  const official = calendarDate(officialDate);
  if (!official) return { matches: false, warning: 'official-publication-date-invalid' };
  return { matches: record === official, warning: record === official ? null : 'publication-date-mismatch' };
}

const identifierValue = (identifier) => identifier.type === 'doi' || identifier.type === 'arxiv' ? identifier.value.trim().toLowerCase() : identifier.value.trim();
const outcome = (value) => Object.freeze({ identifierExists: value, titleMatches: value, publishedAtMatches: value, quoteFound: value });
const result = (status, checked, retracted, warnings) => Object.freeze({ status, outcome: Object.freeze(checked), retracted, warnings: Object.freeze(warnings) });

function evidenceShape(evidence, requested) {
  if (!isPlain(evidence) || !['found', 'not-found', 'unavailable'].includes(evidence.status)) return 'fetcher-result-invalid';
  if (evidence.source !== OFFICIAL_SOURCE[requested.type]) return 'official-source-mismatch';
  if (!isPlain(evidence.identifier) || evidence.identifier.type !== requested.type || typeof evidence.identifier.value !== 'string' ||
      identifierValue(evidence.identifier) !== identifierValue(requested)) return 'identifier-mismatch';
  if (!validInstant(evidence.fetchedAt)) return 'fetched-at-invalid';
  if (evidence.status !== 'found') return null;
  const metadata = evidence.metadata;
  if (!isPlain(metadata) || typeof metadata.title !== 'string' || metadata.title.trim() === '' || typeof metadata.publishedAt !== 'string' ||
      !(metadata.abstract === undefined || metadata.abstract === null || typeof metadata.abstract === 'string') ||
      !(metadata.retracted === undefined || metadata.retracted === null || typeof metadata.retracted === 'boolean')) return 'metadata-invalid';
  return null;
}

/**
 * Compares a finding with evidence returned by an injected fetcher.
 *
 * The fetcher contract is:
 * `{ status, source, identifier: { type, value }, fetchedAt, metadata? }`, where source is
 * `crossref-api` for DOI or `arxiv-api` for arXiv. `metadata` is required only for `found`.
 * This contract records evidence provenance; the caller still has to implement and audit the
 * real official endpoint transport in a later integration slice.
 */
async function verifyFinding(finding, fetcher) {
  if (!isPlain(finding) || typeof finding.id !== 'string') fail('finding-invalid');
  if (typeof fetcher !== 'function') fail('fetcher-invalid');
  const { record, quote } = finding;
  if (!record || !record.identifier) return result('unsupported', outcome(false), null, ['no-identifier']);
  if (!Object.hasOwn(OFFICIAL_SOURCE, record.identifier.type)) return result('unsupported', outcome(null), null, ['identifier-type-unsupported']);

  let evidence;
  try {
    evidence = await fetcher({ type: record.identifier.type, value: record.identifier.value });
  } catch {
    return result('unavailable', outcome(null), null, ['fetcher-unavailable']);
  }
  const shapeProblem = evidenceShape(evidence, record.identifier);
  if (shapeProblem) return result('invalid-evidence', outcome(null), null, [shapeProblem]);
  if (evidence.status === 'unavailable') return result('unavailable', outcome(null), null, ['official-source-unavailable']);
  if (evidence.status === 'not-found') return result('not-found', outcome(false), null, ['identifier-not-found']);

  const metadata = evidence.metadata;
  const warnings = [];
  const titleMatches = normalizeTitle(record.title) !== '' && normalizeTitle(record.title) === normalizeTitle(metadata.title);
  if (!titleMatches) warnings.push('title-mismatch');
  const date = dateEvidence(record.publishedAt, metadata.publishedAt);
  if (date.warning) warnings.push(date.warning);

  let quoteFound = true;
  if (quote?.text) {
    const normalizedQuote = normalizeTitle(quote.text);
    const corpus = `${normalizeTitle(metadata.title)} ${normalizeTitle(metadata.abstract ?? '')}`;
    quoteFound = normalizedQuote !== '' && corpus.includes(normalizedQuote);
    if (!quoteFound) warnings.push('quote-not-found-in-official-source');
  }

  const retracted = typeof metadata.retracted === 'boolean' ? metadata.retracted : null;
  if (retracted === null) warnings.push('retraction-status-unknown');
  if (retracted === true) warnings.push('retracted');
  return result('found', {
    identifierExists: retracted === true ? false : true,
    titleMatches: retracted === true ? false : titleMatches,
    publishedAtMatches: date.matches,
    quoteFound
  }, retracted, warnings);
}

async function verifyAndApply(finding, fetcher) {
  const check = await verifyFinding(finding, fetcher);
  return withVerification(finding, check.outcome);
}

module.exports = { verifyFinding, verifyAndApply, normalizeTitle, VerifierError, OFFICIAL_SOURCE };
