'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fromToolRecord, createFinding } = require('../../src/research/finding');
const { verifyFinding, verifyAndApply, normalizeTitle, VerifierError } = require('../../src/research/verifier');

const DOI = '10.1000/182';
const TITLE = 'Collaborative Multi-Agent Architectures for Software Engineering';
const DATE = '2025-06-15T00:00:00Z';
const ABSTRACT = 'We show that autonomous agents collaborate effectively when clear role boundaries are enforced.';

function createSampleFinding(over = {}) {
  const idType = over.idType ?? 'doi';
  const id = over.id ?? DOI;
  const origin = { serverId: 'academic-mcp', toolName: 'search_papers', retrievedAt: '2026-10-16T12:00:00Z' };
  const record = fromToolRecord({
    id,
    idType,
    title: over.title ?? TITLE,
    abstract: over.abstract ?? ABSTRACT,
    publishedAt: over.publishedAt ?? DATE,
    sourceType: idType === 'arxiv' ? 'preprint' : 'peer-reviewed'
  }, origin);
  return createFinding({
    record,
    claim: 'Multi-agent frameworks benefit from explicit role specialization.',
    comparison: { against: 'docs/ROLE_GROUPS.md', summary: 'Aligns with role boundary enforcement.' },
    novelty: { value: 'partly-new', reason: 'Introduces verifiable role boundary protocol.' },
    confidence: 'high',
    quote: over.quote === undefined ? 'Autonomous agents collaborate effectively' : over.quote
  });
}

function found(over = {}) {
  return {
    status: 'found',
    source: over.source ?? 'crossref-api',
    identifier: over.identifier ?? { type: 'doi', value: DOI },
    fetchedAt: over.fetchedAt ?? '2026-10-16T13:00:00Z',
    metadata: {
      title: over.title ?? TITLE,
      publishedAt: over.publishedAt ?? DATE,
      abstract: over.abstract ?? ABSTRACT,
      retracted: over.retracted ?? false
    }
  };
}

test('normalizeTitle permits punctuation and case differences but verification requires the full normalized title', async () => {
  assert.equal(normalizeTitle('Multi-Agent: Systems!'), normalizeTitle('multi agent systems'));
  const finding = createSampleFinding({ title: 'Safety of Agent Systems', abstract: 'Autonomous agents collaborate effectively.' });
  const check = await verifyFinding(finding, async () => found({ title: 'Safety' }));
  assert.equal(check.outcome.titleMatches, false);
  assert.ok(check.warnings.includes('title-mismatch'));
  assert.equal((await verifyAndApply(finding, async () => found({ title: 'Safety' }))).verification, 'failed');
});

test('matching provenance, identifier and exact metadata can verify a finding', async () => {
  const finding = createSampleFinding();
  let request;
  const fetcher = async (value) => { request = value; return found({ title: 'Collaborative multi agent architectures for software engineering' }); };
  const check = await verifyFinding(finding, fetcher);
  assert.deepEqual(request, { type: 'doi', value: DOI });
  assert.equal(check.status, 'found');
  assert.deepEqual(check.outcome, { identifierExists: true, titleMatches: true, publishedAtMatches: true, quoteFound: true });
  assert.deepEqual(check.warnings, []);
  assert.equal((await verifyAndApply(finding, fetcher)).verification, 'verified');
});

test('identifier and official source must match the request; an arbitrary object is never existence evidence', async () => {
  const finding = createSampleFinding();
  for (const [evidence, warning] of [
    [{ title: TITLE, publishedAt: DATE }, 'fetcher-result-invalid'],
    [found({ source: 'arxiv-api' }), 'official-source-mismatch'],
    [found({ identifier: { type: 'doi', value: '10.1000/different' } }), 'identifier-mismatch'],
    [found({ fetchedAt: '2026-99-99T00:00:00Z' }), 'fetched-at-invalid']
  ]) {
    const check = await verifyFinding(finding, async () => evidence);
    assert.equal(check.status, 'invalid-evidence');
    assert.equal(check.outcome.identifierExists, null);
    assert.deepEqual(check.warnings, [warning]);
    assert.equal((await verifyAndApply(finding, async () => evidence)).verification, 'unverified');
  }
});

test('not-found evidence is distinct from an unavailable or failed fetch', async () => {
  const finding = createSampleFinding();
  const base = { source: 'crossref-api', identifier: { type: 'doi', value: DOI }, fetchedAt: '2026-10-16T13:00:00Z' };
  const absent = await verifyFinding(finding, async () => ({ status: 'not-found', ...base }));
  assert.equal(absent.status, 'not-found');
  assert.equal(absent.outcome.identifierExists, false);
  assert.deepEqual(absent.warnings, ['identifier-not-found']);
  assert.equal((await verifyAndApply(finding, async () => ({ status: 'not-found', ...base }))).verification, 'failed');

  const unavailable = await verifyFinding(finding, async () => ({ status: 'unavailable', ...base }));
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.outcome.identifierExists, null);
  assert.equal((await verifyAndApply(finding, async () => ({ status: 'unavailable', ...base }))).verification, 'unverified');
  const thrown = await verifyFinding(finding, async () => { throw new Error('network details'); });
  assert.equal(thrown.status, 'unavailable');
  assert.deepEqual(thrown.warnings, ['fetcher-unavailable']);
  assert.equal(JSON.stringify(thrown).includes('network details'), false);
});

test('publication dates need a legal exact calendar date; lower precision stays unknown', async () => {
  const finding = createSampleFinding();
  for (const value of ['2025-06-14T00:00:00Z', '2025-07-15T00:00:00Z']) {
    const check = await verifyFinding(finding, async () => found({ publishedAt: value }));
    assert.equal(check.outcome.publishedAtMatches, false, value);
    assert.ok(check.warnings.includes('publication-date-mismatch'));
  }
  const invalid = await verifyFinding(finding, async () => found({ publishedAt: '2025-99-99' }));
  assert.equal(invalid.outcome.publishedAtMatches, false);
  assert.ok(invalid.warnings.includes('official-publication-date-invalid'));
  const overflow = await verifyFinding(finding, async () => found({ publishedAt: '2025-02-30' }));
  assert.equal(overflow.outcome.publishedAtMatches, false);
  const yearOnly = await verifyFinding(finding, async () => found({ publishedAt: '2025' }));
  assert.equal(yearOnly.outcome.publishedAtMatches, null);
  assert.ok(yearOnly.warnings.includes('publication-date-precision-insufficient'));
  assert.equal((await verifyAndApply(finding, async () => found({ publishedAt: '2025' }))).verification, 'unverified');
});

test('a quote absent from the official title and abstract fails verification', async () => {
  const finding = createSampleFinding();
  const evidence = found({ abstract: 'This official abstract does not contain the quoted phrase.' });
  const check = await verifyFinding(finding, async () => evidence);
  assert.equal(check.outcome.quoteFound, false);
  assert.ok(check.warnings.includes('quote-not-found-in-official-source'));
  assert.equal((await verifyAndApply(finding, async () => evidence)).verification, 'failed');
});

test('retraction evidence blocks verification, while an unknown retraction state is disclosed', async () => {
  const finding = createSampleFinding();
  const retracted = await verifyFinding(finding, async () => found({ retracted: true }));
  assert.equal(retracted.retracted, true);
  assert.equal(retracted.outcome.identifierExists, false);
  assert.ok(retracted.warnings.includes('retracted'));
  assert.equal((await verifyAndApply(finding, async () => found({ retracted: true }))).verification, 'failed');

  const evidence = found();
  evidence.metadata.retracted = null;
  const unknown = await verifyFinding(finding, async () => evidence);
  assert.equal(unknown.retracted, null);
  assert.ok(unknown.warnings.includes('retraction-status-unknown'));
});

test('arXiv evidence uses its own named source and exact identifier', async () => {
  const finding = createSampleFinding({ idType: 'arxiv', id: '2501.12345v2' });
  const evidence = found({ source: 'arxiv-api', identifier: { type: 'arxiv', value: '2501.12345v2' } });
  const check = await verifyFinding(finding, async () => evidence);
  assert.equal(check.outcome.identifierExists, true);
  assert.equal((await verifyAndApply(finding, async () => evidence)).verification, 'verified');
});

test('a finding without an identifier is unsupported and does not call the fetcher', async () => {
  const record = fromToolRecord({ title: 'Paper without ID', publishedAt: DATE, sourceType: 'other' }, { serverId: 'academic-mcp', toolName: 'search_papers', retrievedAt: '2026-10-16T12:00:00Z' });
  const finding = createFinding({ record, claim: 'Claim with no identifier' });
  let called = false;
  const check = await verifyFinding(finding, async () => { called = true; return found(); });
  assert.equal(called, false);
  assert.equal(check.status, 'unsupported');
  assert.equal(check.outcome.identifierExists, false);
  assert.ok(check.warnings.includes('no-identifier'));
});

test('invalid caller inputs are rejected with codes only', async () => {
  await assert.rejects(() => verifyFinding(null, async () => found()), (error) => error instanceof VerifierError && error.code === 'finding-invalid');
  await assert.rejects(() => verifyFinding(createSampleFinding(), 'not-a-function'), (error) => error instanceof VerifierError && error.code === 'fetcher-invalid');
});
