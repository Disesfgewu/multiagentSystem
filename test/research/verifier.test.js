'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fromToolRecord, createFinding } = require('../../src/research/finding');
const {
  verifyFinding,
  verifyAndApply,
  normalizeTitle,
  VerifierError
} = require('../../src/research/verifier');

function createSampleFinding({ id = '10.1000/182', idType = 'doi', quoteText = 'Autonomous agents collaborate effectively', retracted = undefined } = {}) {
  const origin = { serverId: 'crossref-mcp', toolName: 'search_works', retrievedAt: '2026-10-16T12:00:00Z' };
  const raw = {
    id,
    idType,
    title: 'Collaborative Multi-Agent Architectures for Software Engineering',
    abstract: 'We show that autonomous agents collaborate effectively when clear role boundaries are enforced.',
    publishedAt: '2025-06-15T00:00:00Z',
    sourceType: 'peer-reviewed'
  };
  if (retracted !== undefined) raw.retracted = retracted;
  const record = fromToolRecord(raw, origin);
  return createFinding({
    record,
    claim: 'Multi-agent frameworks benefit from explicit role specialization.',
    comparison: { against: 'docs/ROLE_GROUPS.md', summary: 'Aligns with role boundary enforcement.' },
    novelty: { value: 'partly-new', reason: 'Introduces verifiable role boundary protocol.' },
    confidence: 'high',
    quote: quoteText
  });
}

test('normalizeTitle handles case, punctuation, and whitespace variations', () => {
  const a = normalizeTitle('Collaborative Multi-Agent Architectures: A Survey (2025)!');
  const b = normalizeTitle('collaborative multi agent architectures a survey 2025');
  assert.equal(a, b);
});

test('verifyFinding succeeds when official metadata matches perfectly', async () => {
  const finding = createSampleFinding();
  const mockFetcher = async () => ({
    title: 'Collaborative Multi-Agent Architectures for Software Engineering',
    publishedAt: '2025-06-15T00:00:00Z',
    abstract: 'We show that autonomous agents collaborate effectively when clear role boundaries are enforced.',
    retracted: false
  });

  const check = await verifyFinding(finding, mockFetcher);
  assert.equal(check.outcome.identifierExists, true);
  assert.equal(check.outcome.titleMatches, true);
  assert.equal(check.outcome.publishedAtMatches, true);
  assert.equal(check.outcome.quoteFound, true);
  assert.equal(check.warnings.length, 0);

  const applied = await verifyAndApply(finding, mockFetcher);
  assert.equal(applied.verification, 'verified');
  assert.equal(applied.novelty.effective, 'partly-new');
  assert.equal(applied.confidence, 'high');
});

test('verifyFinding flags identifier-not-found when fetcher returns null or throws', async () => {
  const finding = createSampleFinding();
  const failingFetcher = async () => null;

  const check = await verifyFinding(finding, failingFetcher);
  assert.equal(check.outcome.identifierExists, false);
  assert.equal(check.warnings.includes('identifier-not-found'), true);

  const applied = await verifyAndApply(finding, failingFetcher);
  assert.equal(applied.verification, 'failed');
  assert.equal(applied.novelty.effective, 'unknown');
});

test('verifyFinding fails title matching when official title is completely different', async () => {
  const finding = createSampleFinding();
  const mismatchFetcher = async () => ({
    title: 'Completely Unrelated Database Indexing Paper',
    publishedAt: '2025-06-15T00:00:00Z',
    abstract: 'Database optimization techniques.',
    retracted: false
  });

  const check = await verifyFinding(finding, mismatchFetcher);
  assert.equal(check.outcome.identifierExists, true);
  assert.equal(check.outcome.titleMatches, false);
  assert.equal(check.warnings.includes('title-mismatch'), true);

  const applied = await verifyAndApply(finding, mismatchFetcher);
  assert.equal(applied.verification, 'failed');
  assert.equal(applied.novelty.effective, 'unknown');
  assert.equal(applied.novelty.blockedBy.includes('verification-failed'), true);
});

test('verifyFinding detects quote hallucination if text is absent from official source', async () => {
  const finding = createSampleFinding();
  const differentAbstractFetcher = async () => ({
    title: 'Collaborative Multi-Agent Architectures for Software Engineering',
    publishedAt: '2025-06-15T00:00:00Z',
    abstract: 'This version discusses general principles without the specific quote phrase.',
    retracted: false
  });

  const check = await verifyFinding(finding, differentAbstractFetcher);
  assert.equal(check.outcome.quoteFound, false);
  assert.equal(check.warnings.includes('quote-not-found-in-official-source'), true);

  const applied = await verifyAndApply(finding, differentAbstractFetcher);
  assert.equal(applied.verification, 'failed');
});

test('verifyFinding detects retracted paper and blocks novelty', async () => {
  const finding = createSampleFinding();
  const retractedFetcher = async () => ({
    title: 'Collaborative Multi-Agent Architectures for Software Engineering',
    publishedAt: '2025-06-15T00:00:00Z',
    abstract: 'We show that autonomous agents collaborate effectively when clear role boundaries are enforced.',
    retracted: true
  });

  const check = await verifyFinding(finding, retractedFetcher);
  assert.equal(check.retracted, true);
  assert.equal(check.warnings.includes('retracted'), true);

  const applied = await verifyAndApply(finding, retractedFetcher);
  assert.equal(applied.verification, 'failed');
  assert.equal(applied.novelty.effective, 'unknown');
  assert.equal(applied.novelty.blockedBy.includes('verification-failed'), true);
});

test('handles finding with no identifier', async () => {
  const origin = { serverId: 'arxiv-mcp', toolName: 'search_papers', retrievedAt: '2026-10-16T12:00:00Z' };
  const raw = {
    title: 'Paper without ID',
    publishedAt: '2025-06-15T00:00:00Z',
    sourceType: 'other'
  };
  const record = fromToolRecord(raw, origin);
  const finding = createFinding({ record, claim: 'Claim with no id source' });

  const check = await verifyFinding(finding, async () => ({}));
  assert.equal(check.outcome.identifierExists, false);
  assert.equal(check.warnings.includes('no-identifier'), true);
});

test('rejects invalid inputs', async () => {
  await assert.rejects(
    async () => verifyFinding(null, async () => {}),
    (err) => err instanceof VerifierError && err.code === 'finding-invalid'
  );
  await assert.rejects(
    async () => verifyFinding({}, 'not-a-function'),
    (err) => err instanceof VerifierError && err.code === 'finding-invalid'
  );
});
